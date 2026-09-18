import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDb, audit } from './db.js';
import { config, startLogin, consumeState, exchangeCode, acceptIdentity, createSession, sessionUser, hash } from './auth.js';
import { service } from './service.js';
import { HttpError } from './policy.js';
import { getAppearance } from './appearance.js';

const publicDir = fileURLToPath(new URL('../public/',import.meta.url));
const files = {'/':['index.html','text/html'], '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css'], '/orbit.css':['orbit.css','text/css'], '/sw.js':['sw.js','text/javascript'],
  '/manifest.webmanifest':['manifest.webmanifest','application/manifest+json'], '/icon.svg':['icon.svg','image/svg+xml'], '/icon-192.png':['icon-192.png','image/png'], '/icon-512.png':['icon-512.png','image/png'], '/mechlin-logo.webp':['mechlin-logo.webp','image/webp'], '/offline.html':['offline.html','text/html']};
export function createApp({db = openDb(process.env.DATABASE_PATH), c = config(), transport = fetch} = {}) {
  const attempts = new Map();
  const cookie = (name,value,maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${c.origin.startsWith('https:')?'; Secure':''}`;
  const server = http.createServer(async (req,res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-ID',requestId);
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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
      if (path.startsWith('/api/')) {
        const user = sessionUser(db,cookies.session); actor = user.id;
        if (!['GET','POST','PUT'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
        let body = {};
        if (req.method !== 'GET') {
          if (req.headers.origin !== c.origin || req.headers['x-csrf-token'] !== user.csrf) throw new HttpError(403,'Request validation failed. Refresh and retry.');
          if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415,'JSON is required.');
          const chunks = []; let size = 0;
          for await (const chunk of req) {size += chunk.length;if(size>131072) throw new HttpError(413,'Request exceeds 128 KB.'); chunks.push(chunk);}
          try {body=JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');} catch {throw new HttpError(400,'Invalid JSON.');}
          if (!body || Array.isArray(body) || typeof body !== 'object') throw new HttpError(400,'JSON object required.');
        }
        if (path === '/api/logout' && req.method === 'POST') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(cookies.session)); audit(db,user.id,'auth.logout',user.id); res.setHeader('Set-Cookie',cookie('session','',0)); return json(200,{ok:true});
        }
        return json(200,service(db,user,req.method,path.slice(5),body,url.searchParams));
      }
      if (files[path] && req.method === 'GET') {
        const [file,type] = files[path];
        const content=readFileSync(resolve(publicDir,file));
        res.writeHead(200,{'Content-Type':type.startsWith('image/')?type:`${type}; charset=utf-8`});
        return res.end(file==='index.html'?content.toString('utf8').replace('data-theme="mechlin"',`data-theme="${getAppearance(db).theme}"`):content);
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
  const app = createApp(); const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
  app.listen(port,host,()=>console.log(`TalentOS listening on ${host}:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>app.close(()=>process.exit(0)));
}
