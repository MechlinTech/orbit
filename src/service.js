import { audit, id, now, transaction } from './db.js';
import { HttpError, roles, requirePermission as permit, requireTeam, inTeam, can, text, email, list, integer } from './policy.js';
import { getAppearance, setAppearance } from './appearance.js';

const get = (db, table, key) => {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key);
  if (!row) throw new HttpError(404, 'Record not found.');
  return row;
};
const publicUser = u => ({ id:u.id, name:u.name, email:u.email, role:u.role, team:u.team, status:u.status, oid:u.oid, tenant:u.tenant, created_at:u.created_at, last_login:u.last_login });
export const pipeline = db => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='pipeline'").get().value);
export function matchSkills(candidate, requisition) {
  const required = JSON.parse(requisition.skills), present = new Set(JSON.parse(candidate.skills).map(s => s.toLowerCase()));
  const matched = required.filter(s => present.has(s.toLowerCase())), missing = required.filter(s => !present.has(s.toLowerCase()));
  return { method:'Deterministic skill overlap; not AI', score: required.length ? Math.round(100 * matched.length / required.length) : null,
    matched, missing, explanation: required.length ? `${matched.length} of ${required.length} explicitly required skills found. Human review required.` : 'No required skills defined. No score calculated.' };
}
function appContext(db, user, aid, interviewer = false) {
  const app = get(db, 'applications', aid), req = get(db, 'requisitions', app.requisition_id);
  if (interviewer && user.role === 'Interviewer') {
    if (!db.prepare('SELECT id FROM interviews WHERE application_id=? AND interviewer_id=?').get(aid,user.id)) throw new HttpError(403,'You are not assigned to this interview.');
  } else requireTeam(user, req.team);
  return { app, req };
}
export function service(db, user, method, path, body = {}, query = new URLSearchParams()) {
  const parts = path.split('/').filter(Boolean), key = parts[1], action = parts[2];
  if (path === 'appearance' && method === 'GET') return getAppearance(db);
  if (path === 'admin/appearance' && method === 'PUT') return setAppearance(db,user,body);
  if (method === 'GET' && path === 'me') return { user:publicUser(user), csrf:user.csrf, roles, permissions:['admin','recruit','requisition','approve_manager','approve_finance','review','analytics','refer','jobs','interview'].filter(p => can(user,p)) };
  if (parts[0] === 'admin') {
    permit(user,'admin');
    if (method === 'GET' && key === 'users') return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(publicUser);
    if (method === 'GET' && key === 'audit') {
      const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200));
      return db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(Number(query.get('before')) || Number.MAX_SAFE_INTEGER,limit);
    }
    if (method === 'POST' && key === 'users' && !action) {
      const address = email(body.email), name = text(body.name,'Name',200), team = text(body.team ?? '','Team',100,true);
      if (!roles.includes(body.role) || body.role === 'Agency') throw new HttpError(400,'Select a supported role. Agency access is not enabled.');
      const oid = text(body.oid,'Entra object ID',36), tenant = text(body.tenant,'Entra tenant ID',36);
      if (!/^[a-f0-9-]{36}$/i.test(oid) || !/^[a-f0-9-]{36}$/i.test(tenant)) throw new HttpError(400,'Entra object and tenant IDs must be GUIDs.');
      const uid = id();
      return transaction(db, () => {
        db.prepare('INSERT INTO users(id,email,name,oid,tenant,role,team,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uid,address,name,oid,tenant,body.role,team,'active',now());
        audit(db,user.id,'admin.user_added',uid,{role:body.role,team}); return publicUser(get(db,'users',uid));
      });
    }
    if (method === 'POST' && key === 'users' && action && parts[3]) {
      const target = get(db,'users',action), op = parts[3];
      if (!['approve','reject','disable','reactivate','force-logout','update'].includes(op)) throw new HttpError(404,'Unknown admin action.');
      if (target.id === user.id && op !== 'force-logout') throw new HttpError(409,'Use another administrator to modify your own access.');
      let status = target.status, role = target.role, team = target.team;
      if (op === 'approve' && target.status !== 'pending') throw new HttpError(409,'Only pending requests can be approved.');
      if (op === 'reject' && target.status !== 'pending') throw new HttpError(409,'Only pending requests can be rejected.');
      if (op === 'reactivate' && !['disabled','rejected'].includes(target.status)) throw new HttpError(409,'Only disabled or rejected users can be reactivated.');
      if (op === 'disable' && target.status !== 'active') throw new HttpError(409,'Only active users can be disabled.');
      if (['approve','update'].includes(op)) {
        if (!roles.includes(body.role) || body.role === 'Agency') throw new HttpError(400,'Select a supported role.');
        role = body.role; team = text(body.team ?? '', 'Team',100,true);
      }
      if (['approve','reactivate'].includes(op)) status = 'active';
      if (op === 'reject') status = 'rejected';
      if (op === 'disable') status = 'disabled';
      if (target.role === 'System Admin' && target.status === 'active' && (status !== 'active' || role !== 'System Admin') && db.prepare("SELECT count(*) n FROM users WHERE role='System Admin' AND status='active'").get().n <= 1) throw new HttpError(409,'Cannot remove the last administrator.');
      return transaction(db, () => {
        db.prepare('UPDATE users SET status=?,role=?,team=?,version=version+1 WHERE id=?').run(status,role,team,target.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
        audit(db,user.id,`admin.${op}`,target.id,{status,role,team}); return publicUser(get(db,'users',target.id));
      });
    }
  }
  if (path === 'pipeline') {
    if (method === 'GET') { permit(user,'jobs'); return pipeline(db); }
    if (method === 'PUT') {
      permit(user,'admin'); const stages = list(body.stages,'Stages',15);
      if (stages.length < 3 || stages[0] !== 'Applied' || stages.at(-2) !== 'Hired' || stages.at(-1) !== 'Rejected') throw new HttpError(400,'Start with Applied and end with Hired, then Rejected.');
      const old = pipeline(db);
      if (old.some(s => !stages.includes(s) && db.prepare('SELECT id FROM applications WHERE stage=?').get(s))) throw new HttpError(409,'Cannot remove a stage in use.');
      return transaction(db, () => { db.prepare("UPDATE settings SET value=? WHERE key='pipeline'").run(JSON.stringify(stages)); audit(db,user.id,'pipeline.updated','',{stages}); return stages; });
    }
  }
  if (parts[0] === 'requisitions') {
    if (method === 'GET') {
      permit(user,'jobs');
      return db.prepare('SELECT * FROM requisitions ORDER BY created_at DESC').all().filter(r => inTeam(user,r.team) && (!['Employee/Referral','Interviewer'].includes(user.role) || r.status === 'open')).map(r => {
        const output = {...r,skills:JSON.parse(r.skills)};
        if (['Employee/Referral','Interviewer'].includes(user.role)) { delete output.salary_min; delete output.salary_max; }
        return output;
      });
    }
    if (method === 'POST' && !key) {
      permit(user,'recruit','requisition'); const team = text(body.team,'Team',100); requireTeam(user,team);
      const title = text(body.title,'Title',200), headcount = integer(body.headcount,'Headcount',1,1000), min = integer(body.salary_min,'Minimum salary'), max = integer(body.salary_max,'Maximum salary');
      if (min > max) throw new HttpError(400,'Minimum salary exceeds maximum.');
      const currency = text(body.currency,'Currency',3).toUpperCase(); if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400,'Use a three-letter currency code.');
      const description = text(body.description,'Job description',15000), skills = list(body.skills,'Skills'), rid = id();
      return transaction(db, () => {
        db.prepare('INSERT INTO requisitions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,title,team,headcount,min,max,currency,description,JSON.stringify(skills),'draft',user.id,now());
        audit(db,user.id,'requisition.created',rid); return get(db,'requisitions',rid);
      });
    }
    if (method === 'POST' && key) {
      const req = get(db,'requisitions',key); requireTeam(user,req.team);
      let status;
      if (action === 'submit') {
        permit(user,'recruit','requisition'); if (req.status !== 'draft') throw new HttpError(409,'Only drafts can be submitted.'); status = 'pending_manager';
      } else if (action === 'approve' || action === 'reject') {
        const step = req.status === 'pending_manager' ? 'manager' : req.status === 'pending_finance' ? 'finance' : null;
        if (!step) throw new HttpError(409,'Requisition is not awaiting approval.');
        permit(user,`approve_${step}`);
        if (req.created_by === user.id || db.prepare('SELECT id FROM approvals WHERE requisition_id=? AND actor=?').get(key,user.id)) throw new HttpError(403,'Requester and each approver must be different people.');
        status = action === 'reject' ? 'rejected' : step === 'manager' ? 'pending_finance' : 'open';
        const note = text(body.note ?? '', 'Approval note',2000,true);
        return transaction(db, () => {
          db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)').run(id(),key,user.id,step,action,note,now());
          db.prepare('UPDATE requisitions SET status=? WHERE id=?').run(status,key); audit(db,user.id,`requisition.${action}`,key,{step,note}); return get(db,'requisitions',key);
        });
      } else throw new HttpError(404,'Unknown requisition action.');
      return transaction(db, () => { db.prepare('UPDATE requisitions SET status=? WHERE id=?').run(status,key); audit(db,user.id,`requisition.${action}`,key); return get(db,'requisitions',key); });
    }
  }
  if (parts[0] === 'candidates') {
    permit(user,'recruit','review');
    if (method === 'GET') {
      const search = (query.get('q') || '').toLowerCase();
      return db.prepare('SELECT * FROM candidates ORDER BY created_at DESC').all().filter(c => inTeam(user,c.team) && `${c.name} ${c.email} ${c.skills} ${c.resume_text}`.toLowerCase().includes(search)).map(c => ({...c,skills:JSON.parse(c.skills)}));
    }
    if (method === 'POST' && !key) {
      permit(user,'recruit'); const team = text(body.team,'Team',100); requireTeam(user,team);
      const address = email(body.email), name = text(body.name,'Name',200), phone = text(body.phone ?? '', 'Phone',50,true), resume = text(body.resume_text ?? '', 'Resume text',50000,true);
      const skills = list(body.skills,'Skills'), source = text(body.source || 'Direct','Source',100), cid = id();
      if (db.prepare('SELECT id FROM candidates WHERE email=?').get(address)) throw new HttpError(409,'A candidate with this email already exists. Ask TA operations to resolve the duplicate.');
      return transaction(db, () => { db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?)').run(cid,name,address,phone,JSON.stringify(skills),resume,source,team,user.id,now()); audit(db,user.id,'candidate.created',cid); return get(db,'candidates',cid); });
    }
  }
  if (path === 'resume/parse' && method === 'POST') {
    permit(user,'recruit'); const resume = text(body.text,'Resume text',50000);
    return {email:resume.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '', phone:resume.match(/\+?[\d][\d ()-]{8,20}\d/)?.[0] || '',
      warning:'Plain-text extraction only. Confirm every field; PDF/DOCX parsing is a later adapter.'};
  }
  if (path === 'jd/draft' && method === 'POST') {
    permit(user,'recruit','requisition'); const title = text(body.title,'Title',200), skills = list(body.skills,'Skills');
    return {method:'Template assistant; not generative AI', draft:`${title}\n\nPurpose\nDescribe the outcomes this role will own.\n\nRequired skills\n${skills.map(s=>`• ${s}`).join('\n')}\n\nResponsibilities\nAdd measurable responsibilities and expected impact.\n\nInterview process\nStructured, job-related assessment with consistent evaluation criteria.\n\nAccessibility\nContact your recruiter to request an interview accommodation.`};
  }
  if (parts[0] === 'applications') {
    permit(user,'recruit','review');
    if (method === 'GET' && !key) return db.prepare(`SELECT a.*,c.name,c.email,c.skills,r.title,r.team FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN requisitions r ON r.id=a.requisition_id ORDER BY a.created_at DESC`).all().filter(a => inTeam(user,a.team));
    if (method === 'POST' && !key) {
      permit(user,'recruit'); const candidate = get(db,'candidates',body.candidate_id), req = get(db,'requisitions',body.requisition_id);
      requireTeam(user,candidate.team); requireTeam(user,req.team);
      if (candidate.team !== req.team) throw new HttpError(409,'Candidate and requisition must belong to the same team.');
      if (req.status !== 'open') throw new HttpError(409,'Requisition must be approved and open.');
      const aid = id(); return transaction(db, () => { db.prepare('INSERT INTO applications VALUES(?,?,?,?,?)').run(aid,candidate.id,req.id,'Applied',now()); audit(db,user.id,'application.created',aid); return get(db,'applications',aid); });
    }
    if (method === 'GET' && key && action === 'match') { const {app,req} = appContext(db,user,key); return matchSkills(get(db,'candidates',app.candidate_id),req); }
    if (method === 'POST' && action === 'stage') {
      permit(user,'recruit'); const {app,req} = appContext(db,user,key), stages = pipeline(db);
      if (!stages.includes(body.stage)) throw new HttpError(400,'Unknown pipeline stage.');
      if (['Hired','Rejected'].includes(app.stage)) throw new HttpError(409,'Terminal applications cannot be moved.');
      if (body.stage !== 'Rejected' && stages.indexOf(body.stage) !== stages.indexOf(app.stage)+1) throw new HttpError(409,'Move to the next stage or reject the application.');
      if (body.stage === 'Hired' && db.prepare("SELECT count(*) n FROM applications WHERE requisition_id=? AND stage='Hired'").get(req.id).n >= req.headcount) throw new HttpError(409,'Approved headcount is filled.');
      return transaction(db, () => {
        db.prepare('UPDATE applications SET stage=? WHERE id=?').run(body.stage,key);
        db.prepare('INSERT INTO stage_events VALUES(?,?,?,?,?,?)').run(id(),key,app.stage,body.stage,user.id,now());
        audit(db,user.id,'application.stage_changed',key,{from:app.stage,to:body.stage}); return get(db,'applications',key);
      });
    }
  }
  if (parts[0] === 'interviews') {
    permit(user,'recruit','review','interview');
    if (method === 'GET' && !key) return db.prepare(`SELECT i.*,c.name,r.title,r.team,u.name interviewer FROM interviews i
      JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN requisitions r ON r.id=a.requisition_id JOIN users u ON u.id=i.interviewer_id`).all().filter(i => user.role === 'Interviewer' ? i.interviewer_id === user.id : inTeam(user,i.team));
    if (method === 'POST' && !key) {
      permit(user,'recruit'); const {app,req} = appContext(db,user,body.application_id), interviewer = get(db,'users',body.interviewer_id);
      if (['Hired','Rejected'].includes(app.stage)) throw new HttpError(409,'Cannot interview a closed application.');
      if (interviewer.status !== 'active' || !['Interviewer','Hiring Manager','Recruiter','TA Manager','TA Director','System Admin'].includes(interviewer.role) || !inTeam(interviewer,req.team)) throw new HttpError(400,'Choose an active interviewer who can access this team.');
      const scheduled = new Date(body.scheduled_at); if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < Date.now()) throw new HttpError(400,'Enter a future interview date.');
      const competencies = list(body.competencies,'Competencies',10); if (!competencies.length) throw new HttpError(400,'At least one competency is required.');
      const iid = id(); return transaction(db, () => { db.prepare('INSERT INTO interviews(id,application_id,interviewer_id,scheduled_at,competencies,created_at) VALUES(?,?,?,?,?,?)').run(iid,app.id,interviewer.id,scheduled.toISOString(),JSON.stringify(competencies),now()); audit(db,user.id,'interview.planned',iid); return {...get(db,'interviews',iid),calendar_status:'Not synced; provider adapter required'}; });
    }
    if (key && action === 'scorecards') {
      const interview = get(db,'interviews',key); appContext(db,user,interview.application_id,true);
      if (method === 'POST') {
        if (interview.interviewer_id !== user.id) throw new HttpError(403,'Only the assigned interviewer can submit this scorecard.');
        const comps = JSON.parse(interview.competencies);
        if (!body.ratings || typeof body.ratings !== 'object' || Array.isArray(body.ratings) || Object.keys(body.ratings).length !== comps.length) throw new HttpError(400,'Rate every planned competency.');
        for (const comp of comps) integer(body.ratings[comp],comp,1,5);
        if (!['Strong yes','Yes','No','Strong no'].includes(body.recommendation)) throw new HttpError(400,'Choose a recommendation.');
        const notes = text(body.notes,'Evidence notes',10000), sid = id();
        return transaction(db, () => { db.prepare('INSERT INTO scorecards VALUES(?,?,?,?,?,?,?)').run(sid,key,user.id,JSON.stringify(body.ratings),body.recommendation,notes,now()); db.prepare("UPDATE interviews SET status='completed' WHERE id=?").run(key); audit(db,user.id,'scorecard.submitted',sid); return {id:sid}; });
      }
      if (method === 'GET') {
        // Any assigned reviewer remains blinded until all their feedback for this application is submitted.
        const assigned = db.prepare('SELECT i.id,s.id submitted FROM interviews i LEFT JOIN scorecards s ON s.interview_id=i.id WHERE i.application_id=? AND i.interviewer_id=?').all(interview.application_id,user.id);
        const blinded = assigned.some(i => !i.submitted);
        const rows = db.prepare('SELECT s.* FROM scorecards s JOIN interviews i ON i.id=s.interview_id WHERE i.application_id=?').all(interview.application_id);
        return {blinded,scorecards: rows.filter(s => blinded ? s.author === user.id : true)};
      }
    }
  }
  if (path === 'interviewers' && method === 'GET') {
    permit(user,'recruit'); return db.prepare("SELECT * FROM users WHERE status='active'").all().filter(u => inTeam(user,u.team) && ['Interviewer','Hiring Manager','Recruiter','TA Manager','TA Director','System Admin'].includes(u.role)).map(u=>({id:u.id,name:u.name,team:u.team}));
  }
  if (path === 'referrals') {
    permit(user,'refer');
    if (method === 'GET') return db.prepare('SELECT * FROM referrals ORDER BY at DESC').all().filter(r => r.created_by === user.id);
    if (method === 'POST') {
      const req = get(db,'requisitions',body.requisition_id); requireTeam(user,req.team);
      if (req.status !== 'open') throw new HttpError(409,'Choose an open requisition.');
      const rid = id(), name = text(body.name,'Name',200), address = email(body.email), note = text(body.note ?? '', 'Referral note',2000,true);
      return transaction(db, () => {db.prepare('INSERT INTO referrals VALUES(?,?,?,?,?,?,?)').run(rid,name,address,req.id,note,user.id,now()); audit(db,user.id,'referral.created',rid);return {id:rid};});
    }
  }
  if (path === 'analytics' && method === 'GET') {
    permit(user,'analytics');
    const reqs = db.prepare('SELECT * FROM requisitions').all().filter(r=>inTeam(user,r.team)), ids = new Set(reqs.map(r=>r.id));
    const apps = db.prepare('SELECT * FROM applications').all().filter(a=>ids.has(a.requisition_id));
    return {openRequisitions:reqs.filter(r=>r.status==='open').length, pendingApprovals:reqs.filter(r=>r.status.startsWith('pending')).length,
      approvedHeadcount:reqs.filter(r=>r.status==='open').reduce((n,r)=>n+r.headcount,0), candidates:db.prepare('SELECT team FROM candidates').all().filter(c=>inTeam(user,c.team)).length,
      stageCounts:Object.fromEntries(pipeline(db).map(s=>[s,apps.filter(a=>a.stage===s).length])),
      averageApplicationAgeDays:apps.length ? Math.round(apps.reduce((n,a)=>n+(Date.now()-Date.parse(a.created_at))/86400000,0)/apps.length) : 0};
  }
  if (path === 'integrations' && method === 'GET') {
    permit(user,'admin','recruit'); return ['Microsoft calendar / Teams','Google calendar / Meet','Candidate email / SMS','Offer e-signature','Preboarding / HRMS','AI matching','PDF / DOCX resume parsing','Fraud signal review','Agency portal'].map(name=>({name,status:'Not configured',phase:name.includes('Agency')?'4':'3',externalWrites:false}));
  }
  throw new HttpError(404,'Endpoint not found.');
}
