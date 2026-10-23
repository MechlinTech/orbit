import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDb, audit } from './db.js';
import { config, startLogin, consumeState, exchangeCode, acceptIdentity, createSession, sessionUser, hash } from './auth.js';
import { service } from './service.js';
import { HttpError } from './policy.js';
import { getAppearance } from './appearance.js';
import { isDemoUser, getOrCreateDemoUser, DEMO_ROLES, DEMO_TEAMS } from './demo.js';
import { verifyWebhookSignature, processWebhookEvent } from './communication/webhook.js';
import { getSigningSessionByToken, submitSignature, declineSignature, downloadSignatureDocument } from './signature/service.js';

const publicDir = fileURLToPath(new URL('../public/',import.meta.url));
const files = {'/':['index.html','text/html'], '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css'], '/orbit.css':['orbit.css','text/css'], '/sw.js':['sw.js','text/javascript'],
  '/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'], '/icon.svg':['icon.svg','image/svg+xml'], '/icon-192.png':['icon-192.png','image/png'], '/icon-512.png':['icon-512.png','image/png'], '/mechlin-logo.webp':['mechlin-logo.webp','image/webp'], '/offline.html':['offline.html','text/html']};
function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  let start = 0;
  let fileBuffer = null, filename = '', mimeType = '';
  while (start < buffer.length) {
    const idx = buffer.indexOf(delimiter, start);
    if (idx === -1) break;
    const partStart = idx + delimiter.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === '--') break;
    const headerStart = partStart + 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;
    const headerStr = buffer.subarray(headerStart, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const nextDelim = buffer.indexOf(delimiter, bodyStart);
    if (nextDelim === -1) break;
    const bodyEnd = nextDelim - 2;
    const partBody = buffer.subarray(bodyStart, bodyEnd);
    const cdMatch = headerStr.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
    const ctMatch = headerStr.match(/content-type:\s*([^\r\n;]+)/i);
    if (cdMatch) {
      const fieldName = cdMatch[1];
      const fn = cdMatch[2];
      if (fn || fieldName === 'file' || fieldName === 'resume') {
        fileBuffer = partBody;
        filename = fn || 'resume';
        mimeType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
      }
    }
    start = nextDelim;
  }
  return { fileBuffer, filename, mimeType };
}

