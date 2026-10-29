export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const roles = ['System Admin','TA Director','TA Manager','Recruiter','Hiring Manager','Interviewer','Finance Approver','Employee/Referral','Agency','Agency Admin','Agency Recruiter'];
export const teams = ['Dev','QA','BD','DevOps','HR','Product','Design','Operations','Sales','Other','PM','TL'];

/**
 * Central permission catalogue. Every backend check and the /api/me response
 * use these keys, so adding or changing a capability is a one-file change.
 */
export const permissions = Object.freeze({
  admin: 'Administration, users, audit, integrations and workspace configuration.',
  recruit: 'Recruitment workflow: candidates, applications, pipeline and interview scheduling.',
  requisition: 'Create and maintain assigned job requisitions.',
  approve_manager: 'Approve requisitions at the hiring-manager stage.',
  approve_finance: 'Approve requisition headcount and compensation at the finance stage.',
  review: 'Read candidate and application information for hiring review.',
  analytics: 'View team-scoped recruiting analytics.',
  refer: 'Submit and manage employee referrals.',
  jobs: 'View open job requisitions.',
  interview: 'View assigned interviews and submit assigned interview feedback.'
});

/**
 * Role-to-permission matrix. Least privilege is the default: unknown roles,
 * disabled users and agency roles receive no internal ATS permission.
 */
export const rolePermissions = Object.freeze({
  'System Admin': Object.freeze(['admin','recruit','requisition','approve_manager','approve_finance','review','analytics','refer','jobs','interview']),
  'TA Director': Object.freeze(['recruit','approve_manager','review','analytics','refer','jobs','interview']),
  'TA Manager': Object.freeze(['recruit','approve_manager','review','analytics','refer','jobs','interview']),
  'Recruiter': Object.freeze(['recruit','review','analytics','refer','jobs','interview']),
  'Hiring Manager': Object.freeze(['requisition','approve_manager','review','refer','jobs','interview']),
  'Interviewer': Object.freeze(['interview','jobs']),
  'Finance Approver': Object.freeze(['approve_finance','jobs']),
  'Employee/Referral': Object.freeze(['refer','jobs']),
  'Agency': Object.freeze([]),
  'Agency Admin': Object.freeze([]),
  'Agency Recruiter': Object.freeze([])
});

/**
 * Granular permission registry. Each identifier is module.action and is the
 * only shape accepted by role management.
 */
const permission = (id, name, module, description, options = {}) => Object.freeze({
  id, name, module, description,
  sensitive: Boolean(options.sensitive),
  assignable: options.assignable !== false
});

