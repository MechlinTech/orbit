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
import { createSignatureRequest, cleanCurrencyCode } from './signature/service.js';
import { getEffectiveIntegrationConfig } from './integrations/storage.js';
import { existsSync, readFileSync } from 'node:fs';
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

  async schedule({ applicationId, interviewId, subject, bodyHtml, startsAt, endsAt, timeZone = 'Asia/Kolkata', attendees = [], idempotencyKey }) {
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

  async reschedule({ providerEventId, subject, bodyHtml, startsAt, endsAt, timeZone = 'Asia/Kolkata', attendees, idempotencyKey }) {
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

    const sanitizedTagValue = idempotencyKey
      ? String(idempotencyKey).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 256)
      : null;

    const payload = {
      from: this.from,
      to: [recipient],
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(sanitizedTagValue ? { tags: [{ name: 'idempotency_key', value: sanitizedTagValue }] } : {})
    };

    return withRetries(async () => {
      const res = await this.transport('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(sanitizedTagValue ? { 'Idempotency-Key': sanitizedTagValue } : {})
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

  isSupabase() {
    const base = String(this.baseUrl || '').toLowerCase();
    const res = String(this.resourcePath || '').toLowerCase();
    return base.includes('supabase.co') || res.includes('rest/v1');
  }

  getSupabaseHeaders(customPrefer = 'return=representation,resolution=merge-duplicates') {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'apikey': this.apiKey,
      'Authorization': `Bearer ${this.apiKey}`,
      'Prefer': customPrefer
    };
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
    const candidate = approvedFields.candidate || {};
    const requisition = approvedFields.requisition || {};
    const offer = approvedFields.offer || {};

    const rawCurrency = approvedFields.currency
      || approvedFields.currency_code
      || approvedFields.salary_currency
      || offer.currency
      || offer.currency_code
      || offer.salary_currency
      || requisition.currency
      || 'USD';
    const currency = cleanCurrencyCode(rawCurrency, requisition.currency || 'USD');

    // Handle Native Supabase BaaS Mode
    if (this.isSupabase()) {
      const restBasePath = cleanPath.endsWith('/users')
        ? cleanPath.replace(/\/users$/, '')
        : (cleanPath.includes('rest/v1') ? cleanPath.replace(/\/+$/, '') : '/rest/v1');

      const userUrl = `${cleanBase}${restBasePath}/users?on_conflict=email`;
      const documentsUrl = `${cleanBase}${restBasePath}/employee_documents?on_conflict=employee_id,document_type_id`;
      const referralsUrl = `${cleanBase}${restBasePath}/referrals`;

      const fullName = approvedFields.full_name || approvedFields.fullName || candidate.name || approvedFields.name || 'New Hire';
      const email = approvedFields.company_email || approvedFields.email || candidate.email || '';
      const personalEmail = approvedFields.personal_email || candidate.email || approvedFields.email || null;
      const phone = approvedFields.phone || candidate.phone || null;
      const position = approvedFields.position || approvedFields.jobTitle || requisition.title || approvedFields.title || null;
      const designationOfferLetter = approvedFields.designation_offer_letter || approvedFields.designation || offer.designation || position;
      const departmentId = approvedFields.department_id || requisition.department_id || null;
      const managerId = approvedFields.manager_id || requisition.manager_id || null;
      const rawSalary = approvedFields.salary !== undefined ? approvedFields.salary : (offer.annual_salary !== undefined ? offer.annual_salary : requisition.salary_min);
      const cleanSalary = (val) => {
        if (val === null || val === undefined || val === '') return null;
        if (typeof val === 'number') return Number.isFinite(val) ? val : null;
        const s = String(val).replace(/[^0-9.]/g, '');
        if (!s) return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      };
      const salary = cleanSalary(rawSalary);
      const monthlyCtc = approvedFields.monthly_ctc || (salary !== null ? String(Math.round(Number(salary) / 12)) : null);
      const rawJoiningDate = approvedFields.date_of_joining || approvedFields.joining_date || offer.joining_date || offer.start_date || null;
      const parseJoiningDate = (v) => {
        if (!v || typeof v !== 'string') return null;
        const t = v.trim();
        if (!t || /two\s+weeks|acceptance|tbd|immediate|pending/i.test(t)) return null;
        const m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
        if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
        const dmy = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
        if (dmy) return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
        return t;
      };
      const dateOfJoining = parseJoiningDate(rawJoiningDate);

      // Resolve department UUID if team name is provided
      const KNOWN_DEPARTMENTS = {
        'human resources': '68733254-c417-4cb9-a085-0b3be3d0f358',
        'hr': '68733254-c417-4cb9-a085-0b3be3d0f358',
        'finance': 'f9c3d859-911c-4a4f-a401-7153637f309b',
        'business development': '0aadecce-c5ee-4108-b2b0-ed4135acde06',
        'bd': '0aadecce-c5ee-4108-b2b0-ed4135acde06',
        'service delivery': 'cabdcb45-e5fe-4614-b4f0-54ca7e9f35d7',
        'sd': 'cabdcb45-e5fe-4614-b4f0-54ca7e9f35d7',
        'quality assurance': 'bf4c86d3-f6ab-4edf-b89b-9689873b031f',
        'qa': 'bf4c86d3-f6ab-4edf-b89b-9689873b031f',
        'engineering': 'e278a419-424d-45c3-b64e-4ae7682a6c19',
        'marketing': 'e68c6f65-a9fe-4e3d-8500-e0786368fea7',
        'project management': '18ebe2d4-7625-4d30-bccf-dbd4f97c32d6',
        'pmo': '18ebe2d4-7625-4d30-bccf-dbd4f97c32d6'
      };

      let resolvedDeptId = null;
      const rawDept = departmentId || requisition.team || candidate.team;
      if (rawDept) {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(rawDept))) {
          resolvedDeptId = rawDept;
        } else {
          resolvedDeptId = KNOWN_DEPARTMENTS[String(rawDept).toLowerCase().trim()] || null;
        }
      }

      const validAuthProviders = ['manual', 'microsoft', 'google'];
      let authProvider = String(approvedFields.auth_provider || 'manual').toLowerCase();
      if (!validAuthProviders.includes(authProvider)) {
        authProvider = 'manual';
      }

      const providerUserId = String(
        approvedFields.provider_user_id ||
        hireId ||
        candidate.id ||
        email ||
        `orbit_${Date.now()}`
      );

      const userRow = {
        full_name: fullName,
        email: email,
        personal_email: personalEmail,
        phone: phone,
        position: position,
        designation_offer_letter: designationOfferLetter,
        status: approvedFields.status || 'active',
        auth_provider: authProvider,
        role_id: approvedFields.role_id || '743fe423-7695-46c5-a6dc-19d0636add9b',
        provider_user_id: providerUserId
      };
      if (resolvedDeptId) userRow.department_id = resolvedDeptId;
      if (managerId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(managerId))) {
        userRow.manager_id = managerId;
      }
      if (salary !== null && salary !== undefined && salary !== '') {
        userRow.salary = Number(salary);
        userRow.annual_salary = Number(salary);
      }
      if (monthlyCtc) userRow.monthly_ctc = String(monthlyCtc);
      if (dateOfJoining) {
        userRow.date_of_joining = dateOfJoining;
        userRow.joining_date = dateOfJoining;
      }
      if (currency) {
        userRow.currency = currency;
        userRow.currency_code = currency;
        userRow.salary_currency = currency;
      }

      return withRetries(async () => {
        let userRes = await this.transport(userUrl, {
          method: 'POST',
          headers: this.getSupabaseHeaders(),
          body: JSON.stringify(userRow),
          signal: AbortSignal.timeout(this.timeoutMs)
        });

        let createdUser = {};
        if (!userRes.ok) {
          const errText = await userRes.text().catch(() => '');
          if (userRes.status === 400 && (errText.includes('currency') || errText.includes('annual_salary') || errText.includes('joining_date'))) {
            const strippedRow = { ...userRow };
            delete strippedRow.currency;
            delete strippedRow.currency_code;
            delete strippedRow.salary_currency;
            delete strippedRow.annual_salary;
            delete strippedRow.joining_date;
            userRes = await this.transport(userUrl, {
              method: 'POST',
              headers: this.getSupabaseHeaders(),
              body: JSON.stringify(strippedRow),
              signal: AbortSignal.timeout(this.timeoutMs)
            });
            if (!userRes.ok) {
              const retryErrText = await userRes.text().catch(() => '');
              const err = new Error(`Supabase HRMS user creation failed with HTTP ${userRes.status}: ${retryErrText.slice(0, 150)}`);
              err.status = userRes.status;
              throw err;
            }
          } else {
            const err = new Error(`Supabase HRMS user creation failed with HTTP ${userRes.status}: ${errText.slice(0, 150)}`);
            err.status = userRes.status;
            throw err;
          }
        }

        const createdData = await userRes.json().catch(() => ({}));
        createdUser = Array.isArray(createdData) ? (createdData[0] || {}) : createdData;
        const employeeId = createdUser.id || null;

        // If offer letter binary or storage path is available, upload to Supabase Storage
        let offerFileUrl = offer.signed_document_url || approvedFields.signed_document_url || null;
        const offerDocName = approvedFields.document_name || offer.document_name || offer.filename || 'Signed Offer Letter';

        if (offer.buffer || (offer.storage_path && existsSync(offer.storage_path))) {
          try {
            const offerBuf = offer.buffer || readFileSync(offer.storage_path);
            const folderName = String(fullName || 'employee').replace(/[^a-zA-Z0-9_-]/g, '_');
            const cleanFileName = String(offer.filename || 'Signed_Offer_Letter.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
            const storagePath = `${folderName}/${cleanFileName}`;
            const storageUploadUrl = `${cleanBase}/storage/v1/object/employee-documents/${storagePath}`;

            const upRes = await this.transport(storageUploadUrl, {
              method: 'POST',
              headers: {
                'apikey': this.apiKey,
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': offer.mime_type || 'application/pdf',
                'x-upsert': 'true'
              },
              body: offerBuf,
              signal: AbortSignal.timeout(this.timeoutMs)
            });

            if (upRes.ok) {
              offerFileUrl = `${cleanBase}/storage/v1/object/public/employee-documents/${storagePath}`;
            }
          } catch (upErr) {
            console.error('Supabase offer storage upload error:', upErr.message);
          }
        }

        // Attach offer letter to employee_documents
        let attachedDocument = null;
        if (employeeId && offerFileUrl) {
          const docTypeId = approvedFields.document_type_id || offer.document_type_id || 'eff934e6-8951-4912-b065-f7056352f394';
          const docName = approvedFields.document_name || offer.document_name || offerDocName;
          try {
            const docRes = await this.transport(documentsUrl, {
              method: 'POST',
              headers: this.getSupabaseHeaders('return=representation,resolution=merge-duplicates'),
              body: JSON.stringify({
                employee_id: employeeId,
                document_type_id: docTypeId,
                document_name: docName,
                file_url: offerFileUrl,
                status: 'uploaded'
              }),
              signal: AbortSignal.timeout(this.timeoutMs)
            });
            if (docRes.ok) {
              const docData = await docRes.json().catch(() => ({}));
              attachedDocument = Array.isArray(docData) ? (docData[0] || null) : docData;
            } else {
              const errBody = await docRes.text().catch(() => '');
              console.error(`Supabase employee_documents insert failed [HTTP ${docRes.status}]: ${errBody.slice(0, 200)}`);
            }
          } catch (docErr) {
            console.error('Supabase employee_documents error:', docErr.message);
          }
        }

        // If candidate resume is available, upload to storage and attach to employee_documents
        const resumeInfo = approvedFields.resume || candidate.resume || null;
        let attachedResume = null;
        if (employeeId && resumeInfo) {
          const resumeTypeId = approvedFields.resume_document_type_id || resumeInfo.document_type_id || 'f75aafd6-416c-4683-9a72-bc4c12027b3d';
          const resumeName = resumeInfo.filename || approvedFields.resume_filename || 'Candidate Resume';
          let resumeFileUrl = resumeInfo.url || resumeInfo.download_url || null;

          // If resume binary buffer or local storage path is present, upload to Supabase Storage
          if (resumeInfo.buffer || (resumeInfo.storage_path && existsSync(resumeInfo.storage_path))) {
            try {
              const fileBuf = resumeInfo.buffer || readFileSync(resumeInfo.storage_path);
              const folderName = String(fullName || 'employee').replace(/[^a-zA-Z0-9_-]/g, '_');
              const cleanFileName = String(resumeName).replace(/[^a-zA-Z0-9._-]/g, '_');
              const storagePath = `${folderName}/${cleanFileName}`;
              const storageUploadUrl = `${cleanBase}/storage/v1/object/employee-documents/${storagePath}`;

              const upRes = await this.transport(storageUploadUrl, {
                method: 'POST',
                headers: {
                  'apikey': this.apiKey,
                  'Authorization': `Bearer ${this.apiKey}`,
                  'Content-Type': resumeInfo.mime_type || 'application/pdf',
                  'x-upsert': 'true'
                },
                body: fileBuf,
                signal: AbortSignal.timeout(this.timeoutMs)
              });

              if (upRes.ok) {
                resumeFileUrl = `${cleanBase}/storage/v1/object/public/employee-documents/${storagePath}`;
              }
            } catch (upErr) {
              console.error('Supabase resume storage upload error:', upErr.message);
            }
          }

          if (resumeFileUrl) {
            try {
              const resDocRes = await this.transport(documentsUrl, {
                method: 'POST',
                headers: this.getSupabaseHeaders('return=representation,resolution=merge-duplicates'),
                body: JSON.stringify({
                  employee_id: employeeId,
                  document_type_id: resumeTypeId,
                  document_name: resumeName,
                  file_url: resumeFileUrl,
                  file_size: resumeInfo.file_size || null,
                  mime_type: resumeInfo.mime_type || 'application/pdf',
                  status: 'uploaded'
                }),
                signal: AbortSignal.timeout(this.timeoutMs)
              });
              if (resDocRes.ok) {
                const resDocData = await resDocRes.json().catch(() => ({}));
                attachedResume = Array.isArray(resDocData) ? (resDocData[0] || null) : resDocData;
              } else {
                const errBody = await resDocRes.text().catch(() => '');
                console.error(`Supabase resume employee_documents insert failed [HTTP ${resDocRes.status}]: ${errBody.slice(0, 200)}`);
              }
            } catch (rErr) {
              console.error('Supabase resume employee_documents error:', rErr.message);
            }
          }
        }

        // If referral exists for this candidate, mark referral as Hired and attach resume_url
        const resumeUrl = attachedResume?.file_url || approvedFields.resume?.url || approvedFields.resume?.download_url || null;
        if (personalEmail) {
          const referralPayload = { status: 'Hired', bonus_eligible: true };
          if (resumeUrl) {
            referralPayload.resume_url = resumeUrl;
          }
          await this.transport(`${referralsUrl}?candidate_email=eq.${encodeURIComponent(personalEmail)}`, {
            method: 'PATCH',
            headers: this.getSupabaseHeaders('return=minimal'),
            body: JSON.stringify(referralPayload),
            signal: AbortSignal.timeout(this.timeoutMs)
          }).catch(() => null);
        }

        // Sync candidate profile and resume_url to Supabase candidates table
        const candidatesUrl = `${cleanBase}${restBasePath}/candidates?on_conflict=email`;
        await this.transport(candidatesUrl, {
          method: 'POST',
          headers: this.getSupabaseHeaders('return=representation,resolution=merge-duplicates'),
          body: JSON.stringify({
            full_name: fullName,
            email: email,
            phone: phone,
            position_applied: position || designationOfferLetter || 'New Hire',
            resume_url: resumeUrl,
            status: 'hired',
            user_id: employeeId
          }),
          signal: AbortSignal.timeout(this.timeoutMs)
        }).catch(() => null);

        return {
          ok: true,
          status: 'accepted',
          provider: 'supabase',
          hireId,
          employeeId,
          providerReference: employeeId || `hrms_${hireId}`,
          currency,
          currencyCode: currency,
          salary,
          data: createdUser,
          document: attachedDocument,
          resume: attachedResume
        };
      }, { maxRetries: this.maxRetries });
    }

    // Generic Webhook / Enterprise API Mode
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
      approvedFields: {
        ...approvedFields,
        currency,
        currency_code: currency,
        salary_currency: currency,
        offer: {
          ...offer,
          currency,
          currency_code: currency
        }
      },
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
        currency,
        currencyCode: currency,
        data
      };
    }, { maxRetries: this.maxRetries });
  }

  async getDepartments() {
    if (!this.configured || !this.baseUrl || !this.apiKey) throw new AdapterNotConfigured('HRMS');
    validateSafeUrl(this.baseUrl, { label: 'HRMS Base URL', requireHttps: true });
    const cleanBase = this.baseUrl.replace(/\/+$/, '');
    const cleanPath = this.resourcePath.startsWith('/') ? this.resourcePath : `/${this.resourcePath}`;
    const targetUrl = this.isSupabase()
      ? `${cleanBase}${cleanPath.replace(/\/users$/, '')}/departments?select=id,name,description`
      : `${cleanBase}/departments`;
    const headers = this.isSupabase() ? this.getSupabaseHeaders('return=representation') : { 'Accept': 'application/json' };
    const res = await this.transport(targetUrl, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`Failed to fetch departments from HRMS: HTTP ${res.status}`);
    return await res.json();
  }

  async getActiveEmployees() {
    if (!this.configured || !this.baseUrl || !this.apiKey) throw new AdapterNotConfigured('HRMS');
    validateSafeUrl(this.baseUrl, { label: 'HRMS Base URL', requireHttps: true });
    const cleanBase = this.baseUrl.replace(/\/+$/, '');
    const cleanPath = this.resourcePath.startsWith('/') ? this.resourcePath : `/${this.resourcePath}`;
    const targetUrl = this.isSupabase()
      ? `${cleanBase}${cleanPath.replace(/\/users$/, '')}/users?select=id,full_name,email,position,department_id&status=eq.active`
      : `${cleanBase}/employees?status=active`;
    const headers = this.isSupabase() ? this.getSupabaseHeaders('return=representation') : { 'Accept': 'application/json' };
    const res = await this.transport(targetUrl, { method: 'GET', headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`Failed to fetch active employees from HRMS: HTTP ${res.status}`);
    return await res.json();
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
