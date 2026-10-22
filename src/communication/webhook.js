/**
 * Webhook signature verification and event processing for Resend delivery events.
 * Compatible with Svix standard HMAC-SHA256 signature specification.
 */
import crypto from 'node:crypto';
import { audit, now } from '../db.js';

/**
 * Verifies the Svix / Resend webhook signature using Node.js crypto.
 * No third-party packages required.
 */
export function verifyWebhookSignature({ rawBody, headers, webhookSecret }) {
  if (!rawBody || !headers || !webhookSecret) {
    return false;
  }

  // Support case-insensitive headers
  const h = {};
  for (const [k, v] of Object.entries(headers)) {
    h[k.toLowerCase()] = v;
  }

  const svixId = h['svix-id'];
  const svixTimestamp = h['svix-timestamp'];
  const svixSignature = h['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  // Reject expired timestamps (5-minute tolerance)
  const timestampSec = parseInt(svixTimestamp, 10);
  if (isNaN(timestampSec)) return false;
  const currentSec = Math.floor(Date.now() / 1000);
  if (Math.abs(currentSec - timestampSec) > 300) {
    return false;
  }

  // Secret may be prefixed with 'whsec_' and base64 encoded
  let secretKey;
  try {
    if (webhookSecret.startsWith('whsec_')) {
      secretKey = Buffer.from(webhookSecret.slice(6), 'base64');
    } else {
      secretKey = Buffer.from(webhookSecret, 'utf8');
    }
  } catch {
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const computedSignature = crypto
    .createHmac('sha256', secretKey)
    .update(signedContent)
    .digest('base64');

  // svix-signature is a space-delimited list of versioned signatures, e.g. "v1,g0hM... v1,..."
  const signatures = svixSignature.split(' ').map(sig => {
    const parts = sig.split(',');
    return parts.length > 1 ? parts.slice(1).join(',') : parts[0];
  });

  const computedBuf = Buffer.from(computedSignature, 'utf8');

  return signatures.some(sig => {
    try {
      const sigBuf = Buffer.from(sig, 'utf8');
      if (sigBuf.length !== computedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, computedBuf);
    } catch {
      return false;
    }
  });
}

/**
 * Idempotently updates communication records based on verified Resend webhook events.
 */
export function processWebhookEvent(db, event) {
  if (!event || typeof event !== 'object') {
    return { status: 'ignored', reason: 'Invalid event object' };
  }

  const eventType = event.type || '';
  const data = event.data || {};
  const emailId = data.email_id || data.id || '';

  if (!emailId) {
    return { status: 'ignored', reason: 'Missing email_id in event payload' };
  }

  // Find matching communication record
  const comm = db.prepare('SELECT * FROM candidate_communications WHERE provider_message_id = ?').get(emailId);
  if (!comm) {
    // Unmatched email ID (e.g. sent from another system or test) - safely acknowledge
    return { status: 'unmatched', emailId, eventType };
  }

  let newStatus = comm.status;
  let errorMessage = comm.error_message;

  if (eventType === 'email.delivered') {
    // Delivered is terminal success
    newStatus = 'delivered';
  } else if (eventType === 'email.bounced') {
    newStatus = 'bounced';
    const bounceDetail = data.bounce ? JSON.stringify(data.bounce) : (data.message || 'Email bounced by recipient mail server');
    errorMessage = `Bounce: ${bounceDetail}`;
  } else if (eventType === 'email.complained') {
    newStatus = 'failed';
    errorMessage = 'Recipient submitted spam complaint';
  } else if (eventType === 'email.delivery_delayed') {
    if (comm.status === 'accepted') {
      newStatus = 'queued';
    }
  }

  // Idempotency check: don't overwrite final states (e.g. don't revert delivered to queued)
  if (comm.status === newStatus && comm.error_message === errorMessage) {
    return { status: 'idempotent_no_change', communicationId: comm.id, currentStatus: comm.status };
  }

  const updatedAt = now();
  db.prepare(`
    UPDATE candidate_communications 
    SET status = ?, error_message = ?, updated_at = ? 
    WHERE id = ?
  `).run(newStatus, errorMessage, updatedAt, comm.id);

  audit(db, 'system', 'communication.webhook_processed', comm.id, {
    event_type: eventType,
    previous_status: comm.status,
    new_status: newStatus,
    provider_message_id: emailId
  });

  return {
    status: 'processed',
    communicationId: comm.id,
    previousStatus: comm.status,
    newStatus,
    eventType
  };
}
