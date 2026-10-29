/**
 * In-House E-Signature Service for Orbit ATS
 * Handles signature requests, signer token authentication, typed/uploaded/drawn
 * signature capture, document generation, and tamper-evident audit trails.
 */

import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { id, now, audit, transaction } from '../db.js';
import { HttpError, requirePermission as permit, inTeam, text as validateText, email as validateEmail, currencies } from '../policy.js';
import { SignatureStorageManager } from './storage.js';
import { validateTypedSignature, validateSignatureImage, validateDrawnSignature } from './validator.js';
import { generateOfferLetterPdf, stampSignedPdf } from './pdf.js';
import { generateStyledSignaturePng } from './renderer.js';
import { isEmailConfigured, sendCandidateCommunication } from '../communication/service.js';
import { CommunicationAdapter } from '../adapters.js';
import { renderTemplate } from '../communication/templates.js';
import { getOfferTemplate, compileTemplateToPdf } from './template_service.js';

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export const tokenCache = new Map();

export const SIGNATURE_BLOCKED_STAGES = Object.freeze(['Rejected', 'Withdrawn']);

/**
 * Central eligibility rule for creating offer/e-signature requests.
 * Candidates without applications remain eligible for general documents.
 * An application is ineligible only when it is rejected or withdrawn, and a
 * candidate is ineligible when every linked application is in one of those stages.
 */
export function getSignatureEligibility(db, { candidateId, applicationId, requisitionId } = {}) {
  let applications = [];

  if (applicationId) {
    const app = db.prepare('SELECT id, candidate_id, requisition_id, stage FROM applications WHERE id = ?').get(applicationId);
    if (app) applications = [app];
  } else if (candidateId && requisitionId) {
    const app = db.prepare('SELECT id, candidate_id, requisition_id, stage FROM applications WHERE candidate_id = ? AND requisition_id = ?').get(candidateId, requisitionId);
    if (app) applications = [app];
  } else if (candidateId) {
    applications = db.prepare('SELECT id, candidate_id, requisition_id, stage FROM applications WHERE candidate_id = ?').all(candidateId);
  }

  const blocked = applications.filter(app => SIGNATURE_BLOCKED_STAGES.includes(app.stage));
  if (applications.length > 0 && blocked.length === applications.length) {
    const hasRejected = blocked.some(app => app.stage === 'Rejected');
    return {
      eligible: false,
      applications,
      reason: hasRejected
        ? 'Cannot create an offer letter or signature request for a rejected application.'
        : 'Cannot create an offer letter or signature request for a withdrawn application.'
    };
  }

  return { eligible: true, applications, reason: '' };
}

/**
 * Dispatches an electronic signature invitation or completion confirmation email.
 * Supports production delivery via Resend/adapter and simulated delivery for local/dev
 * environments without requiring external credentials.
 */
