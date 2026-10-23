import { audit, id, now, transaction } from './db.js';
import { HttpError, roles, teams, requirePermission as permit, requireTeam, inTeam, can, text, email, phone as validatePhone, currency as validateCurrency, list, validateSkills, integer, isAgencyRole } from './policy.js';
import { getAppearance, setAppearance } from './appearance.js';
import { isDemoUser } from './demo.js';
import { ResumeAdapter, CommunicationAdapter, CalendarAdapter, MatchingAdapter, FraudAdapter } from './adapters.js';
import { isEmailConfigured, listCandidateCommunications, setCandidateConsent, getCandidateConsent, sendCandidateCommunication } from './communication/service.js';
import { getAvailableTemplates } from './communication/templates.js';
import { isCalendarConfigured, syncScheduleMeeting, syncRescheduleMeeting, syncCancelMeeting } from './calendar/service.js';
import { evaluateCandidateMatch } from './matching/engine.js';
import { isAiMatchingConfigured, matchWithAi } from './matching/ai.js';
import { getOrRunFraudReview, resolveFraudReview } from './fraud/service.js';
import { draftJobDescription } from './ai/draft.js';
import { getAvailableAiProviders } from './ai/provider.js';
import { createSignatureRequest, getSignatureRequest, listSignatureRequests, cancelSignatureRequest, downloadSignatureDocument, resendSignatureInvitation } from './signature/service.js';
import {
  listAgencies, getAgency, createAgency, updateAgency, setAgencyStatus, addAgencyMember,
  assignRequisitionToAgency, revokeRequisitionFromAgency, publishAgencyFeedback,
  getAgencyDashboard, listAssignedRequisitions, getAssignedRequisition, submitAgencyCandidate,
  listAgencySubmissions, getAgencySubmission, listAgencyMembers, addAgencyRecruiter,
  updateAgencyRecruiterStatus, getAgencyContextForUser
} from './agency/service.js';
import {
  listIntegrationsForAdmin,
  getIntegrationForAdmin,
  updateIntegrationForAdmin,
  testIntegrationForAdmin,
  toggleIntegrationForAdmin
} from './integrations/service.js';
import { getEffectiveIntegrationConfig } from './integrations/storage.js';
import { extractResumeDetails } from './resume/extractor.js';

function getDbSkills(db) {
  if (!db) return [];
  try {
    const skills = new Set();
    const rows = db.prepare('SELECT skills FROM requisitions WHERE deleted_at IS NULL').all();
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.skills || '[]');
        if (Array.isArray(parsed)) {
          for (const s of parsed) {
            if (typeof s === 'string' && s.trim()) skills.add(s.trim());
          }
        }
      } catch {}
    }
    const candRows = db.prepare('SELECT skills FROM candidates WHERE deleted_at IS NULL').all();
    for (const c of candRows) {
      try {
        const parsed = JSON.parse(c.skills || '[]');
        if (Array.isArray(parsed)) {
          for (const s of parsed) {
            if (typeof s === 'string' && s.trim()) skills.add(s.trim());
          }
        }
      } catch {}
    }
    return [...skills];
  } catch {
    return [];
  }
}


const get = (db, table, key) => {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key);
  if (!row) throw new HttpError(404, 'Record not found.');
  return row;
};
const publicUser = u => ({ id:u.id, name:u.name, email:u.email, role:u.role, team:u.team, status:u.status, oid:u.oid, tenant:u.tenant, created_at:u.created_at, last_login:u.last_login });
export const pipeline = db => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='pipeline'").get().value);
export function matchSkills(candidate, requisition) {
  return evaluateCandidateMatch(candidate, requisition);
}
const referralQuery = `SELECT r.*, u.name referrer_name, u.email referrer_email, u.team referrer_team,
    q.title requisition_title, q.team requisition_team, q.status requisition_status
  FROM referrals r
  LEFT JOIN users u ON u.id=r.created_by
  LEFT JOIN requisitions q ON q.id=r.requisition_id`;
