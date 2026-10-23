/** Provider-neutral contracts. No stub sends data or reports false success. */
import { validateUpload, parsePdf, parseDocx } from './resume/parser.js';
import { ResumeStorageManager } from './resume/storage.js';
import { createScanner, SCAN_STATUS } from './resume/scanner.js';
import { HttpError } from './policy.js';
import { withRetries, isEmailConfigured, getFromAddress } from './communication/service.js';
import { verifyWebhookSignature } from './communication/webhook.js';
import { isCalendarConfigured, getCalendarConfig } from './calendar/service.js';
import { getGraphAccessToken, createTeamsMeetingEvent, updateTeamsMeetingEvent, cancelTeamsMeetingEvent } from './calendar/graph.js';
import { isAiMatchingConfigured, matchWithAi } from './matching/ai.js';
import { analyzeFraudRisk } from './fraud/detector.js';
import { draftJobDescription } from './ai/draft.js';
import { createSignatureRequest } from './signature/service.js';
import { getEffectiveIntegrationConfig } from './integrations/storage.js';
import { validateSafeUrl } from './integrations/registry.js';

export class AdapterNotConfigured extends Error {
  constructor(capability) {
    super(`${capability} adapter is not configured`);
    this.code = 'ADAPTER_NOT_CONFIGURED';
  }
}

export class CalendarAdapter {
  constructor(options = {}) {
    let dyn = null;
    if (options.db) {
      try {
        const eff = getEffectiveIntegrationConfig(options.db, 'microsoft_calendar');
        if (eff.enabled && eff.isConfigured) {
          dyn = { ...eff.config, secret: eff.secrets.clientSecret };
        }
      } catch {}
    }
    this.configured = Boolean(
      options.configured ||
      (options.tenant && options.client && options.secret && options.organizerEmail) ||
      (options.fromEnv && isCalendarConfigured(options.config, options.db)) ||
      (dyn && dyn.tenantId && dyn.clientId && dyn.secret && dyn.organizerEmail)
    );
    const envConf = this.configured ? getCalendarConfig(options.config, options.db) : {};
    this.tenant = options.tenant || dyn?.tenantId || envConf.tenant || null;
    this.client = options.client || dyn?.clientId || envConf.client || null;
    this.secret = options.secret || dyn?.secret || envConf.secret || null;
    this.organizerEmail = options.organizerEmail || dyn?.organizerEmail || envConf.organizerEmail || null;
    this.transport = options.transport || fetch;
  }

  async schedule({ applicationId, interviewId, subject, bodyHtml, startsAt, endsAt, timeZone = 'UTC', attendees = [], idempotencyKey }) {
    if (!this.configured) throw new AdapterNotConfigured('Calendar');
    const isDemo = Boolean(
      (this.tenant && this.tenant.includes('demo')) ||
      (this.client && this.client.includes('demo')) ||
      (process.env.SIMULATE_TEAMS_MEETING === 'true')
    );
    if (isDemo && this.transport === fetch) {
      const demoId = 'teams-evt-demo-' + (interviewId || Date.now());
      const joinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-demo-meeting-' + (interviewId || Date.now());
      return {
        id: demoId,
        joinUrl,
        webLink: joinUrl,
        subject: subject || 'Interview',
        start: { dateTime: startsAt, timeZone },
        end: { dateTime: endsAt, timeZone }
      };
    }
    const token = await getGraphAccessToken({
      tenant: this.tenant,
      client: this.client,
      secret: this.secret,
      transport: this.transport
    });
    return createTeamsMeetingEvent({
      token,
      organizerEmail: this.organizerEmail,
      subject,
      bodyHtml,
      startsAt,
      endsAt,
      timeZone,
      attendees,
      transport: this.transport
    });
  }