export function createApp({db = openDb(process.env.DATABASE_PATH), c = config(), transport = fetch} = {}) {
  const attempts = new Map();
  const cookie = (name,value,maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${c.origin.startsWith('https:')?'; Secure':''}`;
  const server = http.createServer(async (req,res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-ID',requestId);
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control','no-store');
    if (c.origin.startsWith('https:')) res.setHeader('Strict-Transport-Security','max-age=31536000');
    const json = (status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    const redirect = url => {res.writeHead(302,{Location:url});res.end();};
    let actor = 'anonymous';
    try {
      const url = new URL(req.url,c.origin), path = url.pathname;
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(s=>s.trim().split('=')).filter(p=>p.length===2));
      if (path === '/health' && req.method === 'GET') {db.prepare('SELECT 1').get();return json(200,{status:'ok'});}
      if ((path === '/webhooks/resend' || path === '/api/webhooks/resend') && req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 131072) throw new HttpError(413, 'Webhook payload exceeds 128 KB.');
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const webhookSecret = c.resendWebhookSecret || process.env.RESEND_WEBHOOK_SECRET;
        if (!webhookSecret) {
          audit(db, 'system', 'communication.webhook_rejected', '', { reason: 'Webhook secret not configured' });
          throw new HttpError(503, 'Webhook secret not configured.');
        }
        const valid = verifyWebhookSignature({ rawBody, headers: req.headers, webhookSecret });
        if (!valid) {
          audit(db, 'system', 'communication.webhook_rejected', '', { reason: 'Invalid signature' });
          throw new HttpError(401, 'Invalid webhook signature.');
        }
        let event = {};
        try { event = JSON.parse(rawBody || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
        const result = processWebhookEvent(db, event);
        return json(200, { ok: true, ...result });
      }
      if (path.startsWith('/auth/')) {
        const ip = req.socket.remoteAddress, current = Date.now();
        for (const [key,item] of attempts) if (item.until < current) attempts.delete(key);
        const entry = attempts.get(ip) || {count:0,until:current+60000}; entry.count++; attempts.set(ip,entry);
        if (entry.count > 30) throw new HttpError(429,'Too many sign-in attempts. Try again in a minute.');
      }
      if (path === '/auth/login' && req.method === 'GET') {
        const login = startLogin(db,c); audit(db,actor,'auth.login_started'); res.setHeader('Set-Cookie',cookie('oauth_state',login.state,600)); return redirect(login.url);
      }
      if (path === '/auth/callback' && req.method === 'GET') {
        const state = consumeState(db,url.searchParams.get('state'),cookies.oauth_state);
        res.setHeader('Set-Cookie',cookie('oauth_state','',0));
        if (url.searchParams.has('error')) throw new HttpError(401,'Microsoft sign-in was cancelled or denied.');
        const code = url.searchParams.get('code'); if (!code || code.length > 10000) throw new HttpError(400,'Missing authorization code.');
        const identity = await exchangeCode(code,state,c,transport), user = acceptIdentity(db,identity,c); actor = user.id;
        if (user.status !== 'active') return redirect(`/?access=${user.status}`);
        const session = createSession(db,user,c); res.setHeader('Set-Cookie',[cookie('oauth_state','',0),cookie('session',session.value,c.sessionSeconds)]); return redirect('/');
      }
      if (path === '/auth/demo' && req.method === 'GET') {
        return json(200, { demoLogin: Boolean(c.demoLogin), roles: DEMO_ROLES, teams: DEMO_TEAMS });
      }
      if (path === '/auth/demo-login' && req.method === 'POST') {
        if (!c.demoLogin) throw new HttpError(403, 'Demo login is disabled in this environment.');
        if (req.headers.origin && req.headers.origin !== c.origin) throw new HttpError(403, 'Request validation failed.');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 131072) throw new HttpError(413, 'Request exceeds 128 KB.'); chunks.push(chunk); }
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
        const demoUser = getOrCreateDemoUser(db, c, body.role, body.team);
        const session = createSession(db, demoUser, c);
        audit(db, demoUser.id, 'auth.demo_login', demoUser.id, { role: demoUser.role, team: demoUser.team });
        res.setHeader('Set-Cookie', cookie('session', session.value, c.sessionSeconds));
        return json(200, { ok: true, user: { id: demoUser.id, name: demoUser.name, email: demoUser.email, role: demoUser.role, team: demoUser.team }, csrf: session.csrf });
      }
      if (path.startsWith('/api/signatures/sign/') || path.startsWith('/api/signatures/decline/')) {
        const signParts = path.split('/').filter(Boolean);
        const sigAction = signParts[2];
        const token = signParts[3];
        const isDoc = signParts[4] === 'document';

        if (sigAction === 'sign' && req.method === 'GET' && isDoc) {
          const doc = downloadSignatureDocument(db, token, '', 'signed');
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${doc.filename || 'document.pdf'}"`,
            'Content-Length': doc.buffer.length
          });
          return res.end(doc.buffer);
        }

        if (sigAction === 'sign' && req.method === 'GET') {
          const session = getSigningSessionByToken(db, token);
          return json(200, session);
        }

        if (sigAction === 'sign' && req.method === 'POST') {
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 5242880) throw new HttpError(413, 'Signature payload exceeds 5 MB.');
            chunks.push(chunk);
          }
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
          const ip = req.socket.remoteAddress;
          const userAgent = req.headers['user-agent'] || 'Orbit Signer';
          const result = await submitSignature(db, token, {
            signatureType: body.signature_type,
            signatureData: body.signature_data,
            signatureStyle: body.signature_style,
            signatureImage: body.signature_image,
            consent: Boolean(body.consent),
            ipAddress: ip,
            userAgent
          }, {
            origin: c.origin,
            communicationAdapter: c.communicationAdapter
          });
          return json(200, result);
        }

        if (sigAction === 'decline' && req.method === 'POST') {
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 131072) throw new HttpError(413, 'Request exceeds 128 KB.');
            chunks.push(chunk);
          }
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
          const result = declineSignature(db, token, { reason: body.reason });
          return json(200, result);
        }
      }
      if (path.startsWith('/api/')) {
        const user = sessionUser(db,cookies.session); actor = user.id;
        if (!['GET','POST','PUT','DELETE'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
        if (req.method === 'DELETE' && !/^\/api\/(?:(?:referrals|candidates|requisitions)\/[^/]+|agencies\/[^/]+\/(?:requisitions|assignments)\/[^/]+)$/.test(path)) throw new HttpError(405,'Method not allowed.');
        let body = {};
        if (req.method !== 'GET') {
          if (req.headers.origin !== c.origin || req.headers['x-csrf-token'] !== user.csrf) throw new HttpError(403,'Request validation failed. Refresh and retry.');
          const isUpload = path === '/api/resume/upload' || path === '/api/agency/resume/upload';
          const maxLimit = isUpload ? c.maxResumeSizeBytes : 131072;
          const contentType = String(req.headers['content-type'] || '');
          if (!contentType.startsWith('application/json') && !(isUpload && contentType.startsWith('multipart/form-data'))) {
            throw new HttpError(415, 'JSON is required.');
          }
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > maxLimit) throw new HttpError(413, isUpload ? `File exceeds maximum upload size of ${Math.round(maxLimit / 1048576)} MB.` : 'Request exceeds 128 KB.');
            chunks.push(chunk);
          }
          const fullBuf = Buffer.concat(chunks);
          if (isUpload && contentType.startsWith('multipart/form-data')) {
            const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
            if (!boundaryMatch) throw new HttpError(400, 'Invalid multipart boundary.');
            const parsed = parseMultipart(fullBuf, boundaryMatch[1].trim());
            if (!parsed.fileBuffer) throw new HttpError(400, 'No file found in upload request.');
            body = { buffer: parsed.fileBuffer, filename: parsed.filename, mimeType: parsed.mimeType };
          } else {
            try { body = JSON.parse(fullBuf.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
            if (!body || Array.isArray(body) || typeof body !== 'object') throw new HttpError(400, 'JSON object required.');
            if (isUpload && body.data) {
              body.buffer = Buffer.from(body.data, 'base64');
            }
          }
        }
        if (path === '/api/demo/switch' && req.method === 'POST') {
          if (!c.demoLogin) throw new HttpError(403, 'Demo login is disabled in this environment.');
          if (!isDemoUser(user)) throw new HttpError(403, 'Role switching is only permitted for demo users.');
          const nextUser = getOrCreateDemoUser(db, c, body.role, body.team);
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(cookies.session));
          const nextSession = createSession(db, nextUser, c);
          audit(db, user.id, 'auth.demo_switch', nextUser.id, { fromRole: user.role, fromTeam: user.team, toRole: nextUser.role, toTeam: nextUser.team });
          res.setHeader('Set-Cookie', cookie('session', nextSession.value, c.sessionSeconds));
          return json(200, { ok: true, user: { id: nextUser.id, name: nextUser.name, email: nextUser.email, role: nextUser.role, team: nextUser.team }, csrf: nextSession.csrf });
        }
        if (path === '/api/logout' && req.method === 'POST') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(cookies.session)); audit(db,user.id,'auth.logout',user.id); res.setHeader('Set-Cookie',cookie('session','',0)); return json(200,{ok:true});
        }
        const result = await service(db,user,req.method,path.slice(5),body,url.searchParams,c);
        if (result && result.isRaw) {
          res.writeHead(200, {
            'Content-Type': result.contentType || 'application/pdf',
            'Content-Disposition': `inline; filename="${result.filename || 'document.pdf'}"`,
            'Content-Length': result.buffer.length
          });
          return res.end(result.buffer);
        }
        return json(200, result);
      }
      if ((files[path] || path.startsWith('/sign/')) && req.method === 'GET') {
        const [file,type] = path.startsWith('/sign/') ? files['/'] : files[path];
        const content=readFileSync(resolve(publicDir,file));
        res.writeHead(200,{'Content-Type':type.startsWith('image/')?type:`${type}; charset=utf-8`});
        return res.end(file==='index.html'?content.toString('utf8').replace('data-theme="mechlin"',`data-theme="${getAppearance(db).theme}"${c.demoLogin?' data-demo-login="true"':''}`):content);
      }
      throw new HttpError(404,'Page not found.');
    } catch (error) {
      const duplicate = String(error.message).includes('UNIQUE constraint');
      const status = error.status || (duplicate ? 409 : 500);
      if (req.url.startsWith('/auth/') || status === 403) audit(db,actor,'security.request_denied','',{requestId,status,path:req.url.split('?')[0]});
      if (status === 500) console.error(JSON.stringify({requestId,error:error.message}));
      return json(status,{error:error.status?error.message:duplicate?'This record already exists.':'An unexpected error occurred. Contact your administrator with the request ID.',requestId});
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 15000;
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile?.(); } catch {}
  const app = createApp(); const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  app.listen(port,host,()=>console.log(`Orbit listening on ${host}:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>app.close(()=>process.exit(0)));
}