export async function dispatchSignatureEmail(db, user, request, signer, options = {}) {
  const isCompletion = Boolean(options.isCompletion);
  const origin = options.origin || null;
  const adapter = options.adapter || options.communicationAdapter || null;
  const notes = options.notes || '';
  const appOrigin = origin || process.env.APP_ORIGIN || 'http://localhost:3000';
  const rawToken = signer.raw_token || signer.token || tokenCache.get(signer.id);
  const signingUrl = isCompletion
    ? `${appOrigin}/api/signatures/${request.id}/document?version=signed`
    : `${appOrigin}/sign/${rawToken}`;

  const expiresDate = request.expires_at ? new Date(request.expires_at) : null;
  const expiresFormatted = expiresDate
    ? expiresDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' })
    : '7 days';

  let validityText = '';
  if (expiresDate) {
    const diffMs = expiresDate.getTime() - Date.now();
    const diffDays = Math.max(0, Math.ceil(diffMs / 86400000));
    validityText = `${diffDays} day${diffDays === 1 ? '' : 's'} remaining`;
  }

  let candidate = null;
  if (request.candidate_id) {
    candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(request.candidate_id);
  }
  let req = null;
  if (request.requisition_id) {
    req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(request.requisition_id);
  }

  const emailVars = {
    candidate_name: signer.name,
    candidate_email: signer.email,
    document_title: request.title,
    requisition_title: req?.title || request.title,
    team: req?.team || user?.team || '',
    signing_url: signingUrl,
    expires_at: expiresFormatted,
    validity: validityText,
    is_completed: isCompletion,
    notes: notes || (isCompletion
      ? 'Your electronic signature and Certificate of Completion have been securely recorded and verified.'
      : 'Please review and execute your document electronically before the expiration date.')
  };

  const rendered = renderTemplate('offer_letter', emailVars);
  const idempotencyKey = options.idempotency_key || options.idempotencyKey || `sig_${isCompletion ? 'completed' : 'invite'}_${request.id}_${signer.id}${options.isResend ? `_${Date.now()}` : ''}`;
  const nowStr = now();

  // Resolve a valid sender user ID from users table for FK integrity and permissions
  let senderUser = user;
  if (!senderUser?.id || senderUser.id === 'system' || !db.prepare('SELECT id FROM users WHERE id = ?').get(senderUser.id)) {
    const creator = request.created_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(request.created_by) : null;
    const adminUser = db.prepare("SELECT * FROM users WHERE role='System Admin' AND status='active' LIMIT 1").get();
    senderUser = creator || adminUser || { id: request.created_by, role: 'System Admin', status: 'active' };
  }

  const commAdapter = adapter || new CommunicationAdapter({ db, fromEnv: true });
  const isConfigured = Boolean(adapter) || commAdapter.configured;

  if (isConfigured) {
    try {
      if (candidate && candidate.id) {
        const commRes = await sendCandidateCommunication(db, senderUser, {
          candidate_id: candidate.id,
          requisition_id: request.requisition_id || undefined,
          template_id: 'offer_letter',
          recipient_email: signer.email,
          subject: rendered.subject,
          variables: emailVars,
          idempotency_key: idempotencyKey
        }, commAdapter);
        audit(db, senderUser.id, isCompletion ? 'signature.completion_email_sent' : 'signature.invitation_email_sent', request.id, {
          signer_id: signer.id,
          recipient: signer.email,
          provider_message_id: commRes.provider_message_id || null
        });
        return {
          ok: true,
          sent: true,
          simulated: false,
          communication_id: commRes.id,
          signing_url: signingUrl,
          ...commRes
        };
      } else {
        const sendResult = await commAdapter.send({
          recipient: signer.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          templateId: 'offer_letter',
          variables: emailVars,
          idempotencyKey
        });
        audit(db, senderUser.id, isCompletion ? 'signature.completion_email_sent' : 'signature.invitation_email_sent', request.id, {
          signer_id: signer.id,
          recipient: signer.email,
          provider_message_id: sendResult.id || null
        });
        return { ok: true, sent: true, simulated: false, signing_url: signingUrl };
      }
    } catch (err) {
      audit(db, senderUser.id, isCompletion ? 'signature.completion_email_failed' : 'signature.invitation_email_failed', request.id, {
        signer_id: signer.id,
        error: err.message
      });
      return { ok: false, sent: false, simulated: false, error: err.message };
    }
  } else {
    // Local / Dev simulated delivery: record communication so it appears in ATS communications history
    const commId = id();
    if (candidate && candidate.id) {
      db.prepare(`
        INSERT INTO candidate_communications(
          id, candidate_id, requisition_id, channel, template_id,
          recipient_email, subject, idempotency_key, provider_message_id,
          status, error_message, metadata, sent_by, created_at, updated_at
        ) VALUES(?, ?, ?, 'email', 'offer_letter', ?, ?, ?, ?, 'delivered', NULL, ?, ?, ?, ?)
      `).run(
        commId,
        candidate.id,
        request.requisition_id || null,
        signer.email,
        rendered.subject,
        idempotencyKey,
        `sim_${id()}`,
        JSON.stringify({
          simulated: true,
          mode: 'local_development',
          signing_url: signingUrl,
          expires_at: expiresFormatted,
          validity: validityText,
          is_completion: isCompletion
        }),
        senderUser.id,
        nowStr,
        nowStr
      );
    }

    audit(db, senderUser.id, isCompletion ? 'signature.completion_email_simulated' : 'signature.invitation_email_simulated', request.id, {
      signer_id: signer.id,
      recipient: signer.email,
      signing_url: signingUrl,
      simulated: true
    });

    console.log(`\n[Orbit E-Signature — Local Simulation]`);
    console.log(`  To: ${signer.email} (${signer.name})`);
    console.log(`  Type: ${isCompletion ? 'Execution Confirmation' : 'Signing Invitation'}`);
    console.log(`  Subject: ${rendered.subject}`);
    console.log(`  URL: ${signingUrl}`);
    console.log(`  Expires: ${expiresFormatted} (${validityText})\n`);

    return {
      ok: true,
      sent: true,
      simulated: true,
      communication_id: commId,
      signing_url: signingUrl
    };
  }
}

/**
 * Resends an invitation email for a pending signature request.
 */
export async function resendSignatureInvitation(db, user, requestId, signerId = null, options = {}) {
  permit(user, 'signatures.manage', 'signatures.request');
  const request = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(requestId);
  if (!request) throw new HttpError(404, 'Signature request not found.');

  if (request.status === 'completed') {
    throw new HttpError(409, 'This agreement has already been completed.');
  }
  if (request.status === 'cancelled') {
    throw new HttpError(409, 'This signature request has been cancelled.');
  }
  if (request.status === 'declined') {
    throw new HttpError(409, 'This signature request was declined by the candidate.');
  }

  // Scoping check
  if (request.requisition_id) {
    const r = db.prepare('SELECT team FROM requisitions WHERE id = ?').get(request.requisition_id);
    if (r) requireTeam(user, r.team);
  } else if (request.candidate_id) {
    const c = db.prepare('SELECT team FROM candidates WHERE id = ?').get(request.candidate_id);
    if (c) requireTeam(user, c.team);
  }

  const signers = db.prepare('SELECT * FROM signature_signers WHERE request_id = ?').all(requestId);
  const targetSigners = signerId ? signers.filter(s => s.id === signerId) : signers.filter(s => s.status !== 'signed');
  if (!targetSigners.length) {
    throw new HttpError(404, 'No pending signers found to invite.');
  }

  const results = [];
  const nowStr = now();

  for (const signer of targetSigners) {
    let rawToken = signer.raw_token || tokenCache.get(signer.id);
    if (!rawToken) {
      rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      db.prepare('UPDATE signature_signers SET token_hash = ?, raw_token = ?, updated_at = ? WHERE id = ?')
        .run(tokenHash, rawToken, nowStr, signer.id);
      signer.raw_token = rawToken;
      tokenCache.set(signer.id, rawToken);
    }
    signer.token = rawToken;

    const res = await dispatchSignatureEmail(db, user, request, signer, { ...options, isResend: true });
    if (!res.ok) {
      throw new HttpError(502, `Failed to send signature invitation email: ${res.error || 'Delivery failed'}`);
    }
    audit(db, user.id, 'signature.invitation_resent', requestId, {
      signer_id: signer.id,
      email: signer.email,
      simulated: Boolean(res.simulated)
    });
    results.push({ signer_id: signer.id, email: signer.email, simulated: Boolean(res.simulated), ok: res.ok, signing_url: res.signing_url });
  }

  return {
    ok: true,
    sent: true,
    request_id: requestId,
    results
  };
}