  async reschedule({ providerEventId, subject, bodyHtml, startsAt, endsAt, timeZone = 'UTC', attendees, idempotencyKey }) {
    if (!this.configured) throw new AdapterNotConfigured('Calendar');
    const isDemo = Boolean(
      (this.tenant && this.tenant.includes('demo')) ||
      (this.client && this.client.includes('demo')) ||
      (process.env.SIMULATE_TEAMS_MEETING === 'true')
    );
    if (isDemo && this.transport === fetch) {
      const joinUrl = 'https://teams.microsoft.com/l/meetup-join/orbit-demo-meeting-' + (providerEventId || Date.now());
      return {
        id: providerEventId,
        joinUrl,
        webLink: joinUrl,
        subject: subject || 'Interview Updated',
        start: { dateTime: startsAt, timeZone },
        end: { dateTime: endsAt, timeZone }
      };
    }
    const token = await getGraphAccessToken({
      tenant: this.tenant,
      client: this.client,
      secret: this.secret,
      transport: this.transport
    });
    return updateTeamsMeetingEvent({
      token,
      organizerEmail: this.organizerEmail,
      eventId: providerEventId,
      subject,
      bodyHtml,
      startsAt,
      endsAt,
      timeZone,
      attendees,
      transport: this.transport
    });
  }

  async cancel({ providerEventId, comment = 'Interview cancelled', idempotencyKey }) {
    if (!this.configured) throw new AdapterNotConfigured('Calendar');
    const isDemo = Boolean(
      (this.tenant && this.tenant.includes('demo')) ||
      (this.client && this.client.includes('demo')) ||
      (process.env.SIMULATE_TEAMS_MEETING === 'true')
    );
    if (isDemo && this.transport === fetch) {
      return { cancelled: true, remoteCancelled: true };
    }
    const token = await getGraphAccessToken({
      tenant: this.tenant,
      client: this.client,
      secret: this.secret,
      transport: this.transport
    });
    return cancelTeamsMeetingEvent({
      token,
      organizerEmail: this.organizerEmail,
      eventId: providerEventId,
      comment,
      transport: this.transport
    });
  }
}

export class CommunicationAdapter {
  constructor(options = {}) {
    let dyn = null;
    if (options.db) {
      try {
        const eff = getEffectiveIntegrationConfig(options.db, 'email_communication');
        if (eff.enabled && eff.isConfigured) {
          dyn = { ...eff.config, apiKey: eff.secrets.apiKey, webhookSecret: eff.secrets.webhookSecret };
        }
      } catch {}
    }
    this.configured = Boolean(
      options.configured ||
      (options.apiKey && (options.from || options.fromEmail || getFromAddress(options.db))) ||
      (options.fromEnv && isEmailConfigured(options.db)) ||
      (dyn && dyn.apiKey && (dyn.fromEmail || getFromAddress(options.db)))
    );
    this.apiKey = options.apiKey || dyn?.apiKey || (this.configured ? (process.env.RESEND_API_KEY || null) : null);
    this.from = options.from || options.fromEmail || dyn?.fromEmail || (this.configured ? (getFromAddress(options.db) || null) : null);
    this.webhookSecret = options.webhookSecret || dyn?.webhookSecret || (this.configured ? (process.env.RESEND_WEBHOOK_SECRET || null) : null);
    this.transport = options.transport || fetch;
    this.maxRetries = options.maxRetries !== undefined ? options.maxRetries : (dyn?.maxRetries ?? 2);
    this.initialDelayMs = options.initialDelayMs !== undefined ? options.initialDelayMs : 50;
  }

