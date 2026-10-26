import { openDb,id,now } from '../src/db.js';
import { config } from '../src/auth.js';
export const tenant='11111111-1111-1111-1111-111111111111';
export const client='22222222-2222-2222-2222-222222222222';
export const testConfig=()=>config({APP_ORIGIN:'http://localhost:3000',ENTRA_TENANT_ID:tenant,ENTRA_CLIENT_ID:client,ENTRA_CLIENT_SECRET:'test-only',ALLOWED_DOMAINS:'example.com'});
export function user(db,role='Recruiter',team='Engineering',status='active'){
  const uid=id();db.prepare('INSERT INTO users(id,email,name,oid,tenant,role,team,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uid,`${uid}@example.com`,role,uid,tenant,role,team,status,now());return db.prepare('SELECT * FROM users WHERE id=?').get(uid);
}
export const fixture=()=>{const db=openDb(':memory:');db.prepare("UPDATE settings SET value=? WHERE key='pipeline'").run('["Applied","Screening","Interview","Offer","Hired","Rejected"]');return {db,admin:user(db,'System Admin'),recruiter:user(db),manager:user(db,'Hiring Manager'),finance:user(db,'Finance Approver'),interviewer:user(db,'Interviewer')};};
export const reqBody={title:'Senior Software Engineer',team:'Engineering',headcount:1,salary_min:90000,salary_max:140000,currency:'USD',description:'Build reliable internal systems.',skills:['JavaScript','SQL']};
export const candidateBody={name:'Avery Chen',email:'avery@example.com',team:'Engineering',phone:'',skills:['SQL'],resume_text:'SQL engineer',source:'Direct'};

export function addSignedOffer(db, applicationId, candidate = null, requisition = null, { salary, currency = 'USD', startDate = '2026-11-15' } = {}) {
  const reqId = id();
  const docId = id();
  const signedDocId = id();
  const signerId = id();
  const nowStr = now();
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

  const app = applicationId ? db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId) : null;
  const candId = candidate?.id || app?.candidate_id || null;
  const reqIdFromApp = requisition?.id || app?.requisition_id || null;

  const cand = candId ? db.prepare('SELECT * FROM candidates WHERE id = ?').get(candId) : candidate;
  const candName = cand?.name || candidate?.name || 'Candidate';
  const candEmail = cand?.email || candidate?.email || 'candidate@example.com';

  const reqRecord = reqIdFromApp ? db.prepare('SELECT * FROM requisitions WHERE id = ?').get(reqIdFromApp) : requisition;
  const offerSalary = salary ? String(salary) : (reqRecord?.salary_max ? String(reqRecord.salary_max) : '100000');

  let creatorId = db.prepare("SELECT id FROM users WHERE role = 'System Admin' OR role = 'Recruiter' LIMIT 1").get()?.id;
  if (!creatorId) {
    creatorId = db.prepare("SELECT id FROM users LIMIT 1").get()?.id;
  }
  if (!creatorId) {
    creatorId = id();
    db.prepare("INSERT INTO users(id, email, name, role, status, created_at) VALUES(?, 'admin@example.com', 'Admin', 'System Admin', 'active', ?)").run(creatorId, nowStr);
  }

  const hash = 'a'.repeat(64);
  const signedHash = 'b'.repeat(64);

  db.prepare(`
    INSERT INTO signature_documents(id, filename, file_format, file_size, storage_path, sha256_hash, is_signed, created_at)
    VALUES(?, 'Offer_Letter.pdf', 'pdf', 1024, 'data/signatures/offer.pdf', ?, 0, ?)
  `).run(docId, hash, nowStr);

  db.prepare(`
    INSERT INTO signature_documents(id, filename, file_format, file_size, storage_path, sha256_hash, is_signed, created_at)
    VALUES(?, 'Offer_Letter_Completed.pdf', 'pdf', 1024, 'data/signatures/signed_offer.pdf', ?, 1, ?)
  `).run(signedDocId, signedHash, nowStr);

  db.prepare(`
    INSERT INTO signature_requests(
      id, title, document_id, signed_document_id, candidate_id, application_id, requisition_id,
      status, original_document_hash, signed_document_hash, created_by, expires_at, created_at, updated_at,
      salary, currency, start_date
    ) VALUES(?, 'Employment Offer Letter', ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reqId, docId, signedDocId, candId, applicationId || null, reqIdFromApp,
    hash, signedHash, creatorId, expiresAt, nowStr, nowStr,
    offerSalary, currency, startDate
  );

  db.prepare(`
    INSERT INTO signature_signers(
      id, request_id, name, email, role, status, token_hash, signature_type, signature_data, signature_style,
      signed_at, ip_address, consent_confirmed, created_at, updated_at
    ) VALUES(?, ?, ?, ?, 'Candidate', 'signed', ?, 'typed', ?, 'cursive', ?, '127.0.0.1', 1, ?, ?)
  `).run(signerId, reqId, candName, candEmail, id(), candName, nowStr, nowStr, nowStr);

  return { requestId: reqId, signedDocId };
}

