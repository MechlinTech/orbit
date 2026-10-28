/**
 * Core communication service for Orbit candidate email communications.
 * Integrates Resend provider, enforces candidate consent and opt-out,
 * supports bounded retries, idempotency, and audit logging.
 */
import { id, now, audit, transaction } from '../db.js';
import { HttpError, requirePermission as permit, requireTeam, email as validateEmail, text as validateText } from '../policy.js';
import { renderTemplate, escapeHtml } from './templates.js';
import { getEffectiveIntegrationConfig } from '../integrations/storage.js';

export function getFromAddress(db = null) {
  if (db) {
    try {
      const eff = getEffectiveIntegrationConfig(db, 'email_communication');
      if (eff.enabled && eff.isConfigured && eff.config?.fromEmail) {
        return eff.config.fromEmail;
      }
    } catch {}
  }
  return process.env.EMAIL_FROM || process.env.RESEND_FROM_EMAIL || null;
}

export function isEmailConfigured(db = null, config = null) {
  if (config?.communicationAdapter || (config?.resendApiKey && (config?.emailFrom || getFromAddress(db)))) {
    return true;
  }
  if (db) {
    try {
      const eff = getEffectiveIntegrationConfig(db, 'email_communication');
      if (eff.enabled && eff.isConfigured && eff.secrets?.apiKey && (eff.config?.fromEmail || getFromAddress(db))) {
        return true;
      }
    } catch {}
  }
  return Boolean(process.env.RESEND_API_KEY && getFromAddress());
}

/**
 * Classifies whether an HTTP status code or error is transient and eligible for retry.
 */
export function isTransientError(statusOrError) {
  if (typeof statusOrError === 'number') {
    return statusOrError === 429 || (statusOrError >= 500 && statusOrError <= 504);
  }
  const msg = String(statusOrError?.message || statusOrError);
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|timeout|rate limit|429|500|502|503|504/i.test(msg);
}

/**
 * Bounded retry wrapper for provider API calls with exponential backoff.
 */