export const permissionDefinitions = Object.freeze([
  permission('users.read', 'View users', 'Administration', 'View user accounts and access assignments.'),
  permission('users.create', 'Provision users', 'Administration', 'Provision a new Microsoft 365 identity.'),
  permission('users.update', 'Update users', 'Administration', 'Change a user name, role, team or account status.', { sensitive: true }),
  permission('users.deactivate', 'Deactivate users', 'Administration', 'Disable, reject or force sign-out for a user.', { sensitive: true }),
  permission('roles.read', 'View roles', 'Administration', 'View roles, permission grants and effective access.'),
  permission('roles.create', 'Create roles', 'Administration', 'Create custom roles.', { sensitive: true }),
  permission('roles.update', 'Update roles', 'Administration', 'Edit custom role names, scopes and permissions.', { sensitive: true }),
  permission('roles.delete', 'Archive roles', 'Administration', 'Archive custom roles that have no assigned users.', { sensitive: true }),
  permission('roles.assign', 'Assign roles', 'Administration', 'Assign or remove a role from a user.', { sensitive: true }),
  permission('permissions.read', 'View permission registry', 'Administration', 'View the authoritative permission catalogue.'),
  permission('audit.read', 'View audit log', 'Administration', 'Read security and administrative audit events.'),
  permission('settings.read', 'View settings', 'Administration', 'View workspace settings and appearance.'),
  permission('settings.update', 'Update settings', 'Administration', 'Change workspace settings and appearance.', { sensitive: true }),
  permission('integrations.read', 'View integrations', 'Administration', 'View integration configuration and status.'),
  permission('integrations.configure', 'Configure integrations', 'Administration', 'Change integration configuration and enablement.', { sensitive: true }),
  permission('integrations.secrets.manage', 'Manage integration secrets', 'Administration', 'Create or rotate integration credentials.', { sensitive: true }),
  permission('requisitions.read', 'View requisitions', 'Requisitions', 'View requisitions within the authorized scope.'),
  permission('requisitions.create', 'Create requisitions', 'Requisitions', 'Create a new requisition.'),
  permission('requisitions.update', 'Edit requisitions', 'Requisitions', 'Edit requisition details within the authorized scope.'),
  permission('requisitions.delete', 'Delete requisitions', 'Requisitions', 'Soft-delete an eligible requisition.'),
  permission('requisitions.submit', 'Submit requisitions', 'Requisitions', 'Submit a draft requisition for approval.'),
  permission('requisitions.approve_manager', 'Approve as hiring manager', 'Requisitions', 'Approve the manager stage of a requisition.', { sensitive: true }),
  permission('requisitions.approve_finance', 'Approve as finance', 'Requisitions', 'Approve the finance stage of a requisition.', { sensitive: true }),
  permission('requisitions.compensation.read', 'View requisition compensation', 'Requisitions', 'View salary ranges and currency.', { sensitive: true }),
  permission('requisitions.override', 'Override requisition approval', 'Requisitions', 'Bypass approval separation rules with an audit reason.', { sensitive: true }),
  permission('candidates.read', 'View candidates', 'Candidates', 'List and read candidate records within the authorized scope.'),
  permission('candidates.create', 'Create candidates', 'Candidates', 'Create candidate records.'),
  permission('candidates.update', 'Edit candidates', 'Candidates', 'Edit candidate details.'),
  permission('candidates.delete', 'Delete candidates', 'Candidates', 'Soft-delete an eligible candidate.'),
  permission('candidates.assigned.read', 'View assigned candidates', 'Candidates', 'Read candidates linked to interviews assigned to the user.', { sensitive: true }),
  permission('candidates.personal.read', 'View candidate contact details', 'Candidates', 'View candidate email and phone number.', { sensitive: true }),
  permission('candidates.resume.read', 'View candidate resumes', 'Candidates', 'View resume text and resume file metadata.', { sensitive: true }),
  permission('candidates.resume.upload', 'Upload candidate resumes', 'Candidates', 'Upload and parse candidate resume files.', { sensitive: true }),
  permission('candidates.communications.read', 'View candidate communications', 'Candidates', 'View candidate email history and consent state.'),
  permission('candidates.communications.send', 'Send candidate communications', 'Candidates', 'Send email to candidates.', { sensitive: true }),
  permission('candidates.consent.read', 'View candidate consent', 'Candidates', 'View candidate communication consent.'),
  permission('candidates.consent.update', 'Update candidate consent', 'Candidates', 'Change candidate communication consent.', { sensitive: true }),
  permission('candidates.fraud.read', 'View fraud signals', 'Candidates', 'View candidate fraud review signals.'),
  permission('candidates.fraud.manage', 'Resolve fraud signals', 'Candidates', 'Resolve or clear a fraud review.', { sensitive: true }),
  permission('applications.read', 'View applications', 'Pipeline', 'View applications and their current stage.'),
  permission('applications.create', 'Create applications', 'Pipeline', 'Add a candidate to an open requisition.'),
  permission('applications.update', 'Move applications', 'Pipeline', 'Change an application pipeline stage.'),
  permission('applications.delete', 'Delete applications', 'Pipeline', 'Remove an application where the workflow permits it.'),
  permission('applications.match', 'Run candidate matching', 'Pipeline', 'Calculate candidate-to-requisition match scores.'),
  permission('applications.evaluate', 'Record training evaluation', 'Pipeline', 'Record a pre-onboarding training evaluation.'),
  permission('applications.hrms_handoff', 'Send HRMS handoff', 'Pipeline', 'Send a hired candidate to the HRMS integration.', { sensitive: true }),
  permission('applications.override', 'Override pipeline rules', 'Pipeline', 'Bypass terminal, sequence or headcount rules with a reason.', { sensitive: true }),
  permission('training.read', 'View training plans', 'Training', 'View training plans, templates, drafts and training history.'),
  permission('training.manage', 'Manage training plans', 'Training', 'Create, edit, send, archive and duplicate training plans.', { sensitive: true }),
  permission('training.lifecycle', 'Manage training lifecycle', 'Training', 'Start, restart, extend or revoke training for an application.', { sensitive: true }),
  permission('pipeline.read', 'View pipeline configuration', 'Pipeline', 'View pipeline stages.'),
  permission('pipeline.configure', 'Configure pipeline', 'Pipeline', 'Change pipeline stages and remap applications.', { sensitive: true }),
  permission('interviews.read', 'View interviews', 'Interviews', 'View interviews and assigned interview context.'),
  permission('interviews.schedule', 'Schedule interviews', 'Interviews', 'Create interviews and assign interviewers.'),
  permission('interviews.update', 'Edit interviews', 'Interviews', 'Reschedule or edit interviews.'),
  permission('interviews.cancel', 'Cancel interviews', 'Interviews', 'Cancel an interview.'),
  permission('interviews.evaluate', 'Submit interview feedback', 'Interviews', 'Submit a scorecard for an assigned interview.'),
  permission('interviews.proxy_evaluate', 'Submit proxy feedback', 'Interviews', 'Submit a scorecard on behalf of another interviewer.', { sensitive: true }),
  permission('interviews.feedback.read', 'Read interview feedback', 'Interviews', 'Read submitted scorecards when blinding rules allow.', { sensitive: true }),
  permission('referrals.read', 'View referrals', 'Referrals', 'View referrals within the authorized scope.'),
  permission('referrals.read_all', 'View all team referrals', 'Referrals', 'View referrals submitted by other employees in the authorized scope.'),
  permission('referrals.create', 'Create referrals', 'Referrals', 'Submit an employee referral.'),
  permission('referrals.update', 'Edit referrals', 'Referrals', 'Edit an eligible referral.'),
  permission('referrals.withdraw', 'Withdraw referrals', 'Referrals', 'Withdraw an eligible referral.'),
  permission('referrals.process', 'Process referrals', 'Referrals', 'Convert a referral into a candidate and application.'),
  permission('referrals.delete', 'Delete referrals', 'Referrals', 'Soft-delete an eligible referral.'),
  permission('offers.read', 'View offers', 'Offers', 'Read offer and signature request records.'),
  permission('offers.create', 'Create offers', 'Offers', 'Create an offer or signature request.', { sensitive: true }),
  permission('offers.update', 'Update offers', 'Offers', 'Update an eligible offer.', { sensitive: true }),
  permission('offers.delete', 'Delete offers', 'Offers', 'Delete an eligible offer.', { sensitive: true }),
  permission('offers.templates.read', 'View offer templates', 'Offers', 'View offer letter templates.'),
  permission('offers.templates.manage', 'Manage offer templates', 'Offers', 'Create, edit and archive offer letter templates.'),
  permission('offers.assets.manage', 'Manage offer assets', 'Offers', 'Upload and replace letterhead assets.'),
  permission('offers.compensation.read', 'View offer compensation', 'Offers', 'View salary, currency and start date on offers.', { sensitive: true }),
  permission('signatures.read', 'View signature requests', 'Offers', 'View signature requests and signing status.'),
  permission('signatures.request', 'Request signatures', 'Offers', 'Send an offer for signature.', { sensitive: true }),
  permission('signatures.manage', 'Manage signature requests', 'Offers', 'Resend, cancel or manage signature requests.', { sensitive: true }),
  permission('signatures.download', 'Download signed documents', 'Offers', 'Download signed offer documents.', { sensitive: true }),
  permission('agencies.read', 'View agencies', 'Agencies', 'View agency records and assignments.'),
  permission('agencies.create', 'Create agencies', 'Agencies', 'Create an agency record.', { sensitive: true }),
  permission('agencies.update', 'Update agencies', 'Agencies', 'Edit agency records and membership.', { sensitive: true }),
  permission('agencies.delete', 'Deactivate agencies', 'Agencies', 'Deactivate an agency.', { sensitive: true }),
  permission('agencies.assign', 'Assign agency requisitions', 'Agencies', 'Assign or revoke requisitions for an agency.'),
  permission('agencies.feedback', 'Publish agency feedback', 'Agencies', 'Publish feedback to an agency submission.'),
  permission('agency.submissions.read', 'View agency submissions', 'Agencies', 'View agency candidate submissions.'),
  permission('analytics.read', 'View analytics', 'Analytics', 'View team-scoped recruiting analytics.'),
  permission('jobs.read', 'View open jobs', 'Jobs', 'View open job requisitions and read-only job details.'),
  permission('system.override', 'Emergency system override', 'System', 'Perform emergency administrative overrides.', { sensitive: true })
]);

