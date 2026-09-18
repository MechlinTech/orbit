export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const roles = ['System Admin','TA Director','TA Manager','Recruiter','Hiring Manager','Interviewer','Finance Approver','Employee/Referral','Agency'];
const grants = {
  'System Admin': ['admin','recruit','approve_manager','approve_finance','review','analytics','refer','jobs'],
  'TA Director': ['recruit','approve_manager','review','analytics','refer','jobs'],
  'TA Manager': ['recruit','approve_manager','review','analytics','refer','jobs'],
  'Recruiter': ['recruit','review','analytics','refer','jobs'],
  'Hiring Manager': ['requisition','approve_manager','review','refer','jobs'],
  'Interviewer': ['interview','jobs'],
  'Finance Approver': ['approve_finance','jobs'],
  'Employee/Referral': ['refer','jobs'],
  'Agency': []
};
export function can(user, action) { return user?.status === 'active' && (grants[user.role] || []).includes(action); }
export function requirePermission(user, ...actions) {
  if (!actions.some(action => can(user, action))) throw new HttpError(403, 'Your role cannot perform this action.');
}
export function inTeam(user, team) { return ['System Admin','TA Director'].includes(user.role) || (user.team && user.team === team); }
export function requireTeam(user, team) { if (!inTeam(user, team)) throw new HttpError(403, 'This record belongs to another team.'); }
export function text(value, label, max = 500, optional = false) {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new HttpError(400, `${label} must be text of 1–${max} characters.`);
  return value.trim();
}
export function email(value) {
  const result = text(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'Enter a valid email address.');
  return result;
}
export function list(value, label, max = 30) {
  if (!Array.isArray(value) || value.length > max) throw new HttpError(400, `${label} must be a list with at most ${max} items.`);
  return [...new Set(value.map(v => text(v, label, 100)))];
}
export function integer(value, label, min = 0, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return value;
}
