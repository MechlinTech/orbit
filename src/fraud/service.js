/**
 * Orbit Fraud Review Service
 * Manages consistency review persistence, human recruiter resolution workflow,
 * and immutable audit logging.
 */

import { id as uuid, now, audit } from '../db.js';
import { HttpError } from '../policy.js';
import { analyzeFraudRisk } from './detector.js';

/**
 * Get or compute consistency and fraud review for a candidate.
 */
export function getOrRunFraudReview(db, candidateId, options = {}) {
  const candidate = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
  if (!candidate) throw new HttpError(404, 'Candidate not found.');

  // Parse candidate skills if stringified
  if (typeof candidate.skills === 'string') {
    try { candidate.skills = JSON.parse(candidate.skills); } catch { candidate.skills = []; }
  }

  // Check for existing review
  const existing = db.prepare('SELECT * FROM fraud_reviews WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1').get(candidateId);

  if (existing && !options.refresh) {
    let reviewer = null;
    if (existing.reviewer_id) {
      reviewer = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(existing.reviewer_id);
    }
    return {
      id: existing.id,
      candidate_id: existing.candidate_id,
      application_id: existing.application_id,
      risk_level: existing.risk_level,
      status: existing.status,
      flags: JSON.parse(existing.flags || '[]'),
      reviewer,
      resolution_notes: existing.resolution_notes,
      resolved_at: existing.resolved_at,
      created_at: existing.created_at,
      updated_at: existing.updated_at,
      safeguards: [
        'Flags are review indicators for human verification, NOT proof of fraud.',
        'Candidates must not be disqualified based solely on review flags.',
        'Human recruiters retain full authority over candidate progression.'
      ]
    };
  }

  // Run fresh analysis
  const analysis = analyzeFraudRisk(candidate, { db });
  const reviewId = uuid();
  const timestamp = now();
  const initialStatus = analysis.flags.length === 0 ? 'cleared' : 'pending';

  db.prepare(`
    INSERT INTO fraud_reviews (id, candidate_id, application_id, risk_level, status, flags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reviewId,
    candidate.id,
    options.application_id || null,
    analysis.risk_level,
    initialStatus,
    JSON.stringify(analysis.flags),
    timestamp,
    timestamp
  );

  return {
    id: reviewId,
    candidate_id: candidate.id,
    application_id: options.application_id || null,
    risk_level: analysis.risk_level,
    status: initialStatus,
    flags: analysis.flags,
    reviewer: null,
    resolution_notes: null,
    resolved_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    safeguards: analysis.safeguards
  };
}

/**
 * Record human recruiter review outcome and notes for a candidate's review flags.
 */
export function resolveFraudReview(db, user, candidateId, body = {}) {
  const allowedStatuses = ['resolved', 'cleared', 'reviewed'];
  const status = body.status;
  if (!allowedStatuses.includes(status)) {
    throw new HttpError(400, `Invalid resolution status. Must be one of: ${allowedStatuses.join(', ')}.`);
  }

  const notes = String(body.resolution_notes || body.notes || '').trim();
  if (!notes) {
    throw new HttpError(400, 'Resolution notes are required to document the reviewer assessment.');
  }

  const review = db.prepare('SELECT * FROM fraud_reviews WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1').get(candidateId);
  if (!review) {
    throw new HttpError(404, 'No fraud review found for this candidate.');
  }

  const timestamp = now();
  db.prepare(`
    UPDATE fraud_reviews
    SET status = ?, reviewer_id = ?, resolution_notes = ?, resolved_at = ?, updated_at = ?
    WHERE id = ?
  `).run(status, user.id, notes, timestamp, timestamp, review.id);

  audit(db, user.id, 'fraud_review.resolved', candidateId, {
    review_id: review.id,
    previous_status: review.status,
    new_status: status,
    resolution_notes: notes
  });

  return getOrRunFraudReview(db, candidateId);
}
