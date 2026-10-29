/**
 * Pre-Onboarding Training Lifecycle Module for Mechlin Orbit ATS.
 * Enforces start/end deadlines, immutable evaluation history across attempts,
 * deadline extensions, retraining, overdue calculation, and controlled offer revocation.
 */

import { id, now, audit, transaction } from '../db.js';
import { HttpError, requirePermission as permit, text as validateText, integer } from '../policy.js';
import { verifyApplicationOfferSignature } from '../signature/service.js';
import { isEmailConfigured, sendStageTransitionNotification } from '../communication/service.js';

/**
 * Authoritatively calculates whether a training deadline has passed.
 */
export function isTrainingOverdue(app) {
  if (!app || !app.training_end_at) return false;
  const isTerminalOrDone = ['completed', 'offer_revoked'].includes(app.training_status) ||
    ['Hired', 'Rejected', 'Revoked'].includes(app.stage);
  if (isTerminalOrDone) return false;
  if (!/pre-onboarding|training/i.test(app.stage || '')) return false;
  const deadlineMs = new Date(app.training_end_at).getTime();
  if (isNaN(deadlineMs)) return false;
  return deadlineMs < Date.now();
}

/**
 * Computes human-readable and system status token for candidate training.
 */
export function resolveEffectiveTrainingStatus(app) {
  if (!app) return 'not_started';
  if (app.offer_status === 'revoked' || app.stage === 'Revoked') return 'offer_revoked';
  if (app.training_status === 'completed' || app.stage === 'Onboarding' || app.stage === 'Hired') return 'completed';
  if (app.training_status === 'evaluation_failed') return 'evaluation_failed';
  if (isTrainingOverdue(app)) return 'overdue';
  return app.training_status || 'not_started';
}

/**
 * Starts candidate training with a mandatory start date and end date (deadline).
 */
export function startTraining(db, user, app, { start_at, end_at, duration_days } = {}) {
  permit(user, 'training.lifecycle');

  if (!/pre-onboarding|training/i.test(app.stage)) {
    throw new HttpError(409, 'Candidate must be in Pre-Onboarding Training stage to start training.');
  }

  // Must have signed offer
  const sigCheck = verifyApplicationOfferSignature(db, app.id, app.candidate_id, app.requisition_id);
  if (!sigCheck.verified) {
    throw new HttpError(409, `Cannot start training: ${sigCheck.reason}`);
  }

  if (app.offer_status === 'revoked' || app.stage === 'Revoked') {
    throw new HttpError(409, 'Cannot start training for a candidate with a revoked offer.');
  }

  const startAt = start_at ? new Date(start_at).toISOString() : now();
  if (isNaN(new Date(startAt).getTime())) {
    throw new HttpError(400, 'Invalid training start date.');
  }

  let endAt = null;
  if (end_at) {
    endAt = new Date(end_at).toISOString();
  } else if (duration_days) {
    const days = Number(duration_days);
    if (days > 0) {
      endAt = new Date(new Date(startAt).getTime() + days * 86400000).toISOString();
    }
  }

  if (!endAt || isNaN(new Date(endAt).getTime())) {
    throw new HttpError(400, 'Mandatory training deadline (end date) is required.');
  }

  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new HttpError(400, 'Training deadline must be strictly after the start date.');
  }

  return transaction(db, () => {
    db.prepare(`
      UPDATE applications
      SET training_status = 'in_progress',
          training_start_at = ?,
          training_end_at = ?,
          training_original_end_at = ?,
          training_attempt = 1,
          training_completed_at = NULL
      WHERE id = ?
    `).run(startAt, endAt, endAt, app.id);

    audit(db, user.id, 'training.started', app.id, {
      start_at: startAt,
      end_at: endAt,
      attempt: 1
    });

    return db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id);
  });
}

/**
 * Extends candidate training deadline while preserving original deadline and audit trail.
 */
