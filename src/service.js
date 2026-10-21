import { audit, id, now, transaction } from './db.js';
import { HttpError, roles, teams, requirePermission as permit, requireTeam, inTeam, can, text, email, phone as validatePhone, currency as validateCurrency, list, validateSkills, integer } from './policy.js';
import { getAppearance, setAppearance } from './appearance.js';
import { isDemoUser } from './demo.js';

const get = (db, table, key) => {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key);
  if (!row) throw new HttpError(404, 'Record not found.');
  return row;
};
const publicUser = u => ({ id:u.id, name:u.name, email:u.email, role:u.role, team:u.team, status:u.status, oid:u.oid, tenant:u.tenant, created_at:u.created_at, last_login:u.last_login });
export const pipeline = db => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='pipeline'").get().value);
export function matchSkills(candidate, requisition) {
  const required = Array.isArray(requisition.skills) ? requisition.skills : JSON.parse(requisition.skills);
  const candSkills = Array.isArray(candidate.skills) ? candidate.skills : JSON.parse(candidate.skills);
  const present = new Set(candSkills.map(s => s.toLowerCase()));
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
export function service(db, user, method, path, body = {}, query = new URLSearchParams(), c = {}) {
  const parts = path.split('/').filter(Boolean), key = parts[1], action = parts[2];
  if (path === 'appearance' && method === 'GET') return getAppearance(db);
  if (path === 'admin/appearance' && method === 'PUT') return setAppearance(db,user,body);
  if (method === 'GET' && path === 'me') return { user: { ...publicUser(user), isDemoUser: isDemoUser(user) }, csrf: user.csrf, roles, teams, demoLogin: Boolean(c?.demoLogin), isDemoUser: isDemoUser(user), permissions: ['admin','recruit','requisition','approve_manager','approve_finance','review','analytics','refer','jobs','interview'].filter(p => can(user,p)) };
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
      if (key) {
        const r = get(db, 'requisitions', key);
        if (!inTeam(user, r.team) || (['Employee/Referral', 'Interviewer'].includes(user.role) && r.status !== 'open')) {
          throw new HttpError(404, 'Requisition not found.');
        }
        const output = { ...r, skills: JSON.parse(r.skills) };
        if (['Employee/Referral', 'Interviewer'].includes(user.role)) { delete output.salary_min; delete output.salary_max; }
        return output;
      }
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
      const currency = validateCurrency(body.currency);
      const description = text(body.description,'Job description',15000), skills = validateSkills(body.skills), rid = id();
      return transaction(db, () => {
        db.prepare('INSERT INTO requisitions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,title,team,headcount,min,max,currency,description,JSON.stringify(skills),'draft',user.id,now());
        audit(db,user.id,'requisition.created',rid); return get(db,'requisitions',rid);
      });
    }
    if ((method === 'PUT' || (method === 'POST' && !action)) && key) {
      permit(user,'recruit','requisition');
      const req = get(db,'requisitions',key);
      requireTeam(user,req.team);
      const isAdmin = can(user, 'admin');
      if (!isAdmin && !['draft','open'].includes(req.status)) {
        if (['pending_manager','pending_finance'].includes(req.status)) {
          throw new HttpError(409,'Cannot edit requisition awaiting approval.');
        }
        throw new HttpError(409,`Cannot edit a requisition with status ${req.status}.`);
      }
      const team = text(body.team ?? req.team,'Team',100);
      requireTeam(user,team);
      const hasApps = Boolean(db.prepare('SELECT id FROM applications WHERE requisition_id=?').get(key));
      if (team !== req.team && hasApps) {
        if (!isAdmin || (!body.admin_override && !body.override)) {
          throw new HttpError(409,'Cannot change team of a requisition with existing applications.');
        }
      }
      const title = text(body.title ?? req.title,'Title',200);
      const headcount = integer(body.headcount !== undefined ? Number(body.headcount) : req.headcount,'Headcount',1,1000);
      if (req.status === 'open') {
        const hired = db.prepare("SELECT count(*) n FROM applications WHERE requisition_id=? AND stage='Hired'").get(key).n;
        if (headcount < hired) throw new HttpError(409,`Headcount cannot be less than the number of hired candidates (${hired}).`);
      }
      const min = integer(body.salary_min !== undefined ? Number(body.salary_min) : req.salary_min,'Minimum salary');
      const max = integer(body.salary_max !== undefined ? Number(body.salary_max) : req.salary_max,'Maximum salary');
      if (min > max) throw new HttpError(400,'Minimum salary exceeds maximum.');
      const currency = validateCurrency(body.currency ?? req.currency);
      const description = text(body.description ?? req.description,'Job description',15000);
      const rawSkills = body.skills !== undefined ? (Array.isArray(body.skills) ? body.skills : typeof body.skills === 'string' ? body.skills.split(',').map(s=>s.trim()).filter(Boolean) : JSON.parse(req.skills)) : JSON.parse(req.skills);
      const skills = validateSkills(rawSkills);
      return transaction(db, () => {
        db.prepare('UPDATE requisitions SET title=?, team=?, headcount=?, salary_min=?, salary_max=?, currency=?, description=?, skills=? WHERE id=?').run(
          title,team,headcount,min,max,currency,description,JSON.stringify(skills),key
        );
        const auditDetail = {title,team,headcount};
        if (isAdmin && ['pending_manager','pending_finance'].includes(req.status)) {
          auditDetail.admin_pending_edit = true;
          auditDetail.previous_status = req.status;
        }
        if (isAdmin && team !== req.team && hasApps) {
          auditDetail.admin_team_reassignment = true;
          auditDetail.previous_team = req.team;
        }
        audit(db,user.id,'requisition.updated',key,auditDetail);
        const updated = get(db,'requisitions',key);
        return {...updated,skills:JSON.parse(updated.skills)};
      });
    }
    if (method === 'POST' && key && action) {
      const req = get(db,'requisitions',key); requireTeam(user,req.team);
      let status;
      if (action === 'submit') {
        permit(user,'recruit','requisition'); if (req.status !== 'draft') throw new HttpError(409,'Only drafts can be submitted.'); status = 'pending_manager';
      } else if (action === 'approve' || action === 'reject') {
        const step = req.status === 'pending_manager' ? 'manager' : req.status === 'pending_finance' ? 'finance' : null;
        if (!step) throw new HttpError(409,'Requisition is not awaiting approval.');
        permit(user,`approve_${step}`);
        const isCreator = req.created_by === user.id;
        const priorApproval = db.prepare('SELECT id FROM approvals WHERE requisition_id=? AND actor=?').get(key,user.id);
        const separationViolated = isCreator || Boolean(priorApproval);
        const isEmergency = Boolean(body.emergency_override || body.admin_override || body.override);

        let overrideReason = '';
        let bypassedRule = '';

        if (separationViolated) {
          if (!isEmergency) {
            throw new HttpError(403,'Requester and each approver must be different people.');
          }
          if (!can(user, 'admin')) {
            throw new HttpError(403,'Only a System Admin can perform an emergency approval override.');
          }
          if (body.override_reason !== undefined) {
            overrideReason = text(body.override_reason, 'Emergency override reason', 2000, false);
            if (!overrideReason || !overrideReason.trim()) {
              throw new HttpError(400, 'A meaningful reason is required for an emergency approval override.');
            }
          } else {
            overrideReason = text(body.reason || body.note || 'System Admin direct approval override', 'Emergency override reason', 2000, true) || 'System Admin direct approval override';
          }
          bypassedRule = isCreator && priorApproval ? 'requester_and_prior_approver' : isCreator ? 'requester_self_approval' : 'same_approver_both_steps';
        } else if (isEmergency) {
          if (!can(user, 'admin')) {
            throw new HttpError(403,'Only a System Admin can perform an emergency approval override.');
          }
          if (body.override_reason !== undefined) {
            overrideReason = text(body.override_reason, 'Emergency override reason', 2000, false);
            if (!overrideReason || !overrideReason.trim()) {
              throw new HttpError(400, 'A meaningful reason is required for an emergency approval override.');
            }
          } else {
            overrideReason = text(body.reason || body.note || 'System Admin direct approval override', 'Emergency override reason', 2000, true) || 'System Admin direct approval override';
          }
          bypassedRule = 'explicit_administrative_override';
        }

        status = action === 'reject' ? 'rejected' : step === 'manager' ? 'pending_finance' : 'open';
        const note = text(body.note ?? '', 'Approval note',2000,true);
        return transaction(db, () => {
          db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)').run(id(),key,user.id,step,action,note,now());
          db.prepare('UPDATE requisitions SET status=? WHERE id=?').run(status,key);
          audit(db,user.id,`requisition.${action}`,key,{step,note});
          if (isEmergency) {
            audit(db,user.id,'admin.emergency_approval_override',key,{
              step,
              action,
              bypassed_rule: bypassedRule,
              override_reason: overrideReason,
              previous_status: req.status,
              new_status: status,
              requisition_title: req.title,
              created_by: req.created_by
            });
          }
          return get(db,'requisitions',key);
        });
      } else throw new HttpError(404,'Unknown requisition action.');
      return transaction(db, () => { db.prepare('UPDATE requisitions SET status=? WHERE id=?').run(status,key); audit(db,user.id,`requisition.${action}`,key); return get(db,'requisitions',key); });
    }
  }
  if (parts[0] === 'candidates') {
    permit(user,'recruit','review');
    if (method === 'GET') {
      if (key) {
        const c = get(db, 'candidates', key);
        requireTeam(user, c.team);
        const apps = db.prepare('SELECT a.id, a.candidate_id, a.requisition_id, a.stage, a.created_at, r.title, r.team FROM applications a JOIN requisitions r ON r.id=a.requisition_id WHERE a.candidate_id=? ORDER BY a.created_at ASC').all(key).filter(a => inTeam(user, a.team)).map(a => ({
          id: a.id,
          requisition_id: a.requisition_id,
          title: a.title,
          stage: a.stage,
          team: a.team,
          created_at: a.created_at
        }));
        return { ...c, skills: JSON.parse(c.skills), experience: c.resume_text, applications: apps };
      }
      const search = (query.get('q') || '').toLowerCase();
      const cands = db.prepare('SELECT * FROM candidates ORDER BY created_at DESC').all().filter(c => inTeam(user,c.team));
      const appRows = db.prepare('SELECT a.id, a.candidate_id, a.requisition_id, a.stage, a.created_at, r.title, r.team FROM applications a JOIN requisitions r ON r.id=a.requisition_id ORDER BY a.created_at ASC').all().filter(a => inTeam(user, a.team));
      const appsByCandidate = new Map();
      for (const a of appRows) {
        let list = appsByCandidate.get(a.candidate_id);
        if (!list) {
          list = [];
          appsByCandidate.set(a.candidate_id, list);
        }
        list.push({
          id: a.id,
          requisition_id: a.requisition_id,
          title: a.title,
          stage: a.stage,
          team: a.team,
          created_at: a.created_at
        });
      }
      return cands
        .filter(c => {
          const appText = (appsByCandidate.get(c.id) || []).map(a => `${a.title} ${a.stage}`).join(' ');
          return `${c.name} ${c.email} ${c.skills} ${c.resume_text} ${appText}`.toLowerCase().includes(search);
        })
        .map(c => ({
          ...c,
          skills: JSON.parse(c.skills),
          experience: c.resume_text,
          applications: appsByCandidate.get(c.id) || []
        }));
    }
    if (method === 'POST' && !key) {
      permit(user,'recruit'); const team = text(body.team,'Team',100); requireTeam(user,team);
      const address = email(body.email), name = text(body.name,'Name',200), phone = validatePhone(body.phone ?? '', true);
      const resumeVal = body.resume_text !== undefined ? body.resume_text : body.experience !== undefined ? body.experience : '';
      const resume = text(resumeVal, 'Resume text', 50000, true);
      const skills = validateSkills(body.skills), source = text(body.source || 'Direct','Source',100), cid = id();
      if (db.prepare('SELECT id FROM candidates WHERE email=?').get(address)) throw new HttpError(409,'A candidate with this email already exists. Ask TA operations to resolve the duplicate.');
      return transaction(db, () => {
        db.prepare('INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?)').run(cid,name,address,phone,JSON.stringify(skills),resume,source,team,user.id,now());
        audit(db,user.id,'candidate.created',cid);
        const created = get(db,'candidates',cid);
        return {...created,skills:JSON.parse(created.skills),experience:created.resume_text,applications:[]};
      });
    }
    if ((method === 'PUT' || method === 'POST') && key) {
      permit(user,'recruit');
      const candidate = get(db,'candidates',key);
      requireTeam(user,candidate.team);
      const team = text(body.team || candidate.team,'Team',100); requireTeam(user,team);
      const address = email(body.email ?? candidate.email), name = text(body.name ?? candidate.name,'Name',200);
      const phone = validatePhone(body.phone ?? candidate.phone ?? '', true);
      const resumeVal = body.resume_text !== undefined ? body.resume_text : body.experience !== undefined ? body.experience : candidate.resume_text;
      const resume = text(resumeVal ?? '','Resume text',50000,true);
      const rawSkills = Array.isArray(body.skills) ? body.skills : typeof body.skills === 'string' ? body.skills.split(',').map(s=>s.trim()).filter(Boolean) : JSON.parse(candidate.skills);
      const skills = validateSkills(rawSkills);
      const source = text(body.source || candidate.source || 'Direct','Source',100);
      const duplicate = db.prepare('SELECT id FROM candidates WHERE email=? AND id!=?').get(address,key);
      if (duplicate) throw new HttpError(409,'A candidate with this email already exists. Ask TA operations to resolve the duplicate.');
      return transaction(db, () => {
        db.prepare('UPDATE candidates SET name=?,email=?,phone=?,skills=?,resume_text=?,source=?,team=? WHERE id=?').run(name,address,phone,JSON.stringify(skills),resume,source,team,key);
        audit(db,user.id,'candidate.updated',key,{name,email:address,team});
        const updated = get(db,'candidates',key);
        const apps = db.prepare('SELECT a.id, a.candidate_id, a.requisition_id, a.stage, a.created_at, r.title, r.team FROM applications a JOIN requisitions r ON r.id=a.requisition_id WHERE a.candidate_id=? ORDER BY a.created_at ASC').all(key).filter(a => inTeam(user, a.team)).map(a => ({
          id: a.id,
          requisition_id: a.requisition_id,
          title: a.title,
          stage: a.stage,
          team: a.team,
          created_at: a.created_at
        }));
        return {...updated,skills:JSON.parse(updated.skills),experience:updated.resume_text,applications:apps};
      });
    }
  }
  if (path === 'resume/parse' && method === 'POST') {
    permit(user,'recruit'); const resume = text(body.text,'Resume text',50000);
    const email = resume.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
    const phone = resume.match(/\+?[\d][\d ()-]{8,20}\d/)?.[0] || '';
    const message = (email || phone) ? 'Email and phone number extracted successfully.' : 'No email or phone number found in resume text.';
    return { email, phone, message, warning: message };
  }
  if (path === 'jd/draft' && method === 'POST') {
    permit(user,'recruit','requisition'); const title = text(body.title,'Title',200), skills = validateSkills(body.skills);
    return {method:'Template assistant; not generative AI', draft:`${title}\n\nPurpose\nDescribe the outcomes this role will own.\n\nRequired skills\n${skills.map(s=>`• ${s}`).join('\n')}\n\nResponsibilities\nAdd measurable responsibilities and expected impact.\n\nInterview process\nStructured, job-related assessment with consistent evaluation criteria.\n\nAccessibility\nContact your recruiter to request an interview accommodation.`};
  }
  if (parts[0] === 'applications') {
    permit(user,'recruit','review');
    if (method === 'GET' && !key) return db.prepare(`SELECT a.*,c.name,c.email,c.skills,r.title,r.team FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN requisitions r ON r.id=a.requisition_id ORDER BY a.created_at DESC`).all().filter(a => inTeam(user,a.team));
    if (method === 'POST' && !key) {
      permit(user,'recruit'); const candidate = get(db,'candidates',body.candidate_id), req = get(db,'requisitions',body.requisition_id);
      requireTeam(user,candidate.team); requireTeam(user,req.team);
      const isAdmin = can(user, 'admin');
      if (!isAdmin && candidate.team !== req.team) throw new HttpError(409,'Candidate and requisition must belong to the same team.');
      if (req.status !== 'open') throw new HttpError(409,'Requisition must be approved and open.');
      const aid = id();
      return transaction(db, () => {
        db.prepare('INSERT INTO applications VALUES(?,?,?,?,?)').run(aid,candidate.id,req.id,'Applied',now());
        const auditDetail = { candidate_id: candidate.id, requisition_id: req.id };
        if (candidate.team !== req.team) {
          auditDetail.cross_team_override = true;
          auditDetail.candidate_team = candidate.team;
          auditDetail.requisition_team = req.team;
        }
        audit(db,user.id,'application.created',aid,auditDetail);
        return get(db,'applications',aid);
      });
    }
    if (method === 'GET' && key && action === 'match') { const {app,req} = appContext(db,user,key); return matchSkills(get(db,'candidates',app.candidate_id),req); }
    if (method === 'POST' && action === 'stage') {
      permit(user,'recruit'); const {app,req} = appContext(db,user,key), stages = pipeline(db);
      if (!stages.includes(body.stage)) throw new HttpError(400,'Unknown pipeline stage.');
      const isAdmin = can(user, 'admin');
      const isTerminal = ['Hired','Rejected'].includes(app.stage);
      const isSequential = body.stage === 'Rejected' || stages.indexOf(body.stage) === stages.indexOf(app.stage)+1 || (!isTerminal && stages.indexOf(body.stage) === stages.indexOf(app.stage)-1);
      const hiredCount = db.prepare("SELECT count(*) n FROM applications WHERE requisition_id=? AND stage='Hired'").get(req.id).n;
      const isOverHeadcount = body.stage === 'Hired' && hiredCount >= req.headcount;

      const hasRuleViolation = isTerminal || !isSequential || isOverHeadcount;
      let isOverride = false;
      let overrideReason = '';
      let bypassedRule = '';

      if (hasRuleViolation) {
        if (!isAdmin) {
          if (isTerminal) throw new HttpError(409,'Terminal applications cannot be moved.');
          if (!isSequential) throw new HttpError(409,'Move to the next stage or reject the application.');
          if (isOverHeadcount) throw new HttpError(409,'Approved headcount is filled.');
        }
        if (!body.admin_override && !body.override && !body.override_reason && !body.reason) {
          if (isTerminal) throw new HttpError(409,'Terminal applications cannot be moved without administrative override.');
          if (!isSequential) throw new HttpError(409,'Non-sequential stage transition requires administrative override.');
          if (isOverHeadcount) throw new HttpError(409,'Hiring beyond approved headcount requires administrative override.');
        }
        isOverride = true;
        overrideReason = text(body.override_reason || body.reason || 'Administrative pipeline correction', 'Override reason', 2000, true);
        bypassedRule = [
          isTerminal ? 'terminal_stage' : '',
          !isSequential ? 'non_sequential_transition' : '',
          isOverHeadcount ? 'headcount_limit' : ''
        ].filter(Boolean).join(', ');
      }

      return transaction(db, () => {
        db.prepare('UPDATE applications SET stage=? WHERE id=?').run(body.stage,key);
        db.prepare('INSERT INTO stage_events VALUES(?,?,?,?,?,?)').run(id(),key,app.stage,body.stage,user.id,now());
        const auditDetail = {from:app.stage,to:body.stage};
        if (isOverride) {
          auditDetail.admin_override = true;
          auditDetail.bypassed_rule = bypassedRule;
          auditDetail.override_reason = overrideReason;
        }
        audit(db,user.id,isOverride ? 'admin.application_stage_override' : 'application.stage_changed',key,auditDetail);
        return get(db,'applications',key);
      });
    }
  }
  if (parts[0] === 'interviews') {
    permit(user,'recruit','review','interview');
    if (method === 'GET' && !key) return db.prepare(`SELECT i.*,c.name,r.title,r.team,u.name interviewer FROM interviews i
      JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN requisitions r ON r.id=a.requisition_id JOIN users u ON u.id=i.interviewer_id`).all().filter(i => user.role === 'Interviewer' ? i.interviewer_id === user.id : inTeam(user,i.team));
    if (method === 'GET' && key && !action) {
      const interview = get(db, 'interviews', key);
      appContext(db, user, interview.application_id, true);
      return db.prepare(`SELECT i.*,c.name,r.title,r.team,u.name interviewer FROM interviews i
        JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN requisitions r ON r.id=a.requisition_id JOIN users u ON u.id=i.interviewer_id WHERE i.id=?`).get(key);
    }
    if (method === 'POST' && !key) {
      permit(user,'recruit'); const {app,req} = appContext(db,user,body.application_id), interviewer = get(db,'users',body.interviewer_id);
      if (['Hired','Rejected'].includes(app.stage)) throw new HttpError(409,'Cannot interview a closed application.');
      if (interviewer.status !== 'active' || !['Interviewer','Hiring Manager','Recruiter','TA Manager','TA Director','System Admin'].includes(interviewer.role) || !inTeam(interviewer,req.team)) throw new HttpError(400,'Choose an active interviewer who can access this team.');
      const scheduled = new Date(body.scheduled_at); if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < Date.now()) throw new HttpError(400,'Enter a future interview date.');
      const competencies = list(body.competencies,'Competencies',10); if (!competencies.length) throw new HttpError(400,'At least one competency is required.');
      const iid = id(); return transaction(db, () => { db.prepare('INSERT INTO interviews(id,application_id,interviewer_id,scheduled_at,competencies,created_at) VALUES(?,?,?,?,?,?)').run(iid,app.id,interviewer.id,scheduled.toISOString(),JSON.stringify(competencies),now()); audit(db,user.id,'interview.planned',iid); return {...get(db,'interviews',iid),calendar_status:'Not synced; provider adapter required'}; });
    }
    if (method === 'PUT' && key && !action) {
      const interview = get(db, 'interviews', key);
      const {app, req} = appContext(db, user, interview.application_id, true);
      if (!can(user, 'recruit') && !can(user, 'admin') && interview.interviewer_id !== user.id) {
        throw new HttpError(403, 'Your role cannot perform this action.');
      }
      if (interview.status === 'completed') {
        throw new HttpError(409, 'Completed interviews cannot be edited.');
      }
      if (['Hired', 'Rejected'].includes(app.stage)) {
        throw new HttpError(409, 'Cannot edit an interview for a closed application.');
      }
      let interviewerId = interview.interviewer_id;
      if (body.interviewer_id && body.interviewer_id !== interview.interviewer_id) {
        permit(user, 'recruit', 'admin');
        const interviewer = get(db, 'users', body.interviewer_id);
        if (interviewer.status !== 'active' || !['Interviewer','Hiring Manager','Recruiter','TA Manager','TA Director','System Admin'].includes(interviewer.role) || !inTeam(interviewer, req.team)) {
          throw new HttpError(400, 'Choose an active interviewer who can access this team.');
        }
        interviewerId = interviewer.id;
      }
      const scheduled = new Date(body.scheduled_at);
      if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < Date.now()) {
        throw new HttpError(400, 'Enter a future interview date.');
      }
      let competencies = JSON.parse(interview.competencies);
      if (body.competencies !== undefined) {
        permit(user, 'recruit', 'admin');
        competencies = list(body.competencies, 'Competencies', 10);
        if (!competencies.length) throw new HttpError(400, 'At least one competency is required.');
      }
      return transaction(db, () => {
        db.prepare('UPDATE interviews SET scheduled_at=?, interviewer_id=?, competencies=? WHERE id=?').run(scheduled.toISOString(), interviewerId, JSON.stringify(competencies), key);
        audit(db, user.id, 'interview.updated', key, { scheduled_at: scheduled.toISOString(), interviewer_id: interviewerId });
        return { ...get(db, 'interviews', key), calendar_status: 'Not synced; provider adapter required' };
      });
    }
    if (key && action === 'scorecards') {
      const interview = get(db,'interviews',key); appContext(db,user,interview.application_id,true);
      if (method === 'POST') {
        const isAdmin = can(user, 'admin');
        const isAssigned = interview.interviewer_id === user.id;
        if (!isAssigned && !isAdmin) {
          throw new HttpError(403,'Only the assigned interviewer can submit this scorecard.');
        }
        let isProxy = false;
        let proxyReason = null;
        if (!isAssigned && isAdmin) {
          isProxy = true;
          proxyReason = text(body.proxy_reason || body.reason || '', 'Proxy submission reason', 2000, false);
          if (!proxyReason || !proxyReason.trim()) {
            throw new HttpError(400, 'A meaningful reason is required for proxy scorecard submission.');
          }
        }
        const comps = JSON.parse(interview.competencies);
        if (!body.ratings || typeof body.ratings !== 'object' || Array.isArray(body.ratings) || Object.keys(body.ratings).length !== comps.length) throw new HttpError(400,'Rate every planned competency.');
        for (const comp of comps) integer(body.ratings[comp],comp,1,5);
        if (!['Strong yes','Yes','No','Strong no'].includes(body.recommendation)) throw new HttpError(400,'Choose a recommendation.');
        const notes = text(body.notes,'Evidence notes',10000), sid = id();
        const proxyFor = isProxy ? interview.interviewer_id : null;
        return transaction(db, () => {
          db.prepare('INSERT INTO scorecards(id,interview_id,author,ratings,recommendation,notes,submitted_at,proxy_for,proxy_reason) VALUES(?,?,?,?,?,?,?,?,?)').run(
            sid,key,user.id,JSON.stringify(body.ratings),body.recommendation,notes,now(),proxyFor,proxyReason
          );
          db.prepare("UPDATE interviews SET status='completed' WHERE id=?").run(key);
          const auditDetail = {
            interview_id: key,
            application_id: interview.application_id,
            recommendation: body.recommendation
          };
          if (isProxy) {
            auditDetail.proxy_for = interview.interviewer_id;
            auditDetail.proxy_reason = proxyReason;
            auditDetail.submitting_admin = user.id;
          }
          audit(db,user.id,isProxy ? 'admin.scorecard_proxy_submitted' : 'scorecard.submitted',sid,auditDetail);
          return {id:sid, proxy_for: proxyFor};
        });
      }
      if (method === 'GET') {
        const isAdmin = can(user, 'admin');
        // Non-admin assigned reviewers remain blinded until all their feedback for this application is submitted.
        const assigned = db.prepare('SELECT i.id,s.id submitted FROM interviews i LEFT JOIN scorecards s ON s.interview_id=i.id WHERE i.application_id=? AND i.interviewer_id=?').all(interview.application_id,user.id);
        const blinded = !isAdmin && assigned.some(i => !i.submitted);
        const rows = db.prepare(`SELECT s.*, u.name author_name, pi.name proxy_for_name 
          FROM scorecards s 
          JOIN interviews i ON i.id=s.interview_id 
          LEFT JOIN users u ON u.id=s.author 
          LEFT JOIN users pi ON pi.id=s.proxy_for 
          WHERE i.application_id=?`).all(interview.application_id);
        return {blinded,scorecards: rows.filter(s => blinded ? s.author === user.id : true)};
      }
    }
  }
  if (path === 'interviewers' && method === 'GET') {
    permit(user,'recruit','admin'); return db.prepare("SELECT * FROM users WHERE status='active'").all().filter(u => inTeam(user,u.team) && ['Interviewer','Hiring Manager','Recruiter','TA Manager','TA Director','System Admin'].includes(u.role)).map(u=>({id:u.id,name:u.name,team:u.team}));
  }
  if (path === 'referrals') {
    permit(user,'refer');
    if (method === 'GET') {
      const all = db.prepare(`SELECT r.*, u.name referrer_name, u.email referrer_email 
        FROM referrals r 
        LEFT JOIN users u ON u.id=r.created_by 
        ORDER BY r.at DESC`).all();
      return can(user, 'admin') ? all : all.filter(r => r.created_by === user.id);
    }
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
    permit(user,'admin','recruit'); return ['Microsoft calendar / Teams','Candidate email','Offer e-signature','AI matching','PDF / DOCX resume parsing','Fraud signal review','Agency portal','Preboarding / HRMS'].map(name=>({name,status:'Not configured',phase:name.includes('Agency')?'4':'3',externalWrites:false}));
  }
  throw new HttpError(404,'Endpoint not found.');
}