/**
 * Creates a new signature request.
 */
export async function createSignatureRequest(db, user, {
  title,
  candidateId,
  applicationId,
  requisitionId,
  documentType = 'offer',
  documentBuffer = null,
  filename = 'document.pdf',
  signers = [],
  expiresDays = 7,
  salary,
  currency,
  startDate,
  templateId = null,
  templateVariables = {},
  customSections = null
} = {}, options = {}) {
  permit(user, 'signatures.request', 'offers.create');

  const safeTitle = validateText(title || 'Employment Offer Letter', 'Title', 200);
  const storage = options.storage || new SignatureStorageManager();

  const eligibility = getSignatureEligibility(db, { candidateId, applicationId, requisitionId });
  if (!eligibility.eligible) throw new HttpError(409, eligibility.reason);

  // Obtain or generate document buffer
  let pdfBuffer = documentBuffer;
  let candidate = null;
  let req = null;

  if (applicationId) {
    const appRecord = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
    if (appRecord) {
      if (!candidateId && appRecord.candidate_id) candidateId = appRecord.candidate_id;
      if (!requisitionId && appRecord.requisition_id) requisitionId = appRecord.requisition_id;
    }
  }

  if (candidateId) {
    candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
    if (!candidate) throw new HttpError(404, 'Candidate not found.');
    requireTeam(user, candidate.team);
  }

  if (!requisitionId && candidateId) {
    const candApp = db.prepare('SELECT requisition_id FROM applications WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1').get(candidateId);
    if (candApp?.requisition_id) requisitionId = candApp.requisition_id;
  }

  if (requisitionId) {
    req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId);
    if (!req) throw new HttpError(404, 'Requisition not found.');
    requireTeam(user, req.team);
  }

  const detectedSalaryCurrency = salary ? cleanCurrencyCode(salary, null) : null;
  const rawCurrency = currency || detectedSalaryCurrency || req?.currency || 'USD';
  const finalCurrency = cleanCurrencyCode(rawCurrency, req?.currency || 'USD');

  let finalSalary = salary || null;
  let finalStartDate = startDate || null;
  let templateSnapshot = null;
  let activeTemplateId = templateId || null;

  if (!pdfBuffer && documentType === 'offer') {
    if (activeTemplateId === 'default') {
      try {
        const defaultTpl = db.prepare("SELECT id FROM offer_letter_templates WHERE is_default = 1 AND status = 'active' LIMIT 1").get();
        if (defaultTpl) activeTemplateId = defaultTpl.id;
      } catch {}
    }

    if (activeTemplateId && activeTemplateId !== 'default') {
      try {
        const tpl = getOfferTemplate(db, user, activeTemplateId);
        if (tpl && (tpl.status === 'active' || tpl.status === 'draft')) {
          const compiled = compileTemplateToPdf(db, tpl, {
            candidateId,
            applicationId,
            requisitionId,
            offerData: {
              salary: finalSalary,
              currency: finalCurrency,
              start_date: finalStartDate,
              expires_days: expiresDays
            },
            user,
            customVariables: templateVariables,
            customSections: customSections || null
          });
          pdfBuffer = compiled.pdfBuffer;
          templateSnapshot = compiled.templateSnapshot;
          filename = `${(candidate?.name || 'Candidate').replace(/\s+/g, '_')}_Offer_Letter.pdf`;
        }
      } catch (tplErr) {
        if (templateId) throw tplErr;
      }
    }

    if (!pdfBuffer) {
      finalSalary = salary || (req?.salary_max ? String(req.salary_max) : '100,000');
      // Format clean display salary without duplicate currency symbols
      const displaySalary = String(finalSalary).replace(/^(?:INR|USD|EUR|GBP|CAD|AUD|₹|\$|€|£)\s*/i, '').trim();
      pdfBuffer = generateOfferLetterPdf({
        candidateName: candidate?.name || 'Candidate',
        requisitionTitle: req?.title || 'Open Position',
        team: req?.team || user.team || 'General',
        salary: displaySalary,
        currency: finalCurrency,
        startDate: startDate || 'Two weeks following signature acceptance',
        recruiterName: user.name || 'Talent Acquisition Team'
      });
      filename = `${(candidate?.name || 'Candidate').replace(/\s+/g, '_')}_Offer_Letter.pdf`;
    }
  }

  // Validate PDF magic bytes
  if (!pdfBuffer || !pdfBuffer.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46]))) {
    throw new HttpError(400, 'Invalid document format. Only valid PDF files are supported.');
  }

  // Save original document in storage
  const savedDoc = storage.saveDocument(pdfBuffer, filename);
  const docId = id();
  const requestId = id();
  const nowStr = now();
  const expiresAt = new Date(Date.now() + expiresDays * 86400000).toISOString();

  // Ensure at least one signer
  const signerList = Array.isArray(signers) && signers.length
    ? signers
    : [{ name: candidate?.name || 'Signer', email: candidate?.email || 'candidate@example.com', role: 'Candidate' }];

  const createdSigners = [];

  transaction(db, () => {
    // 1. Insert document record
    db.prepare(`
      INSERT INTO signature_documents(id, filename, file_format, file_size, storage_path, sha256_hash, is_signed, created_at)
      VALUES(?, ?, 'pdf', ?, ?, ?, 0, ?)
    `).run(docId, filename, savedDoc.size, savedDoc.storagePath, savedDoc.sha256, nowStr);

    // 2. Insert request record
    db.prepare(`
      INSERT INTO signature_requests(
        id, title, document_id, candidate_id, application_id, requisition_id,
        status, original_document_hash, created_by, expires_at, created_at, updated_at,
        salary, currency, start_date, template_id, template_snapshot
      )
      VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId, safeTitle, docId, candidateId || null, applicationId || null, requisitionId || null,
      savedDoc.sha256, user.id, expiresAt, nowStr, nowStr,
      finalSalary ? String(finalSalary) : null,
      finalCurrency,
      finalStartDate ? String(finalStartDate) : null,
      activeTemplateId || null,
      templateSnapshot ? JSON.stringify(templateSnapshot) : null
    );

    // 3. Insert signers and generate single-use security tokens
    for (const s of signerList) {
      const sId = id();
      const sName = validateText(s.name || 'Signer', 'Signer name', 100);
      const sEmail = validateEmail(s.email);
      const sRole = validateText(s.role || 'Signer', 'Role', 50, false);
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);

      db.prepare(`
        INSERT INTO signature_signers(
          id, request_id, name, email, role, status, token_hash, raw_token, token_expires_at,
          placement_page, placement_x, placement_y, created_at, updated_at
        )
        VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sId, requestId, sName, sEmail, sRole, tokenHash, rawToken, expiresAt,
        s.placement_page || 1, s.placement_x || 72, s.placement_y || 150, nowStr, nowStr
      );

      tokenCache.set(sId, rawToken);
      const appOrigin = options.origin || process.env.APP_ORIGIN || 'http://localhost:3000';
      createdSigners.push({
        id: sId,
        name: sName,
        email: sEmail,
        role: sRole,
        status: 'pending',
        token: rawToken,
        invitation_url: `${appOrigin}/sign/${rawToken}`
      });
    }

    // 4. Record audit entry
    audit(db, user.id, 'signature.request_created', requestId, {
      title: safeTitle,
      candidate_id: candidateId,
      original_hash: savedDoc.sha256,
      signers_count: createdSigners.length
    });
  });

  const resultReq = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(requestId);

  // 5. Send invitation emails to all signers
  for (const signer of createdSigners) {
    try {
      await dispatchSignatureEmail(db, user, resultReq, signer, {
        isCompletion: false,
        origin: options.origin,
        adapter: options.communicationAdapter,
        notes: options.notes
      });
    } catch (emailErr) {
      audit(db, user.id, 'signature.invitation_email_failed', requestId, { signer_id: signer.id, error: emailErr.message });
    }
  }

  return {
    ...resultReq,
    original_document_hash: savedDoc.sha256,
    signers: createdSigners
  };
}