export const permissionIds = Object.freeze(permissionDefinitions.map(entry => entry.id));
export const permissionById = Object.freeze(Object.fromEntries(permissionDefinitions.map(entry => [entry.id, entry])));
export const permissionModules = Object.freeze([...new Set(permissionDefinitions.map(entry => entry.module))]);
export const permissionGroups = Object.freeze(permissionModules.map(module => Object.freeze({
  module,
  permissions: Object.freeze(permissionDefinitions.filter(entry => entry.module === module))
})));

const grants = (...items) => Object.freeze([...new Set(items.flat())]);
const recruitmentRead = grants('jobs.read','requisitions.read','requisitions.compensation.read','candidates.read','candidates.personal.read','candidates.resume.read','candidates.communications.read','candidates.consent.read','candidates.fraud.read','applications.read','applications.match','pipeline.read','interviews.read','interviews.feedback.read','referrals.read');

/**
 * Built-in roles. Their names and record scopes are authoritative and cannot be
 * renamed, re-scoped or archived. Operational roles may have their permissions
 * customized by an authorized role administrator. System Admin and the external
 * agency identities remain fully immutable so a workspace cannot lock itself
 * out or grant internal access to an agency. Custom roles are additive and
 * store their permissions in rbac_role_permissions.
 */
export const systemRoleDefinitions = Object.freeze({
  'System Admin': Object.freeze({ scope: 'organization', description: 'Protected workspace administrator with every capability.', permissions: grants(permissionIds) }),
  'TA Director': Object.freeze({ scope: 'organization', description: 'Organization-wide talent acquisition leadership.', permissions: grants(recruitmentRead,
    'requisitions.create','requisitions.update','requisitions.delete','requisitions.submit','requisitions.approve_manager','requisitions.approve_finance',
    'candidates.create','candidates.update','candidates.delete','candidates.resume.upload','candidates.communications.send','candidates.consent.update','candidates.fraud.manage',
    'applications.create','applications.update','applications.delete','applications.evaluate','applications.hrms_handoff',
    'training.read','training.manage','training.lifecycle',
    'interviews.schedule','interviews.update','interviews.cancel','interviews.evaluate',
    'referrals.create','referrals.update','referrals.withdraw','referrals.process','referrals.delete',
    'offers.read','offers.create','offers.update','offers.delete','offers.templates.read','offers.templates.manage','offers.assets.manage','offers.compensation.read','signatures.read','signatures.request','signatures.manage','signatures.download',
    'agencies.read','agencies.assign','agencies.feedback','agency.submissions.read','analytics.read') }),
  'TA Manager': Object.freeze({ scope: 'team', description: 'Team-level talent acquisition management and approvals.', permissions: grants(recruitmentRead,
    'requisitions.create','requisitions.update','requisitions.delete','requisitions.submit','requisitions.approve_manager',
    'candidates.create','candidates.update','candidates.delete','candidates.resume.upload','candidates.communications.send','candidates.consent.update','candidates.fraud.manage',
    'applications.create','applications.update','applications.delete','applications.evaluate','applications.hrms_handoff',
    'training.read','training.manage','training.lifecycle',
    'interviews.schedule','interviews.update','interviews.cancel','interviews.evaluate',
    'referrals.create','referrals.update','referrals.withdraw','referrals.process','referrals.delete',
    'offers.read','offers.create','offers.update','offers.delete','offers.templates.read','offers.templates.manage','offers.assets.manage','offers.compensation.read','signatures.read','signatures.request','signatures.manage','signatures.download',
    'agencies.read','agencies.assign','agencies.feedback','agency.submissions.read','analytics.read') }),
  'Recruiter': Object.freeze({ scope: 'team', description: 'Runs the recruiting workflow for an assigned team.', permissions: grants(recruitmentRead,
    'requisitions.create','requisitions.update','requisitions.delete','requisitions.submit',
    'candidates.create','candidates.update','candidates.delete','candidates.resume.upload','candidates.communications.send','candidates.consent.update','candidates.fraud.manage',
    'applications.create','applications.update','applications.delete','applications.evaluate','applications.hrms_handoff',
    'training.read','training.manage','training.lifecycle',
    'interviews.schedule','interviews.update','interviews.cancel','interviews.evaluate',
    'referrals.create','referrals.update','referrals.withdraw','referrals.process','referrals.delete',
    'offers.read','offers.create','offers.update','offers.delete','offers.templates.read','offers.templates.manage','offers.assets.manage','offers.compensation.read','signatures.read','signatures.request','signatures.manage','signatures.download',
    'agencies.read','agencies.assign','agencies.feedback','agency.submissions.read','analytics.read') }),
  'Hiring Manager': Object.freeze({ scope: 'team', description: 'Owns requisitions and hiring decisions for an assigned team.', permissions: grants('jobs.read','requisitions.read','requisitions.create','requisitions.update','requisitions.submit','requisitions.approve_manager','requisitions.compensation.read',
    'candidates.read','candidates.personal.read','candidates.resume.read','applications.read','applications.match','pipeline.read','interviews.read','interviews.feedback.read',
    'training.read',
    'referrals.read','referrals.read_all','referrals.create','referrals.update','referrals.withdraw') }),
  'Interviewer': Object.freeze({ scope: 'team', description: 'Conducts assigned interviews and submits structured feedback.', permissions: grants('jobs.read','interviews.read','interviews.evaluate','candidates.assigned.read','candidates.personal.read') }),
  'Finance Approver': Object.freeze({ scope: 'team', description: 'Reviews headcount and compensation at the finance stage.', permissions: grants('jobs.read','requisitions.read','requisitions.approve_finance','requisitions.compensation.read') }),
  'Employee/Referral': Object.freeze({ scope: 'team', description: 'Submits and tracks their own employee referrals.', permissions: grants('jobs.read','referrals.read','referrals.create','referrals.update','referrals.withdraw','referrals.delete') }),
  'Agency': Object.freeze({ scope: 'none', description: 'Reserved external agency identity; no internal ATS access.', permissions: grants() }),
  'Agency Admin': Object.freeze({ scope: 'none', description: 'Reserved external agency administrator; no internal ATS access.', permissions: grants() }),
  'Agency Recruiter': Object.freeze({ scope: 'none', description: 'Reserved external agency recruiter; no internal ATS access.', permissions: grants() })
});