export function extendTrainingDeadline(db, user, app, { new_deadline, reason } = {}) {
  permit(user, 'training.lifecycle');

  if (app.offer_status === 'revoked' || app.stage === 'Revoked') {
    throw new HttpError(409, 'Cannot extend deadline for a revoked offer.');
  }

  if (!/pre-onboarding|training/i.test(app.stage)) {
    throw new HttpError(409, 'Application is not in Pre-Onboarding Training stage.');
  }

  if (app.training_status === 'completed') {
    throw new HttpError(409, 'Training has already been completed.');
  }

  if (!app.training_end_at) {
    throw new HttpError(400, 'Training has not been started yet. Please start training before extending deadlines.');
  }

  if (!new_deadline) {
    throw new HttpError(400, 'New training deadline is required.');
  }

  const newDeadlineStr = new Date(new_deadline).toISOString();
  if (isNaN(new Date(newDeadlineStr).getTime())) {
    throw new HttpError(400, 'Invalid new deadline date format.');
  }

  const currentDeadlineMs = new Date(app.training_end_at).getTime();
  const newDeadlineMs = new Date(newDeadlineStr).getTime();

  if (newDeadlineMs <= currentDeadlineMs) {
    throw new HttpError(400, 'The new deadline must be strictly later than the current deadline.');
  }

  const extensionReason = validateText(reason || '', 'Extension reason', 1000, true);
  const extId = id();
  const nowStr = now();
  const currentAttempt = app.training_attempt || 1;

  return transaction(db, () => {
    // 1. Record extension history
    db.prepare(`
      INSERT INTO training_deadline_extensions(id, application_id, attempt, previous_deadline, new_deadline, reason, extended_by, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run(extId, app.id, currentAttempt, app.training_end_at, newDeadlineStr, extensionReason, user.id, nowStr);

    // 2. Update application deadline and status (preserve original deadline and failed status if applicable)
    const newStatus = app.training_status === 'evaluation_failed' ? 'evaluation_failed' : 'extended';

    db.prepare(`
      UPDATE applications
      SET training_end_at = ?,
          training_status = ?,
          training_original_end_at = COALESCE(training_original_end_at, ?)
      WHERE id = ?
    `).run(newDeadlineStr, newStatus, app.training_end_at, app.id);

    audit(db, user.id, 'training.deadline_extended', app.id, {
      attempt: currentAttempt,
      previous_deadline: app.training_end_at,
      new_deadline: newDeadlineStr,
      reason: extensionReason
    });

    const updated = db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id);
    const extensionRow = db.prepare(`
      SELECT te.*, u.name AS extended_by_name, u.email AS extended_by_email
      FROM training_deadline_extensions te
      JOIN users u ON u.id = te.extended_by
      WHERE te.id = ?
    `).get(extId);

    return {
      application: updated,
      extension: extensionRow,
      is_overdue: isTrainingOverdue(updated)
    };
  });
}

/**
 * Restarts training (retraining) after evaluation failure or training need.
 * Increments attempt count and preserves all prior evaluation/extension history.
 */
export function restartTraining(db, user, app, { start_at, end_at, reason } = {}) {
  permit(user, 'training.lifecycle');

  if (app.offer_status === 'revoked' || app.stage === 'Revoked') {
    throw new HttpError(409, 'Cannot restart training for a revoked offer.');
  }

  if (!/pre-onboarding|training/i.test(app.stage)) {
    throw new HttpError(409, 'Candidate must be in Pre-Onboarding Training stage to restart training.');
  }

  const restartReason = validateText(reason || '', 'Restart reason', 1000, true);

  const startAt = start_at ? new Date(start_at).toISOString() : now();
  if (isNaN(new Date(startAt).getTime())) {
    throw new HttpError(400, 'Invalid retraining start date.');
  }

  if (!end_at) {
    throw new HttpError(400, 'Mandatory end date (deadline) is required for retraining.');
  }

  const endAt = new Date(end_at).toISOString();
  if (isNaN(new Date(endAt).getTime())) {
    throw new HttpError(400, 'Invalid retraining deadline.');
  }

  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new HttpError(400, 'Retraining deadline must be strictly after the start date.');
  }

  const nextAttempt = (app.training_attempt || 1) + 1;

  return transaction(db, () => {
    db.prepare(`
      UPDATE applications
      SET training_attempt = ?,
          training_status = 'retraining',
          training_start_at = ?,
          training_end_at = ?,
          training_original_end_at = ?,
          training_completed_at = NULL
      WHERE id = ?
    `).run(nextAttempt, startAt, endAt, endAt, app.id);

    audit(db, user.id, 'training.restarted', app.id, {
      attempt: nextAttempt,
      start_at: startAt,
      end_at: endAt,
      reason: restartReason
    });

    const updated = db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id);
    return {
      application: updated,
      attempt: nextAttempt,
      is_overdue: isTrainingOverdue(updated)
    };
  });
}

/**
 * Revokes candidate offer following failed evaluation or overdue deadline.
 * Executes existing offer revocation workflow, records audit, and preserves all training records.
 */
export function revokeOffer(db, user, app, { reason } = {}, config = null) {
  permit(user, 'training.lifecycle');

  if (app.offer_status === 'revoked' || app.stage === 'Revoked') {
    throw new HttpError(409, 'Candidate offer has already been revoked.');
  }

  const revocationReason = validateText(reason || '', 'Revocation reason', 2000, true);
  const nowStr = now();

  // Determine stage progression
  const pipelineRow = db.prepare("SELECT value FROM settings WHERE key='pipeline'").get();
  const stages = pipelineRow ? JSON.parse(pipelineRow.value) : ['Applied', 'Hired', 'Rejected', 'Revoked'];
  const targetStage = stages.includes('Revoked') ? 'Revoked' : 'Rejected';

  const updatedApp = transaction(db, () => {
    // 1. Update applications
    db.prepare(`
      UPDATE applications
      SET stage = ?,
          training_status = 'offer_revoked',
          offer_status = 'revoked',
          offer_revoked_at = ?,
          offer_revoked_by = ?,
          offer_revocation_reason = ?
      WHERE id = ?
    `).run(targetStage, nowStr, user.id, revocationReason, app.id);

    // 2. Update signature requests
    try {
      db.prepare(`
        UPDATE signature_requests
        SET offer_status = 'revoked',
            revoked_at = ?,
            revoked_by = ?,
            revocation_reason = ?
        WHERE application_id = ?
      `).run(nowStr, user.id, revocationReason, app.id);
    } catch {}

    // 3. Update referrals
    db.prepare(`
      UPDATE referrals
      SET status = ?, updated_at = ?
      WHERE application_id = ? AND status != 'Withdrawn'
    `).run(targetStage, nowStr, app.id);

    // 4. Record stage event
    db.prepare('INSERT INTO stage_events VALUES(?,?,?,?,?,?)').run(
      id(), app.id, app.stage, targetStage, user.id, nowStr
    );

    // 5. Audit event
    audit(db, user.id, 'offer.revoked', app.id, {
      candidate_id: app.candidate_id,
      requisition_id: app.requisition_id,
      from_stage: app.stage,
      to_stage: targetStage,
      reason: revocationReason,
      training_attempt: app.training_attempt || 1,
      training_status: app.training_status
    });

    return db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id);
  });

  // Optional stage transition email if configured
  if (isEmailConfigured(db, config) || Boolean(config?.communicationAdapter)) {
    (async () => {
      try {
        await sendStageTransitionNotification({
          db,
          user,
          applicationId: app.id,
          oldStage: app.stage,
          newStage: targetStage,
          notes: revocationReason,
          sendNotification: true,
          config,
          adapter: config?.communicationAdapter
        });
      } catch (err) {
        console.error('Failed to dispatch offer revocation stage notification:', err);
      }
    })();
  }

  return {
    ok: true,
    stage: targetStage,
    offer_status: 'revoked',
    application: updatedApp,
    reason: revocationReason
  };
}

/**
 * Submits training evaluation with strict enforcement of:
 * - Evaluation Failure MUST NOT remove candidate from training stage.
 * - Passing evaluation advances candidate to next stage (e.g. Onboarding).
 * - Evaluations link to current attempt number and do not overwrite previous attempts.
 */
export function evaluateTraining(db, user, app, body = {}, config = null) {
  permit(user, 'training.lifecycle');

  if (app.offer_status === 'revoked' || app.stage === 'Revoked') {
    throw new HttpError(409, 'Cannot evaluate an application with a revoked offer.');
  }

  if (!/pre-onboarding|training/i.test(app.stage)) {
    throw new HttpError(409, 'Candidate must be in Pre-Onboarding Training stage to record an evaluation.');
  }

  // If user explicitly chose revoke offer from evaluation modal
  if (body.decision === 'revoked') {
    return revokeOffer(db, user, app, { reason: body.notes || 'Offer revoked during training evaluation.' }, config);
  }

  const rating = integer(body.rating, 'Rating', 1, 5);
  const practicalScore = body.practical_score !== undefined && body.practical_score !== '' && body.practical_score !== null
    ? Number(body.practical_score)
    : null;

  if (practicalScore !== null && (!Number.isFinite(practicalScore) || practicalScore < 0 || practicalScore > 100)) {
    throw new HttpError(400, 'Practical score must be a number between 0 and 100.');
  }

  const notes = validateText(body.notes || '', 'Training notes', 2000, false);
  const currentAttempt = app.training_attempt || 1;

  // Determine pass vs fail
  const isPass = body.decision === 'next' || body.status === 'passed' ||
    (body.status !== 'failed' && body.decision !== 'rejected' && body.decision !== 'failed' && rating >= 3);

  const evalId = id();
  const nowStr = now();

  const pipelineRow = db.prepare("SELECT value FROM settings WHERE key='pipeline'").get();
  const stages = pipelineRow ? JSON.parse(pipelineRow.value) : ['Applied', 'Hired', 'Rejected'];

  let targetStage = null;
  let newTrainingStatus = 'evaluation_failed';

  if (isPass) {
    const curIdx = stages.indexOf(app.stage);
    if (stages.includes('Onboarding')) {
      targetStage = 'Onboarding';
    } else if (curIdx !== -1 && curIdx + 1 < stages.length && !['Hired', 'Rejected', 'Revoked'].includes(stages[curIdx + 1])) {
      targetStage = stages[curIdx + 1];
    } else {
      targetStage = 'Onboarding';
    }
    newTrainingStatus = 'completed';
  } else {
    // CRITICAL: Evaluation failure must keep candidate in Pre-Onboarding Training!
    targetStage = null;
    newTrainingStatus = 'evaluation_failed';
  }

  const evalStatus = isPass ? 'passed' : 'failed';
  const evalDecision = isPass ? 'next' : (body.decision || 'rejected');

  const result = transaction(db, () => {
    // 1. Insert evaluation linked to attempt
    db.prepare(`
      INSERT INTO training_evaluations(id, application_id, candidate_id, evaluator_id, rating, practical_score, status, decision, notes, attempt, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(evalId, app.id, app.candidate_id, user.id, rating, practicalScore, evalStatus, evalDecision, notes, currentAttempt, nowStr, nowStr);

    // 2. Update application status
    if (isPass && targetStage && app.stage !== targetStage) {
      db.prepare(`
        UPDATE applications
        SET stage = ?, training_status = 'completed', training_completed_at = ?
        WHERE id = ?
      `).run(targetStage, nowStr, app.id);

      db.prepare(`
        UPDATE referrals
        SET status = ?, updated_at = ?
        WHERE application_id = ? AND status != 'Withdrawn'
      `).run(targetStage, nowStr, app.id);

      db.prepare('INSERT INTO stage_events VALUES(?,?,?,?,?,?)').run(
        id(), app.id, app.stage, targetStage, user.id, nowStr
      );
    } else {
      // Keeps candidate in Pre-Onboarding Training!
      db.prepare(`
        UPDATE applications
        SET training_status = ?
        WHERE id = ?
      `).run(newTrainingStatus, app.id);
    }

    audit(db, user.id, isPass ? 'training.evaluation_passed' : 'training.evaluation_failed', app.id, {
      attempt: currentAttempt,
      rating,
      practical_score: practicalScore,
      decision: evalDecision,
      status: evalStatus,
      target_stage: targetStage
    });

    const savedEval = db.prepare(`
      SELECT te.*, u.name AS evaluator_name, u.email AS evaluator_email
      FROM training_evaluations te
      JOIN users u ON u.id = te.evaluator_id
      WHERE te.id = ?
    `).get(evalId);

    const updatedApp = db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id);

    return {
      evaluation: savedEval,
      application: updatedApp,
      is_overdue: isTrainingOverdue(updatedApp)
    };
  });

  // Stage transition notification for passing evaluation
  if (isPass && targetStage && app.stage !== targetStage) {
    const emailConfigured = (isEmailConfigured(db, config) || Boolean(config?.communicationAdapter)) && body.send_notification !== false;
    if (emailConfigured) {
      (async () => {
        try {
          await sendStageTransitionNotification({
            db,
            user,
            applicationId: app.id,
            oldStage: app.stage,
            newStage: targetStage,
            notes,
            sendNotification: body.send_notification !== false,
            config,
            adapter: config?.communicationAdapter
          });
        } catch (_) {}
      })();
    }
  }

  return result;
}

/**
 * Retrieves full audit history of training: attempts, evaluations, and deadline extensions.
 */
export function getTrainingHistory(db, user, app) {
  permit(user, 'training.read');

  const cand = db.prepare('SELECT name, email FROM candidates WHERE id = ?').get(app.candidate_id);
  const req = db.prepare('SELECT title, team FROM requisitions WHERE id = ?').get(app.requisition_id);

  const evaluations = db.prepare(`
    SELECT te.*, u.name AS evaluator_name, u.email AS evaluator_email
    FROM training_evaluations te
    JOIN users u ON u.id = te.evaluator_id
    WHERE te.application_id = ?
    ORDER BY te.attempt ASC, te.created_at ASC
  `).all(app.id);

  const extensions = db.prepare(`
    SELECT te.*, u.name AS extended_by_name, u.email AS extended_by_email
    FROM training_deadline_extensions te
    JOIN users u ON u.id = te.extended_by
    WHERE te.application_id = ?
    ORDER BY te.created_at ASC
  `).all(app.id);

  let planDraft = null;
  try {
    planDraft = db.prepare('SELECT * FROM training_plan_drafts WHERE application_id = ?').get(app.id);
  } catch {}

  const overdue = isTrainingOverdue(app);
  const effectiveStatus = resolveEffectiveTrainingStatus(app);

  return {
    application: {
      ...app,
      name: cand?.name || '',
      email: cand?.email || '',
      title: req?.title || '',
      team: req?.team || '',
      is_overdue: overdue,
      effective_training_status: effectiveStatus
    },
    current_attempt: app.training_attempt || 1,
    is_overdue: overdue,
    effective_status: effectiveStatus,
    evaluations,
    extensions,
    plan_draft: planDraft || null
  };
}