/**
 * Retrieves a signature request with its signers and document metadata.
 */
export function getSignatureRequest(db, user, requestId) {
  const req = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(requestId);
  if (!req) throw new HttpError(404, 'Signature request not found.');

  // Scoping check
  if (user) {
    if (req.requisition_id) {
      const r = db.prepare('SELECT team FROM requisitions WHERE id = ?').get(req.requisition_id);
      if (r) requireTeam(user, r.team);
    } else if (req.candidate_id) {
      const c = db.prepare('SELECT team FROM candidates WHERE id = ?').get(req.candidate_id);
      if (c) requireTeam(user, c.team);
    }
  }

  const signers = db.prepare('SELECT id, request_id, name, email, role, status, raw_token, signature_type, signature_style, signed_at, created_at FROM signature_signers WHERE request_id = ?').all(requestId);
  for (const s of signers) {
    s.token = s.raw_token || (tokenCache.has(s.id) ? tokenCache.get(s.id) : undefined);
  }
  const originalDoc = db.prepare('SELECT id, filename, file_size, sha256_hash, created_at FROM signature_documents WHERE id = ?').get(req.document_id);
  const signedDoc = req.signed_document_id
    ? db.prepare('SELECT id, filename, file_size, sha256_hash, created_at FROM signature_documents WHERE id = ?').get(req.signed_document_id)
    : null;

  return {
    ...req,
    signers,
    document: originalDoc,
    signed_document: signedDoc
  };
}

/**
 * Lists signature requests accessible to the user.
 */