export const roleScopes = Object.freeze(['organization', 'team', 'assigned', 'none']);

export function legacyCapabilitiesForPermissions(permissionList = []) {
  const set = new Set(permissionList);
  const out = new Set();
  // Keep the legacy admin token for the documented emergency override only.
  // Narrow administration grants must not imply every admin UI capability.
  if (set.has('system.override')) out.add('admin');
  if ([...set].some(p => p.startsWith('candidates.create') || p.startsWith('candidates.update') || p.startsWith('candidates.delete') || p === 'applications.create' || p === 'applications.update' || p === 'interviews.schedule' || p === 'referrals.process' || p === 'offers.create')) out.add('recruit');
  if (set.has('requisitions.create') || set.has('requisitions.update') || set.has('requisitions.submit')) out.add('requisition');
  if (set.has('requisitions.approve_manager')) out.add('approve_manager');
  if (set.has('requisitions.approve_finance')) out.add('approve_finance');
  if (set.has('candidates.read') || set.has('applications.read')) out.add('review');
  if (set.has('analytics.read')) out.add('analytics');
  if (set.has('referrals.read') || set.has('referrals.create')) out.add('refer');
  if (set.has('jobs.read')) out.add('jobs');
  if (set.has('interviews.read') || set.has('interviews.evaluate')) out.add('interview');
  return [...out];
}

