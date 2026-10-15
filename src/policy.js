export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const roles = ['System Admin','TA Director','TA Manager','Recruiter','Hiring Manager','Interviewer','Finance Approver','Employee/Referral','Agency'];
export const teams = ['Dev','QA','BD','DevOps','HR','Product','Design','Operations','Sales','Other','PM','TL'];
const grants = {
  'System Admin': ['admin','recruit','requisition','approve_manager','approve_finance','review','analytics','refer','jobs','interview'],
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
export function phone(value, optional = true) {
  const result = text(value ?? '', 'Phone', 50, optional);
  if (!result) return '';
  const digits = result.replace(/\D/g, '');
  if ((!/^\+?[0-9\s\-().–—]+$/.test(result) && !/^\([+]?[0-9]+\)[\s0-9\-().–—]+$/.test(result)) || digits.length < 7 || digits.length > 15) throw new HttpError(400, 'Enter a valid phone number.');
  return result;
}
export const currencies = ['USD','EUR','GBP','CAD','AUD','INR','JPY','CHF','SGD','NZD','AED','HKD','SEK','NOK','DKK','BRL','MXN','ZAR'];
export function currency(value) {
  const result = text(value, 'Currency', 10).toUpperCase();
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