export function listSignatureRequests(db, user, { candidateId, applicationId, status } = {}) {
  permit(user, 'signatures.read', 'offers.read');

  let sql = 'SELECT * FROM signature_requests WHERE 1=1';
  const params = [];

  if (candidateId) {
    sql += ' AND candidate_id = ?';
    params.push(candidateId);
  }
  if (applicationId) {
    sql += ' AND application_id = ?';
    params.push(applicationId);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';

  const requests = db.prepare(sql).all(...params);

  // Filter by team
  const filtered = requests.filter(req => {
    if (req.requisition_id) {
      const r = db.prepare('SELECT team FROM requisitions WHERE id = ?').get(req.requisition_id);
      return !r || inTeam(user, r.team);
    }
    if (req.candidate_id) {
      const c = db.prepare('SELECT team FROM candidates WHERE id = ?').get(req.candidate_id);
      return !c || inTeam(user, c.team);
    }
    return true;
  });

  return filtered.map(req => {
    const signers = db.prepare('SELECT id, request_id, name, email, role, status, raw_token, signature_type, signature_style, signed_at, created_at FROM signature_signers WHERE request_id = ?').all(req.id);
    for (const s of signers) {
      s.token = s.raw_token || (tokenCache.has(s.id) ? tokenCache.get(s.id) : undefined);
    }
    return {
      ...req,
      signers
    };
  });
}

/**
 * Authenticates a single-use or scoped signing session token.
 */
export function getSigningSessionByToken(db, token) {
  if (!token || typeof token !== 'string') {
    throw new HttpError(400, 'Signing token is missing.');
  }

  const tHash = hashToken(token);
  const signer = db.prepare('SELECT * FROM signature_signers WHERE token_hash = ?').get(tHash);
  if (!signer) {
    throw new HttpError(404, 'Signing session not found or link is invalid.');
  }

  if (signer.token_expires_at && new Date(signer.token_expires_at) < new Date()) {
    throw new HttpError(410, 'This signature request link has expired. Please request a new invitation.');
  }

  const request = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(signer.request_id);
  if (!request) {
    throw new HttpError(404, 'Associated signature request not found.');
  }

  if (request.status === 'cancelled') {
    throw new HttpError(410, 'This signature request was cancelled by the hiring team.');
  }
  if (request.status === 'declined') {
    throw new HttpError(410, 'This signature request has already been declined.');
  }

  // Record viewed audit and status transition if first view
  if (signer.status === 'pending') {
    const nowStr = now();
    db.prepare("UPDATE signature_signers SET status = 'viewed', updated_at = ? WHERE id = ?").run(nowStr, signer.id);
    if (request.status === 'pending') {
      db.prepare("UPDATE signature_requests SET status = 'viewed', updated_at = ? WHERE id = ?").run(nowStr, request.id);
      request.status = 'viewed';
    }
    signer.status = 'viewed';
    audit(db, signer.email, 'signature.viewed', request.id, { signer_id: signer.id });
  }

  const doc = db.prepare('SELECT id, filename, file_size, sha256_hash FROM signature_documents WHERE id = ?').get(request.document_id);

  return {
    signer: {
      id: signer.id,
      name: signer.name,
      email: signer.email,
      role: signer.role,
      status: signer.status,
      signed_at: signer.signed_at
    },
    request: {
      id: request.id,
      title: request.title,
      status: request.status,
      candidate_id: request.candidate_id,
      requisition_id: request.requisition_id,
      created_by: request.created_by,
      expires_at: request.expires_at,
      original_document_hash: request.original_document_hash
    },
    document: doc
  };
}

/**
 * Submits an electronic signature (typed, uploaded image, or drawn).
 */
export async function submitSignature(db, actorOrToken, {
  signatureType = 'typed',
  signatureData = '',
  signatureStyle = 'cursive',
  signatureImage = null,
  consent = false,
  ipAddress = '127.0.0.1',
  userAgent = 'Orbit ATS Signing Client'
} = {}, options = {}) {
  if (!consent) {
    throw new HttpError(400, 'Affirmative consent is required to execute an electronic signature.');
  }

  let signer;
  let request;

  if (typeof actorOrToken === 'string') {
    const session = getSigningSessionByToken(db, actorOrToken);
    signer = db.prepare('SELECT * FROM signature_signers WHERE id = ?').get(session.signer.id);
    request = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(session.request.id);
  } else if (actorOrToken?.signerId) {
    signer = db.prepare('SELECT * FROM signature_signers WHERE id = ?').get(actorOrToken.signerId);
    if (!signer) throw new HttpError(404, 'Signer record not found.');
    request = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(signer.request_id);
  } else {
    throw new HttpError(401, 'Unauthorized signing session.');
  }

  // Idempotency check: prevent duplicate signing
  if (signer.status === 'signed') {
    throw new HttpError(409, 'This document has already been signed by this recipient.');
  }

  const storage = options.storage || new SignatureStorageManager();
  let storedSignatureData = signatureData;
  let validatedStyle = signatureStyle;

  const normType = signatureType === 'upload' ? 'uploaded' : signatureType;

  // Process signature type
  if (normType === 'typed') {
    const val = validateTypedSignature({
      name: signatureData || signer.name,
      style: signatureStyle
    });
    storedSignatureData = val.name;
    validatedStyle = val.style;

    if (signatureImage) {
      try {
        const rawBuf = Buffer.isBuffer(signatureImage)
          ? signatureImage
          : Buffer.from(String(signatureImage).replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64');
        storage.saveTypedSignatureAsset(signer.id, rawBuf);
      } catch {}
    } else {
      try {
        const genBuf = generateStyledSignaturePng(storedSignatureData, validatedStyle);
        storage.saveTypedSignatureAsset(signer.id, genBuf);
      } catch {}
    }
  } else if (normType === 'uploaded') {
    const buf = Buffer.isBuffer(signatureData) ? signatureData : Buffer.from(signatureData, 'base64');
    const val = validateSignatureImage({ buffer: buf });
    const asset = storage.saveSignatureAsset(buf, val.format);
    storedSignatureData = asset.storagePath;
  } else if (normType === 'drawn') {
    const val = validateDrawnSignature(signatureData);
    const asset = storage.saveSignatureAsset(val.buffer, 'png');
    storedSignatureData = asset.storagePath;
  } else {
    throw new HttpError(400, 'Invalid signature type. Supported types: typed, uploaded, drawn.');
  }

  const nowStr = now();

  const result = transaction(db, () => {
    // 1. Update signer record
    db.prepare(`
      UPDATE signature_signers
      SET status = 'signed', signature_type = ?, signature_data = ?, signature_style = ?,
          signed_at = ?, ip_address = ?, user_agent = ?, consent_confirmed = 1, updated_at = ?
      WHERE id = ?
    `).run(
      normType, storedSignatureData, validatedStyle, nowStr, ipAddress, userAgent, nowStr, signer.id
    );

    // 2. Audit record for individual signing
    audit(db, signer.email, 'signature.signed', request.id, {
      signer_id: signer.id,
      signer_name: signer.name,
      signature_type: signatureType,
      signature_style: validatedStyle,
      ip: ipAddress
    });

    // 3. Check if all signers have signed
    const allSigners = db.prepare('SELECT * FROM signature_signers WHERE request_id = ?').all(request.id);
    const allSigned = allSigners.every(s => s.status === 'signed');

    if (allSigned) {
      // Load original document
      const docRecord = db.prepare('SELECT * FROM signature_documents WHERE id = ?').get(request.document_id);
      const originalPdfBuffer = storage.readFile(docRecord.storage_path);

      // Verify original document hash integrity before stamping
      const currentOriginalHash = storage.hash(originalPdfBuffer);
      if (currentOriginalHash !== request.original_document_hash) {
        throw new HttpError(409, 'Original document integrity check failed. Document was modified after request creation.');
      }

      // Stamp PDF with visual signatures and certificate
      const signedPdfBuffer = stampSignedPdf({
        originalPdfBuffer,
        request,
        signers: allSigners,
        storage
      });

      // Save signed output
      const savedSigned = storage.saveSignedDocument(signedPdfBuffer, request.id);
      const signedDocId = id();

      db.prepare(`
        INSERT INTO signature_documents(id, filename, file_format, file_size, storage_path, sha256_hash, is_signed, created_at)
        VALUES(?, ?, 'pdf', ?, ?, ?, 1, ?)
      `).run(
        signedDocId, `${request.title.replace(/\s+/g, '_')}_Completed.pdf`,
        signedPdfBuffer.length, savedSigned.storagePath, savedSigned.sha256, nowStr
      );

      db.prepare(`
        UPDATE signature_requests
        SET status = 'completed', signed_document_id = ?, signed_document_hash = ?, updated_at = ?
        WHERE id = ?
      `).run(signedDocId, savedSigned.sha256, nowStr, request.id);

      audit(db, 'system', 'signature.completed', request.id, {
        original_hash: request.original_document_hash,
        signed_hash: savedSigned.sha256,
        signers_count: allSigners.length
      });

      return {
        status: 'completed',
        signer_status: 'signed',
        signed_document_hash: savedSigned.sha256
      };
    } else {
      db.prepare(`
        UPDATE signature_requests
        SET status = 'partially_signed', updated_at = ?
        WHERE id = ?
      `).run(nowStr, request.id);

      return {
        status: 'partially_signed',
        signer_status: 'signed'
      };
    }
  });

  // 4. Dispatch completion emails to signers if document is completed
  if (result.status === 'completed') {
    const updatedRequest = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(request.id);
    const allSigners = db.prepare('SELECT * FROM signature_signers WHERE request_id = ?').all(request.id);
    const appOrigin = options.origin || process.env.APP_ORIGIN || 'http://localhost:3000';
    for (const s of allSigners) {
      try {
        await dispatchSignatureEmail(db, { id: 'system', name: 'Orbit System', role: 'System Admin', status: 'active' }, updatedRequest, s, {
          isCompletion: true,
          origin: appOrigin,
          adapter: options.communicationAdapter
        });
      } catch (err) {
        audit(db, 'system', 'signature.completion_email_failed', request.id, { signer_id: s.id, error: err.message });
      }
    }
  }

  return result;
}

/**
 * Declines a signature request with an optional reason.
 */
export function declineSignature(db, rawToken, { reason = '' } = {}) {
  const session = getSigningSessionByToken(db, rawToken);
  const nowStr = now();

  return transaction(db, () => {
    db.prepare(`
      UPDATE signature_signers
      SET status = 'declined', declined_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, nowStr, session.signer.id);

    db.prepare(`
      UPDATE signature_requests
      SET status = 'declined', updated_at = ?
      WHERE id = ?
    `).run(nowStr, session.request.id);

    audit(db, session.signer.email, 'signature.declined', session.request.id, {
      reason,
      signer_id: session.signer.id
    });

    if (session.request.candidate_id) {
      try {
        const commId = id();
        const sentByUserId = session.request.created_by || db.prepare("SELECT id FROM users LIMIT 1").get()?.id;
        db.prepare(`
          INSERT INTO candidate_communications(
            id, candidate_id, requisition_id, channel, template_id,
            recipient_email, subject, idempotency_key, provider_message_id,
            status, error_message, metadata, sent_by, created_at, updated_at
          ) VALUES(?, ?, ?, 'email', 'offer_letter', ?, ?, ?, ?, 'delivered', NULL, ?, ?, ?, ?)
        `).run(
          commId,
          session.request.candidate_id,
          session.request.requisition_id || null,
          session.signer.email,
          `Declined: ${session.request.title}`,
          `sig_decline_${session.request.id}_${session.signer.id}_${Date.now()}`,
          `sim_${id()}`,
          JSON.stringify({ event: 'signature_declined', reason, signer_name: session.signer.name }),
          sentByUserId,
          nowStr,
          nowStr
        );
      } catch {}
    }

    return { status: 'declined', reason };
  });
}

/**
 * Cancels a signature request (by recruiter or admin).
 */
export function cancelSignatureRequest(db, user, requestId, { reason = '' } = {}) {
  permit(user, 'signatures.manage');
  const req = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(requestId);
  if (!req) throw new HttpError(404, 'Signature request not found.');

  if (req.status === 'completed') {
    throw new HttpError(409, 'Cannot cancel a completed signature agreement.');
  }

  const nowStr = now();

  return transaction(db, () => {
    db.prepare(`
      UPDATE signature_requests
      SET status = 'cancelled', updated_at = ?
      WHERE id = ?
    `).run(nowStr, requestId);

    audit(db, user.id, 'signature.cancelled', requestId, { reason });
    return { status: 'cancelled', requestId };
  });
}

/**
 * Downloads the original or signed PDF document for a signature request.
 */
export function downloadSignatureDocument(db, userOrToken, requestId = '', version = 'signed', options = {}) {
  let reqId = requestId;
  if (typeof userOrToken === 'string') {
    // Verified by signing token
    const session = getSigningSessionByToken(db, userOrToken);
    if (reqId && session.request.id !== reqId) {
      throw new HttpError(403, 'Unauthorized access to this document.');
    }
    reqId = session.request.id;
  }
  const req = db.prepare('SELECT * FROM signature_requests WHERE id = ?').get(reqId);
  if (!req) throw new HttpError(404, 'Signature request not found.');
  if (typeof userOrToken === 'object' && userOrToken) {
    if (req.requisition_id) {
      const r = db.prepare('SELECT team FROM requisitions WHERE id = ?').get(req.requisition_id);
      if (r) requireTeam(userOrToken, r.team);
    } else if (req.candidate_id) {
      const c = db.prepare('SELECT team FROM candidates WHERE id = ?').get(req.candidate_id);
      if (c) requireTeam(userOrToken, c.team);
    }
  }

  const storage = options.storage || new SignatureStorageManager();

  const targetDocId = (version === 'signed' && req.signed_document_id)
    ? req.signed_document_id
    : req.document_id;

  const doc = db.prepare('SELECT * FROM signature_documents WHERE id = ?').get(targetDocId);
  if (!doc) throw new HttpError(404, 'Document record not found.');

  const buffer = storage.readFile(doc.storage_path);
  return {
    isRaw: true,
    contentType: 'application/pdf',
    buffer,
    filename: doc.filename,
    sha256: doc.sha256_hash,
    isSigned: Boolean(doc.is_signed)
  };
}

function requireTeam(user, team) {
  if (!inTeam(user, team)) throw new HttpError(403, 'Team mismatch: access denied.');
}

/**
 * Normalizes an offer letter start date to YYYY-MM-DD format without timezone shifts.
 * Returns null if no specific calendar date is specified (e.g. 'Two weeks following signature acceptance').
 */
export function parseOfferJoiningDate(startDateStr) {
  if (!startDateStr || typeof startDateStr !== 'string') return null;
  const trimmed = startDateStr.trim();
  if (!trimmed) return null;

  // Ignore non-date descriptive phrases
  if (/two\s+weeks|acceptance|tbd|immediate|pending|upon\s+signature/i.test(trimmed)) {
    return null;
  }

  // 1. Direct YYYY-MM-DD or YYYY/MM/DD (preserves exact date without timezone shift)
  const ymd = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) {
    const y = ymd[1];
    const m = String(ymd[2]).padStart(2, '0');
    const d = String(ymd[3]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 2. DD-MM-YYYY or DD/MM/YYYY
  const dmy = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    const d = String(dmy[1]).padStart(2, '0');
    const m = String(dmy[2]).padStart(2, '0');
    const y = dmy[3];
    return `${y}-${m}-${d}`;
  }

  // 3. Textual date parsing (e.g. "November 15, 2026" or "15 Nov 2026")
  const monthNames = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };
  const namedMonthMatch = trimmed.match(/([a-z]{3,})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i) ||
                          trimmed.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})[a-z]*,?\s+(\d{4})/i);
  if (namedMonthMatch) {
    let monthStr, dayStr, yearStr;
    if (isNaN(Number(namedMonthMatch[1]))) {
      monthStr = namedMonthMatch[1].slice(0, 3).toLowerCase();
      dayStr = namedMonthMatch[2];
      yearStr = namedMonthMatch[3];
    } else {
      dayStr = namedMonthMatch[1];
      monthStr = namedMonthMatch[2].slice(0, 3).toLowerCase();
      yearStr = namedMonthMatch[3];
    }
    if (monthNames[monthStr]) {
      return `${yearStr}-${monthNames[monthStr]}-${String(dayStr).padStart(2, '0')}`;
    }
  }

  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    const dt = new Date(parsed);
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}

/**
 * Cleans and converts a salary string or number to a finite numeric value.
 */
export function cleanSalaryValue(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  const s = String(val).replace(/[^0-9.]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes currency codes from raw input strings, symbols, or requisition records.
 * Supports symbols like ₹, $, €, £, and standard 3-letter codes.
 */
export function cleanCurrencyCode(val, fallback = 'USD') {
  if (val === null || val === undefined) return fallback;
  const s = String(val).trim();
  if (!s) return fallback;

  if (/^₹|^rs\.?|^inr/i.test(s)) return 'INR';
  if (/^\$|^usd/i.test(s)) return 'USD';
  if (/^€|^eur/i.test(s)) return 'EUR';
  if (/^£|^gbp/i.test(s)) return 'GBP';
  if (/^c\$|^cad/i.test(s)) return 'CAD';
  if (/^a\$|^aud/i.test(s)) return 'AUD';
  if (/^¥|^jpy/i.test(s)) return 'JPY';

  const m = s.toUpperCase().match(/[A-Z]{3}/);
  if (m && currencies.includes(m[0])) return m[0];
  if (m) return m[0];

  return fallback;
}

/**
 * Verifies that the application has a successfully completed and verified offer-letter signature.
 * Returns { verified: true, request, signers } or { verified: false, status, reason }.
 */
export function verifyApplicationOfferSignature(db, applicationId, candidateId = null, requisitionId = null) {
  const requests = db.prepare(`
    SELECT r.*, d.storage_path, d.is_signed, d.sha256_hash AS doc_hash
    FROM signature_requests r
    LEFT JOIN signature_documents d ON d.id = r.signed_document_id
    WHERE (r.application_id = ? OR (r.application_id IS NULL AND r.candidate_id = ? AND (r.requisition_id = ? OR r.requisition_id IS NULL)))
    ORDER BY r.created_at DESC, r.updated_at DESC
  `).all(applicationId, candidateId, requisitionId);

  if (!requests.length) {
    return {
      verified: false,
      reason: 'No offer letter found for this candidate. The candidate must sign the offer letter before proceeding.'
    };
  }

  const latest = requests[0];

  if (latest.status === 'pending') {
    return {
      verified: false,
      status: 'pending',
      reason: 'Offer letter is pending signature. The candidate must sign the offer letter before proceeding.'
    };
  }
  if (latest.status === 'declined') {
    return {
      verified: false,
      status: 'declined',
      reason: 'Offer letter was declined. The candidate must sign the offer letter before proceeding.'
    };
  }
  if (latest.status === 'expired') {
    return {
      verified: false,
      status: 'expired',
      reason: 'Offer letter has expired. The candidate must sign the offer letter before proceeding.'
    };
  }
  if (latest.status === 'cancelled') {
    return {
      verified: false,
      status: 'cancelled',
      reason: 'Offer letter was cancelled. The candidate must sign the offer letter before proceeding.'
    };
  }
  if (latest.status === 'partially_signed' || latest.status === 'draft' || latest.status === 'viewed') {
    return {
      verified: false,
      status: latest.status,
      reason: 'Offer letter signature is incomplete. The candidate must sign the offer letter before proceeding.'
    };
  }
  if (latest.status !== 'completed') {
    return {
      verified: false,
      status: latest.status,
      reason: 'The candidate must sign the offer letter before proceeding.'
    };
  }

  // Verify backend records integrity: signed document
  if (!latest.signed_document_id || latest.is_signed !== 1 || !latest.signed_document_hash) {
    return {
      verified: false,
      reason: 'Offer letter signed document verification failed. The candidate must sign the offer letter before proceeding.'
    };
  }

  // Verify backend records integrity: signers
  const signers = db.prepare('SELECT * FROM signature_signers WHERE request_id = ?').all(latest.id);
  if (!signers.length || !signers.every(s => s.status === 'signed' && s.signed_at && s.consent_confirmed === 1)) {
    return {
      verified: false,
      reason: 'Candidate signature verification incomplete. The candidate must sign the offer letter before proceeding.'
    };
  }

  return {
    verified: true,
    request: latest,
    signers
  };
}

/**
 * Retrieves authoritative approved candidate offer details (salary, joining date, signed document URL).
 */
export function getAuthoritativeOfferDetails(db, applicationId, candidateId = null, requisitionId = null, fallbackReq = null) {
  const completedOffer = db.prepare(`
    SELECT r.id AS request_id, r.signed_document_id, r.salary, r.currency, r.start_date,
           d.storage_path, d.sha256_hash AS doc_hash
    FROM signature_requests r
    LEFT JOIN signature_documents d ON d.id = r.signed_document_id
    WHERE (r.application_id = ? OR (r.application_id IS NULL AND r.candidate_id = ? AND (r.requisition_id = ? OR r.requisition_id IS NULL)))
      AND r.status = 'completed'
    ORDER BY r.updated_at DESC, r.created_at DESC
    LIMIT 1
  `).get(applicationId, candidateId, requisitionId);

  let rawSalary = completedOffer?.salary || null;
  let rawStartDate = completedOffer?.start_date || null;
  let rawCurrency = completedOffer?.currency || null;

  if ((!rawSalary || !rawStartDate || !rawCurrency) && completedOffer?.storage_path && existsSync(completedOffer.storage_path)) {
    try {
      const pdfBuf = readFileSync(completedOffer.storage_path);
      let pdfContent = pdfBuf.toString('utf8');
      let idx = 0;
      while ((idx = pdfBuf.indexOf('stream', idx)) !== -1) {
        const end = pdfBuf.indexOf('endstream', idx);
        const start = pdfBuf.indexOf(0x0a, idx) + 1;
        try {
          const decompressed = zlib.inflateSync(pdfBuf.subarray(start, end)).toString('utf8');
          pdfContent += '\n' + decompressed;
        } catch {}
        idx = end + 9;
      }
      if (!rawSalary) {
        const salMatch = pdfContent.match(/Annual Base Salary:\s*(?:[A-Z]{3}|[^\s0-9()]+)?\s*([0-9,.]+)/i);
        if (salMatch) rawSalary = salMatch[1];
      }
      if (!rawStartDate) {
        const dateMatch = pdfContent.match(/Anticipated Start Date:\s*([^\r\n)]+)/i);
        if (dateMatch) rawStartDate = dateMatch[1]?.trim();
      }
      if (!rawCurrency) {
        const currMatch = pdfContent.match(/Annual Base Salary:\s*([A-Z]{3})/i);
        if (currMatch) rawCurrency = currMatch[1]?.trim()?.toUpperCase();
      }
    } catch {}
  }

  const cleanedSalary = cleanSalaryValue(rawSalary);
  const finalSalary = cleanedSalary !== null ? cleanedSalary : (fallbackReq?.salary_min !== undefined ? fallbackReq.salary_min : null);
  const joiningDate = parseOfferJoiningDate(rawStartDate);
  const finalCurrency = cleanCurrencyCode(rawCurrency || fallbackReq?.currency || 'USD', fallbackReq?.currency || 'USD');

  return {
    salary: finalSalary,
    currency: finalCurrency,
    currencyCode: finalCurrency,
    joiningDate,
    rawStartDate,
    storagePath: completedOffer?.storage_path || null,
    requestId: completedOffer?.request_id || null,
    signedDocId: completedOffer?.signed_document_id || null
  };
}

