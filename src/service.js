import { audit, id, now, transaction } from './db.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpError, roles, teams, permissions as permissionCatalog, permissionDefinitions, permissionGroups, permissionIds, permissionById, requirePermission as permit, requireTeam, inTeam, userTeams, can, text, email, phone as validatePhone, currency as validateCurrency, list, validateSkills, integer, isAgencyRole, normalizeTeamName } from './policy.js';
import { accessSummary, archiveRole, assignmentImpact, createRole, duplicateRole, hydrateUser, listRoles, permissionsForRole, resolveRoleForAssignment, roleView, updateRole } from './rbac.js';
import { getAppearance, setAppearance } from './appearance.js';
import { isDemoUser } from './demo.js';
import { ResumeAdapter, CommunicationAdapter, CalendarAdapter, MatchingAdapter, FraudAdapter, HrmsAdapter } from './adapters.js';
import { isEmailConfigured, listCandidateCommunications, setCandidateConsent, getCandidateConsent, sendCandidateCommunication, sendStageTransitionNotification } from './communication/service.js';
import { getAvailableTemplates } from './communication/templates.js';
import { isCalendarConfigured, syncScheduleMeeting, syncRescheduleMeeting, syncCancelMeeting } from './calendar/service.js';
import { evaluateCandidateMatch } from './matching/engine.js';
import { isAiMatchingConfigured, matchWithAi } from './matching/ai.js';
import { getOrRunFraudReview, resolveFraudReview } from './fraud/service.js';
import { draftJobDescription } from './ai/draft.js';
import { getAvailableAiProviders } from './ai/provider.js';
import {
  createSignatureRequest, getSignatureRequest, listSignatureRequests,
  cancelSignatureRequest, downloadSignatureDocument, resendSignatureInvitation,
  verifyApplicationOfferSignature, getAuthoritativeOfferDetails
} from './signature/service.js';
import {
  listOfferTemplates, getOfferTemplate, createOfferTemplate, updateOfferTemplate,
  duplicateOfferTemplate, setOfferTemplateStatus, uploadLetterheadAsset,
  getLetterheadAssetBuffer, previewOfferTemplate, compileTemplateToPdf, seedDefaultTemplatesIfEmpty,
  listOfferLetterAssets, deleteOfferLetterAsset
} from './signature/template_service.js';
import {
  listTrainingTemplates, getTrainingTemplate, createTrainingTemplate, updateTrainingTemplate,
  duplicateTrainingTemplate, setTrainingTemplateStatus, archiveTrainingTemplate,
  suggestTrainingPlan, getOrCreateTrainingDraft, saveTrainingDraft, discardTrainingDraft,
  previewTrainingEmail, sendTrainingPlan, resendTrainingPlan, uploadTrainingAsset,
  getTrainingAsset, seedDefaultTrainingTemplatesIfEmpty
} from './training/service.js';
import {
  startTraining, extendTrainingDeadline, restartTraining,
  revokeOffer, evaluateTraining, getTrainingHistory,
  isTrainingOverdue, resolveEffectiveTrainingStatus
} from './training/lifecycle.js';
import { VARIABLE_REGISTRY } from './signature/variables.js';
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

export const PIPELINE_PRESETS = {
  smart_hybrid: [
    'Applied',
    'Screening Round',
    'Interview Round 1',
    'Interview Round 2',
    'HR Round',
    'Offer',
    'Pre-Onboarding Training',
    'Onboarding',
    'Hired',
    'Rejected',
    'Revoked'
  ],
  smart_hybrid_3rounds: [
    'Applied',
    'Screening Round',
    'Interview Round 1',
    'Interview Round 2',
    'Interview Round 3',
    'HR Round',
    'Offer',
    'Pre-Onboarding Training',
    'Onboarding',
    'Hired',
    'Rejected',
    'Revoked'
  ],
  standard: [
    'Applied',
    'Screening',
    'Interview',
    'Offer',
    'Hired',
    'Rejected'
  ]
};

export function isAllowedStageProgression(fromStage, toStage, stages) {
  // Terminal stages cannot transition sequentially
  if (['Hired', 'Rejected', 'Revoked'].includes(fromStage)) {
    return false;
  }

  if (['Rejected', 'Revoked'].includes(toStage)) {
    return true;
  }
  const fromIdx = stages.indexOf(fromStage);
  const toIdx = stages.indexOf(toStage);
  if (fromIdx === -1 || toIdx === -1) return false;

  // Direct single step forward
  if (toIdx === fromIdx + 1) return true;

  // Direct single step backward (mistake correction)
  if (toIdx === fromIdx - 1) return true;

  // Forward transitions (including skipping intermediate non-major stages like interview rounds)
  if (toIdx > fromIdx) {
    const intermediateStages = stages.slice(fromIdx + 1, toIdx);

    // Rule 1: Major pipeline gates (Offer, Hired) cannot be bypassed/skipped over
    if (intermediateStages.some(s => /(^|\b)(offer|hired)(\b|$)/i.test(s.trim()))) {
      return false;
    }

    // Rule 2: Cannot skip straight into Hired (must come from immediately preceding stage or post-training onboarding)
    if (toStage === 'Hired') {
      if (fromIdx === toIdx - 1) return true;
      if (/pre-onboarding/i.test(fromStage) && intermediateStages.every(s => /onboarding/i.test(s))) {
        return true;
      }
      return false;
    }

    // Rule 3: Entry stage 'Applied' cannot jump straight to post-interview training
    if (fromStage === 'Applied' && /pre-onboarding|training/i.test(toStage)) {
      return false;
    }

    // Rule 4: Intermediate interview rounds, screenings, assessments, HR, or training stages are freely skippable
    // Any forward jump where skipped intermediate stages do not bypass major gates (Offer, Hired) is allowed
    const isMajor = s => /(^|\b)(offer|hired|rejected|revoked)(\b|$)/i.test(s.trim());
    if (intermediateStages.every(s => !isMajor(s))) {
      return true;
    }
  }

  // Flexible backward step within interview rounds (e.g. HR Round back to Round 2 or Round 1 for further assessment)
  if (toIdx < fromIdx) {
    const isInterviewOrHr = s => /interview|round|technical|assessment|hr/i.test(s);
    if (isInterviewOrHr(fromStage) && isInterviewOrHr(toStage)) {
      const intermediateStages = stages.slice(toIdx + 1, fromIdx);
      if (intermediateStages.every(s => isInterviewOrHr(s))) {
        return true;
      }
    }
  }

  return false;
}

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
  if (row.created_by === user.id) return true;
  if (!can(user, 'referrals.read_all') && !can(user, 'referrals.process')) return false;
  if (user._scope === 'organization') return true;
  return inTeam(user, referralTeam(row));
}
function withdrawalCheck(db, row, user) {
  if (row.status === 'Withdrawn' || row.withdrawn_at) return { ok:false, status:409, message:'This referral has already been withdrawn.' };
  if (row.created_by !== user.id && !can(user, 'system.override')) return { ok:false, status:403, message:'Only the employee who made this referral can withdraw it.' };
  const app = referralApplication(db, row);
  if (app && !['Applied', 'Screening'].includes(app.stage)) {
    return { ok:false, status:409, message:`This referral can no longer be withdrawn because the linked application has reached the ${app.stage} stage. Contact the recruiting team if the referral must be removed from consideration.` };
  }
  return { ok:true };
}
function referralView(db, user, row) {
  const app = referralApplication(db, row), status = referralStatus(db, row), applicationStage = app?.stage || null;
  const isOwner = row.created_by === user.id, isWithdrawn = status === 'Withdrawn';
  const employeeLike = !can(user, 'referrals.process') && !can(user, 'referrals.read_all');
  const teamAccess = inTeam(user, referralTeam(row));
  const canViewRequisition = Boolean(row.requisition_team && inTeam(user, row.requisition_team) && (!employeeLike || row.requisition_status === 'open'));
  const ownerEligible = isOwner && !isWithdrawn && (!applicationStage || ['Applied', 'Screening'].includes(applicationStage));
  const recruiterEdit = can(user, 'referrals.process') && can(user, 'referrals.update') && teamAccess && !isWithdrawn && !['Hired', 'Rejected'].includes(status);
  const adminEdit = can(user, 'system.override') && !isWithdrawn;
  const managerEdit = can(user, 'referrals.read_all') && can(user, 'referrals.update') && isOwner && teamAccess && !isWithdrawn && !['Hired', 'Rejected'].includes(status);
  const canProcess = can(user, 'referrals.process') && teamAccess && row.requisition_status === 'open' && !isWithdrawn && !app;
  const authorizedForDelete = can(user, 'system.override') || (can(user, 'referrals.delete') && teamAccess) || isOwner;
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
  if (interviewer && (user._scope === 'assigned' || user.role === 'Interviewer')) {
    if (!db.prepare('SELECT id FROM interviews WHERE application_id=? AND interviewer_id=?').get(aid,user.id)) throw new HttpError(403,'You are not assigned to this interview.');
  } else requireTeam(user, req.team);
  return { app, req };
}
/**
 * Candidate information required to prepare for an assigned interview.
 * Deliberately excludes resume text, resume files, salary, creator identity
 * and applications the interviewer is not assigned to.
 */