export function isAgencyRole(role) { return ['Agency','Agency Admin','Agency Recruiter'].includes(role); }
const immutableSystemRolePermissions = new Set(['System Admin','Agency','Agency Admin','Agency Recruiter']);
export function isSystemRolePermissionsEditable(role) {
  const name = typeof role === 'string' ? role : role?.name;
  return Boolean(name) && !immutableSystemRolePermissions.has(name);
}
export function isKnownRole(role) { return roles.includes(role); }
export function permissionsFor(role) { return [...(rolePermissions[role] || [])]; }
export function can(user, action) {
  if (!user || user.status !== 'active') return false;
  // Hydrated users carry their persisted role grants. Legacy capability tokens
  // remain available so existing workflows keep working during migration.
  if (user._grants instanceof Set) {
    if (user._grants.has(action)) return true;
    // Legacy tokens stay available for compatibility checks such as can(user, 'recruit').
    // A derived token does not satisfy a different granular permission.
    return Boolean(user._legacy instanceof Set && user._legacy.has(action));
  }
  // Direct calls that have not loaded the saved grant rows still follow the
  // shipped role catalogue. Request handling hydrates the saved grants first.
  if (rolePermissions[user.role]?.includes(action)) return true;
  return Boolean(systemRoleDefinitions[user.role]?.permissions.includes(action));
}
export function requirePermission(user, ...actions) {
  if (!actions.some(action => can(user, action))) throw new HttpError(403, 'Your role cannot perform this action.');
}
export function requireRole(user, ...allowedRoles) {
  if (!user || user.status !== 'active' || !allowedRoles.includes(user.role)) throw new HttpError(403, 'Your role cannot perform this action.');
}
export function requireAllPermissions(user, ...actions) {
  if (!actions.every(action => can(user, action))) throw new HttpError(403, 'Your role cannot perform this action.');
}
export function normalizeTeamName(val) {
  if (!val || typeof val !== 'string') return '';
  const clean = val.trim();
  if (!clean) return '';
  const lower = clean.toLowerCase();
  if (
    lower === 'qa' ||
    lower === 'quality assurance' ||
    lower === 'quality assurance team' ||
    lower === 'qa team' ||
    lower === 'qa candidate pool' ||
    lower === 'qa pool' ||
    lower === 'qa talent pool' ||
    lower === 'quality assurance candidate pool' ||
    lower === 'quality assurance pool' ||
    /^(qa|quality\s+assurance)(\s+(team|candidate\s+pool|talent\s+pool|pool))?$/i.test(clean)
  ) return 'QA';
  if (lower === 'engineering') return 'Engineering';
  if (lower === 'dev' || lower === 'software engineering' || lower === 'development') return 'Dev';
  if (lower === 'bd' || lower === 'business development') return 'BD';
  if (lower === 'devops' || lower === 'dev ops' || lower === 'sre' || lower === 'infrastructure') return 'DevOps';
  if (lower === 'hr' || lower === 'human resources' || lower === 'people' || lower === 'people operations') return 'HR';
  if (lower === 'product' || lower === 'product management') return 'Product';
  if (lower === 'design' || lower === 'ui/ux' || lower === 'product design') return 'Design';
  if (lower === 'operations' || lower === 'ops') return 'Operations';
  if (lower === 'sales') return 'Sales';
  if (lower === 'pm' || lower === 'project manager' || lower === 'project management') return 'PM';
  if (lower === 'tl' || lower === 'tech lead' || lower === 'team lead') return 'TL';
  if (lower === 'other') return 'Other';
  const match = teams.find(t => t.toLowerCase() === lower);
  return match || clean;
}