function referralRow(db, rid) {
  const row = db.prepare(`${referralQuery} WHERE r.id=?`).get(rid);
  if (!row || row.deleted_at) throw new HttpError(404, 'Referral not found.');
  return row;
}
function referralTeam(row) { return row.requisition_team || row.referrer_team || ''; }
function referralApplication(db, row) {
  if (row.application_id) {
    const app = db.prepare('SELECT id,candidate_id,requisition_id,stage FROM applications WHERE id=?').get(row.application_id);
    if (app) return app;
  }
  if (row.candidate_id && row.requisition_id) {
    return db.prepare('SELECT id,candidate_id,requisition_id,stage FROM applications WHERE candidate_id=? AND requisition_id=?').get(row.candidate_id, row.requisition_id) || null;
  }
  return null;
}
function referralStatus(db, row) {
  if (row.status === 'Withdrawn' || row.withdrawn_at) return 'Withdrawn';
  const app = referralApplication(db, row);
  return app ? app.stage : 'Submitted';
}
function referralAccess(user, row) {
  if (['System Admin', 'TA Director'].includes(user.role)) return true;
  if (['Recruiter', 'TA Manager', 'Hiring Manager'].includes(user.role)) {
    return row.created_by === user.id || inTeam(user, referralTeam(row));
  }
  return row.created_by === user.id;
}
function withdrawalCheck(db, row, user) {
  if (row.status === 'Withdrawn' || row.withdrawn_at) return { ok:false, status:409, message:'This referral has already been withdrawn.' };
  if (row.created_by !== user.id && !can(user, 'admin')) return { ok:false, status:403, message:'Only the employee who made this referral can withdraw it.' };
  const app = referralApplication(db, row);
  if (app && !['Applied', 'Screening'].includes(app.stage)) {
    return { ok:false, status:409, message:`This referral can no longer be withdrawn because the linked application has reached the ${app.stage} stage. Contact the recruiting team if the referral must be removed from consideration.` };
  }
  return { ok:true };
}
function referralView(db, user, row) {
  const app = referralApplication(db, row), status = referralStatus(db, row), applicationStage = app?.stage || null;
  const isOwner = row.created_by === user.id, isWithdrawn = status === 'Withdrawn';
  const employeeLike = ['Employee/Referral', 'Interviewer'].includes(user.role);
  const teamAccess = inTeam(user, referralTeam(row));
  const canViewRequisition = Boolean(row.requisition_team && inTeam(user, row.requisition_team) && (!employeeLike || row.requisition_status === 'open'));
  const ownerEligible = isOwner && !isWithdrawn && (!applicationStage || ['Applied', 'Screening'].includes(applicationStage));
  const recruiterEdit = can(user, 'recruit') && teamAccess && !isWithdrawn && !['Hired', 'Rejected'].includes(status);
  const adminEdit = can(user, 'admin') && !isWithdrawn;
  const managerEdit = user.role === 'Hiring Manager' && isOwner && teamAccess && !isWithdrawn && !['Hired', 'Rejected'].includes(status);
  const canProcess = can(user, 'recruit') && teamAccess && row.requisition_status === 'open' && !isWithdrawn && !app;
  const authorizedForDelete = can(user, 'admin') || (can(user, 'recruit') && teamAccess) || isOwner;
  const hasDependency = Boolean(row.application_id || row.candidate_id || app);
  const denial = withdrawalCheck(db, row, user);
  return {
    ...row,
    requisition_title: teamAccess ? row.requisition_title : null,
    requisition_team: teamAccess ? row.requisition_team : null,
    requisition_restricted: Boolean(row.requisition_id && !teamAccess),
    requisition_application_stage: applicationStage,
    application_id: app?.id || row.application_id || null,
    candidate_id: row.candidate_id || app?.candidate_id || null,
    status,
    referrer_name: row.referrer_name || null,
    referrer_email: row.referrer_email || null,
    can_view_requisition: canViewRequisition,
    can_edit: adminEdit || recruiterEdit || ownerEligible || managerEdit,
    can_process: canProcess,
    can_withdraw: denial.ok,
    withdraw_block_reason: denial.ok ? '' : denial.message,
    can_delete: authorizedForDelete && !hasDependency && !isWithdrawn
  };
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
  if (method === 'GET' && path === 'me') {
    const agencyMember = db.prepare(`
      SELECT m.id, m.agency_id, m.role as agency_role, m.status as member_status,
             a.name as agency_name, a.code as agency_code, a.status as agency_status
      FROM agency_members m
      JOIN agencies a ON a.id = m.agency_id
      WHERE m.user_id = ?
    `).get(user.id);
    return {
      user: {
        ...publicUser(user),
        isDemoUser: isDemoUser(user),
        isAgency: Boolean(agencyMember || isAgencyRole(user.role))
      },
      agency: agencyMember ? {
        id: agencyMember.agency_id,
        name: agencyMember.agency_name,
        code: agencyMember.agency_code,
        role: agencyMember.agency_role,
        status: agencyMember.agency_status
      } : null,
      csrf: user.csrf,
      roles,
      teams,
      demoLogin: Boolean(c?.demoLogin),
      isDemoUser: isDemoUser(user),
      permissions: ['admin','recruit','requisition','approve_manager','approve_finance','review','analytics','refer','jobs','interview'].filter(p => can(user,p))
    };
  }
  if (parts[0] === 'admin') {
    permit(user,'admin');
    if (key === 'integrations') {
      if (!action && method === 'GET') {
        return listIntegrationsForAdmin(db, user);
      }
      if (action && !parts[3]) {
        if (method === 'GET') return getIntegrationForAdmin(db, user, action);
        if (method === 'PUT') return updateIntegrationForAdmin(db, user, action, body);
      }
      if (action && parts[3] === 'test' && method === 'POST') {
        return testIntegrationForAdmin(db, user, action, body, c?.transport || fetch);
      }
      if (action && parts[3] === 'toggle' && method === 'POST') {
        return toggleIntegrationForAdmin(db, user, action, body);
      }
      throw new HttpError(404, 'Unknown integrations admin endpoint.');
    }
    if (method === 'GET' && key === 'users') return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(publicUser);
    if (method === 'GET' && key === 'audit') {
      const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200));
      return db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(Number(query.get('before')) || Number.MAX_SAFE_INTEGER,limit);
    }
    if (method === 'POST' && key === 'users' && !action) {
      const address = email(body.email), name = text(body.name,'Name',200), team = text(body.team ?? '','Team',100,true);
      if (!roles.includes(body.role) || isAgencyRole(body.role)) throw new HttpError(400,'Select a supported role. Agency access is not enabled.');
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
        if (!roles.includes(body.role) || isAgencyRole(body.role)) throw new HttpError(400,'Select a supported role.');
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
        if (r.deleted_at || !inTeam(user, r.team) || (['Employee/Referral', 'Interviewer'].includes(user.role) && r.status !== 'open')) {
          throw new HttpError(404, 'Requisition not found.');
        }
        const output = { ...r, skills: JSON.parse(r.skills) };
        if (['Employee/Referral', 'Interviewer'].includes(user.role)) { delete output.salary_min; delete output.salary_max; }
        return output;
      }
      return db.prepare('SELECT * FROM requisitions WHERE deleted_at IS NULL ORDER BY created_at DESC').all().filter(r => inTeam(user,r.team) && (!['Employee/Referral','Interviewer'].includes(user.role) || r.status === 'open')).map(r => {
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
        db.prepare('INSERT INTO requisitions(id,title,team,headcount,salary_min,salary_max,currency,description,skills,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,title,team,headcount,min,max,currency,description,JSON.stringify(skills),'draft',user.id,now());
        audit(db,user.id,'requisition.created',rid); return get(db,'requisitions',rid);
      });
    }
    if ((method === 'PUT' || (method === 'POST' && !action)) && key) {
      permit(user,'recruit','requisition');
      const req = get(db,'requisitions',key);
      if (req.deleted_at) throw new HttpError(404, 'Requisition not found.');
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
    if (method === 'DELETE' && key && !action) {
      permit(user,'recruit','requisition');
      const req = get(db,'requisitions',key);
      if (req.deleted_at) throw new HttpError(404, 'Requisition not found.');
      requireTeam(user,req.team);
      const applications = db.prepare('SELECT count(*) n FROM applications WHERE requisition_id=?').get(key).n;
      const referrals = db.prepare('SELECT count(*) n FROM referrals WHERE requisition_id=? AND deleted_at IS NULL').get(key).n;
      const approvals = db.prepare('SELECT count(*) n FROM approvals WHERE requisition_id=?').get(key).n;
      if (applications || referrals || approvals) {
        const dependencies = [
          applications ? `${applications} application(s)` : '',
          referrals ? `${referrals} referral(s)` : '',
          approvals ? `${approvals} approval record(s)` : ''
        ].filter(Boolean).join(', ');
        throw new HttpError(409, `This requisition cannot be deleted because it has linked ${dependencies}. Close or retain the requisition instead.`);
      }
      return transaction(db, () => {
        const deletedAt = now();
        db.prepare('UPDATE requisitions SET deleted_at=?, deleted_by=?, updated_at=? WHERE id=?').run(deletedAt, user.id, deletedAt, key);
        audit(db,user.id,'requisition.deleted',key,{title:req.title,team:req.team,status:req.status,soft_delete:true});
        return { ok:true, id:key, deleted_at:deletedAt };
      });
    }
    if (method === 'POST' && key && action) {
      const req = get(db,'requisitions',key);
      if (req.deleted_at) throw new HttpError(404, 'Requisition not found.');
      requireTeam(user,req.team);
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
    if (key && action === 'communications') {
      if (method === 'GET') {
        return listCandidateCommunications(db, user, key);
      }
      if (method === 'POST') {
        return (async () => {
          const commAdapter = c?.communicationAdapter || new CommunicationAdapter({ db, fromEnv: true, transport: c?.transport });
          return await sendCandidateCommunication(db, user, { ...body, candidate_id: key }, commAdapter);
        })();
      }
    }
    if (key && action === 'consent') {
      if (method === 'GET') {
        permit(user, 'recruit', 'review');
        return getCandidateConsent(db, key);
      }
      if (method === 'POST' || method === 'PUT') {
        return setCandidateConsent(db, user, key, body.opted_out, body.reason);
      }
    }
    if (key && action === 'signatures') {
      if (method === 'GET') {
        permit(user, 'recruit', 'review', 'admin');
        const cand = get(db, 'candidates', key);
        requireTeam(user, cand.team);
        return listSignatureRequests(db, user, { candidateId: key });
      }
    }
    if (key && (action === 'fraud-review' || action === 'fraud')) {
      const cand = get(db, 'candidates', key);
      requireTeam(user, cand.team);
      if (method === 'GET') {
        permit(user, 'recruit', 'review');
        return getOrRunFraudReview(db, cand.id, { refresh: query.get('refresh') === 'true' });
      }
      if (method === 'POST') {
        permit(user, 'recruit', 'admin');
        if (parts[3] === 'resolve' || body.action === 'resolve' || body.status) {
          return resolveFraudReview(db, user, cand.id, body);
        }
        return getOrRunFraudReview(db, cand.id, { refresh: true });
      }
    }
    if (key && action === 'templates') {
      if (method === 'GET') {
        permit(user, 'recruit');
        const cand = get(db, 'candidates', key);
        requireTeam(user, cand.team);
        const apps = db.prepare('SELECT a.id, a.requisition_id, a.stage, r.title, r.team FROM applications a JOIN requisitions r ON r.id=a.requisition_id WHERE a.candidate_id=?').all(key);
        const interviews = db.prepare('SELECT i.id, i.scheduled_at, u.name interviewer FROM interviews i JOIN applications a ON a.id=i.application_id JOIN users u ON u.id=i.interviewer_id WHERE a.candidate_id=? ORDER BY i.scheduled_at DESC').all(key);
        return {
          templates: getAvailableTemplates(),
          candidate: {
            id: cand.id,
            name: cand.name,
            email: cand.email,
            team: cand.team
          },
          applications: apps,
          interviews
        };
      }
    }
    if (method === 'GET') {
      if (key) {
        const c = get(db, 'candidates', key);
        if (c.deleted_at) throw new HttpError(404, 'Candidate not found.');
        requireTeam(user, c.team);
        const apps = db.prepare('SELECT a.id, a.candidate_id, a.requisition_id, a.stage, a.created_at, r.title, r.team FROM applications a JOIN requisitions r ON r.id=a.requisition_id WHERE a.candidate_id=? ORDER BY a.created_at ASC').all(key).filter(a => inTeam(user, a.team)).map(a => ({
          id: a.id,
          requisition_id: a.requisition_id,
          title: a.title,
          stage: a.stage,
          team: a.team,
          created_at: a.created_at
        }));
        const resumeMeta = db.prepare('SELECT id, filename, file_format, file_size, scan_status, extraction_status, created_at FROM candidate_resumes WHERE candidate_id=? ORDER BY created_at DESC LIMIT 1').get(key);
        const totalApps = db.prepare('SELECT count(*) n FROM applications WHERE candidate_id=?').get(key).n;
        const totalInterviews = db.prepare('SELECT count(*) n FROM interviews i JOIN applications a ON a.id=i.application_id WHERE a.candidate_id=?').get(key).n;
        const canDelete = totalApps === 0 && totalInterviews === 0;
        return { ...c, skills: JSON.parse(c.skills), experience: c.resume_text, applications: apps, resume: resumeMeta || null, can_delete: canDelete };
      }
      const search = (query.get('q') || '').toLowerCase();
      const cands = db.prepare('SELECT * FROM candidates WHERE deleted_at IS NULL ORDER BY created_at DESC').all().filter(c => inTeam(user,c.team));
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
        .map(c => {
          const cApps = appsByCandidate.get(c.id) || [];
          return {
            ...c,
            skills: JSON.parse(c.skills),
            experience: c.resume_text,
            applications: cApps,
            can_delete: cApps.length === 0
          };
        });
    }
    if (method === 'POST' && !key) {
      permit(user,'recruit'); const team = text(body.team,'Team',100); requireTeam(user,team);
      const address = email(body.email), name = text(body.name,'Name',200), phone = validatePhone(body.phone ?? '', true);
      const resumeVal = body.resume_text !== undefined ? body.resume_text : body.experience !== undefined ? body.experience : '';
      const resume = text(resumeVal, 'Resume text', 50000, true);
      const skills = validateSkills(body.skills), source = text(body.source || 'Direct','Source',100), cid = id();
      const resumeId = body.resume_id ? String(body.resume_id) : null;
      if (db.prepare('SELECT id FROM candidates WHERE email=?').get(address)) throw new HttpError(409,'A candidate with this email already exists. Ask TA operations to resolve the duplicate.');
      return transaction(db, () => {
        db.prepare('INSERT INTO candidates(id,name,email,phone,skills,resume_text,source,team,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(cid,name,address,phone,JSON.stringify(skills),resume,source,team,user.id,now());
        if (resumeId) {
          const resRow = db.prepare('SELECT * FROM candidate_resumes WHERE id=?').get(resumeId);
          if (resRow) {
            db.prepare('UPDATE candidate_resumes SET candidate_id=?, updated_at=? WHERE id=?').run(cid, now(), resumeId);
            audit(db, user.id, 'candidate.resume_attached', cid, { resume_id: resumeId, filename: resRow.filename, format: resRow.file_format });
          }
        }
        audit(db,user.id,'candidate.created',cid);
        let createdApps = [];
        if (body.requisition_id) {
          const req = get(db, 'requisitions', body.requisition_id);
          requireTeam(user, req.team);
          const isAdmin = can(user, 'admin');
          if (!isAdmin && team !== req.team) throw new HttpError(409, 'Candidate and requisition must belong to the same team.');
          if (req.status !== 'open') throw new HttpError(409, 'Requisition must be approved and open.');
          const aid = id();
          const firstStage = 'Applied';
          db.prepare('INSERT INTO applications VALUES(?,?,?,?,?)').run(aid, cid, req.id, firstStage, now());
          const auditDetail = { candidate_id: cid, requisition_id: req.id, stage: firstStage };
          if (team !== req.team) {
            auditDetail.cross_team_override = true;
            auditDetail.candidate_team = team;
            auditDetail.requisition_team = req.team;
          }
          audit(db, user.id, 'application.created', aid, auditDetail);
          createdApps.push({ id: aid, candidate_id: cid, requisition_id: req.id, stage: firstStage, title: req.title, team: req.team, created_at: now() });
        }
        const created = get(db,'candidates',cid);
        const resumeMeta = db.prepare('SELECT id, filename, file_format, file_size, scan_status, extraction_status, created_at FROM candidate_resumes WHERE candidate_id=? ORDER BY created_at DESC LIMIT 1').get(cid);
        return {...created,skills:JSON.parse(created.skills),experience:created.resume_text,applications:createdApps,resume:resumeMeta||null};
      });
    }
    if ((method === 'PUT' || method === 'POST') && key && !action) {
      permit(user,'recruit');
      const candidate = get(db,'candidates',key);
      if (candidate.deleted_at) throw new HttpError(404, 'Candidate not found.');
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
      const resumeId = body.resume_id ? String(body.resume_id) : null;
      return transaction(db, () => {
        db.prepare('UPDATE candidates SET name=?,email=?,phone=?,skills=?,resume_text=?,source=?,team=? WHERE id=?').run(name,address,phone,JSON.stringify(skills),resume,source,team,key);
        if (resumeId) {
          const resRow = db.prepare('SELECT * FROM candidate_resumes WHERE id=?').get(resumeId);
          if (resRow && resRow.candidate_id !== key) {
            const prev = db.prepare('SELECT id, filename FROM candidate_resumes WHERE candidate_id=? ORDER BY created_at DESC LIMIT 1').get(key);
            db.prepare('UPDATE candidate_resumes SET candidate_id=?, updated_at=? WHERE id=?').run(key, now(), resumeId);
            audit(db, user.id, 'candidate.resume_updated', key, { new_resume_id: resumeId, previous_resume_id: prev?.id || null, filename: resRow.filename });
          }
        }
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
        const resumeMeta = db.prepare('SELECT id, filename, file_format, file_size, scan_status, extraction_status, created_at FROM candidate_resumes WHERE candidate_id=? ORDER BY created_at DESC LIMIT 1').get(key);
        return {...updated,skills:JSON.parse(updated.skills),experience:updated.resume_text,applications:apps,resume:resumeMeta||null};
      });
    }
    if (method === 'DELETE' && key && !action) {
      permit(user,'recruit');
      const candidate = get(db,'candidates',key);
      if (candidate.deleted_at) throw new HttpError(404, 'Candidate not found.');
      requireTeam(user,candidate.team);
      const applications = db.prepare('SELECT count(*) n FROM applications WHERE candidate_id=?').get(key).n;
      const interviews = db.prepare('SELECT count(*) n FROM interviews i JOIN applications a ON a.id=i.application_id WHERE a.candidate_id=?').get(key).n;
      if (applications || interviews) {
        const dependencies = [applications ? `${applications} application(s)` : '', interviews ? `${interviews} interview(s)` : ''].filter(Boolean).join(', ');
        throw new HttpError(409, `This candidate cannot be deleted because it has linked ${dependencies}. Retain the record to preserve application and interview history.`);
      }
      return transaction(db, () => {
        const deletedAt = now();
        db.prepare('UPDATE candidates SET deleted_at=?, deleted_by=?, updated_at=? WHERE id=?').run(deletedAt, user.id, deletedAt, key);
        audit(db,user.id,'candidate.deleted',key,{name:candidate.name,email:candidate.email,team:candidate.team,soft_delete:true});
        return { ok:true, id:key, deleted_at:deletedAt };
      });
    }
  }
  if (path === 'resume/upload' && method === 'POST') {
    permit(user, 'recruit');
    if (!body.buffer || !Buffer.isBuffer(body.buffer)) {
      throw new HttpError(400, 'Uploaded file content is missing or invalid.');
    }
    const adapter = c?.resumeAdapter || new ResumeAdapter({
      enabled: true,
      maxSizeBytes: c?.maxResumeSizeBytes,
      antivirusRequired: c?.antivirusRequired,
      antivirusProvider: c?.antivirusProvider
    });

    return (async () => {
      try {
        const result = await adapter.processUpload({
          buffer: body.buffer,
          filename: body.filename || 'resume',
          mimeType: body.mimeType || ''
        });

        const details = extractResumeDetails(result.text, getDbSkills(db));
        const email = details.email;
        const phone = details.phone;
        const name = details.name;
        const skills = details.skills;
        const resumeId = id();
        const nowStr = now();

        db.prepare(`
          INSERT INTO candidate_resumes(id, candidate_id, storage_id, filename, file_format, file_size, mime_type, scan_status, extraction_status, error_message, uploaded_by, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          resumeId,
          null,
          result.storageId,
          result.filename,
          result.format,
          result.size,
          body.mimeType || (result.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
          result.scanStatus,
          result.text ? 'success' : (result.ocrRequired ? 'ocr_required' : 'empty'),
          result.warnings.join('; ') || null,
          user.id,
          nowStr,
          nowStr
        );

        audit(db, user.id, 'resume.uploaded', resumeId, {
          filename: result.filename,
          format: result.format,
          size: result.size,
          scan_status: result.scanStatus,
          extraction_status: result.text ? 'success' : (result.ocrRequired ? 'ocr_required' : 'empty')
        });

        return {
          resume_id: resumeId,
          text: result.text,
          email,
          phone,
          name,
          skills,
          filename: result.filename,
          format: result.format,
          size: result.size,
          scan_status: result.scanStatus,
          ocr_required: result.ocrRequired,
          warnings: result.warnings
        };
      } catch (err) {
        audit(db, user.id, 'resume.upload_rejected', '', {
          filename: body.filename || 'unknown',
          reason: err.message
        });
        throw err;
      }
    })();
  }
  if (path === 'resume/parse' && method === 'POST') {
    permit(user,'recruit'); const resume = text(body.text,'Resume text',50000);
    const details = extractResumeDetails(resume, getDbSkills(db));
    const hasContact = Boolean(details.email || details.phone);
    const hasAny = Boolean(hasContact || details.name || (details.skills && details.skills.length));
    const message = hasContact
      ? 'Email and phone number extracted successfully.'
      : hasAny
        ? 'Resume details extracted successfully.'
        : 'No email or phone number found in resume text.';
    return {
      email: details.email,
      phone: details.phone,
      name: details.name,
      skills: details.skills,
      message,
      warning: message
    };
  }
  if (path === 'jd/draft' && method === 'POST') {
    permit(user,'recruit','requisition');
    const title = text(body.title,'Title',200), skills = validateSkills(body.skills);
    if (!skills.length) throw new HttpError(400, 'Add at least one required skill before drafting a job description.');
    if (isAiMatchingConfigured(c) || body.provider) {
      return (async () => {
        return draftJobDescription({
          title,
          skills,
          team: body.team || user.team,
          context: body.context || '',
          provider: body.provider,
          model: body.model,
          config: c
        });
      })();
    }
    return {
      method: 'Draft generated from the job title and required skills.',
      message: 'Job description drafted. Please review before saving.',
      draft: `${title}\n\nRole overview\nWe are looking for a ${title} to join our team and deliver measurable outcomes in a collaborative, inclusive environment. The successful candidate will combine practical expertise with clear communication and a commitment to quality.\n\nKey responsibilities\n• Apply strong ${skills.slice(0, 3).join(', ')} expertise to day-to-day delivery.\n• Collaborate with partners across the team to plan, prioritise and complete work.\n• Communicate progress, risks and decisions clearly to stakeholders.\n• Contribute to a culture of learning, inclusion and continuous improvement.\n\nRequired skills and experience\n${skills.map(skill => `• ${skill}`).join('\n')}\n\nWhat success looks like\n• Work is delivered to agreed quality, time and service expectations.\n• Stakeholders have the information they need to make decisions.\n• The role contributes to a safe, respectful and high-performing team.\n\nInterview process\nStructured, job-related assessment with consistent evaluation criteria.\n\nAccessibility\nContact your recruiter to request an interview accommodation.`
    };
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
    if ((method === 'GET' || method === 'POST') && key && action === 'match') {
      const {app,req} = appContext(db,user,key);
      const cand = get(db,'candidates',app.candidate_id);
      if (isAiMatchingConfigured(c) || body.provider) {
        return (async () => {
          const res = await matchWithAi(cand, req, { config: c, provider: body.provider, model: body.model });
          try {
            db.prepare('INSERT INTO application_matches (id,application_id,score,matched_skills,missing_skills,experience_score,method,explanation,breakdown,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
              id(), app.id, res.score, JSON.stringify(res.matched || []), JSON.stringify(res.missing || []),
              res.breakdown?.experience_score || null, res.method || 'AI', res.explanation || '',
              JSON.stringify(res.breakdown || {}), JSON.stringify(res.evidence || []), now()
            );
          } catch {}
          if (method === 'POST') audit(db, user.id, 'application.match_calculated', app.id, { score: res.score, method: res.method });
          return res;
        })();
      }
      const res = evaluateCandidateMatch(cand, req);
      try {
        db.prepare('INSERT INTO application_matches (id,application_id,score,matched_skills,missing_skills,experience_score,method,explanation,breakdown,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
          id(), app.id, res.score, JSON.stringify(res.matched || []), JSON.stringify(res.missing || []),
          res.breakdown?.experience_score || null, res.method || 'Deterministic', res.explanation || '',
          JSON.stringify(res.breakdown || {}), JSON.stringify(res.evidence || []), now()
        );
      } catch {}
      if (method === 'POST') audit(db, user.id, 'application.match_calculated', app.id, { score: res.score, method: res.method });
      return res;
    }
    if (key && (action === 'fraud-review' || action === 'fraud')) {
      const {app,req} = appContext(db,user,key);
      if (method === 'GET') {
        permit(user, 'recruit', 'review');
        return getOrRunFraudReview(db, app.candidate_id, { application_id: app.id, refresh: query.get('refresh') === 'true' });
      }
      if (method === 'POST') {
        permit(user, 'recruit', 'admin');
        if (parts[3] === 'resolve' || body.action === 'resolve' || body.status) {
          return resolveFraudReview(db, user, app.candidate_id, body);
        }
        return getOrRunFraudReview(db, app.candidate_id, { application_id: app.id, refresh: true });
      }
    }
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

      const updatedApp = transaction(db, () => {
        db.prepare('UPDATE applications SET stage=? WHERE id=?').run(body.stage,key);
        db.prepare("UPDATE referrals SET status=?, updated_at=? WHERE application_id=? AND status!='Withdrawn'").run(body.stage,now(),key);
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

      const emailConfigured = (isEmailConfigured(db) || Boolean(c?.communicationAdapter)) && body.send_notification !== false;
      if (emailConfigured && app.stage !== body.stage) {
        return (async () => {
          try {
            const cand = db.prepare('SELECT id, name, email, team FROM candidates WHERE id = ?').get(app.candidate_id);
            if (cand && cand.email) {
              const commAdapter = c?.communicationAdapter || new CommunicationAdapter({ db, fromEnv: true, transport: c?.transport });
              const templateId = body.stage === 'Rejected' ? 'application_rejection' : 'stage_update';
              const emailVars = {
                candidate_name: cand.name,
                candidate_email: cand.email,
                requisition_title: req?.title || '',
                team: req?.team || cand.team || '',
                stage: body.stage,
                new_stage: body.stage,
                previous_stage: app.stage,
                from_stage: app.stage,
                notes: body.notes || body.comment || ''
              };
              const idempotencyKey = `stage_update_${key}_${body.stage}_${app.stage}`;
              await sendCandidateCommunication(db, user, {
                candidate_id: cand.id,
                requisition_id: req?.id || undefined,
                template_id: templateId,
                recipient_email: cand.email,
                variables: emailVars,
                idempotency_key: idempotencyKey
              }, commAdapter);
              audit(db, user.id, 'application.stage_email_sent', key, {
                stage: body.stage,
                previous_stage: app.stage,
                candidate_id: cand.id,
                recipient: cand.email
              });
            }
          } catch (emailErr) {
            audit(db, user.id, 'application.stage_email_failed', key, {
              stage: body.stage,
              error: emailErr.message
            });
          }
          return updatedApp;
        })();
      }

      return updatedApp;
    }
  }
  if (parts[0] === 'interviews') {
    permit(user,'recruit','review','interview');
    if (method === 'GET' && key === 'calendar-status') {
      const calEffective = getEffectiveIntegrationConfig(db, 'microsoft_calendar');
      const configured = Boolean((calEffective.enabled && calEffective.isConfigured) || isCalendarConfigured(c, db) || c?.calendarAdapter);
      return { configured, status: configured ? 'active' : 'not_configured' };
    }
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
      const duration = body.duration_minutes !== undefined ? integer(body.duration_minutes, 'Duration', 15, 480) : 45;
      const timezone = body.timezone ? text(body.timezone, 'Timezone', 100, false) : 'Asia/Kolkata';
      const notes = body.notes ? text(body.notes, 'Notes', 5000, false) : '';
      const customMeetingUrl = body.meeting_url ? text(body.meeting_url, 'Meeting URL', 1000, false) : null;
      const cand = get(db, 'candidates', app.candidate_id);
      const title = body.title ? text(body.title, 'Title', 200, false) : `Interview: ${cand.name} — ${req.title}`;
      const iid = id();
      transaction(db, () => {
        db.prepare('INSERT INTO interviews(id,application_id,interviewer_id,scheduled_at,competencies,title,duration_minutes,timezone,notes,status,calendar_status,meeting_url,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          iid, app.id, interviewer.id, scheduled.toISOString(), JSON.stringify(competencies), title, duration, timezone, notes, 'planned', customMeetingUrl ? 'manual_link' : 'not_synced', customMeetingUrl, now()
        );
        audit(db, user.id, 'interview.planned', iid, { scheduled_at: scheduled.toISOString(), interviewer_id: interviewer.id, duration_minutes: duration, timezone, meeting_url: customMeetingUrl });
      });
      const calConfigured = isCalendarConfigured(c, db) || Boolean(c?.calendarAdapter);
      const emailConfigured = (isEmailConfigured(db) || Boolean(c?.communicationAdapter)) && body.send_invitation !== false;
      if (calConfigured || emailConfigured) {
        return (async () => {
          let meetingUrl = customMeetingUrl;
          if (calConfigured) {
            const calResult = await syncScheduleMeeting({
              db, user, interviewId: iid, scheduledAt: scheduled.toISOString(), durationMinutes: duration, timezone, title, notes, candidate: cand, req, interviewer, transport: c?.calendarAdapter?.transport || c?.transport || fetch, config: c
            });
            meetingUrl = calResult.meeting_url || customMeetingUrl;
          }
          if (meetingUrl && meetingUrl !== customMeetingUrl) {
            db.prepare('UPDATE interviews SET meeting_url = ? WHERE id = ?').run(meetingUrl, iid);
          }
          if (emailConfigured) {
            try {
              const commAdapter = c?.communicationAdapter || new CommunicationAdapter({ db, fromEnv: true, transport: c?.transport });
              await sendCandidateCommunication(db, user, {
                candidate_id: cand.id,
                requisition_id: req.id,
                template_id: 'interview_invitation',
                scheduled_at: scheduled.toISOString(),
                duration_minutes: duration,
                timezone,
                interviewer_name: interviewer.name,
                meeting_url: meetingUrl || undefined,
                notes: notes || undefined,
                idempotency_key: `interview_invite_${iid}`
              }, commAdapter);
            } catch (emailErr) {
              audit(db, user.id, 'communication.invitation_failed', iid, { error: emailErr.message });
            }
          }
          const row = get(db, 'interviews', iid);
          return { ...row, calendar_status: row.calendar_status || 'Not synced; provider adapter required' };
        })();
      }
      return { ...get(db, 'interviews', iid), calendar_status: 'Not synced; provider adapter required' };
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
      if (interview.status === 'cancelled') {
        throw new HttpError(409, 'Cancelled interviews cannot be edited.');
      }
      if (['Hired', 'Rejected'].includes(app.stage)) {
        throw new HttpError(409, 'Cannot edit an interview for a closed application.');
      }
      let interviewerId = interview.interviewer_id;
      let assignedInterviewer = get(db, 'users', interview.interviewer_id);
      if (body.interviewer_id && body.interviewer_id !== interview.interviewer_id) {
        permit(user, 'recruit', 'admin');
        const interviewer = get(db, 'users', body.interviewer_id);
        if (interviewer.status !== 'active' || !['Interviewer','Hiring Manager','Recruiter','TA Manager','TA Director','System Admin'].includes(interviewer.role) || !inTeam(interviewer, req.team)) {
          throw new HttpError(400, 'Choose an active interviewer who can access this team.');
        }
        interviewerId = interviewer.id;
        assignedInterviewer = interviewer;
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
      const duration = body.duration_minutes !== undefined ? integer(body.duration_minutes, 'Duration', 15, 480) : (interview.duration_minutes || 45);
      const timezone = body.timezone !== undefined ? text(body.timezone, 'Timezone', 100, false) : (interview.timezone || 'Asia/Kolkata');
      const notes = body.notes !== undefined ? text(body.notes, 'Notes', 5000, false) : (interview.notes || '');
      const title = body.title !== undefined ? text(body.title, 'Title', 200, false) : (interview.title || '');
      const cand = get(db, 'candidates', app.candidate_id);
      const customMeetingUrl = body.meeting_url !== undefined ? (body.meeting_url ? text(body.meeting_url, 'Meeting URL', 1000, false) : null) : interview.meeting_url;

      transaction(db, () => {
        db.prepare('UPDATE interviews SET scheduled_at=?, interviewer_id=?, competencies=?, duration_minutes=?, timezone=?, notes=?, title=?, meeting_url=? WHERE id=?').run(
          scheduled.toISOString(), interviewerId, JSON.stringify(competencies), duration, timezone, notes, title, customMeetingUrl, key
        );
        audit(db, user.id, 'interview.updated', key, { scheduled_at: scheduled.toISOString(), interviewer_id: interviewerId, duration_minutes: duration, meeting_url: customMeetingUrl });
      });

      const calConfigured = isCalendarConfigured(c, db) || Boolean(c?.calendarAdapter);
      const emailConfigured = (isEmailConfigured(db) || Boolean(c?.communicationAdapter)) && body.send_notification !== false;
      if (calConfigured || emailConfigured) {
        return (async () => {
          let meetingUrl = customMeetingUrl;
          if (calConfigured) {
            const calResult = await syncRescheduleMeeting({
              db, user, interviewId: key, scheduledAt: scheduled.toISOString(), durationMinutes: duration, timezone, title, notes, candidate: cand, req, interviewer: assignedInterviewer, transport: c?.calendarAdapter?.transport || c?.transport || fetch, config: c
            });
            meetingUrl = calResult.meeting_url || customMeetingUrl;
          }
          if (meetingUrl && meetingUrl !== customMeetingUrl) {
            db.prepare('UPDATE interviews SET meeting_url = ? WHERE id = ?').run(meetingUrl, key);
          }
          if (emailConfigured) {
            try {
              const commAdapter = c?.communicationAdapter || new CommunicationAdapter({ db, fromEnv: true, transport: c?.transport });
              await sendCandidateCommunication(db, user, {
                candidate_id: cand.id,
                requisition_id: req.id,
                template_id: 'interview_update',
                scheduled_at: scheduled.toISOString(),
                duration_minutes: duration,
                timezone,
                interviewer_name: assignedInterviewer.name,
                meeting_url: meetingUrl || undefined,
                notes: notes || undefined,
                idempotency_key: `interview_update_${key}_${scheduled.getTime()}`
              }, commAdapter);
            } catch (emailErr) {
              audit(db, user.id, 'communication.update_failed', key, { error: emailErr.message });
            }
          }
          const row = get(db, 'interviews', key);
          return { ...row, calendar_status: row.calendar_status || 'Not synced; provider adapter required' };
        })();
      }
      return { ...get(db, 'interviews', key), calendar_status: 'Not synced; provider adapter required' };
    }
    if (key && action === 'cancel' && method === 'POST') {
      const interview = get(db, 'interviews', key);
      const {app, req} = appContext(db, user, interview.application_id, true);
      if (!can(user, 'recruit') && !can(user, 'admin') && interview.interviewer_id !== user.id) {
        throw new HttpError(403, 'Your role cannot perform this action.');
      }
      if (interview.status === 'completed') {
        throw new HttpError(409, 'Completed interviews cannot be cancelled.');
      }
      if (interview.status === 'cancelled') {
        throw new HttpError(409, 'Interview is already cancelled.');
      }
      const reason = body.reason ? text(body.reason, 'Cancellation reason', 2000, false) : '';
      const cand = get(db, 'candidates', app.candidate_id);

      transaction(db, () => {
        db.prepare("UPDATE interviews SET status='cancelled', calendar_status='cancelled' WHERE id=?").run(key);
        audit(db, user.id, 'interview.cancelled', key, { reason });
      });

      const calConfigured = isCalendarConfigured(c, db) || Boolean(c?.calendarAdapter);
      const emailConfigured = (isEmailConfigured(db) || Boolean(c?.communicationAdapter)) && body.send_notification !== false;
      if (calConfigured || emailConfigured) {
        return (async () => {
          if (calConfigured) {
            await syncCancelMeeting({
              db, user, interviewId: key, comment: reason || 'Interview cancelled', transport: c?.calendarAdapter?.transport || c?.transport || fetch, config: c
            });
          }
          if (emailConfigured) {
            try {
              const commAdapter = c?.communicationAdapter || new CommunicationAdapter({ db, fromEnv: true, transport: c?.transport });
              await sendCandidateCommunication(db, user, {
                candidate_id: cand.id,
                requisition_id: req.id,
                template_id: 'interview_cancellation',
                scheduled_at: interview.scheduled_at,
                duration_minutes: interview.duration_minutes,
                timezone: interview.timezone,
                notes: reason || undefined,
                idempotency_key: `interview_cancel_${key}`
              }, commAdapter);
            } catch (emailErr) {
              audit(db, user.id, 'communication.cancellation_failed', key, { error: emailErr.message });
            }
          }
          return get(db, 'interviews', key);
        })();
      }
      return get(db, 'interviews', key);
    }
    if (key && action === 'scorecards') {
      const interview = get(db,'interviews',key); appContext(db,user,interview.application_id,true);
      if (method === 'POST') {
        const isAdmin = can(user, 'admin');
        const isAssigned = interview.interviewer_id === user.id;
        if (!isAssigned && !isAdmin) {
          throw new HttpError(403,'Only the assigned interviewer can submit this scorecard.');
        }
        const scheduledTime = Date.parse(interview.scheduled_at);
        if (!Number.isFinite(scheduledTime) || scheduledTime > Date.now()) {
          throw new HttpError(409,'Feedback can be submitted after the scheduled interview time.');
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
  if (parts[0] === 'referrals') {
    permit(user,'refer');
    if (method === 'GET' && !key) {
      return db.prepare(`${referralQuery} ORDER BY r.at DESC`).all()
        .filter(row => !row.deleted_at && referralAccess(user, row))
        .map(row => referralView(db, user, row));
    }
    if (method === 'GET' && key && !action) {
      const row = referralRow(db, key);
      if (!referralAccess(user, row)) throw new HttpError(404, 'Referral not found.');
      return referralView(db, user, row);
    }
    if (method === 'GET' && key && action === 'requisition') {
      // Referral-linked requisition access is read-only and explicitly scoped to
      // the referral the caller is allowed to see.
      const row = referralRow(db, key);
      if (!referralAccess(user, row)) throw new HttpError(404, 'Referral not found.');
      const view = referralView(db, user, row);
      if (!view.can_view_requisition) throw new HttpError(404, 'Requisition not found.');
      const req = get(db, 'requisitions', row.requisition_id);
      if (req.deleted_at) throw new HttpError(404, 'Requisition not found.');
      const output = { ...req, skills: JSON.parse(req.skills), read_only: true };
      if (['Employee/Referral', 'Interviewer'].includes(user.role)) { delete output.salary_min; delete output.salary_max; }
      return output;
    }
    if (method === 'POST' && !key) {
      if (!body.requisition_id) throw new HttpError(400, 'Select a job position for this referral.');
      const req = get(db,'requisitions',body.requisition_id);
      if (req.deleted_at) throw new HttpError(404, 'Requisition not found.');
      requireTeam(user,req.team);
      if (req.status !== 'open') throw new HttpError(409,'Choose an open requisition.');
      const rid = id(), name = text(body.name,'Name',200), address = email(body.email), note = text(body.note ?? '', 'Referral note',2000,true);
      return transaction(db, () => {
        db.prepare('INSERT INTO referrals(id,name,email,requisition_id,note,created_by,at,status) VALUES(?,?,?,?,?,?,?,?)').run(rid,name,address,req.id,note,user.id,now(),'Submitted');
        audit(db,user.id,'referral.created',rid,{requisition_id:req.id,status:'Submitted'});
        return referralView(db,user,referralRow(db,rid));
      });
    }
    if ((method === 'PUT' || (method === 'POST' && !action)) && key) {
      const row = referralRow(db, key);
      if (!referralAccess(user, row)) throw new HttpError(404, 'Referral not found.');
      const view = referralView(db,user,row);
      if (!view.can_edit) throw new HttpError(403, 'You cannot edit this referral at its current stage.');
      const requisitionId = body.requisition_id !== undefined ? body.requisition_id : row.requisition_id;
      if (!requisitionId) throw new HttpError(400, 'Select a job position for this referral.');
      if (row.application_id && requisitionId !== row.requisition_id) {
        throw new HttpError(409, 'The job position cannot be changed after the referral has been linked to an application.');
      }
      const req = get(db,'requisitions',requisitionId);
      if (req.deleted_at) throw new HttpError(404, 'Requisition not found.');
      requireTeam(user,req.team);
      if (req.id !== row.requisition_id && req.status !== 'open') throw new HttpError(409, 'Choose an open requisition.');
      const name = text(body.name ?? row.name,'Name',200);
      const address = email(body.email ?? row.email);
      if (row.candidate_id && address !== row.email) throw new HttpError(409, 'The referral email cannot be changed after a candidate has been linked.');
      const note = text(body.note !== undefined ? body.note : row.note,'Referral note',2000,true);
      return transaction(db, () => {
        db.prepare('UPDATE referrals SET name=?,email=?,requisition_id=?,note=?,updated_at=? WHERE id=?').run(name,address,req.id,note,now(),key);
        audit(db,user.id,'referral.updated',key,{name,email:address,requisition_id:req.id});
        return referralView(db,user,referralRow(db,key));
      });
    }
    if (method === 'POST' && key && action === 'withdraw') {
      const row = referralRow(db, key);
      if (!referralAccess(user, row)) throw new HttpError(404, 'Referral not found.');
      const check = withdrawalCheck(db, row, user);
      if (!check.ok) throw new HttpError(check.status, check.message);
      return transaction(db, () => {
        const app = referralApplication(db, row), at = now();
        db.prepare("UPDATE referrals SET status='Withdrawn', withdrawn_at=?, withdrawn_by=?, updated_at=? WHERE id=?").run(at,user.id,at,key);
        audit(db,user.id,'referral.withdrawn',key,{referrer_id:row.created_by,candidate_id:row.candidate_id||null,application_id:app?.id||null,application_stage:app?.stage||null});
        return referralView(db,user,referralRow(db,key));
      });
    }
    if (method === 'POST' && key && action === 'process') {
      permit(user,'recruit');
      const row = referralRow(db, key);
      if (!referralAccess(user, row)) throw new HttpError(404, 'Referral not found.');
      const view = referralView(db,user,row);
      if (view.application_id && view.status !== 'Withdrawn') return {...view, candidate_created:false, application_created:false, already_processed:true};
      if (!view.can_process) throw new HttpError(409, view.status === 'Withdrawn' ? 'Withdrawn referrals cannot be processed.' : 'This referral cannot be processed. It may already be linked, outside your team, or the requisition is not open.');
      const req = get(db,'requisitions', row.requisition_id);
      return transaction(db, () => {
        const referral = referralRow(db,key);
        let candidate = db.prepare('SELECT * FROM candidates WHERE email=?').get(referral.email);
        if (candidate?.deleted_at) throw new HttpError(409,'A deleted candidate already uses this email. Ask TA operations to restore or resolve the record.');
        if (candidate && !can(user,'admin') && candidate.team !== req.team) throw new HttpError(409,'The matching candidate belongs to another team. Ask a System Admin to process this cross-team referral.');
        let candidateCreated = false;
        if (!candidate) {
          const cid = id();
          db.prepare('INSERT INTO candidates(id,name,email,phone,skills,resume_text,source,team,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(cid,referral.name,referral.email,'',JSON.stringify([]),'', 'Employee referral',req.team,user.id,now());
          candidate = get(db,'candidates',cid);
          candidateCreated = true;
          audit(db,user.id,'candidate.created',cid,{source:'referral',referral_id:key});
        }
        let application = db.prepare('SELECT * FROM applications WHERE candidate_id=? AND requisition_id=?').get(candidate.id,req.id);
        let applicationCreated = false;
        if (!application) {
          const aid = id();
          db.prepare('INSERT INTO applications VALUES(?,?,?,?,?)').run(aid,candidate.id,req.id,'Applied',now());
          application = get(db,'applications',aid);
          applicationCreated = true;
          audit(db,user.id,'application.created',aid,{candidate_id:candidate.id,requisition_id:req.id,referral_id:key});
        }
        const at = now();
        db.prepare('UPDATE referrals SET candidate_id=?,application_id=?,status=?,updated_at=? WHERE id=?').run(candidate.id,application.id,application.stage,at,key);
        audit(db,user.id,'referral.processed',key,{candidate_id:candidate.id,application_id:application.id,candidate_created:candidateCreated,application_created:applicationCreated,referrer_id:referral.created_by});
        return {...referralView(db,user,referralRow(db,key)), candidate_created:candidateCreated, application_created:applicationCreated};
      });
    }
    if (method === 'DELETE' && key && !action) {
      const row = referralRow(db, key);
      if (!referralAccess(user, row)) throw new HttpError(404, 'Referral not found.');
      const view = referralView(db,user,row);
      if (!view.can_delete) throw new HttpError(409, view.status === 'Withdrawn' ? 'Withdrawn referrals are retained for history and cannot be deleted.' : 'This referral cannot be deleted because it is linked to a candidate or application, or you do not have permission.');
      return transaction(db, () => {
        const at = now();
        db.prepare('UPDATE referrals SET deleted_at=?, deleted_by=?, updated_at=? WHERE id=?').run(at,user.id,at,key);
        audit(db,user.id,'referral.deleted',key,{name:row.name,email:row.email,referrer_id:row.created_by,requisition_id:row.requisition_id,status:view.status,soft_delete:true});
        return { ok:true, id:key, deleted_at:at };
      });
    }
    throw new HttpError(404,'Unknown referral action.');
  }
  if (parts[0] === 'fraud-reviews') {
    permit(user, 'recruit', 'admin');
    if (key && (action === 'resolve' || !action) && method === 'POST') {
      const review = get(db, 'fraud_reviews', key);
      const cand = get(db, 'candidates', review.candidate_id);
      requireTeam(user, cand.team);
      return resolveFraudReview(db, user, cand.id, body);
    }
  }
  if (parts[0] === 'signatures') {
    if (method === 'GET' && !key) {
      permit(user, 'recruit', 'review', 'admin');
      const candidateId = query.get('candidate_id') || query.get('candidateId');
      const applicationId = query.get('application_id') || query.get('applicationId');
      const status = query.get('status');
      return listSignatureRequests(db, user, { candidateId, applicationId, status });
    }
    if (method === 'POST' && !key) {
      permit(user, 'recruit', 'admin');
      let docBuffer = null;
      if (body.document_buffer) {
        docBuffer = Buffer.isBuffer(body.document_buffer) ? body.document_buffer : Buffer.from(body.document_buffer, 'base64');
      } else if (body.document_data) {
        docBuffer = Buffer.from(body.document_data, 'base64');
      }
      return createSignatureRequest(db, user, {
        title: body.title,
        candidateId: body.candidate_id || body.candidateId,
        applicationId: body.application_id || body.applicationId,
        requisitionId: body.requisition_id || body.requisitionId,
        documentType: body.document_type || body.documentType || 'offer',
        documentBuffer: docBuffer,
        filename: body.filename,
        signers: body.signers,
        expiresDays: body.expires_days || body.expiresDays || 7,
        salary: body.salary,
        currency: body.currency,
        startDate: body.start_date || body.startDate
      }, {
        origin: c?.origin,
        communicationAdapter: c?.communicationAdapter
      });
    }
    if (key && !action && method === 'GET') {
      permit(user, 'recruit', 'review', 'admin');
      return getSignatureRequest(db, user, key);
    }
    if (key && action === 'document' && method === 'GET') {
      permit(user, 'recruit', 'review', 'admin');
      const version = query.get('version') || 'signed';
      return downloadSignatureDocument(db, user, key, version);
    }
    if (key && (action === 'send-email' || action === 'resend') && method === 'POST') {
      permit(user, 'recruit', 'admin');
      return resendSignatureInvitation(db, user, key, body?.signer_id, {
        origin: c?.origin,
        communicationAdapter: c?.communicationAdapter
      });
    }
    if (key && action === 'cancel' && method === 'POST') {
      permit(user, 'recruit', 'admin');
      return cancelSignatureRequest(db, user, key, { reason: body.reason });
    }
  }
  if (parts[0] === 'agencies') {
    permit(user, 'admin', 'recruit');
    if (method === 'GET' && !key) {
      return listAgencies(db, user, query);
    }
    if (method === 'POST' && !key) {
      permit(user, 'admin');
      return createAgency(db, user, body);
    }
    if (key && !action) {
      if (method === 'GET') return getAgency(db, user, key);
      if (method === 'PUT') {
        permit(user, 'admin');
        return updateAgency(db, user, key, body);
      }
    }
    if (key && action === 'status' && method === 'POST') {
      permit(user, 'admin');
      return setAgencyStatus(db, user, key, body.status, body.reason);
    }
    if (key && action === 'members' && method === 'POST') {
      permit(user, 'admin');
      return addAgencyMember(db, user, key, body);
    }
    if (key && (action === 'requisitions' || action === 'assignments')) {
      if (method === 'POST' && (!parts[3] || parts[4] !== 'revoke')) {
        permit(user, 'recruit', 'admin');
        return assignRequisitionToAgency(db, user, key, {
          requisitionId: body.requisition_id || body.requisitionId,
          instructions: body.instructions ?? body.sourcing_instructions ?? '',
          deadline: body.deadline ?? body.submission_deadline ?? null
        });
      }
      if (method === 'DELETE' || (method === 'POST' && parts[3] && parts[4] === 'revoke')) {
        permit(user, 'recruit', 'admin');
        const reqId = parts[3];
        return revokeRequisitionFromAgency(db, user, key, reqId);
      }
    }
  }
  if (parts[0] === 'agency') {
    if (parts[1] === 'submissions' && parts[2] && parts[3] === 'feedback' && method === 'POST') {
      permit(user, 'recruit', 'admin');
      return publishAgencyFeedback(db, user, parts[2], body.feedback);
    }
    if (key === 'me' && method === 'GET') {
      return getAgencyContextForUser(db, user);
    }
    if (key === 'dashboard' && method === 'GET') {
      return getAgencyDashboard(db, user);
    }
    if (key === 'requisitions') {
      if (action && method === 'GET') return getAssignedRequisition(db, user, action);
      if (method === 'GET') return listAssignedRequisitions(db, user, query);
    }
    if (key === 'submissions') {
      if (!action && method === 'POST') {
        return submitAgencyCandidate(db, user, body, { resumeAdapter: c?.resumeAdapter });
      }
      if (action && method === 'GET') {
        return getAgencySubmission(db, user, action);
      }
      if (method === 'GET') {
        return listAgencySubmissions(db, user, query);
      }
    }
    if (key === 'members') {
      if (method === 'GET') return listAgencyMembers(db, user);
      if (method === 'POST' && !action) return addAgencyRecruiter(db, user, body);
      if (action && parts[3] === 'status' && method === 'POST') {
        return updateAgencyRecruiterStatus(db, user, action, body.status);
      }
    }
    if (key === 'resume' && action === 'upload' && method === 'POST') {
      if (!body.buffer || !Buffer.isBuffer(body.buffer)) {
        throw new HttpError(400, 'Uploaded file content is missing or invalid.');
      }
      const adapter = c?.resumeAdapter || new ResumeAdapter({ enabled: true });
      return (async () => {
        const result = await adapter.processUpload({
          buffer: body.buffer,
          filename: body.filename || 'resume',
          mimeType: body.mimeType || ''
        });
        const resumeId = id();
        const nowStr = now();
        db.prepare(`
          INSERT INTO candidate_resumes(id, candidate_id, storage_id, filename, file_format, file_size, mime_type, scan_status, extraction_status, error_message, uploaded_by, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?,'clean','success',?,?,?,?)
        `).run(
          resumeId,
          null,
          result.storageId,
          result.filename,
          result.format,
          result.size,
          body.mimeType || (result.format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
          null,
          user.id,
          nowStr,
          nowStr
        );
        const details = extractResumeDetails(result.text, getDbSkills(db));
        return {
          resume_id: resumeId,
          text: result.text,
          name: details.name,
          email: details.email,
          phone: details.phone,
          skills: details.skills,
          filename: result.filename,
          format: result.format,
          size: result.size
        };
      })();
    }
  }
  if (path === 'analytics' && method === 'GET') {
    permit(user,'analytics');
    const reqs = db.prepare('SELECT * FROM requisitions WHERE deleted_at IS NULL').all().filter(r=>inTeam(user,r.team)), ids = new Set(reqs.map(r=>r.id));
    const apps = db.prepare('SELECT * FROM applications').all().filter(a=>ids.has(a.requisition_id));
    return {openRequisitions:reqs.filter(r=>r.status==='open').length, pendingApprovals:reqs.filter(r=>r.status.startsWith('pending')).length,
      approvedHeadcount:reqs.filter(r=>r.status==='open').reduce((n,r)=>n+r.headcount,0), candidates:db.prepare('SELECT team FROM candidates WHERE deleted_at IS NULL').all().filter(c=>inTeam(user,c.team)).length,
      stageCounts:Object.fromEntries(pipeline(db).map(s=>[s,apps.filter(a=>a.stage===s).length])),
      averageApplicationAgeDays:apps.length ? Math.round(apps.reduce((n,a)=>n+(Date.now()-Date.parse(a.created_at))/86400000,0)/apps.length) : 0};
  }
  if (path === 'integrations' && method === 'GET') {
    permit(user,'admin','recruit');
    const calEffective = getEffectiveIntegrationConfig(db, 'microsoft_calendar');
    const emailEffective = getEffectiveIntegrationConfig(db, 'email_communication');
    const hrmsEffective = getEffectiveIntegrationConfig(db, 'hrms');
    const emailStatus = (emailEffective.enabled && emailEffective.isConfigured) || isEmailConfigured(db) ? 'Active (Resend provider configured)' : 'Not configured';
    const calStatus = (calEffective.enabled && calEffective.isConfigured) || isCalendarConfigured(c, db) ? 'Active (Microsoft Graph / Teams configured)' : 'Not configured';
    const aiProviders = getAvailableAiProviders(c);
    const aiStatus = aiProviders.length > 0
      ? `Active (${aiProviders.map(p => `${p.name} [${p.model}]`).join(', ')})`
      : 'Active (Deterministic explainable fallback operational)';
    const fraudStatus = 'Active (Rule-based inconsistency detector operational)';
    const sigStatus = 'Active (In-house e-signature engine operational)';
    const agencyStatus = 'Active (Isolated external recruiter portal operational)';
    const hrmsStatus = (hrmsEffective.enabled && hrmsEffective.isConfigured) ? 'Active (Enterprise HRMS configured)' : 'Not configured';
    return ['Microsoft calendar / Teams','Candidate email','Offer e-signature','AI matching','PDF / DOCX resume parsing','Fraud signal review','Agency portal','Preboarding / HRMS'].map(name=>({
      name,
      status: name === 'PDF / DOCX resume parsing' ? 'Active (Phase 1 operational)'
        : (name === 'Candidate email' ? emailStatus
        : (name === 'Microsoft calendar / Teams' ? calStatus
        : (name === 'Offer e-signature' ? sigStatus
        : (name === 'AI matching' ? aiStatus
        : (name === 'Fraud signal review' ? fraudStatus
        : (name === 'Agency portal' ? agencyStatus
        : (name === 'Preboarding / HRMS' ? hrmsStatus
        : 'Not configured'))))))),
      phase: name.includes('Agency')?'4':'3',
      externalWrites: name === 'Microsoft calendar / Teams' ? ((calEffective.enabled && calEffective.isConfigured) || isCalendarConfigured(c, db)) : (name === 'Candidate email' ? ((emailEffective.enabled && emailEffective.isConfigured) || isEmailConfigured(db)) : (name === 'AI matching' ? aiProviders.length > 0 : (name === 'Preboarding / HRMS' ? Boolean(hrmsEffective.enabled && hrmsEffective.isConfigured) : false)))
    }));
  }
  throw new HttpError(404,'Endpoint not found.');
}