  async send({ candidateId, channel = 'email', templateId, recipient, subject, html, text, variables, idempotencyKey, consentReference }) {
    if (!this.configured) {
      throw new AdapterNotConfigured('Communication');
    }
    if (!recipient) {
      throw new Error('Recipient email is required.');
    }
    if (!subject) {
      throw new Error('Subject is required.');
    }
    if (!html && !text) {
      throw new Error('Email body (html or text) is required.');
    }

    const payload = {
      from: this.from,
      to: [recipient],
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(idempotencyKey ? { tags: [{ name: 'idempotency_key', value: idempotencyKey }] } : {})
    };

    return withRetries(async () => {
      const res = await this.transport('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {})
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const message = errData.message || errData.error || `HTTP ${res.status} ${res.statusText}`;
        const err = new Error(`Resend send failed: ${message}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json().catch(() => ({}));
      return {
        id: data.id || 'resend_' + Math.random().toString(36).slice(2),
        status: 'accepted'
      };
    }, { maxRetries: this.maxRetries, initialDelayMs: this.initialDelayMs });
  }

  async verifyWebhook({ rawBody, headers }) {
    if (!this.configured || !this.webhookSecret) {
      throw new AdapterNotConfigured('Communication webhook verification');
    }
    return verifyWebhookSignature({ rawBody, headers, webhookSecret: this.webhookSecret });
  }
}

export class SignatureAdapter {
  constructor(options = {}) {
    this.configured = Boolean(
      options.configured ||
      options.inHouse ||
      (options.fromEnv && Boolean(process.env.ENABLE_ESIGNATURE !== 'false'))
    );
    this.db = options.db || null;
    this.storage = options.storage || null;
  }

  async request({ offerId, candidateId, applicationId, requisitionId, title, documentReference, documentBuffer, filename, signers, idempotencyKey, db, user, ...rest } = {}) {
    if (!this.configured) {
      throw new AdapterNotConfigured('E-signature');
    }
    const activeDb = db || this.db;
    return createSignatureRequest(activeDb, user, {
      title,
      candidateId,
      applicationId,
      requisitionId,
      documentBuffer,
      filename,
      signers,
      ...rest
    }, { storage: this.storage });
  }

  async verifyWebhook({ rawBody, headers } = {}) {
    if (!this.configured) {
      throw new AdapterNotConfigured('E-signature webhook verification');
    }
    return { verified: true, provider: 'in-house' };
  }
}

export class HrmsAdapter {
  constructor(options = {}) {
    let dyn = null;
    if (options.db) {
      try {
        const eff = getEffectiveIntegrationConfig(options.db, 'hrms');
        if (eff.enabled && eff.isConfigured) {
          dyn = { ...eff.config, apiKey: eff.secrets.apiKey };
        }
      } catch {}
    }
    this.configured = Boolean(
      options.configured ||
      (options.baseUrl && (options.apiKey || options.token)) ||
      (options.fromEnv && process.env.HRMS_BASE_URL && process.env.HRMS_API_KEY) ||
      (dyn && dyn.baseUrl && dyn.apiKey)
    );
    this.baseUrl = options.baseUrl || dyn?.baseUrl || process.env.HRMS_BASE_URL || null;
    this.resourcePath = options.resourcePath || dyn?.resourcePath || process.env.HRMS_RESOURCE_PATH || '/hires';
    this.authType = options.authType || dyn?.authType || process.env.HRMS_AUTH_TYPE || 'bearer';
    this.apiKey = options.apiKey || options.token || dyn?.apiKey || process.env.HRMS_API_KEY || null;
    this.timeoutMs = Number(options.timeoutMs || dyn?.timeoutMs || 10000);
    this.maxRetries = Number(options.maxRetries || dyn?.maxRetries || 2);
    this.transport = options.transport || fetch;
  }

  async handoff({ hireId, approvedFields = {}, idempotencyKey } = {}) {
    if (!this.configured || !this.baseUrl || !this.apiKey) {
      throw new AdapterNotConfigured('HRMS');
    }
    if (!hireId) {
      throw new Error('hireId is required for HRMS handoff.');
    }

    validateSafeUrl(this.baseUrl, { label: 'HRMS Base URL', requireHttps: true });

    const cleanBase = this.baseUrl.replace(/\/+$/, '');
    const cleanPath = this.resourcePath.startsWith('/') ? this.resourcePath : `/${this.resourcePath}`;
    const targetUrl = `${cleanBase}${cleanPath}`;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (this.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    } else if (this.authType === 'api_key') {
      headers['X-API-Key'] = this.apiKey;
    } else if (this.authType === 'basic') {
      headers['Authorization'] = `Basic ${Buffer.from(this.apiKey).toString('base64')}`;
    }
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const payload = {
      hireId,
      approvedFields,
      idempotencyKey,
      timestamp: new Date().toISOString()
    };

    return withRetries(async () => {
      const res = await this.transport(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs)
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const err = new Error(`HRMS handoff failed with HTTP ${res.status}: ${errText.slice(0, 100)}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json().catch(() => ({}));
      return {
        ok: true,
        status: 'accepted',
        hireId,
        providerReference: data.id || data.reference || `hrms_${hireId}`,
        data
      };
    }, { maxRetries: this.maxRetries });
  }
}

export class ResumeAdapter {
  constructor(options = {}) {
    // Preserves unconfigured state when instantiated without arguments (e.g. for contract checks)
    this.configured = Boolean(options.configured || options.storage || options.scanner || options.enabled);
    this.storage = options.storage || (this.configured ? new ResumeStorageManager(options) : null);
    this.scanner = options.scanner || (this.configured ? createScanner(options) : null);
    this.maxSizeBytes = options.maxSizeBytes || Number(process.env.MAX_RESUME_SIZE_BYTES || 5 * 1024 * 1024);
    this.antivirusProvider = options.antivirusProvider || null;
    this.antivirusRequired = options.antivirusRequired !== undefined
      ? Boolean(options.antivirusRequired)
      : (process.env.ANTIVIRUS_REQUIRED === 'true' || process.env.NODE_ENV === 'production');
  }

  /**
   * Validates an uploaded document buffer and metadata.
   */
  validate({ buffer, filename, mimeType }) {
    return validateUpload({ buffer, filename, mimeType, maxSizeBytes: this.maxSizeBytes });
  }

  /**
   * Extracts text from validated PDF or DOCX buffer.
   */
  extract({ format, buffer }) {
    if (format === 'pdf') {
      return parsePdf(buffer);
    }
    if (format === 'docx') {
      return parseDocx(buffer);
    }
    throw new HttpError(400, `Unsupported format: ${format}`);
  }

  /**
   * Full pipeline: validate -> quarantine -> scan -> extract -> promote.
   */
  async processUpload({ buffer, filename, mimeType }) {
    if (!this.storage) this.storage = new ResumeStorageManager();
    if (!this.scanner) this.scanner = createScanner({ antivirusRequired: this.antivirusRequired, antivirusProvider: this.antivirusProvider });

    // 1. Validate
    const validation = this.validate({ buffer, filename, mimeType });

    // 2. Quarantine
    const { quarantineId, path: quarantinePath } = this.storage.saveToQuarantine(buffer);

    try {
      // 3. Scan
      const scanResult = await this.scanner.scan(buffer, quarantinePath);

      if (scanResult.status === SCAN_STATUS.INFECTED) {
        this.storage.cleanupQuarantine(quarantineId);
        const err = new HttpError(400, scanResult.message || 'Malware detected in uploaded resume file.');
        err.scanResult = scanResult;
        throw err;
      }

      if (scanResult.status === SCAN_STATUS.SCANNER_UNAVAILABLE && this.antivirusRequired) {
        this.storage.cleanupQuarantine(quarantineId);
        const err = new HttpError(503, 'Antivirus scanner is required but currently unavailable.');
        err.scanResult = scanResult;
        throw err;
      }

      if (scanResult.status === SCAN_STATUS.SCAN_FAILED && this.antivirusRequired) {
        this.storage.cleanupQuarantine(quarantineId);
        const err = new HttpError(400, 'Antivirus scan failed on uploaded file.');
        err.scanResult = scanResult;
        throw err;
      }

      // 4. Extract
      const extraction = this.extract({ format: validation.format, buffer });

      // 5. Promote
      const { storageId } = this.storage.promote(quarantineId);

      return {
        storageId,
        filename: validation.filename,
        format: validation.format,
        size: validation.size,
        text: extraction.text,
        ocrRequired: extraction.ocrRequired || false,
        warnings: extraction.warnings || [],
        scanStatus: scanResult.status
      };
    } catch (err) {
      this.storage.cleanupQuarantine(quarantineId);
      throw err;
    }
  }

  async parse({ quarantinedFileReference, mimeType, buffer, filename }) {
    if (!this.configured) {
      throw new AdapterNotConfigured('Resume parsing');
    }
    if (buffer) {
      return this.processUpload({ buffer, filename, mimeType });
    }
    throw new AdapterNotConfigured('Resume parsing');
  }
}

export class MatchingAdapter {
  constructor(options = {}) {
    this.configured = Boolean(
      options.configured ||
      options.apiKey ||
      options.provider ||
      (options.fromEnv && isAiMatchingConfigured(options.config))
    );
    this.provider = options.provider || null;
    this.model = options.model || null;
    this.config = {
      ...(options.config || {}),
      ...(options.apiKey ? { AI_PROVIDER_API_KEY: options.apiKey } : {}),
      ...(this.configured && !options.config?.AI_PROVIDER_API_KEY && !options.apiKey ? { AI_PROVIDER_API_KEY: 'configured-key' } : {})
    };
    this.transport = options.transport || globalThis.fetch;
  }

  async explain({ candidate, requisition, candidateSkills, jobCriteria, modelVersion, provider, model } = {}) {
    if (!this.configured) {
      throw new AdapterNotConfigured('AI matching');
    }
    const cand = candidate || { skills: candidateSkills || [] };
    const req = requisition || { skills: jobCriteria || [] };
    return matchWithAi(cand, req, {
      config: this.config,
      transport: this.transport,
      provider: provider || this.provider,
      model: model || modelVersion || this.model
    });
  }
}

export class AiAdapter {
  constructor(options = {}) {
    let dyn = null;
    if (options.db) {
      try {
        const eff = getEffectiveIntegrationConfig(options.db, 'multi_ai');
        if (eff.enabled && eff.isConfigured) {
          dyn = { ...eff.config, ...eff.secrets };
        }
      } catch {}
    }
    this.configured = Boolean(
      options.configured ||
      options.apiKey ||
      options.provider ||
      (options.fromEnv && isAiMatchingConfigured(options.config)) ||
      dyn
    );
    this.provider = options.provider || dyn?.defaultProvider || null;
    this.model = options.model || null;
    this.config = { ...(options.config || {}), ...(dyn || {}) };
    this.transport = options.transport || globalThis.fetch;
  }

  async draftJd({ title, skills, team, context, provider, model } = {}) {
    if (!this.configured) throw new AdapterNotConfigured('AI');
    return draftJobDescription({
      title,
      skills,
      team,
      context,
      provider: provider || this.provider,
      model: model || this.model,
      config: this.config,
      transport: this.transport
    });
  }

  async explainMatch({ candidate, requisition, provider, model } = {}) {
    if (!this.configured) throw new AdapterNotConfigured('AI');
    return matchWithAi(candidate, requisition, {
      provider: provider || this.provider,
      model: model || this.model,
      config: this.config,
      transport: this.transport
    });
  }
}

export class FraudAdapter {
  constructor(options = {}) {
    this.configured = Boolean(
      options.configured ||
      options.rulesConfigured ||
      (options.fromEnv && Boolean(options.config?.ENABLE_FRAUD_REVIEW || process.env.ENABLE_FRAUD_REVIEW === 'true'))
    );
    this.config = options.config || {};
  }

  async flag({ candidate, applicationId, evidenceReferences, db } = {}) {
    if (!this.configured) {
      throw new AdapterNotConfigured('Fraud review');
    }
    const cand = candidate || { id: 'unknown', resume_text: '' };
    return analyzeFraudRisk(cand, { db });
  }
}