function interviewerCandidateContext(db, user, candidateId) {
  const interviews = db.prepare(`SELECT i.id, i.application_id, i.scheduled_at, i.status, i.title,
      i.competencies, r.id requisition_id, r.title requisition_title, r.team requisition_team, a.stage
    FROM interviews i JOIN applications a ON a.id=i.application_id JOIN requisitions r ON r.id=a.requisition_id
    WHERE a.candidate_id=? AND i.interviewer_id=? ORDER BY i.scheduled_at ASC`).all(candidateId, user.id);
  if (!interviews.length) throw new HttpError(403, 'You can only view candidates assigned to your interviews.');
  const cand = get(db, 'candidates', candidateId);
  if (cand.deleted_at) throw new HttpError(404, 'Candidate not found.');
  const byApplication = new Map(interviews.map(i => [i.application_id, i]));
  const applications = db.prepare(`SELECT a.id, a.candidate_id, a.requisition_id, a.stage, a.created_at, r.title, r.team
    FROM applications a JOIN requisitions r ON r.id=a.requisition_id WHERE a.candidate_id=? ORDER BY a.created_at ASC`)
    .all(candidateId).filter(a => byApplication.has(a.id))
    .map(a => ({ id: a.id, requisition_id: a.requisition_id, title: a.title, stage: a.stage, team: a.team, created_at: a.created_at }));
  const output = {
    id: cand.id,
    name: cand.name,
    team: cand.team,
    skills: JSON.parse(cand.skills || '[]'),
    source: cand.source,
    applications,
    interviews: interviews.map(i => ({
      id: i.id, application_id: i.application_id, scheduled_at: i.scheduled_at, status: i.status,
      title: i.title, competencies: JSON.parse(i.competencies || '[]'),
      requisition_id: i.requisition_id, requisition_title: i.requisition_title,
      requisition_team: i.requisition_team, stage: i.stage
    })),
    access_scope: 'assigned_interviews',
    can_delete: false
  };
  if (can(user, 'candidates.personal.read')) {
    output.email = cand.email;
    output.phone = cand.phone;
  }
  return output;
}
function candidateOutput(user, candidate, extra = {}) {
  const out = { ...candidate, skills: JSON.parse(candidate.skills || '[]'), ...extra };
  if (!can(user, 'candidates.resume.read')) {
    delete out.resume_text;
    delete out.experience;
    delete out.resume;
  }
  if (!can(user, 'candidates.personal.read')) {
    delete out.email;
    delete out.phone;
  }
  if (!can(user, 'candidates.delete')) out.can_delete = false;
  return out;
}
function redactMatchEvidence(user, result) {
  if (!result || can(user, 'candidates.resume.read')) return result;
  return {
    ...result,
    evidence: Array.isArray(result.evidence)
      ? result.evidence.map(entry => {
          if (!entry || typeof entry !== 'object') return entry;
          const { snippet: _snippet, ...safe } = entry;
          return safe;
        })
      : result.evidence
  };
}
function redactOfferCompensation(user, row) {
  if (!row || typeof row !== 'object') return row;
  const output = { ...row };
  if (!can(user, 'offers.compensation.read')) {
    delete output.salary;
    delete output.currency;
    delete output.start_date;
    delete output.startDate;
    delete output.compensation;
  }
  return output;
}
function interviewContextView(db, interview, user) {
  const row = db.prepare(`SELECT i.*,a.candidate_id,c.name,c.email,c.phone,c.skills,r.title,r.team,u.name interviewer
    FROM interviews i JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id
    JOIN requisitions r ON r.id=a.requisition_id JOIN users u ON u.id=i.interviewer_id WHERE i.id=?`).get(interview.id);
  if (!row) return row;
  const candidate = { id: row.candidate_id, name: row.name, skills: JSON.parse(row.skills || '[]') };
  if (can(user, 'candidates.personal.read')) {
    candidate.email = row.email;
    candidate.phone = row.phone;
  }
  const { email: _candidateEmail, phone: _candidatePhone, ...safeRow } = row;
  return {
    ...safeRow,
    candidate,
    application: (() => {
      const app = db.prepare('SELECT a.id,a.stage,a.requisition_id FROM applications a WHERE a.id=?').get(row.application_id);
      return app ? { id: app.id, stage: app.stage, requisition_id: app.requisition_id, requisition_title: row.title, requisition_team: row.team } : null;
    })()
  };
}
export function service(db, user, method, path, body = {}, query = new URLSearchParams(), c = {}) {
  seedDefaultTemplatesIfEmpty(db);
  seedDefaultTrainingTemplatesIfEmpty(db);
  hydrateUser(db, user);
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
      roles: listRoles(db).filter(role => !isAgencyRole(role.name)).map(role => role.name),
      teams,
      permissionCatalog,
      permissionRegistry: permissionDefinitions,
      permissionGroups,
      roleScope: user._scope,
      roleDefinition: user._role ? roleView(db, user._role) : null,
      demoLogin: Boolean(c?.demoLogin),
      isDemoUser: isDemoUser(user),
      // Legacy capability tokens are derived from persisted grants so removals
      // from customized system roles are reflected immediately.
      permissions: [...user._legacy],
      grants: [...user._grants]
    };
  }
  if (parts[0] === 'admin') {
    if (key === 'integrations') {
      permit(user, 'integrations.read', 'integrations.configure', 'integrations.secrets.manage');
      if (!action && method === 'GET') return listIntegrationsForAdmin(db, user);
      if (action && !parts[3]) {
        if (method === 'GET') return getIntegrationForAdmin(db, user, action);
        if (method === 'PUT') {
          permit(user, 'integrations.configure');
          const incomingSecrets = body?.secrets && typeof body.secrets === 'object' ? body.secrets : {};
          const secretChanges = Object.entries(incomingSecrets).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '').length
            + (Array.isArray(body?.removeSecrets) ? body.removeSecrets.length : 0);
          if (secretChanges) permit(user, 'integrations.secrets.manage');
          return updateIntegrationForAdmin(db, user, action, body);
        }
      }
      if (action && parts[3] === 'test' && method === 'POST') {
        permit(user, 'integrations.configure');
        return testIntegrationForAdmin(db, user, action, body, c?.transport || fetch);
      }
      if (action && parts[3] === 'toggle' && method === 'POST') {
        permit(user, 'integrations.configure');
        return toggleIntegrationForAdmin(db, user, action, body);
      }
      throw new HttpError(404, 'Unknown integrations admin endpoint.');
    }

    if (method === 'GET' && key === 'access') {
      permit(user, 'roles.read', 'users.read');
      return accessSummary(db);
    }
    if (method === 'GET' && key === 'permissions') {
      permit(user, 'permissions.read', 'roles.read');
      return { permissions: permissionDefinitions, groups: permissionGroups };
    }
    if (key === 'roles') {
      if (method === 'GET' && !action) {
        permit(user, 'roles.read');
        return listRoles(db, { includeArchived: query.get('archived') === 'true' });
      }
      if (method === 'POST' && !action) {
        permit(user, 'roles.create');
        return createRole(db, user, body);
      }
      if (action) {
        const role = db.prepare('SELECT * FROM rbac_roles WHERE id=?').get(action);
        if (!role) throw new HttpError(404, 'Role not found.');
        if (method === 'GET' && !parts[3]) {
          permit(user, 'roles.read');
          return { ...roleView(db, role), impact: assignmentImpact(db, role), users: db.prepare('SELECT id,name,email,team,status,last_login FROM users WHERE role_id=? OR (role_id IS NULL AND role=?) ORDER BY name').all(role.id, role.name) };
        }
        if ((method === 'PUT' || method === 'POST') && !parts[3]) {
          permit(user, 'roles.update');
          return updateRole(db, user, role.id, body);
        }
        if (method === 'POST' && parts[3] === 'duplicate') {
          permit(user, 'roles.create');
          return duplicateRole(db, user, role.id, body);
        }
        if ((method === 'DELETE' && !parts[3]) || (method === 'POST' && parts[3] === 'archive')) {
          permit(user, 'roles.delete');
          return archiveRole(db, user, role.id, body);
        }
      }
      throw new HttpError(404, 'Unknown role administration endpoint.');
    }

    if (method === 'GET' && key === 'users') {
      permit(user, 'users.read');
      const roleMap = new Map(listRoles(db, { includeArchived: true }).map(role => [role.name, role]));
      return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(row => {
        const role = roleMap.get(row.role);
        return {
          ...publicUser(row),
          role_id: row.role_id || role?.id || null,
          role_scope: role?.scope || 'none',
          effective_permissions: role?.permission_count || 0
        };
      });
    }
    if (method === 'GET' && key === 'audit') {
      permit(user, 'audit.read');
      const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 200));
      const clauses = ['id < ?'], params = [Number(query.get('before')) || Number.MAX_SAFE_INTEGER];
      const event = (query.get('event') || '').trim(), actor = (query.get('actor') || '').trim(), q = (query.get('q') || '').trim();
      const from = (query.get('from') || '').trim(), to = (query.get('to') || '').trim();
      if (event) { clauses.push('event LIKE ?'); params.push(`%${event}%`); }
      if (actor) { clauses.push('actor = ?'); params.push(actor); }
      if (q) { clauses.push('(event LIKE ? OR actor LIKE ? OR target LIKE ? OR detail LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
      if (from) { clauses.push('at >= ?'); params.push(/^\d{4}-\d{2}-\d{2}$/.test(from) ? `${from}T00:00:00.000Z` : from); }
      if (to) { clauses.push('at <= ?'); params.push(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to); }
      params.push(limit);
      return db.prepare(`SELECT * FROM audit WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params).map(row => {
        let detail = {};
        try { detail = JSON.parse(row.detail || '{}'); } catch {}
        return { ...row, detail };
      });
    }
    if (method === 'POST' && key === 'users' && !action) {
      permit(user, 'users.create');
      const address = email(body.email), name = text(body.name,'Name',200), team = text(body.team ?? '','Team',100,true);
      const role = resolveRoleForAssignment(db, user, body.role);
      if (role.scope !== 'organization' && role.scope !== 'none' && !team) throw new HttpError(400,'Team is required for this role.');
      if (team && !inTeam(user, team)) throw new HttpError(403, 'You cannot assign users outside your team scope.');
      if (roles.includes(role.name) && ['System Admin','TA Director'].includes(role.name) && !team) { /* organization roles may omit team */ }
      const oid = text(body.oid,'Entra object ID',36), tenant = text(body.tenant,'Entra tenant ID',36);
      if (!/^[a-f0-9-]{36}$/i.test(oid) || !/^[a-f0-9-]{36}$/i.test(tenant)) throw new HttpError(400,'Entra object and tenant IDs must be GUIDs.');
      const uid = id();
      return transaction(db, () => {
        db.prepare('INSERT INTO users(id,email,name,oid,tenant,role,role_id,team,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(uid,address,name,oid,tenant,role.name,role.id,team,'active',now());
        audit(db,user.id,'admin.user_added',uid,{role:role.name,role_id:role.id,team}); return publicUser(get(db,'users',uid));
      });
    }
    if (method === 'POST' && key === 'users' && action && parts[3]) {
      const target = get(db,'users',action), op = parts[3];
      if (!['approve','reject','disable','reactivate','force-logout','update'].includes(op)) throw new HttpError(404,'Unknown admin action.');
      if (target.id === user.id && op !== 'force-logout') throw new HttpError(409,'Use another administrator to modify your own access.');
      if (op === 'force-logout') permit(user, 'users.deactivate');
      else if (['disable','reject'].includes(op)) permit(user, 'users.deactivate');
      else permit(user, 'users.update');
      let status = target.status, role = target.role, roleId = target.role_id, team = target.team;
      if (op === 'approve' && target.status !== 'pending') throw new HttpError(409,'Only pending requests can be approved.');
      if (op === 'reject' && target.status !== 'pending') throw new HttpError(409,'Only pending requests can be rejected.');
      if (op === 'reactivate' && !['disabled','rejected'].includes(target.status)) throw new HttpError(409,'Only disabled or rejected users can be reactivated.');
      if (op === 'disable' && target.status !== 'active') throw new HttpError(409,'Only active users can be disabled.');
      if (['approve','update'].includes(op)) {
        const nextRole = resolveRoleForAssignment(db, user, body.role ?? target.role);
        const roleChanged = nextRole.name !== target.role
          || (target.role_id && nextRole.id !== target.role_id)
          || (body.role !== undefined && body.role !== target.role);
        if (roleChanged) permit(user, 'roles.assign');
        role = nextRole.name; roleId = nextRole.id; team = text(body.team ?? '', 'Team',100,true);
        if (nextRole.scope !== 'organization' && nextRole.scope !== 'none' && !team) throw new HttpError(400,'Team is required for this role.');
        if (team && !inTeam(user, team)) throw new HttpError(403, 'You cannot assign users outside your team scope.');
      }
      if (['approve','reactivate'].includes(op)) status = 'active';
      if (op === 'reject') status = 'rejected';
      if (op === 'disable') status = 'disabled';
      const adminRole = db.prepare("SELECT id FROM rbac_roles WHERE name='System Admin'").get();
      const wasAdmin = target.role === 'System Admin' || (adminRole && target.role_id === adminRole.id);
      const remainsAdmin = role === 'System Admin' || (adminRole && roleId === adminRole.id);
      if (wasAdmin && target.status === 'active' && (status !== 'active' || !remainsAdmin)) {
        const activeAdmins = db.prepare("SELECT count(*) n FROM users WHERE status='active' AND (role='System Admin' OR role_id=?)").get(adminRole?.id || '').n;
        if (activeAdmins <= 1) throw new HttpError(409,'Cannot remove the last administrator.');
      }
      return transaction(db, () => {
        const guarded = op === 'approve' || op === 'reject';
        const updated = guarded
          ? db.prepare('UPDATE users SET status=?,role=?,role_id=?,team=?,version=version+1 WHERE id=? AND status=?').run(status,role,roleId,team,target.id,'pending')
          : db.prepare('UPDATE users SET status=?,role=?,role_id=?,team=?,version=version+1 WHERE id=?').run(status,role,roleId,team,target.id);
        if (guarded && updated.changes !== 1) throw new HttpError(409, 'This access request was already decided.');
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
        audit(db,user.id,`admin.${op}`,target.id,{status,role,role_id:roleId,team}); return publicUser(get(db,'users',target.id));
      });
    }
  }
  if (path === 'pipeline/presets' && method === 'GET') {
    permit(user, 'pipeline.read', 'jobs.read');
    return PIPELINE_PRESETS;
  }
  if (path === 'pipeline') {
    if (method === 'GET') { permit(user,'pipeline.read','jobs.read'); return pipeline(db); }
    if (method === 'PUT') {
      permit(user,'pipeline.configure');
      let targetStages = body?.preset && PIPELINE_PRESETS[body.preset] ? PIPELINE_PRESETS[body.preset] : body?.stages;
      if (!targetStages && Array.isArray(body)) targetStages = body;
      const stages = list(targetStages, 'Stages', 30);
      const validEnd = (stages.at(-2) === 'Hired' && stages.at(-1) === 'Rejected') ||
                       (stages.at(-3) === 'Hired' && stages.at(-2) === 'Rejected' && stages.at(-1) === 'Revoked') ||
                       (stages.at(-2) === 'Hired' && ['Rejected', 'Revoked'].includes(stages.at(-1)));
      if (stages.length < 3 || stages[0] !== 'Applied' || !validEnd) {
        throw new HttpError(400, 'Start with Applied and end with Hired, then Rejected.');
      }
      const old = pipeline(db);
      const stageRemap = body?.stage_remap || body?.stageRemap || {};
      const removedStages = old.filter(s => !stages.includes(s));

      const occupiedWithoutRemap = [];
      for (const s of removedStages) {
        const count = db.prepare('SELECT count(*) as count FROM applications WHERE stage=?').get(s)?.count || 0;
        if (count > 0) {
          const target = stageRemap[s];
          if (!target || !stages.includes(target)) {
            occupiedWithoutRemap.push(`${s} (${count} active candidate${count > 1 ? 's' : ''})`);
          }
        }
      }

      if (occupiedWithoutRemap.length > 0) {
        throw new HttpError(409, `Cannot remove stages with active candidates: ${occupiedWithoutRemap.join(', ')}. Keep these stages in your pipeline, or remap existing candidates.`);
      }

      return transaction(db, () => {
        for (const [oldStage, newStage] of Object.entries(stageRemap)) {
          if (old.includes(oldStage) && stages.includes(newStage)) {
            const appsInStage = db.prepare('SELECT id FROM applications WHERE stage=?').all(oldStage);
            for (const app of appsInStage) {
              db.prepare('UPDATE applications SET stage=? WHERE id=?').run(newStage, app.id);
              db.prepare('INSERT INTO stage_events VALUES(?,?,?,?,?,?)').run(id(), app.id, oldStage, newStage, user.id, now());
            }
          }
        }
        db.prepare("UPDATE settings SET value=? WHERE key='pipeline'").run(JSON.stringify(stages));
        audit(db, user.id, 'pipeline.updated', '', { stages, stageRemap });
        return stages;
      });
    }
  }
  if (parts[0] === 'requisitions') {
    if (method === 'GET') {
      permit(user,'jobs.read','requisitions.read');
      const openOnly = !can(user, 'requisitions.read');
      const redactCompensation = !can(user, 'requisitions.compensation.read');
      if (key) {
        const r = get(db, 'requisitions', key);
        if (r.deleted_at || !inTeam(user, r.team) || (openOnly && r.status !== 'open')) {
          throw new HttpError(404, 'Requisition not found.');
        }
        const output = { ...r, skills: JSON.parse(r.skills) };
        if (redactCompensation) { delete output.salary_min; delete output.salary_max; delete output.currency; }
        return output;
      }
      return db.prepare('SELECT * FROM requisitions WHERE deleted_at IS NULL ORDER BY created_at DESC').all().filter(r => inTeam(user,r.team) && (!openOnly || r.status === 'open')).map(r => {
        const output = {...r,skills:JSON.parse(r.skills)};
        if (redactCompensation) { delete output.salary_min; delete output.salary_max; delete output.currency; }
        return output;
      });
    }
    if (method === 'POST' && !key) {
      permit(user,'requisitions.create'); const team = normalizeTeamName(text(body.team,'Team',100)); requireTeam(user,team);
      if (!can(user, 'requisitions.compensation.read') && ['salary_min','salary_max','currency'].some(field => body[field] !== undefined && body[field] !== null && body[field] !== '')) {
        throw new HttpError(403, 'You do not have permission to set compensation fields.');
      }
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
      permit(user,'requisitions.update');
      if (!can(user, 'requisitions.compensation.read') && ['salary_min','salary_max','currency'].some(field => body[field] !== undefined)) {
        throw new HttpError(403, 'You do not have permission to change compensation fields.');
      }
      const req = get(db,'requisitions',key);
      if (req.deleted_at) throw new HttpError(404, 'Requisition not found.');
      requireTeam(user,req.team);
      const isAdmin = can(user, 'requisitions.override') || can(user, 'system.override');
      const canCrossTeam = can(user, 'system.override');
      if (!isAdmin && !['draft','open'].includes(req.status)) {
        if (['pending_manager','pending_finance'].includes(req.status)) {
          throw new HttpError(409,'Cannot edit requisition awaiting approval.');
        }
        throw new HttpError(409,`Cannot edit a requisition with status ${req.status}.`);
      }
      const team = normalizeTeamName(text(body.team ?? req.team,'Team',100));
      requireTeam(user,team);
      const hasApps = Boolean(db.prepare('SELECT id FROM applications WHERE requisition_id=?').get(key));
      if (team !== normalizeTeamName(req.team) && hasApps) {
        if (!canCrossTeam || (!body.admin_override && !body.override)) {
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
        if (canCrossTeam && team !== normalizeTeamName(req.team) && hasApps) {
          auditDetail.admin_team_reassignment = true;
          auditDetail.previous_team = req.team;
        }
        audit(db,user.id,'requisition.updated',key,auditDetail);
        const updated = get(db,'requisitions',key);
        return {...updated,skills:JSON.parse(updated.skills)};
      });
    }
    if (method === 'DELETE' && key && !action) {
      permit(user,'requisitions.delete');
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
        permit(user,'requisitions.submit'); if (req.status !== 'draft') throw new HttpError(409,'Only drafts can be submitted.'); status = 'pending_manager';
      } else if (action === 'approve' || action === 'reject') {
        const step = req.status === 'pending_manager' ? 'manager' : req.status === 'pending_finance' ? 'finance' : null;
        if (!step) throw new HttpError(409,'Requisition is not awaiting approval.');
        permit(user, step === 'manager' ? 'requisitions.approve_manager' : 'requisitions.approve_finance');
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
          if (!can(user, 'requisitions.override') && !can(user, 'system.override')) {
            throw new HttpError(403,'The requisitions.override permission is required for an emergency approval override.');
          }
          if (body.override_reason !== undefined) {
            overrideReason = text(body.override_reason, 'Emergency override reason', 2000, false);
            if (!overrideReason || !overrideReason.trim()) {
              throw new HttpError(400, 'A meaningful reason is required for an emergency approval override.');
            }
          } else {
            overrideReason = text(body.reason || body.note || 'Authorized emergency approval override', 'Emergency override reason', 2000, true) || 'Authorized emergency approval override';
          }
          bypassedRule = isCreator && priorApproval ? 'requester_and_prior_approver' : isCreator ? 'requester_self_approval' : 'same_approver_both_steps';
        } else if (isEmergency) {
          if (!can(user, 'requisitions.override') && !can(user, 'system.override')) {
            throw new HttpError(403,'The requisitions.override permission is required for an emergency approval override.');
          }
          if (body.override_reason !== undefined) {
            overrideReason = text(body.override_reason, 'Emergency override reason', 2000, false);
            if (!overrideReason || !overrideReason.trim()) {
              throw new HttpError(400, 'A meaningful reason is required for an emergency approval override.');
            }
          } else {
            overrideReason = text(body.reason || body.note || 'Authorized emergency approval override', 'Emergency override reason', 2000, true) || 'Authorized emergency approval override';
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
    const assignedCandidateRead = method === 'GET' && key && !action && !can(user, 'candidates.read') && can(user, 'candidates.assigned.read');
    if (!assignedCandidateRead) {
      if (method === 'POST' && !key) permit(user, 'candidates.create');
      else if ((method === 'PUT' || method === 'POST') && key && !action) permit(user, 'candidates.update');
      else if (method === 'DELETE') permit(user, 'candidates.delete');
      else if (method === 'GET' && !action) permit(user, 'candidates.read');
      // Action routes below perform their own field-specific permission check.
    }
    if (key && action === 'resume' && method === 'GET') {
      permit(user, 'candidates.resume.read');
      const cand = get(db, 'candidates', key);
      requireTeam(user, cand.team);
      const resRow = db.prepare('SELECT * FROM candidate_resumes WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1').get(key);
      if (!resRow) {
        throw new HttpError(404, 'No resume document found for this candidate.');
      }
      const storagePath = resolve('data/resumes/approved', `${resRow.storage_id}.bin`);
      if (!existsSync(storagePath)) {
        throw new HttpError(404, 'Resume file is not present on disk.');
      }
      const buffer = readFileSync(storagePath);
      return {
        isRaw: true,
        buffer,
        contentType: resRow.mime_type || (resRow.file_format === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
        filename: resRow.filename || `${cand.name.replace(/\s+/g, '_')}_Resume.${resRow.file_format || 'pdf'}`
      };
    }
    if (key && action === 'communications') {
      if (method === 'GET') {
        permit(user, 'candidates.communications.read');
        return listCandidateCommunications(db, user, key);
      }
      if (method === 'POST') {
        permit(user, 'candidates.communications.send');
        return (async () => {
          const commAdapter = c?.communicationAdapter || new CommunicationAdapter({ db, fromEnv: true, transport: c?.transport });
          return await sendCandidateCommunication(db, user, { ...body, candidate_id: key }, commAdapter);
        })();
      }
    }
    if (key && action === 'consent') {
      if (method === 'GET') {
        permit(user, 'candidates.consent.read');
        return getCandidateConsent(db, key);
      }
      if (method === 'POST' || method === 'PUT') {
        permit(user, 'candidates.consent.update');
        return setCandidateConsent(db, user, key, body.opted_out, body.reason);
      }
    }
    if (key && action === 'signatures') {
      if (method === 'GET') {
        permit(user, 'signatures.read', 'offers.read');
        const cand = get(db, 'candidates', key);
        requireTeam(user, cand.team);
        return listSignatureRequests(db, user, { candidateId: key }).map(row => redactOfferCompensation(user, row));
      }
    }
    if (key && (action === 'fraud-review' || action === 'fraud')) {
      const cand = get(db, 'candidates', key);
      requireTeam(user, cand.team);
      if (method === 'GET') {
        permit(user, 'candidates.fraud.read');
        return getOrRunFraudReview(db, cand.id, { refresh: query.get('refresh') === 'true' });
      }
      if (method === 'POST') {
        permit(user, 'candidates.fraud.manage');
        if (parts[3] === 'resolve' || body.action === 'resolve' || body.status) {
          return resolveFraudReview(db, user, cand.id, body);
        }
        return getOrRunFraudReview(db, cand.id, { refresh: true });
      }
    }
    if (key && action === 'templates') {
      if (method === 'GET') {
        permit(user, 'candidates.read', 'candidates.update');
        const cand = get(db, 'candidates', key);
        requireTeam(user, cand.team);
        const apps = db.prepare('SELECT a.id, a.requisition_id, a.stage, r.title, r.team FROM applications a JOIN requisitions r ON r.id=a.requisition_id WHERE a.candidate_id=?').all(key);
        const interviews = db.prepare('SELECT i.id, i.scheduled_at, u.name interviewer FROM interviews i JOIN applications a ON a.id=i.application_id JOIN users u ON u.id=i.interviewer_id WHERE a.candidate_id=? ORDER BY i.scheduled_at DESC').all(key);
        return {
          templates: getAvailableTemplates(),
          candidate: {
            id: cand.id,
            name: cand.name,
            team: cand.team,
            ...(can(user, 'candidates.personal.read') ? { email: cand.email } : {})
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
        if (!can(user, 'candidates.read')) return interviewerCandidateContext(db, user, key);
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
        return candidateOutput(user, c, { experience: c.resume_text, applications: apps, resume: can(user, 'candidates.resume.read') ? (resumeMeta || null) : null, can_delete: canDelete });
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
      const canSearchResume = can(user, 'candidates.resume.read');
      const canSearchContact = can(user, 'candidates.personal.read');
      return cands
        .filter(c => {
          const appText = (appsByCandidate.get(c.id) || []).map(a => `${a.title} ${a.stage}`).join(' ');
          return `${c.name} ${canSearchContact ? c.email : ''} ${c.skills} ${canSearchResume ? c.resume_text : ''} ${appText}`.toLowerCase().includes(search);
        })
        .map(c => {
          const cApps = appsByCandidate.get(c.id) || [];
          return candidateOutput(user, c, {
            experience: c.resume_text,
            applications: cApps,
            can_delete: cApps.length === 0
          });
        });
    }
    if (method === 'POST' && !key) {
      permit(user,'candidates.create');
      const defaultTeam = user.team ? userTeams(user)[0] : '';
      const rawTeam = (body.team !== undefined && body.team !== null && String(body.team).trim() !== '') ? body.team : defaultTeam;
      const team = normalizeTeamName(text(rawTeam,'Team',100));
      requireTeam(user,team);
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
          permit(user, 'applications.create');
          const req = get(db, 'requisitions', body.requisition_id);
          requireTeam(user, req.team);
          const isAdmin = can(user, 'system.override');
          if (!isAdmin && normalizeTeamName(team) !== normalizeTeamName(req.team)) throw new HttpError(409, 'Candidate and requisition must belong to the same team.');
          if (req.status !== 'open') throw new HttpError(409, 'Requisition must be approved and open.');
          const aid = id();
          const firstStage = 'Applied';
          db.prepare('INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at) VALUES(?,?,?,?,?)').run(aid, cid, req.id, firstStage, now());
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
        return candidateOutput(user, created, { experience: created.resume_text, applications: createdApps, resume: resumeMeta || null });
      });
    }
    if ((method === 'PUT' || method === 'POST') && key && !action) {
      permit(user,'candidates.update');
      if (!can(user, 'candidates.resume.read') && (body.resume_text !== undefined || body.experience !== undefined || body.resume_id)) {
        throw new HttpError(403, 'You do not have permission to change resume fields.');
      }
      if (!can(user, 'candidates.personal.read') && (body.email !== undefined || body.phone !== undefined)) {
        throw new HttpError(403, 'You do not have permission to change candidate contact details.');
      }
      const candidate = get(db,'candidates',key);
      if (candidate.deleted_at) throw new HttpError(404, 'Candidate not found.');
      requireTeam(user,candidate.team);
      const team = normalizeTeamName(text(body.team || candidate.team,'Team',100)); requireTeam(user,team);
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
        return candidateOutput(user, updated, { experience: updated.resume_text, applications: apps, resume: can(user, 'candidates.resume.read') ? (resumeMeta || null) : null });
      });
    }
    if (method === 'DELETE' && key && !action) {
      permit(user,'candidates.delete');
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
    permit(user, 'candidates.resume.upload');
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
          text: can(user, 'candidates.resume.read') ? result.text : '',
          email: can(user, 'candidates.personal.read') ? email : '',
          phone: can(user, 'candidates.personal.read') ? phone : '',
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
    permit(user,'candidates.resume.upload'); const resume = text(body.text,'Resume text',50000);
    const details = extractResumeDetails(resume, getDbSkills(db));
    const hasContact = Boolean(details.email || details.phone);
    const hasAny = Boolean(hasContact || details.name || (details.skills && details.skills.length));
    const message = hasContact
      ? 'Email and phone number extracted successfully.'
      : hasAny
        ? 'Resume details extracted successfully.'
        : 'No email or phone number found in resume text.';
    return {
      email: can(user, 'candidates.personal.read') ? details.email : '',
      phone: can(user, 'candidates.personal.read') ? details.phone : '',
      name: details.name,
      skills: details.skills,
      message,
      warning: message
    };
  }
  if (path === 'jd/draft' && method === 'POST') {
    permit(user,'requisitions.create','requisitions.update');
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
    if (method === 'GET' && !key) permit(user,'applications.read');
    else if (method === 'POST' && !key) permit(user,'applications.create');
    // Action routes below perform their own field-specific permission check.
    if (method === 'GET' && !key) {
      const apps = db.prepare(`SELECT a.*,c.name,c.email,c.skills,r.title,r.team FROM applications a JOIN candidates c ON c.id=a.candidate_id JOIN requisitions r ON r.id=a.requisition_id ORDER BY a.created_at DESC`).all().filter(a => inTeam(user,a.team));
      if (!apps.length) return [];
      try {
        const evals = db.prepare(`SELECT * FROM training_evaluations ORDER BY created_at DESC`).all();
        const evalMap = new Map();
        for (const e of evals) {
          if (!evalMap.has(e.application_id)) evalMap.set(e.application_id, e);
        }
        let draftMap = new Map();
        try {
          const drafts = db.prepare(`SELECT application_id, status, template_id, sent_at FROM training_plan_drafts`).all();
          for (const d of drafts) {
            if (!draftMap.has(d.application_id)) draftMap.set(d.application_id, d);
          }
        } catch {}
        let interviewMap = new Map();
        try {
          const interviews = db.prepare(`
            SELECT i.id, i.application_id, i.status, i.round, i.round_number, i.interviewer_id, i.scheduled_at, u.name as interviewer_name,
                   s.id as scorecard_id, s.ratings, s.recommendation, s.submitted_at
            FROM interviews i
            JOIN users u ON u.id = i.interviewer_id
            LEFT JOIN scorecards s ON s.interview_id = i.id
            ORDER BY i.scheduled_at DESC, i.created_at DESC
          `).all();
          for (const inv of interviews) {
            if (!interviewMap.has(inv.application_id)) {
              interviewMap.set(inv.application_id, []);
            }
            interviewMap.get(inv.application_id).push(inv);
          }
        } catch {}
        return apps.map(a => {
          const ev = evalMap.get(a.id);
          const dr = draftMap.get(a.id);
          const overdue = isTrainingOverdue(a);
          const effectiveStatus = resolveEffectiveTrainingStatus(a);
          const appInvs = interviewMap.get(a.id) || [];
          const nonInterviewStages = ['Applied', 'Offer', 'Pre-Onboarding Training', 'Onboarding', 'Hired', 'Rejected', 'Revoked'];
          const isInterviewStage = !nonInterviewStages.includes(a.stage);
          const pendingInv = isInterviewStage
            ? (appInvs.find(i => i.status === 'planned' && (i.round?.toLowerCase() === a.stage?.toLowerCase() || !i.round || i.round === 'Round 1'))
               || appInvs.find(i => i.status === 'planned'))
            : null;
          const latestRatedInv = appInvs.find(i => i.scorecard_id);
          const out = {
            ...a,
            is_overdue: overdue,
            effective_training_status: effectiveStatus,
            pending_interview: pendingInv || null,
            latest_scorecard: latestRatedInv ? {
              id: latestRatedInv.scorecard_id,
              interview_id: latestRatedInv.id,
              ratings: latestRatedInv.ratings,
              recommendation: latestRatedInv.recommendation,
              submitted_at: latestRatedInv.submitted_at,
              interviewer_name: latestRatedInv.interviewer_name,
              round: latestRatedInv.round
            } : null,
            ...(ev ? { training_evaluation: ev, training_rating: ev.rating, training_decision: ev.decision } : {}),
            ...(dr ? { training_plan_status: dr.status, training_plan_sent_at: dr.sent_at } : {})
          };
          if (!can(user, 'candidates.personal.read')) delete out.email;
          return out;
        });
      } catch {
        return apps.map(a => {
          if (can(user, 'candidates.personal.read')) return a;
          const { email: _email, ...safe } = a;
          return safe;
        });
      }
    }
    if (method === 'POST' && !key) {
      const candidate = get(db,'candidates',body.candidate_id), req = get(db,'requisitions',body.requisition_id);
      requireTeam(user,candidate.team); requireTeam(user,req.team);
      const isAdmin = can(user, 'system.override');
      if (!isAdmin && normalizeTeamName(candidate.team) !== normalizeTeamName(req.team)) throw new HttpError(409,'Candidate and requisition must belong to the same team.');
      if (req.status !== 'open') throw new HttpError(409,'Requisition must be approved and open.');
      const aid = id();
      return transaction(db, () => {
        db.prepare('INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at) VALUES(?,?,?,?,?)').run(aid,candidate.id,req.id,'Applied',now());
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
      permit(user, method === 'POST' ? 'applications.match' : 'applications.read');
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
          return redactMatchEvidence(user, res);
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
      return redactMatchEvidence(user, res);
    }
    if (key && (action === 'fraud-review' || action === 'fraud')) {
      const {app,req} = appContext(db,user,key);
      if (method === 'GET') {
        permit(user, 'candidates.fraud.read');
        return getOrRunFraudReview(db, app.candidate_id, { application_id: app.id, refresh: query.get('refresh') === 'true' });
      }
      if (method === 'POST') {
        permit(user, 'candidates.fraud.manage');
        if (parts[3] === 'resolve' || body.action === 'resolve' || body.status) {
          return resolveFraudReview(db, user, app.candidate_id, body);
        }
        return getOrRunFraudReview(db, app.candidate_id, { application_id: app.id, refresh: true });
      }
    }
    if (key && (action === 'training-evaluation' || action === 'training' || action === 'revoke')) {
      const { app, req } = appContext(db, user, key);
      const subAction = parts[3];

      if (action === 'revoke' && method === 'POST') {
        return revokeOffer(db, user, app, body, c);
      }

      if (action === 'training') {
        if (subAction === 'start' && method === 'POST') {
          return startTraining(db, user, app, body);
        }
        if (subAction === 'extend-deadline' && method === 'POST') {
          return extendTrainingDeadline(db, user, app, body);
        }
        if (subAction === 'restart' && method === 'POST') {
          return restartTraining(db, user, app, body);
        }
        if ((subAction === 'revoke' || subAction === 'revoke-offer') && method === 'POST') {
          return revokeOffer(db, user, app, body, c);
        }
        if (subAction === 'history' && method === 'GET') {
          return getTrainingHistory(db, user, app);
        }
        throw new HttpError(404, 'Unknown training action.');
      }

      if (action === 'training-evaluation') {
        if (method === 'GET') {
          permit(user, 'applications.read', 'recruit', 'review');
          const evalRow = db.prepare(`
            SELECT te.*, u.name AS evaluator_name, u.email AS evaluator_email
            FROM training_evaluations te
            JOIN users u ON u.id = te.evaluator_id
            WHERE te.application_id = ?
            ORDER BY te.created_at DESC LIMIT 1
          `).get(app.id);
          const overdue = isTrainingOverdue(app);
          const effectiveStatus = resolveEffectiveTrainingStatus(app);
          return {
            evaluation: evalRow || null,
            training_status: app.training_status,
            effective_status: effectiveStatus,
            is_overdue: overdue,
            attempt: app.training_attempt || 1,
            start_at: app.training_start_at,
            end_at: app.training_end_at,
            original_end_at: app.training_original_end_at
          };
        }

        if (method === 'POST') {
          permit(user, 'applications.evaluate', 'recruit', 'admin');
          return evaluateTraining(db, user, app, body, c);
        }
        throw new HttpError(405, 'Method not allowed.');
      }
    }
    if (key && (action === 'training-plan' || action === 'training-draft')) {
      const subAction = parts[3];
      if (subAction === 'suggest' && method === 'GET') {
        permit(user, 'recruit', 'review', 'admin');
        return suggestTrainingPlan(db, { applicationId: key });
      }
      if (subAction === 'preview' && method === 'POST') {
        permit(user, 'recruit', 'review', 'admin');
        return previewTrainingEmail(db, user, key, body);
      }
      if (subAction === 'discard' && method === 'POST') {
        permit(user, 'recruit', 'admin');
        return discardTrainingDraft(db, user, key);
      }
      if (subAction === 'send' && method === 'POST') {
        permit(user, 'recruit', 'admin');
        return sendTrainingPlan(db, user, key, body, { communicationAdapter: c?.communicationAdapter, transport: c?.transport });
      }
      if (subAction === 'resend' && method === 'POST') {
        permit(user, 'recruit', 'admin');
        return resendTrainingPlan(db, user, key, body, { communicationAdapter: c?.communicationAdapter, transport: c?.transport });
      }
      if (!subAction && method === 'GET') {
        permit(user, 'recruit', 'review', 'admin');
        return getOrCreateTrainingDraft(db, user, key);
      }
      if (!subAction && method === 'PUT') {
        permit(user, 'recruit', 'admin');
        return saveTrainingDraft(db, user, key, body);
      }
    }
    if (key && (action === 'hrms-handoff' || action === 'handoff') && method === 'POST') {
      permit(user, 'applications.hrms_handoff');
      const { app, req } = appContext(db, user, key);
      const hrmsEffective = getEffectiveIntegrationConfig(db, 'hrms');
      if (!hrmsEffective.enabled || !hrmsEffective.isConfigured) {
        throw new HttpError(400, 'HRMS integration is not enabled or configured. Please configure HRMS in Admin Settings.');
      }
      return (async () => {
        const hrmsAdapter = c?.hrmsAdapter || new HrmsAdapter({ db, transport: c?.transport });
        const cand = db.prepare('SELECT * FROM candidates WHERE id = ?').get(app.candidate_id);
        const offerDetails = getAuthoritativeOfferDetails(db, key, app.candidate_id, req?.id, req);

        const resumeMeta = db.prepare(`
          SELECT id, storage_id, filename, file_format, file_size, mime_type
          FROM candidate_resumes
          WHERE candidate_id = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(app.candidate_id);

        const appOrigin = c?.origin || process.env.APP_ORIGIN || 'http://localhost:3000';
        const signedDocUrl = (offerDetails.storagePath && offerDetails.requestId)
          ? `${appOrigin}/api/signatures/${offerDetails.requestId}/document?version=signed`
          : null;

        const resumeStoragePath = resumeMeta?.storage_id
          ? resolve('data/resumes/approved', `${resumeMeta.storage_id}.bin`)
          : null;

        const resumeInfo = resumeMeta ? {
          id: resumeMeta.id,
          filename: resumeMeta.filename,
          mime_type: resumeMeta.mime_type || (resumeMeta.file_format === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
          file_size: resumeMeta.file_size,
          storage_path: (resumeStoragePath && existsSync(resumeStoragePath)) ? resumeStoragePath : null,
          download_url: `${appOrigin}/api/candidates/${cand.id}/resume`
        } : null;

        const offerCurrency = offerDetails.currency || req?.currency || 'USD';

        const handoffResult = await hrmsAdapter.handoff({
          hireId: key,
          approvedFields: {
            candidate: cand,
            requisition: req,
            offer: {
              annual_salary: offerDetails.salary,
              salary: offerDetails.salary,
              currency: offerCurrency,
              currency_code: offerCurrency,
              salary_currency: offerCurrency,
              ...(offerDetails.joiningDate ? { joining_date: offerDetails.joiningDate } : {}),
              signed_document_url: signedDocUrl
            },
            ...(offerDetails.salary !== null && offerDetails.salary !== undefined ? { salary: offerDetails.salary } : {}),
            currency: offerCurrency,
            currency_code: offerCurrency,
            salary_currency: offerCurrency,
            ...(offerDetails.joiningDate ? {
              joining_date: offerDetails.joiningDate,
              date_of_joining: offerDetails.joiningDate
            } : {}),
            resume: resumeInfo
          },
          idempotencyKey: `hrms_manual_${key}_${Date.now()}`
        });

        audit(db, user.id, 'application.hrms_handoff_success', key, {
          employeeId: handoffResult.employeeId || handoffResult.providerReference,
          provider: handoffResult.provider || 'hrms',
          documentAttached: Boolean(handoffResult.document),
          resumeAttached: Boolean(handoffResult.resume)
        });

        return handoffResult;
      })();
    }
    if (method === 'POST' && action === 'stage') {
      permit(user,'applications.update'); const {app,req} = appContext(db,user,key), stages = pipeline(db);
      if (!stages.includes(body.stage)) throw new HttpError(400,'Unknown pipeline stage.');
      if (body.stage === app.stage) {
        throw new HttpError(400, `Application is already in ${app.stage} stage.`);
      }

      // 1. Offer revocation check: cannot advance if candidate's offer was revoked
      if (app.offer_status === 'revoked' && !['Rejected', 'Revoked'].includes(body.stage)) {
        throw new HttpError(409, 'Cannot advance candidate: The candidate offer has been revoked.');
      }

      // 2. Offer signature verification for gated post-offer stages
      if (body.stage === 'Pre-Onboarding Training' || /pre-onboarding/i.test(body.stage)) {
        const sigCheck = verifyApplicationOfferSignature(db, key, app.candidate_id, req.id);
        if (!sigCheck.verified) {
          throw new HttpError(409, `Cannot advance to Pre-Onboarding Training: The candidate must sign the offer letter before starting pre-onboarding training. ${sigCheck.reason}`);
        }
      }
      if (body.stage === 'Onboarding' || /onboarding/i.test(body.stage)) {
        const sigCheck = verifyApplicationOfferSignature(db, key, app.candidate_id, req.id);
        if (!sigCheck.verified) {
          throw new HttpError(409, `Cannot advance to Onboarding: The candidate must sign the offer letter before proceeding. ${sigCheck.reason}`);
        }
      }
      if (body.stage === 'Hired') {
        const sigCheck = verifyApplicationOfferSignature(db, key, app.candidate_id, req.id);
        if (!sigCheck.verified) {
          throw new HttpError(409, sigCheck.reason);
        }
      }
      const fromIdx = stages.indexOf(app.stage);
      const toIdx = stages.indexOf(body.stage);
      const isAdvancing = toIdx > fromIdx && !['Rejected', 'Revoked'].includes(body.stage);

      // 3. Pre-onboarding training rating & evaluation gate:
      // Without passing rating and passed evaluation, candidate cannot be moved to next stage!
      if (/pre-onboarding|training/i.test(app.stage) && isAdvancing) {
        const latestEval = db.prepare(`
          SELECT * FROM training_evaluations 
          WHERE application_id = ? 
          ORDER BY attempt DESC, created_at DESC LIMIT 1
        `).get(key);

        const passingEval = db.prepare(`
          SELECT id FROM training_evaluations 
          WHERE application_id = ? AND status = 'passed' AND rating >= 3
          ORDER BY created_at DESC LIMIT 1
        `).get(key);

        if (!latestEval && app.training_status !== 'completed') {
          if (!app.training_start_at || app.training_status === 'not_started') {
            throw new HttpError(409, 'Cannot advance candidate: Pre-onboarding training has not started. A passing performance rating and evaluation are required before moving to the next stage.');
          }
          throw new HttpError(409, 'Cannot advance candidate: Pre-onboarding training performance rating and passing evaluation are required before moving to the next stage.');
        }

        if (latestEval && (latestEval.status === 'failed' || latestEval.rating < 3 || app.training_status === 'evaluation_failed')) {
          throw new HttpError(409, `Cannot advance candidate: Candidate failed training evaluation (Rating: ${latestEval.rating}/5, Status: ${latestEval.status}). Training must be restarted and passed with a satisfactory rating before moving to the next stage.`);
        }

        if (!passingEval && app.training_status !== 'completed') {
          throw new HttpError(409, 'Cannot advance candidate: Pre-onboarding training performance rating and passing evaluation are required before moving to the next stage.');
        }

        if (isTrainingOverdue(app) && app.training_status !== 'completed') {
          throw new HttpError(409, 'Cannot advance candidate: Training deadline has passed. Please extend deadline or restart training before evaluating.');
        }
      }

      const isAdmin = can(user, 'applications.override') || can(user, 'system.override') || can(user, 'admin');

      // 4. Interview round evaluation & rating validations:
      if (isAdvancing) {
        const nonInterviewStages = ['Applied', 'Offer', 'Pre-Onboarding Training', 'Onboarding', 'Hired', 'Rejected', 'Revoked'];
        const isInterviewStage = !nonInterviewStages.includes(app.stage);

        if (isInterviewStage) {
          // Any scheduled interview for this application's current round that is planned / unrated
          const plannedInterview = db.prepare(`
            SELECT i.*, u.name as interviewer_name 
            FROM interviews i
            JOIN users u ON u.id = i.interviewer_id
            WHERE i.application_id = ? AND i.status = 'planned' 
              AND (i.round = ? OR (i.round IS NULL AND ? != 'Applied'))
            ORDER BY i.scheduled_at ASC LIMIT 1
          `).get(key, app.stage, app.stage);
          if (plannedInterview && !isAdmin) {
            throw new HttpError(409, `Cannot advance candidate: An interview with ${plannedInterview.interviewer_name} is scheduled for ${plannedInterview.round || app.stage} and has not been rated. A completed scorecard rating is required before moving to the next stage.`);
          }
        }

        // Any completed interview missing a scorecard
        const unratedCompleted = db.prepare(`
          SELECT i.*, u.name as interviewer_name 
          FROM interviews i
          JOIN users u ON u.id = i.interviewer_id
          LEFT JOIN scorecards s ON s.interview_id = i.id
          WHERE i.application_id = ? AND i.status = 'completed' AND s.id IS NULL
          LIMIT 1
        `).get(key);
        if (unratedCompleted && !isAdmin) {
          throw new HttpError(409, `Cannot advance candidate: Completed interview with ${unratedCompleted.interviewer_name} for ${unratedCompleted.round || app.stage} is missing a scorecard rating.`);
        }
      }

      // 5. Negative interview scorecard recommendation check
      const latestScorecard = isAdvancing ? db.prepare(`
        SELECT s.*, i.round, u.name as author_name
        FROM scorecards s
        JOIN interviews i ON i.id = s.interview_id
        JOIN users u ON u.id = s.author
        WHERE i.application_id = ?
        ORDER BY s.submitted_at DESC LIMIT 1
      `).get(key) : null;
      const isNegativeRec = Boolean(latestScorecard && ['No', 'Strong no'].includes(latestScorecard.recommendation));
      const isTerminal = ['Hired','Rejected','Revoked'].includes(app.stage);
      const isSequential = isAllowedStageProgression(app.stage, body.stage, stages);
      const hiredCount = db.prepare("SELECT count(*) n FROM applications WHERE requisition_id=? AND stage='Hired'").get(req.id).n;
      const isOverHeadcount = body.stage === 'Hired' && hiredCount >= req.headcount;

      const hasRuleViolation = isTerminal || !isSequential || isOverHeadcount || isNegativeRec;
      let isOverride = false;
      let overrideReason = '';
      let bypassedRule = '';

      if (hasRuleViolation) {
        if (!isAdmin) {
          if (isTerminal) throw new HttpError(409,'Terminal applications cannot be moved.');
          if (!isSequential) throw new HttpError(409,'Move to the next stage or reject the application.');
          if (isOverHeadcount) throw new HttpError(409,'Approved headcount is filled.');
          if (isNegativeRec) throw new HttpError(409,`Cannot advance candidate: Candidate received a negative recommendation ('${latestScorecard.recommendation}') from ${latestScorecard.author_name} for ${latestScorecard.round || 'interview'}. Advancing requires administrative override.`);
        }
        if (!body.admin_override && !body.override && !body.override_reason && !body.reason) {
          if (isTerminal) throw new HttpError(409,'Terminal applications cannot be moved without administrative override.');
          if (!isSequential) throw new HttpError(409,'Non-sequential stage transition requires administrative override.');
          if (isOverHeadcount) throw new HttpError(409,'Hiring beyond approved headcount requires administrative override.');
          if (isNegativeRec) throw new HttpError(409,`Advancing a candidate with negative recommendation ('${latestScorecard.recommendation}') requires administrative override.`);
        }
        isOverride = true;
        overrideReason = text(body.override_reason || body.reason || 'Administrative pipeline correction', 'Override reason', 2000, true);
        bypassedRule = [
          isTerminal ? 'terminal_stage' : '',
          !isSequential ? 'non_sequential_transition' : '',
          isOverHeadcount ? 'headcount_limit' : '',
          isNegativeRec ? 'negative_recommendation' : ''
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

      const emailConfigured = (isEmailConfigured(db, c) || Boolean(c?.communicationAdapter)) && body.send_notification !== false;
      const hrmsEffective = getEffectiveIntegrationConfig(db, 'hrms');
      const hrmsSyncEnabled = Boolean(
        hrmsEffective.enabled &&
        hrmsEffective.isConfigured &&
        hrmsEffective.config?.syncEnabled
      );

      if ((emailConfigured && app.stage !== body.stage) || (body.stage === 'Hired' && hrmsSyncEnabled)) {
        return (async () => {
          // 1. Candidate email notification
          if (emailConfigured && app.stage !== body.stage) {
            await sendStageTransitionNotification({
              db,
              user,
              applicationId: key,
              oldStage: app.stage,
              newStage: body.stage,
              requisition: req,
              notes: body.notes || body.comment || '',
              sendNotification: body.send_notification !== false,
              config: c,
              adapter: c?.communicationAdapter,
              templateId: body.template_id || (body.stage === 'Rejected' ? 'application_rejection' : 'stage_update')
            });
          }

          // 2. Automated HRMS employee onboarding handoff
          if (body.stage === 'Hired' && hrmsSyncEnabled) {
            try {
              const hrmsAdapter = c?.hrmsAdapter || new HrmsAdapter({ db, transport: c?.transport });
              const cand = db.prepare('SELECT * FROM candidates WHERE id = ?').get(app.candidate_id);
              const offerDetails = getAuthoritativeOfferDetails(db, key, app.candidate_id, req?.id, req);

              const resumeMeta = db.prepare(`
                SELECT id, storage_id, filename, file_format, file_size, mime_type
                FROM candidate_resumes
                WHERE candidate_id = ?
                ORDER BY created_at DESC LIMIT 1
              `).get(app.candidate_id);

              const appOrigin = c?.origin || process.env.APP_ORIGIN || 'http://localhost:3000';
              const signedDocUrl = (offerDetails.storagePath && offerDetails.requestId)
                ? `${appOrigin}/api/signatures/${offerDetails.requestId}/document?version=signed`
                : null;

              const resumeStoragePath = resumeMeta?.storage_id
                ? resolve('data/resumes/approved', `${resumeMeta.storage_id}.bin`)
                : null;

              const resumeInfo = resumeMeta ? {
                id: resumeMeta.id,
                filename: resumeMeta.filename,
                mime_type: resumeMeta.mime_type || (resumeMeta.file_format === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
                file_size: resumeMeta.file_size,
                storage_path: (resumeStoragePath && existsSync(resumeStoragePath)) ? resumeStoragePath : null,
                download_url: `${appOrigin}/api/candidates/${cand.id}/resume`
              } : null;

              const offerCurrency = offerDetails.currency || req?.currency || 'USD';

              const handoffResult = await hrmsAdapter.handoff({
                hireId: key,
                approvedFields: {
                  candidate: cand,
                  requisition: req,
                  offer: {
                    annual_salary: offerDetails.salary,
                    salary: offerDetails.salary,
                    currency: offerCurrency,
                    currency_code: offerCurrency,
                    salary_currency: offerCurrency,
                    ...(offerDetails.joiningDate ? { joining_date: offerDetails.joiningDate } : {}),
                    signed_document_url: signedDocUrl
                  },
                  ...(offerDetails.salary !== null && offerDetails.salary !== undefined ? { salary: offerDetails.salary } : {}),
                  currency: offerCurrency,
                  currency_code: offerCurrency,
                  salary_currency: offerCurrency,
                  ...(offerDetails.joiningDate ? {
                    joining_date: offerDetails.joiningDate,
                    date_of_joining: offerDetails.joiningDate
                  } : {}),
                  resume: resumeInfo
                },
                idempotencyKey: `hrms_handoff_${key}`
              });

              audit(db, user.id, 'application.hrms_handoff_success', key, {
                employeeId: handoffResult.employeeId || handoffResult.providerReference,
                provider: handoffResult.provider || 'hrms',
                documentAttached: Boolean(handoffResult.document),
                resumeAttached: Boolean(handoffResult.resume)
              });
            } catch (hrmsErr) {
              audit(db, user.id, 'application.hrms_handoff_failed', key, {
                error: hrmsErr.message
              });
            }
          }

          return updatedApp;
        })();
      }

      return updatedApp;
    }
    if (key && action === 'retry-stage-notification' && method === 'POST') {
      permit(user, 'recruit');
      const { app, req } = appContext(db, user, key, true);
      const lastEvent = db.prepare('SELECT * FROM stage_events WHERE application_id = ? ORDER BY at DESC LIMIT 1').get(key);
      if (!lastEvent) {
        throw new HttpError(400, 'No stage transition found to retry notification for.');
      }
      const cand = db.prepare('SELECT id, name, email, team FROM candidates WHERE id = ?').get(app.candidate_id);
      if (!cand || !cand.email) {
        throw new HttpError(400, 'Candidate does not have a valid email address.');
      }
      return (async () => {
        const result = await sendStageTransitionNotification({
          db,
          user,
          applicationId: key,
          oldStage: lastEvent.from_stage,
          newStage: lastEvent.to_stage,
          candidate: cand,
          requisition: req,
          notes: body.notes || '',
          sendNotification: true,
          config: c,
          adapter: c?.communicationAdapter
        });
        return { success: result.sent, result };
      })();
    }
  }
  if (parts[0] === 'interviews') {
    permit(user,'interviews.read','interviews.schedule','interviews.update','interviews.cancel','interviews.evaluate','interviews.proxy_evaluate','interviews.feedback.read');
    if (method === 'GET' && key === 'calendar-status') {
      const calEffective = getEffectiveIntegrationConfig(db, 'microsoft_calendar');
      const configured = Boolean((calEffective.enabled && calEffective.isConfigured) || isCalendarConfigured(c, db) || c?.calendarAdapter);
      return { configured, status: configured ? 'active' : 'not_configured' };
    }
    if (method === 'GET' && !key) return db.prepare(`SELECT i.*,a.candidate_id,c.name,r.title,r.team,u.name interviewer FROM interviews i
      JOIN applications a ON a.id=i.application_id JOIN candidates c ON c.id=a.candidate_id JOIN requisitions r ON r.id=a.requisition_id JOIN users u ON u.id=i.interviewer_id`).all().filter(i => (user._scope === 'assigned' || user.role === 'Interviewer') ? i.interviewer_id === user.id : inTeam(user,i.team));
    if (method === 'GET' && key && !action) {
      const interview = get(db, 'interviews', key);
      appContext(db, user, interview.application_id, true);
      return interviewContextView(db, interview, user);
    }
    if (method === 'POST' && !key) {
      permit(user,'interviews.schedule'); const {app,req} = appContext(db,user,body.application_id), interviewer = get(db,'users',body.interviewer_id);
      if (['Hired','Rejected'].includes(app.stage)) throw new HttpError(409,'Cannot interview a closed application.');
      if (interviewer.status !== 'active' || !['Interviewer','Hiring Manager','Recruiter','TA Manager','TA Director','System Admin'].includes(interviewer.role) || !inTeam(interviewer,req.team)) throw new HttpError(400,'Choose an active interviewer who can access this team.');
      const scheduled = new Date(body.scheduled_at); if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < Date.now()) throw new HttpError(400,'Enter a future interview date.');
      const competencies = list(body.competencies,'Competencies',25); if (!competencies.length) throw new HttpError(400,'At least one competency is required.');
      const duration = body.duration_minutes !== undefined ? integer(body.duration_minutes, 'Duration', 15, 480) : 45;
      const timezone = body.timezone ? text(body.timezone, 'Timezone', 100, false) : 'Asia/Kolkata';
      const interviewType = body.interview_type === 'in_person' ? 'in_person' : 'virtual';
      const location = body.location !== undefined ? (text(body.location, 'Location', 500, true) || (interviewType === 'in_person' ? 'Mechlin Technologies Office' : '')) : (interviewType === 'in_person' ? 'Mechlin Technologies Office' : '');
      const notes = body.notes ? text(body.notes, 'Notes', 5000, false) : '';
      const customMeetingUrl = interviewType === 'in_person' ? null : (body.meeting_url ? text(body.meeting_url, 'Meeting URL', 1000, false) : null);
      const cand = get(db, 'candidates', app.candidate_id);
      const existingInterviews = db.prepare('SELECT count(*) n FROM interviews WHERE application_id=?').get(app.id).n;
      const roundNumber = body.round_number ? integer(body.round_number, 'Round Number', 1, 20) : (existingInterviews + 1);
      const round = body.round ? text(body.round, 'Round', 100, false) : `Round ${roundNumber}`;
      const title = body.title ? text(body.title, 'Title', 200, false) : `${round}: ${cand.name} — ${req.title}`;
      const iid = id();
      transaction(db, () => {
        db.prepare('INSERT INTO interviews(id,application_id,interviewer_id,scheduled_at,competencies,title,duration_minutes,timezone,notes,status,calendar_status,meeting_url,round,round_number,interview_type,location,invitation_status,invitation_error,meeting_error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
          iid, app.id, interviewer.id, scheduled.toISOString(), JSON.stringify(competencies), title, duration, timezone, notes, 'planned', customMeetingUrl ? 'manual_link' : 'not_synced', customMeetingUrl, round, roundNumber, interviewType, location, 'pending', '', '', now()
        );
        audit(db, user.id, 'interview.planned', iid, { scheduled_at: scheduled.toISOString(), interviewer_id: interviewer.id, duration_minutes: duration, timezone, meeting_url: customMeetingUrl, round, round_number: roundNumber, interview_type: interviewType, location });
      });
      const calConfigured = isCalendarConfigured(c, db) || Boolean(c?.calendarAdapter);
      const emailConfigured = (isEmailConfigured(db) || Boolean(c?.communicationAdapter)) && body.send_invitation !== false;
      if (calConfigured || emailConfigured) {
        return (async () => {
          let meetingUrl = customMeetingUrl;
          if (calConfigured) {
            const calResult = await syncScheduleMeeting({
              db, user, interviewId: iid, scheduledAt: scheduled.toISOString(), durationMinutes: duration, timezone, title, notes, candidate: cand, req, interviewer, transport: c?.calendarAdapter?.transport || c?.transport || fetch, config: c,
              interviewType, location
            });
            meetingUrl = interviewType === 'in_person' ? null : (calResult.meeting_url || customMeetingUrl);
          }
          if (meetingUrl && meetingUrl !== customMeetingUrl) {
            db.prepare('UPDATE interviews SET meeting_url = ? WHERE id = ?').run(meetingUrl, iid);
          }
          if (emailConfigured) {
            if (interviewType === 'virtual' && !meetingUrl) {
              db.prepare("UPDATE interviews SET invitation_status = 'pending', invitation_error = 'Waiting for valid Teams meeting link' WHERE id = ?").run(iid);
              audit(db, user.id, 'interview.invitation_held', iid, {
                reason: 'Online interview missing valid Teams join URL'
              });
            } else {
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
                  interview_type: interviewType,
                  location,
                  idempotency_key: `interview_invite_${iid}`
                }, commAdapter);
                db.prepare("UPDATE interviews SET invitation_status = 'accepted', invitation_error = '' WHERE id = ?").run(iid);
                audit(db, user.id, 'interview.invitation_sent', iid, {
                  candidate_id: cand.id,
                  recipient: cand.email,
                  meeting_url: meetingUrl
                });
              } catch (emailErr) {
                db.prepare("UPDATE interviews SET invitation_status = 'failed', invitation_error = ? WHERE id = ?").run(emailErr.message, iid);
                audit(db, user.id, 'communication.invitation_failed', iid, { error: emailErr.message });
              }
            }
          } else {
            db.prepare("UPDATE interviews SET invitation_status = 'not_required' WHERE id = ?").run(iid);
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
      if (!can(user, 'interviews.update') && interview.interviewer_id !== user.id) {
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
        permit(user, 'interviews.update');
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
        if (!can(user, 'interviews.update') && !can(user, 'recruit') && !can(user, 'admin') && interview.interviewer_id !== user.id) {
          throw new HttpError(403, 'Your role cannot perform this action.');
        }
        competencies = list(body.competencies, 'Competencies', 25);
        if (!competencies.length) throw new HttpError(400, 'At least one competency is required.');
      }
      const duration = body.duration_minutes !== undefined ? integer(body.duration_minutes, 'Duration', 15, 480) : (interview.duration_minutes || 45);
      const timezone = body.timezone !== undefined ? text(body.timezone, 'Timezone', 100, false) : (interview.timezone || 'Asia/Kolkata');
      const notes = body.notes !== undefined ? text(body.notes, 'Notes', 5000, false) : (interview.notes || '');
      const title = body.title !== undefined ? text(body.title, 'Title', 200, false) : (interview.title || '');
      const cand = get(db, 'candidates', app.candidate_id);
      const interviewType = body.interview_type !== undefined ? (body.interview_type === 'in_person' ? 'in_person' : 'virtual') : (interview.interview_type || 'virtual');
      const location = body.location !== undefined
        ? (text(body.location, 'Location', 500, true) || (interviewType === 'in_person' ? 'Mechlin Technologies Office' : ''))
        : (interview.location || (interviewType === 'in_person' ? 'Mechlin Technologies Office' : ''));
      const customMeetingUrl = interviewType === 'in_person'
        ? null
        : (body.meeting_url !== undefined
            ? (body.meeting_url && String(body.meeting_url).trim() !== '' ? text(String(body.meeting_url).trim(), 'Meeting URL', 1000, false) : null)
            : interview.meeting_url);

      transaction(db, () => {
        db.prepare('UPDATE interviews SET scheduled_at=?, interviewer_id=?, competencies=?, duration_minutes=?, timezone=?, notes=?, title=?, meeting_url=?, interview_type=?, location=? WHERE id=?').run(
          scheduled.toISOString(), interviewerId, JSON.stringify(competencies), duration, timezone, notes, title, customMeetingUrl, interviewType, location, key
        );
        audit(db, user.id, 'interview.updated', key, { scheduled_at: scheduled.toISOString(), interviewer_id: interviewerId, duration_minutes: duration, meeting_url: customMeetingUrl, interview_type: interviewType, location });
      });

      const calConfigured = isCalendarConfigured(c, db) || Boolean(c?.calendarAdapter);
      const emailConfigured = (isEmailConfigured(db) || Boolean(c?.communicationAdapter)) && body.send_notification !== false;
      if (calConfigured || emailConfigured) {
        return (async () => {
          let meetingUrl = customMeetingUrl;
          if (calConfigured) {
            const calResult = await syncRescheduleMeeting({
              db, user, interviewId: key, scheduledAt: scheduled.toISOString(), durationMinutes: duration, timezone, title, notes, candidate: cand, req, interviewer: assignedInterviewer, transport: c?.calendarAdapter?.transport || c?.transport || fetch, config: c,
              interviewType, location
            });
            meetingUrl = interviewType === 'in_person' ? null : (calResult.meeting_url || customMeetingUrl);
          }
          if (meetingUrl && meetingUrl !== customMeetingUrl) {
            db.prepare('UPDATE interviews SET meeting_url = ? WHERE id = ?').run(meetingUrl, key);
          }
          if (emailConfigured) {
            if (interviewType === 'virtual' && !meetingUrl) {
              db.prepare("UPDATE interviews SET invitation_status = 'pending', invitation_error = 'Waiting for valid Teams meeting link' WHERE id = ?").run(key);
              audit(db, user.id, 'interview.invitation_held', key, {
                reason: 'Online interview missing valid Teams join URL on update'
              });
            } else {
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
                  interview_type: interviewType,
                  location,
                  idempotency_key: `interview_update_${key}_${scheduled.getTime()}`
                }, commAdapter);
                db.prepare("UPDATE interviews SET invitation_status = 'accepted', invitation_error = '' WHERE id = ?").run(key);
                audit(db, user.id, 'interview.invitation_updated', key, {
                  candidate_id: cand.id,
                  recipient: cand.email,
                  meeting_url: meetingUrl
                });
              } catch (emailErr) {
                db.prepare("UPDATE interviews SET invitation_status = 'failed', invitation_error = ? WHERE id = ?").run(emailErr.message, key);
                audit(db, user.id, 'communication.update_failed', key, { error: emailErr.message });
              }
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
      if (!can(user, 'interviews.cancel') && interview.interviewer_id !== user.id) {
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
        db.prepare("UPDATE interviews SET status='cancelled', calendar_status='cancelled', invitation_status='cancelled' WHERE id=?").run(key);
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
    if (key && action === 'retry-meeting' && method === 'POST') {
      permit(user, 'recruit', 'interview');
      const interview = get(db, 'interviews', key);
      const { app, req } = appContext(db, user, interview.application_id, true);
      if (interview.status === 'completed' || interview.status === 'cancelled') {
        throw new HttpError(409, `Cannot retry meeting sync for a ${interview.status} interview.`);
      }
      if (interview.interview_type === 'in_person') {
        throw new HttpError(400, 'Physical / in-person interviews do not use Microsoft Teams online meetings.');
      }
      const calConfigured = isCalendarConfigured(c, db) || Boolean(c?.calendarAdapter);
      if (!calConfigured) {
        throw new HttpError(400, 'Microsoft Calendar integration is not configured.');
      }
      const cand = get(db, 'candidates', app.candidate_id);
      const interviewer = get(db, 'users', interview.interviewer_id);
      return (async () => {
        const calResult = await syncScheduleMeeting({
          db, user, interviewId: key, scheduledAt: interview.scheduled_at, durationMinutes: interview.duration_minutes, timezone: interview.timezone, title: interview.title, notes: interview.notes, candidate: cand, req, interviewer, transport: c?.calendarAdapter?.transport || c?.transport || fetch, config: c,
          interviewType: 'virtual', location: ''
        });
        if (calResult.synced && calResult.meeting_url) {
          const emailConfigured = (isEmailConfigured(db) || Boolean(c?.communicationAdapter)) && body.send_invitation !== false;
          if (emailConfigured && interview.invitation_status !== 'accepted') {
            try {
              const commAdapter = c?.communicationAdapter || new CommunicationAdapter({ db, fromEnv: true, transport: c?.transport });
              await sendCandidateCommunication(db, user, {
                candidate_id: cand.id,
                requisition_id: req.id,
                template_id: 'interview_invitation',
                scheduled_at: interview.scheduled_at,
                duration_minutes: interview.duration_minutes,
                timezone: interview.timezone,
                interviewer_name: interviewer.name,
                meeting_url: calResult.meeting_url,
                notes: interview.notes || undefined,
                interview_type: 'virtual',
                idempotency_key: `interview_invite_${key}`
              }, commAdapter);
              db.prepare("UPDATE interviews SET invitation_status = 'accepted', invitation_error = '' WHERE id = ?").run(key);
            } catch (invErr) {
              db.prepare("UPDATE interviews SET invitation_status = 'failed', invitation_error = ? WHERE id = ?").run(invErr.message, key);
            }
          }
        }
        return get(db, 'interviews', key);
      })();
    }
    if (key && action === 'retry-invitation' && method === 'POST') {
      permit(user, 'recruit', 'interview');
      const interview = get(db, 'interviews', key);
      const { app, req } = appContext(db, user, interview.application_id, true);
      if (interview.status === 'completed' || interview.status === 'cancelled') {
        throw new HttpError(409, `Cannot resend invitation for a ${interview.status} interview.`);
      }
      const isPhysical = interview.interview_type === 'in_person';
      if (!isPhysical && !interview.meeting_url) {
        throw new HttpError(400, 'Cannot send invitation: Microsoft Teams meeting link is missing. Retry meeting creation first.');
      }
      const emailConfigured = isEmailConfigured(db) || Boolean(c?.communicationAdapter);
      if (!emailConfigured) {
        throw new HttpError(400, 'Email communication is not configured.');
      }
      const cand = get(db, 'candidates', app.candidate_id);
      const interviewer = get(db, 'users', interview.interviewer_id);
      return (async () => {
        const commAdapter = c?.communicationAdapter || new CommunicationAdapter({ db, fromEnv: true, transport: c?.transport });
        const idempotencyKey = `interview_invite_${key}_retry_${Date.now()}`;
        try {
          await sendCandidateCommunication(db, user, {
            candidate_id: cand.id,
            requisition_id: req.id,
            template_id: 'interview_invitation',
            scheduled_at: interview.scheduled_at,
            duration_minutes: interview.duration_minutes,
            timezone: interview.timezone,
            interviewer_name: interviewer.name,
            meeting_url: isPhysical ? undefined : interview.meeting_url,
            notes: interview.notes || undefined,
            interview_type: interview.interview_type,
            location: interview.location,
            idempotency_key: idempotencyKey
          }, commAdapter);
          db.prepare("UPDATE interviews SET invitation_status = 'accepted', invitation_error = '' WHERE id = ?").run(key);
          audit(db, user.id, 'interview.invitation_retried', key, { candidate_id: cand.id, recipient: cand.email });
        } catch (invErr) {
          db.prepare("UPDATE interviews SET invitation_status = 'failed', invitation_error = ? WHERE id = ?").run(invErr.message, key);
          throw invErr;
        }
        return get(db, 'interviews', key);
      })();
    }
    if (key && action === 'scorecards') {
      const interview = get(db,'interviews',key); appContext(db,user,interview.application_id,true);
      if (method === 'POST') {
        permit(user, 'interviews.evaluate', 'interviews.proxy_evaluate');
        const isAdmin = can(user, 'interviews.proxy_evaluate');
        const isAssigned = interview.interviewer_id === user.id;
        if (!isAssigned && !isAdmin) {
          throw new HttpError(403,'Only the assigned interviewer can submit this scorecard.');
        }
        let schedStr = String(interview.scheduled_at || '').trim();
        if (schedStr && !schedStr.endsWith('Z') && !schedStr.includes('+')) {
          schedStr = schedStr.replace(' ', 'T') + (schedStr.length === 10 ? 'T00:00:00Z' : 'Z');
        }
        const scheduledTime = Date.parse(schedStr);
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
        if (!body.ratings || typeof body.ratings !== 'object' || Array.isArray(body.ratings)) {
          throw new HttpError(400, 'Ratings must be an object.');
        }
        const ratingEntries = Object.entries(body.ratings);
        if (!ratingEntries.length) {
          throw new HttpError(400, 'At least one competency rating is required.');
        }
        if (ratingEntries.length > 25) {
          throw new HttpError(400, 'Competencies must be at most 25 items.');
        }
        const sanitizedRatings = {};
        for (const [rawComp, score] of ratingEntries) {
          const comp = text(rawComp, 'Competency name', 100);
          integer(score, comp, 1, 5);
          sanitizedRatings[comp] = score;
        }
        if (!['Strong yes','Yes','No','Strong no'].includes(body.recommendation)) throw new HttpError(400,'Choose a recommendation.');
        const notes = text(body.notes,'Evidence notes',10000), sid = id();
        const proxyFor = isProxy ? interview.interviewer_id : null;
        const evaluatedComps = Object.keys(sanitizedRatings);
        return transaction(db, () => {
          db.prepare('INSERT INTO scorecards(id,interview_id,author,ratings,recommendation,notes,submitted_at,proxy_for,proxy_reason) VALUES(?,?,?,?,?,?,?,?,?)').run(
            sid,key,user.id,JSON.stringify(sanitizedRatings),body.recommendation,notes,now(),proxyFor,proxyReason
          );
          db.prepare("UPDATE interviews SET status='completed', competencies=? WHERE id=?").run(JSON.stringify(evaluatedComps), key);
          const auditDetail = {
            interview_id: key,
            application_id: interview.application_id,
            recommendation: body.recommendation,
            competencies: evaluatedComps
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
        permit(user, 'interviews.feedback.read', 'interviews.evaluate');
        const isAdmin = can(user, 'interviews.feedback.read');
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
    permit(user,'interviews.schedule','interviews.read'); return db.prepare("SELECT * FROM users WHERE status='active'").all().filter(u => inTeam(user,u.team) && ['Interviewer','Hiring Manager','Recruiter','TA Manager','TA Director','System Admin'].includes(u.role)).map(u=>({id:u.id,name:u.name,team:u.team}));
  }
  if (parts[0] === 'referrals') {
    if (method === 'GET') permit(user,'referrals.read');
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
      if (!can(user, 'requisitions.compensation.read')) { delete output.salary_min; delete output.salary_max; delete output.currency; }
      return output;
    }
    if (method === 'POST' && !key) {
      permit(user, 'referrals.create');
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
      permit(user, 'referrals.update');
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
      permit(user, 'referrals.withdraw');
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
      permit(user,'referrals.process');
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
        if (candidate && !can(user,'system.override') && normalizeTeamName(candidate.team) !== normalizeTeamName(req.team)) throw new HttpError(409,'The matching candidate belongs to another team. Ask a System Admin to process this cross-team referral.');
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
          db.prepare('INSERT INTO applications(id, candidate_id, requisition_id, stage, created_at) VALUES(?,?,?,?,?)').run(aid,candidate.id,req.id,'Applied',now());
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
      permit(user, 'referrals.delete');
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
    permit(user, 'candidates.fraud.manage');
    if (key && (action === 'resolve' || !action) && method === 'POST') {
      const review = get(db, 'fraud_reviews', key);
      const cand = get(db, 'candidates', review.candidate_id);
      requireTeam(user, cand.team);
      return resolveFraudReview(db, user, cand.id, body);
    }
  }
  if (parts[0] === 'signatures') {
    if (method === 'GET' && !key) {
      permit(user, 'signatures.read', 'offers.read');
      const candidateId = query.get('candidate_id') || query.get('candidateId');
      const applicationId = query.get('application_id') || query.get('applicationId');
      const status = query.get('status');
      return listSignatureRequests(db, user, { candidateId, applicationId, status }).map(row => redactOfferCompensation(user, row));
    }
    if (method === 'POST' && !key) {
      permit(user, 'signatures.request', 'offers.create');
      if (!can(user, 'offers.compensation.read') && [body.salary, body.currency, body.start_date, body.startDate].some(value => value !== undefined && value !== null && value !== '')) {
        throw new HttpError(403, 'You do not have permission to set offer compensation.');
      }
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
        startDate: body.start_date || body.startDate,
        templateId: body.template_id || body.templateId,
        templateVariables: body.template_variables || body.templateVariables || {},
        customSections: body.custom_sections || body.customSections || null
      }, {
        origin: c?.origin,
        communicationAdapter: c?.communicationAdapter
      }).then(result => redactOfferCompensation(user, result));
    }
    if (key && !action && method === 'GET') {
      permit(user, 'signatures.read', 'offers.read');
      return redactOfferCompensation(user, getSignatureRequest(db, user, key));
    }
    if (key && action === 'document' && method === 'GET') {
      permit(user, 'signatures.download');
      const version = query.get('version') || 'signed';
      return downloadSignatureDocument(db, user, key, version);
    }
    if (key && (action === 'send-email' || action === 'resend') && method === 'POST') {
      permit(user, 'signatures.manage', 'signatures.request');
      return resendSignatureInvitation(db, user, key, body?.signer_id, {
        origin: c?.origin,
        communicationAdapter: c?.communicationAdapter
      });
    }
    if (key && action === 'cancel' && method === 'POST') {
      permit(user, 'signatures.manage');
      return cancelSignatureRequest(db, user, key, { reason: body.reason });
    }
  }
  if (parts[0] === 'offer-variables' && method === 'GET') {
    permit(user, 'offers.templates.read', 'offers.read');
    return { variables: VARIABLE_REGISTRY };
  }
  if (parts[0] === 'offer-letter-assets') {
    if (method === 'GET' && !key) {
      permit(user, 'offers.templates.read', 'offers.read');
      return listOfferLetterAssets(db, user);
    }
    if (method === 'POST' && !key) {
      permit(user, 'offers.assets.manage');
      let assetBuffer = body.buffer;
      if (!assetBuffer && (body.fileBase64 || body.file_base64)) {
        assetBuffer = Buffer.from(body.fileBase64 || body.file_base64, 'base64');
      } else if (!assetBuffer && body.data) {
        assetBuffer = Buffer.from(body.data, 'base64');
      } else if (!assetBuffer && body.file_buffer) {
        assetBuffer = Buffer.isBuffer(body.file_buffer) ? body.file_buffer : Buffer.from(body.file_buffer, 'base64');
      }
      return uploadLetterheadAsset(db, user, {
        name: body.name || null,
        buffer: assetBuffer,
        filename: body.filename || 'letterhead.png',
        format: body.format || null,
        scaling: body.scaling || null,
        pageTarget: body.pageTarget || body.page_target || null
      });
    }
    if (key && method === 'GET') {
      permit(user, 'offers.templates.read', 'offers.read');
      const asset = getLetterheadAssetBuffer(db, user, key);
      return {
        isRaw: true,
        buffer: asset.buffer,
        contentType: asset.mimeType,
        filename: asset.filename
      };
    }
    if (key && method === 'DELETE') {
      permit(user, 'offers.assets.manage');
      return deleteOfferLetterAsset(db, user, key);
    }
  }
  if (parts[0] === 'offer-templates') {
    if (method === 'GET' && !key) {
      permit(user, 'offers.templates.read', 'offers.read');
      return listOfferTemplates(db, user, { status: query.get('status') });
    }
    if (method === 'POST' && !key) {
      permit(user, 'offers.templates.manage');
      return createOfferTemplate(db, user, body);
    }
    if (key && !action && method === 'GET') {
      permit(user, 'offers.templates.read', 'offers.read');
      return getOfferTemplate(db, user, key);
    }
    if (key && !action && method === 'PUT') {
      permit(user, 'offers.templates.manage');
      return updateOfferTemplate(db, user, key, body);
    }
    if (key && action === 'duplicate' && method === 'POST') {
      permit(user, 'offers.templates.manage');
      return duplicateOfferTemplate(db, user, key, body);
    }
    if (key && action === 'status' && method === 'POST') {
      permit(user, 'offers.templates.manage');
      return setOfferTemplateStatus(db, user, key, body.status, body.is_default);
    }
    if (((key && action === 'preview') || key === 'preview') && method === 'POST') {
      permit(user, 'offers.templates.read', 'offers.read');
      const candidateId = body.candidate_id || body.candidateId || body.application_id || body.applicationId;
      const requisitionId = body.requisition_id || body.requisitionId;
      if (candidateId && !can(user, 'candidates.personal.read')) {
        throw new HttpError(403, 'Candidate contact permission is required to preview a candidate offer.');
      }
      if ((requisitionId || body.salary || body.currency || body.start_date || body.startDate) && !can(user, 'offers.compensation.read')) {
        throw new HttpError(403, 'Offer compensation permission is required to preview real offer terms.');
      }
      return previewOfferTemplate(db, user, key === 'preview' ? 'preview' : key, {
        ...body,
        customSections: body.custom_sections || body.customSections || body.sections || null,
        pageConfig: body.page_config || body.pageConfig || null,
        headerConfig: body.header_config || body.headerConfig || null,
        footerConfig: body.footer_config || body.footerConfig || null,
        backgroundConfig: body.background_config || body.backgroundConfig || null
      });
    }
    if (key && action === 'preview.pdf' && method === 'GET') {
      permit(user, 'offers.templates.read', 'offers.read');
      const tpl = getOfferTemplate(db, user, key);
      const candId = query.get('candidate_id') || query.get('candidateId');
      const appId = query.get('application_id') || query.get('applicationId');
      const reqId = query.get('requisition_id') || query.get('requisitionId');
      const salary = query.get('salary');
      const currency = query.get('currency');
      if ((candId || appId) && !can(user, 'candidates.personal.read')) {
        throw new HttpError(403, 'Candidate contact permission is required to preview a candidate offer.');
      }
      if ((reqId || salary || currency) && !can(user, 'offers.compensation.read')) {
        throw new HttpError(403, 'Offer compensation permission is required to preview real offer terms.');
      }
      const compiled = compileTemplateToPdf(db, tpl, {
        candidateId: candId,
        applicationId: appId,
        requisitionId: reqId,
        offerData: { salary, currency },
        user
      });
      return {
        isRaw: true,
        buffer: compiled.pdfBuffer,
        contentType: 'application/pdf',
        filename: `${tpl.name.replace(/\s+/g, '_')}_preview.pdf`
      };
    }
  }
  if (parts[0] === 'training-plans') {
    if (parts[1] === 'templates') {
      const templateId = parts[2];
      const templateAction = parts[3];
      if (!templateId && method === 'GET') {
        permit(user, 'recruit', 'review', 'admin');
        return listTrainingTemplates(db, user, query);
      }
      if (!templateId && method === 'POST') {
        permit(user, 'recruit', 'admin');
        return createTrainingTemplate(db, user, body);
      }
      if (templateId && !templateAction && method === 'GET') {
        permit(user, 'recruit', 'review', 'admin');
        return getTrainingTemplate(db, user, templateId);
      }
      if (templateId && !templateAction && method === 'PUT') {
        permit(user, 'recruit', 'admin');
        return updateTrainingTemplate(db, user, templateId, body);
      }
      if (templateId && templateAction === 'duplicate' && method === 'POST') {
        permit(user, 'recruit', 'admin');
        return duplicateTrainingTemplate(db, user, templateId, body);
      }
      if (templateId && templateAction === 'status' && method === 'POST') {
        permit(user, 'recruit', 'admin');
        return setTrainingTemplateStatus(db, user, templateId, body.status, body.is_default);
      }
      if (templateId && templateAction === 'archive' && method === 'POST') {
        permit(user, 'recruit', 'admin');
        return archiveTrainingTemplate(db, user, templateId);
      }
      if (templateId && method === 'DELETE') {
        permit(user, 'recruit', 'admin');
        return archiveTrainingTemplate(db, user, templateId);
      }
    }
    if (parts[1] === 'assets') {
      const assetId = parts[2];
      if (!assetId && method === 'POST') {
        permit(user, 'recruit', 'admin');
        return uploadTrainingAsset(db, user, body);
      }
      if (assetId && method === 'GET') {
        permit(user, 'recruit', 'review', 'admin');
        const asset = getTrainingAsset(db, user, assetId);
        return {
          isRaw: true,
          buffer: asset.buffer,
          contentType: asset.contentType,
          filename: asset.filename
        };
      }
    }
  }
  if (parts[0] === 'agencies') {
    if (method === 'GET' && !key) {
      permit(user, 'agencies.read');
      return listAgencies(db, user, query);
    }
    if (method === 'POST' && !key) {
      permit(user, 'agencies.create');
      return createAgency(db, user, body);
    }
    if (key && !action) {
      if (method === 'GET') {
        permit(user, 'agencies.read');
        return getAgency(db, user, key);
      }
      if (method === 'PUT') {
        permit(user, 'agencies.update');
        return updateAgency(db, user, key, body);
      }
    }
    if (key && action === 'status' && method === 'POST') {
      permit(user, 'agencies.delete');
      return setAgencyStatus(db, user, key, body.status, body.reason);
    }
    if (key && action === 'members' && method === 'POST') {
      permit(user, 'agencies.update');
      return addAgencyMember(db, user, key, body);
    }
    if (key && (action === 'requisitions' || action === 'assignments')) {
      if (method === 'POST' && (!parts[3] || parts[4] !== 'revoke')) {
        permit(user, 'agencies.assign');
        return assignRequisitionToAgency(db, user, key, {
          requisitionId: body.requisition_id || body.requisitionId,
          instructions: body.instructions ?? body.sourcing_instructions ?? '',
          deadline: body.deadline ?? body.submission_deadline ?? null
        });
      }
      if (method === 'DELETE' || (method === 'POST' && parts[3] && parts[4] === 'revoke')) {
        permit(user, 'agencies.assign');
        const reqId = parts[3];
        return revokeRequisitionFromAgency(db, user, key, reqId);
      }
    }
  }
  if (parts[0] === 'agency') {
    if (parts[1] === 'submissions' && parts[2] && parts[3] === 'feedback' && method === 'POST') {
      permit(user, 'agencies.feedback');
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
    permit(user,'analytics.read');
    const reqs = db.prepare('SELECT * FROM requisitions WHERE deleted_at IS NULL').all().filter(r=>inTeam(user,r.team)), ids = new Set(reqs.map(r=>r.id));
    const apps = db.prepare('SELECT * FROM applications').all().filter(a=>ids.has(a.requisition_id));
    return {openRequisitions:reqs.filter(r=>r.status==='open').length, pendingApprovals:reqs.filter(r=>r.status.startsWith('pending')).length,
      approvedHeadcount:reqs.filter(r=>r.status==='open').reduce((n,r)=>n+r.headcount,0), candidates:db.prepare('SELECT team FROM candidates WHERE deleted_at IS NULL').all().filter(c=>inTeam(user,c.team)).length,
      stageCounts:Object.fromEntries(pipeline(db).map(s=>[s,apps.filter(a=>a.stage===s).length])),
      averageApplicationAgeDays:apps.length ? Math.round(apps.reduce((n,a)=>n+(Date.now()-Date.parse(a.created_at))/86400000,0)/apps.length) : 0};
  }
  if (path === 'integrations' && method === 'GET') {
    permit(user,'applications.read','integrations.read');
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