export function teamsEquivalent(a, b) {
  if (!a || !b) return false;
  const la = String(a).trim().toLowerCase();
  const lb = String(b).trim().toLowerCase();
  if (la === lb) return true;
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (na && nb && na.toLowerCase() === nb.toLowerCase()) return true;
  if ((la === 'dev' || la === 'engineering' || na === 'Dev' || na === 'Engineering') && (lb === 'dev' || lb === 'engineering' || nb === 'Dev' || nb === 'Engineering')) return true;
  if ((la === 'qa' || la === 'quality assurance' || na === 'QA') && (lb === 'qa' || lb === 'quality assurance' || nb === 'QA')) return true;
  return false;
}

export function userTeams(user) {
  if (!user || !user.team) return [];
  const raw = String(user.team);
  return raw.split(/[,;/|]+/).map(t => normalizeTeamName(t)).filter(Boolean);
}

export function inTeam(user, team) {
  if (!user) return false;
  if (can(user, 'system.override')) return true;
  const normTarget = normalizeTeamName(team);
  if (user._scope) {
    if (user._scope === 'organization') return true;
    if (user._scope === 'team') {
      if (!user.team || !normTarget) return false;
      const targetLower = normTarget.toLowerCase();
      const list = userTeams(user).map(t => t.toLowerCase());
      return list.some(t => teamsEquivalent(t, targetLower)) || teamsEquivalent(user.team, normTarget);
    }
    return false;
  }
  const isOrg = ['System Admin','TA Director'].includes(user.role);
  if (isOrg) return true;
  if (!user.team || !normTarget) return false;
  const targetLower = normTarget.toLowerCase();
  const list = userTeams(user).map(t => t.toLowerCase());
  return list.some(t => teamsEquivalent(t, targetLower)) || teamsEquivalent(user.team, normTarget);
}
export function requireTeam(user, team) { if (!inTeam(user, team)) throw new HttpError(403, 'This record belongs to another team.'); }
export function text(value, label, max = 500, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new HttpError(400, `${label} must be text of 1–${max} characters.`);
  return value.trim();
}
export function email(value) {
  const result = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@.]+(?:\.[^\s@.]+)*@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'Enter a valid email address.');
  return result;
}
export function phone(value, optional = true) {
  const result = text(value ?? '', 'Phone', 50, optional);
  if (!result) return '';
  const digits = result.replace(/\D/g, '');
  if ((!/^\+?[0-9\s\-().–—]+$/.test(result) && !/^\([+]?[0-9]+\)[\s0-9\-().–—]+$/.test(result)) || digits.length < 7 || digits.length > 15) throw new HttpError(400, 'Enter a valid phone number.');
  return result;
}
export const currencies = ['USD','EUR','GBP','CAD','AUD','INR','JPY','CHF','SGD','NZD','AED','HKD','SEK','NOK','DKK','BRL','MXN','ZAR'];
export function currency(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Enter a supported three-letter currency code.');
  const result = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(result) || !currencies.includes(result)) throw new HttpError(400, 'Enter a supported three-letter currency code.');
  return result;
}
export function list(value, label, max = 30) {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, `${label} must be a list with at most ${max} items.`);
  return [...new Set(value.map(v => text(v, label, 100)))];
}
export function validateSkills(value) {
  const rawList = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
  const items = list(rawList, 'Skills');
  for (const s of items) {
    if (/[*:&;|~^$%@!=<>?`"\\]/.test(s) || !/^[\p{L}\p{N}\s.\-/+#()']{1,100}$/u.test(s)) {
      throw new HttpError(400, 'Enter skills only in the expected comma-separated format, for example: Manual Testing, Automation Testing');
    }
  }
  return items;
}
export function integer(value, label, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return value;
}