export async function withRetries(fn, { maxRetries = 2, initialDelayMs = 50 } = {}) {
  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const isTransient = isTransientError(err.status || err);
      if (attempt > maxRetries || !isTransient) {
        throw err;
      }
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

/**
 * Checks candidate consent preferences.
 * By default candidates are subscribed (opted_out = false).
 */
export function getCandidateConsent(db, candidateId) {
  const row = db.prepare('SELECT opted_out, opt_out_reason, updated_at FROM communication_consents WHERE candidate_id = ?').get(candidateId);
  return {
    opted_out: Boolean(row?.opted_out),
    reason: row?.opt_out_reason || '',
    updated_at: row?.updated_at || null
  };
}

/**
 * Updates candidate communication consent preferences.
 */
export function setCandidateConsent(db, user, candidateId, optedOut, reason = '') {
  permit(user, 'candidates.consent.update', 'recruit');
  const cand = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
  if (!cand) throw new HttpError(404, 'Candidate not found.');
  requireTeam(user, cand.team);

  const cleanOptedOut = Boolean(optedOut);
  const cleanReason = validateText(reason || '', 'Consent reason', 500, true);
  const updatedAt = now();

  return transaction(db, () => {
    db.prepare(`
      INSERT INTO communication_consents(candidate_id, opted_out, opt_out_reason, updated_by, updated_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        opted_out = excluded.opted_out,
        opt_out_reason = excluded.opt_out_reason,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(candidateId, cleanOptedOut ? 1 : 0, cleanReason, user.id, updatedAt);

    audit(db, user.id, 'candidate.consent_updated', candidateId, {
      opted_out: cleanOptedOut,
      reason: cleanReason
    });

    return {
      candidate_id: candidateId,
      opted_out: cleanOptedOut,
      reason: cleanReason,
      updated_at: updatedAt
    };
  });
}

/**
 * Retrieves the communication history for a candidate.
 */
export function listCandidateCommunications(db, user, candidateId) {
  permit(user, 'candidates.communications.read', 'recruit', 'review');
  const cand = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
  if (!cand) throw new HttpError(404, 'Candidate not found.');
  requireTeam(user, cand.team);

  const comms = db.prepare(`
    SELECT c.*, u.name as sent_by_name
    FROM candidate_communications c
    LEFT JOIN users u ON u.id = c.sent_by
    WHERE c.candidate_id = ?
    ORDER BY c.created_at DESC
  `).all(candidateId);

  const consent = getCandidateConsent(db, candidateId);

  return {
    candidate_id: candidateId,
    consent,
    communications: comms.map(c => ({
      id: c.id,
      candidate_id: c.candidate_id,
      requisition_id: c.requisition_id,
      channel: c.channel,
      template_id: c.template_id,
      recipient_email: c.recipient_email,
      subject: c.subject,
      provider_message_id: c.provider_message_id,
      status: c.status,
      error_message: c.error_message,
      sent_by_name: c.sent_by_name || 'System',
      created_at: c.created_at,
      updated_at: c.updated_at
    }))
  };
}

/**
 * Sends a communication to a candidate using a validated template or custom message.
 */
export async function sendCandidateCommunication(db, user, body, adapter) {
  permit(user, 'candidates.communications.send', 'recruit');
  const candidateId = body.candidate_id || body.candidateId;
  if (!candidateId) throw new HttpError(400, 'Candidate ID is required.');

  const cand = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
  if (!cand) throw new HttpError(404, 'Candidate not found.');
  requireTeam(user, cand.team);

  const recipient = body.recipient_email ? validateEmail(body.recipient_email) : validateEmail(cand.email);
  const templateId = body.template_id || body.templateId || 'application_acknowledgement';
  const reqId = body.requisition_id || body.requisitionId || null;
  let req = null;
  if (reqId) {
    req = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(reqId);
    if (req) requireTeam(user, req.team);
  }

  // Idempotency check: if an idempotency key was supplied and was already processed, return existing
  const idempotencyKey = body.idempotency_key ? String(body.idempotency_key).trim() : null;
  let commId = id();
  let isRetryOfFailed = false;
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM candidate_communications WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      if (existing.status !== 'failed') {
        return {
          ...existing,
          idempotent_replay: true
        };
      }
      commId = existing.id;
      isRetryOfFailed = true;
    }
  }

  // Enforce candidate consent and opt-out preferences
  const consent = getCandidateConsent(db, candidateId);
  const vars = {
    candidate_name: cand.name,
    candidate_email: recipient,
    requisition_title: req?.title || body.requisition_title || '',
    team: req?.team || cand.team || '',
    scheduled_at: body.scheduled_at || '',
    interviewer_name: body.interviewer_name || '',
    notes: body.notes || body.custom_notes || '',
    meeting_url: body.meeting_url || '',
    interview_type: body.interview_type || 'virtual',
    location: body.location || '',
    ...(body.variables || {})
  };

  const rendered = renderTemplate(templateId, vars);

  // If candidate opted out and template is not essential, reject send
  if (consent.opted_out && !rendered.isEssential) {
    throw new HttpError(409, 'Candidate has opted out of recruitment email communications.');
  }

  const subject = body.subject ? validateText(body.subject, 'Subject', 300) : rendered.subject;
  const html = body.html || rendered.html;
  const text = body.text || rendered.text;
  const createdAt = now();

  // Create communication record in queued state
  try {
    transaction(db, () => {
      if (isRetryOfFailed) {
        db.prepare(`
          UPDATE candidate_communications
          SET status = 'queued', error_message = NULL, recipient_email = ?, subject = ?, updated_at = ?
          WHERE id = ?
        `).run(recipient, subject, createdAt, commId);
      } else {
        db.prepare(`
          INSERT INTO candidate_communications(
            id, candidate_id, requisition_id, channel, template_id,
            recipient_email, subject, idempotency_key, provider_message_id,
            status, error_message, metadata, sent_by, created_at, updated_at
          ) VALUES(?, ?, ?, 'email', ?, ?, ?, ?, NULL, 'queued', NULL, ?, ?, ?, ?)
        `).run(
          commId,
          candidateId,
          reqId,
          templateId,
          recipient,
          subject,
          idempotencyKey,
          JSON.stringify({ isEssential: rendered.isEssential, consentReference: consent.opted_out ? 'operational_exemption' : 'active_consent' }),
          user.id,
          createdAt,
          createdAt
        );
      }
    });
  } catch (insertErr) {
    if (idempotencyKey && String(insertErr.message).includes('UNIQUE constraint')) {
      const existing = db.prepare('SELECT * FROM candidate_communications WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing && existing.status !== 'failed') {
        return {
          ...existing,
          idempotent_replay: true
        };
      }
    }
    throw insertErr;
  }

  // Execute delivery via communication adapter
  try {
    const result = await adapter.send({
      candidateId,
      channel: 'email',
      templateId,
      recipient,
      subject,
      html,
      text,
      variables: vars,
      idempotencyKey,
      consentReference: consent.opted_out ? 'operational_exemption' : 'active_consent'
    });

    const providerMessageId = result.id || result.messageId || null;
    const updatedAt = now();

    db.prepare(`
      UPDATE candidate_communications
      SET status = 'accepted', provider_message_id = ?, updated_at = ?
      WHERE id = ?
    `).run(providerMessageId, updatedAt, commId);

    audit(db, user.id, 'candidate.email_sent', candidateId, {
      communication_id: commId,
      template_id: templateId,
      recipient: recipient,
      provider_message_id: providerMessageId,
      status: 'accepted'
    });

    return {
      id: commId,
      candidate_id: candidateId,
      requisition_id: reqId,
      template_id: templateId,
      recipient_email: recipient,
      subject,
      provider_message_id: providerMessageId,
      status: 'accepted',
      created_at: createdAt,
      updated_at: updatedAt
    };
  } catch (err) {
    const sanitizedError = String(err.message || 'Email delivery failed').replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED]');
    const updatedAt = now();

    db.prepare(`
      UPDATE candidate_communications
      SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(sanitizedError, updatedAt, commId);

    audit(db, user.id, 'candidate.email_failed', candidateId, {
      communication_id: commId,
      template_id: templateId,
      recipient: recipient,
      reason: sanitizedError
    });

    const errorStatus = err.status || (sanitizedError.includes('not configured') ? 503 : 502);
    throw new HttpError(errorStatus, `Email delivery failed: ${sanitizedError}`);
  }
}

/**
 * Centralized pipeline stage transition notification service.
 * Enforces consistent status email triggers across all stage changes.
 */
export async function sendStageTransitionNotification({
  db,
  user,
  applicationId,
  oldStage,
  newStage,
  candidate = null,
  requisition = null,
  notes = '',
  sendNotification = true,
  config = null,
  adapter = null,
  templateId = null
}) {
  if (oldStage === newStage) {
    return { sent: false, reason: 'unchanged_stage' };
  }
  if (sendNotification === false) {
    return { sent: false, reason: 'notification_disabled' };
  }

  const emailConfigured = isEmailConfigured(db, config) || Boolean(adapter || config?.communicationAdapter);
  if (!emailConfigured) {
    return { sent: false, reason: 'email_not_configured' };
  }

  let cand = candidate;
  if (!cand && applicationId) {
    const app = db.prepare('SELECT candidate_id FROM applications WHERE id = ?').get(applicationId);
    if (app?.candidate_id) {
      cand = db.prepare('SELECT id, name, email, team FROM candidates WHERE id = ?').get(app.candidate_id);
    }
  }

  if (!cand || !cand.email) {
    return { sent: false, reason: 'missing_candidate_email' };
  }

  let req = requisition;
  if (!req && applicationId) {
    req = db.prepare('SELECT r.* FROM requisitions r JOIN applications a ON a.requisition_id = r.id WHERE a.id = ?').get(applicationId);
  }

  let commAdapter = adapter || config?.communicationAdapter;
  if (!commAdapter) {
    const { CommunicationAdapter } = await import('../adapters.js');
    commAdapter = new CommunicationAdapter({ db, fromEnv: true, transport: config?.transport });
  }

  const chosenTemplateId = templateId || (newStage === 'Rejected' ? 'application_rejection' : 'stage_update');
  const appOrigin = config?.origin || (typeof process !== 'undefined' ? process.env?.APP_ORIGIN : null) || 'http://localhost:3000';

  const emailVars = {
    candidate_name: cand.name,
    candidate_email: cand.email,
    requisition_title: req?.title || '',
    team: req?.team || cand.team || '',
    stage: newStage,
    new_stage: newStage,
    previous_stage: oldStage,
    from_stage: oldStage,
    notes: notes || '',
    app_origin: appOrigin
  };

  const safeAppId = String(applicationId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeNew = String(newStage || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeOld = String(oldStage || 'none').replace(/[^a-zA-Z0-9_-]/g, '_');
  const idempotencyKey = `stage_update_${safeAppId}_${safeNew}_${safeOld}`;

  try {
    const result = await sendCandidateCommunication(db, user, {
      candidate_id: cand.id,
      requisition_id: req?.id || undefined,
      template_id: chosenTemplateId,
      recipient_email: cand.email,
      variables: emailVars,
      idempotency_key: idempotencyKey
    }, commAdapter);

    audit(db, user.id, 'application.stage_email_sent', applicationId, {
      stage: newStage,
      previous_stage: oldStage,
      candidate_id: cand.id,
      recipient: cand.email,
      communication_id: result.id
    });

    return { sent: true, communication_id: result.id, idempotent_replay: Boolean(result.idempotent_replay) };
  } catch (emailErr) {
    audit(db, user.id, 'application.stage_email_failed', applicationId, {
      stage: newStage,
      previous_stage: oldStage,
      candidate_id: cand.id,
      recipient: cand.email,
      error: emailErr.message
    });
    return { sent: false, error: emailErr.message };
  }
}

