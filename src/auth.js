import { randomBytes, createHash, createPublicKey, verify } from 'node:crypto';
import { audit, id, now, transaction } from './db.js';
import { HttpError, email } from './policy.js';
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('base64url');
const csv = value => (value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
export function config(env = process.env) {
  const c = { origin: env.APP_ORIGIN || 'http://localhost:3000', tenant: env.ENTRA_TENANT_ID || '', client: env.ENTRA_CLIENT_ID || '',
    secret: env.ENTRA_CLIENT_SECRET || '', domains: csv(env.ALLOWED_DOMAINS), groups: csv(env.ALLOWED_GROUP_IDS),
    production: env.NODE_ENV === 'production', sessionSeconds: Number(env.SESSION_SECONDS || 28800) };
  if (!Number.isInteger(c.sessionSeconds) || c.sessionSeconds < 300 || c.sessionSeconds > 86400) throw new Error('SESSION_SECONDS must be 300–86400');
  const origin = new URL(c.origin);
  if (origin.origin !== c.origin || origin.username || origin.password) throw new Error('APP_ORIGIN must be a bare origin');
  if (c.production && (!c.origin.startsWith('https://') || !c.secret || !c.domains.length)) throw new Error('Production requires HTTPS, Entra credentials and ALLOWED_DOMAINS');
  if ((c.tenant && !/^[0-9a-f-]{36}$/i.test(c.tenant)) || (c.client && !/^[0-9a-f-]{36}$/i.test(c.client))) throw new Error('Entra IDs must be GUIDs');
  if (c.production && (!c.tenant || !c.client)) throw new Error('Production requires tenant/client IDs');
  return c;
}
export function startLogin(db, c) {
  if (!c.tenant || !c.client || !c.secret) throw new HttpError(503, 'Microsoft 365 sign-in is not configured. Ask your administrator.');
  const state = token(), nonce = token(), verifier = token();
  db.prepare('DELETE FROM oauth_states WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO oauth_states VALUES(?,?,?,?)').run(hash(state), verifier, nonce, Date.now() + 600000);
  const params = new URLSearchParams({ client_id: c.client, response_type: 'code', redirect_uri: `${c.origin}/auth/callback`,
    response_mode: 'query', scope: 'openid profile email', state, nonce, code_challenge: hash(verifier), code_challenge_method: 'S256' });
  return { state, url: `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/authorize?${params}` };
}
export function consumeState(db, state, cookie) {
  if (!state || state !== cookie) throw new HttpError(400, 'Sign-in state mismatch. Start sign-in again.');
  const stored = db.prepare('SELECT * FROM oauth_states WHERE state_hash=?').get(hash(state));
  db.prepare('DELETE FROM oauth_states WHERE state_hash=?').run(hash(state));
  if (!stored || stored.expires < Date.now()) throw new HttpError(400, 'Sign-in request expired or already used.');
  return stored;
}
export function validateIdToken(jwt, jwks, c, nonce) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Invalid identity token.');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
  catch { throw new HttpError(401, 'Malformed identity token.'); }
  const jwk = jwks.keys?.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'));
  if (header.alg !== 'RS256' || !jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new HttpError(401, 'Identity signature validation failed.');
  const seconds = Date.now() / 1000;
  if (claims.aud !== c.client || claims.iss !== `https://login.microsoftonline.com/${c.tenant}/v2.0` || claims.tid !== c.tenant || claims.nonce !== nonce || !claims.oid || !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 60 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 60))) throw new HttpError(401, 'Identity claims validation failed.');
  return claims;
}
export async function exchangeCode(code, state, c, transport = fetch) {
  const root = `https://login.microsoftonline.com/${c.tenant}`;
  const response = await transport(`${root}/oauth2/v2.0/token`, { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.client, client_secret: c.secret,
      grant_type: 'authorization_code', code, redirect_uri: `${c.origin}/auth/callback`, code_verifier: state.verifier }) });
  if (!response.ok) throw new HttpError(401, 'Microsoft sign-in could not be completed.');
  const result = await response.json();
  const keys = await transport(`${root}/discovery/v2.0/keys`, { signal: AbortSignal.timeout(15000) });
  if (!keys.ok) throw new HttpError(503, 'Microsoft signing keys are unavailable.');
  return validateIdToken(result.id_token, await keys.json(), c, state.nonce);
}
export function acceptIdentity(db, claims, c) {
  return transaction(db, () => {
    if (claims.tid !== c.tenant) throw new HttpError(403, 'Organization not permitted.');
    const address = email(claims.preferred_username || claims.email);
    if (c.domains.length && !c.domains.includes(address.split('@')[1])) throw new HttpError(403, 'Email domain not permitted.');
    if (c.groups.length && (!Array.isArray(claims.groups) || !claims.groups.some(g => c.groups.includes(g.toLowerCase())))) throw new HttpError(403, 'Required group membership was not provided.');
    let user = db.prepare('SELECT * FROM users WHERE oid=? AND tenant=?').get(claims.oid, claims.tid);
    if (!user) {
      // Email is display/contact data, never authority to claim a manually provisioned identity.
      const collision = db.prepare('SELECT id FROM users WHERE email=?').get(address);
      if (collision) throw new HttpError(403, 'Contact an administrator to bind your Entra object ID.');
      const uid = id();
      db.prepare('INSERT INTO users(id,email,name,oid,tenant,status,created_at) VALUES(?,?,?,?,?,?,?)').run(uid, address, String(claims.name || address).slice(0,200), claims.oid, claims.tid, 'pending', now());
      audit(db, uid, 'auth.access_requested', uid);
      user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
    }
    audit(db, user.id, `auth.login_${user.status}`, user.id);
    if (user.status === 'active') db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now(), user.id);
    return user;
  });
}
export function createSession(db, user, c) {
  if (user.status !== 'active') throw new HttpError(403, 'Access is not approved.');
  const value = token(), csrf = token();
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash(value), user.id, user.version, csrf, Date.now() + c.sessionSeconds * 1000);
  return { value, csrf };
}
export function sessionUser(db, value) {
  if (!value) throw new HttpError(401, 'Sign in with Microsoft 365.');
  const row = db.prepare(`SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires>? AND s.version=u.version AND u.status='active'`).get(hash(value), Date.now());
  if (!row) throw new HttpError(401, 'Session expired or access revoked.');
  return row;
}
