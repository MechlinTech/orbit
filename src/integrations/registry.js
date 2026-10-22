import { HttpError, email as validateEmail } from '../policy.js';

export const INTEGRATION_CATEGORIES = [
  'Calendar & Scheduling',
  'Email & Communications',
  'Artificial Intelligence',
  'Resume & Security',
  'Signatures & Documents',
  'Risk & Compliance',
  'Agency & Partners',
  'HRMS & Core Systems'
];

/**
 * Validates a web URL safely.
 * In production, requires HTTPS and blocks localhost / private IP addresses.
 */
export function validateSafeUrl(rawUrl, { label = 'URL', requireHttps = false, allowLocal = false } = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new HttpError(400, `${label} is required.`);
  }
  const trimmed = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, `${label} must be a valid, well-formed URL.`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new HttpError(400, `${label} must use HTTP or HTTPS protocol.`);
  }

  const isProduction = process.env.NODE_ENV === 'production';
  if (requireHttps && isProduction && parsed.protocol !== 'https:') {
    throw new HttpError(400, `${label} must use HTTPS in production.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  // Check for SSRF targets (localhost, link-local, loopback, cloud metadata)
  const isLocalOrPrivate = (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '169.254.169.254' ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    /^192\.168\./.test(hostname)
  );

  if (isProduction && !allowLocal && isLocalOrPrivate) {
    throw new HttpError(400, `${label} cannot point to loopback, link-local, or private network addresses.`);
  }

  return trimmed;
}

export const INTEGRATION_REGISTRY = [
  {
    id: 'microsoft_calendar',
    category: 'Calendar & Scheduling',
    name: 'Microsoft Calendar & Teams Meetings',
    description: 'Integrates Outlook calendar events and generates Microsoft Teams video meeting links for interview loops.',
    isExternal: true,
    capabilities: [
      'Schedule Outlook calendar events for interview loops',
      'Generate online Microsoft Teams video meeting links',
      'Reschedule and update interview invitations with attendees',
      'Cancel meetings with synchronized attendee notifications'
    ],
    fallbackPolicy: 'Unsynchronized local interview records preserved when Microsoft Graph is unconfigured or unavailable.',
    fields: [
      {
        key: 'tenantId',
        label: 'Microsoft Entra Tenant ID',
        type: 'text',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
        helpText: 'Azure Entra Directory (tenant) ID.',
        validate: v => {
          if (!v || typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'Tenant ID is required.');
          return v.trim();
        }
      },
      {
        key: 'clientId',
        label: 'Application (Client) ID',
        type: 'text',
        required: true,
        placeholder: '00000000-0000-0000-0000-000000000000',
        helpText: 'App Registration Client ID in Azure portal.',
        validate: v => {
          if (!v || typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'Client ID is required.');
          return v.trim();
        }
      },
      {
        key: 'clientSecret',
        label: 'Client Secret Value',
        type: 'password',
        secret: true,
        required: true,
        placeholder: '••••••••',
        helpText: 'Client Secret from Azure App Registrations certificates & secrets.'
      },
      {
        key: 'organizerEmail',
        label: 'Teams Organizer Email',
        type: 'text',
        required: true,
        placeholder: 'interviews@company.com',
        helpText: 'Company mailbox used to schedule Teams meetings.',
        validate: v => validateEmail(v)
      },
      {
        key: 'timeoutMs',
        label: 'Request Timeout (ms)',
        type: 'number',
        default: 10000,
        min: 1000,
        max: 60000,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 1000 || n > 60000) throw new HttpError(400, 'Timeout must be between 1000 and 60000 ms.');
          return n;
        }
      },
      {
        key: 'retryCount',
        label: 'Max Retries',
        type: 'number',
        default: 2,
        min: 0,
        max: 5,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 0 || n > 5) throw new HttpError(400, 'Retries must be between 0 and 5.');
          return n;
        }
      }
    ],
    envFallback: {
      tenantId: () => process.env.ENTRA_TENANT_ID || '',
      clientId: () => process.env.ENTRA_CLIENT_ID || '',
      clientSecret: () => process.env.ENTRA_CLIENT_SECRET || '',
      organizerEmail: () => process.env.TEAMS_ORGANIZER_EMAIL || ''
    }
  },
  {
    id: 'email_communication',
    category: 'Email & Communications',
    name: 'Candidate Email Communications',
    description: 'Delivers candidate invitations, status notifications, and offer letters via verified company domain addresses with consent tracking.',
    isExternal: true,
    capabilities: [
      'Transactional candidate email delivery via company domains',
      'Candidate consent and opt-out compliance management',
      'Delivery, bounce, and failure tracking via webhook callbacks',
      'Automated transient retry handling with backoff'
    ],
    fallbackPolicy: 'Email dispatches fail safely with explicit notifications when unconfigured; candidates can still be processed manually.',
    fields: [
      {
        key: 'provider',
        label: 'Email Provider',
        type: 'select',
        required: true,
        default: 'resend',
        options: [
          { value: 'resend', label: 'Resend API (api.resend.com)' }
        ]
      },
      {
        key: 'apiKey',
        label: 'Provider API Key',
        type: 'password',
        secret: true,
        required: true,
        placeholder: 're_...',
        helpText: 'Resend API key with sending permissions.'
      },
      {
        key: 'fromEmail',
        label: 'Sender From Address',
        type: 'text',
        required: true,
        placeholder: 'careers@mechlin.com',
        helpText: 'Verified sender email address on your company domain.',
        validate: v => validateEmail(v)
      },
      {
        key: 'fromName',
        label: 'Sender Display Name',
        type: 'text',
        default: 'Mechlin Careers',
        placeholder: 'Mechlin Careers',
        validate: v => String(v || '').trim().slice(0, 100)
      },
      {
        key: 'webhookSecret',
        label: 'Webhook Signing Secret',
        type: 'password',
        secret: true,
        required: false,
        placeholder: 'wh_secret_...',
        helpText: 'Optional secret used to verify inbound Resend delivery webhooks.'
      },
      {
        key: 'timeoutMs',
        label: 'Request Timeout (ms)',
        type: 'number',
        default: 10000,
        min: 1000,
        max: 60000,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 1000 || n > 60000) throw new HttpError(400, 'Timeout must be between 1000 and 60000 ms.');
          return n;
        }
      },
      {
        key: 'maxRetries',
        label: 'Max Retries',
        type: 'number',
        default: 2,
        min: 0,
        max: 5,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 0 || n > 5) throw new HttpError(400, 'Retries must be between 0 and 5.');
          return n;
        }
      }
    ],
    envFallback: {
      provider: () => 'resend',
      apiKey: () => process.env.RESEND_API_KEY || '',
      fromEmail: () => process.env.EMAIL_FROM || process.env.RESEND_FROM_EMAIL || '',
      webhookSecret: () => process.env.RESEND_WEBHOOK_SECRET || ''
    }
  },
  {
    id: 'multi_ai',
    category: 'Artificial Intelligence',
    name: 'Multi-AI Providers (OpenAI, Anthropic, Gemini, Grok)',
    description: 'Manages multi-provider AI evaluations for candidate-job matching explanations and assisted job description drafting.',
    isExternal: true,
    capabilities: [
      'Candidate skill matching explanation and gap analysis',
      'Job description drafting assistance for hiring managers',
      'Independent provider configurations (OpenAI, Anthropic, Gemini, Grok)',
      'Configurable fallback priority and deterministic fallback'
    ],
    fallbackPolicy: 'Deterministic rule-based skill matching engine ensures 100% availability if AI providers are unconfigured or unreachable.',
    fields: [
      {
        key: 'defaultProvider',
        label: 'Default AI Provider',
        type: 'select',
        required: true,
        default: 'openai',
        options: [
          { value: 'openai', label: 'OpenAI (GPT-4o / GPT-4o-mini)' },
          { value: 'anthropic', label: 'Anthropic Claude (3.5 Sonnet)' },
          { value: 'gemini', label: 'Google Gemini (1.5 Flash)' },
          { value: 'grok', label: 'xAI Grok (Grok 2)' }
        ]
      },
      {
        key: 'fallbackPolicy',
        label: 'Fallback Policy',
        type: 'select',
        required: true,
        default: 'deterministic',
        options: [
          { value: 'deterministic', label: 'Deterministic Rule Engine (Explainable, local fallback)' },
          { value: 'fail_closed', label: 'Fail Closed (Return error if provider fails)' }
        ]
      },
      {
        key: 'openaiApiKey',
        label: 'OpenAI API Key',
        type: 'password',
        secret: true,
        placeholder: 'sk-...'
      },
      {
        key: 'openaiModel',
        label: 'OpenAI Model',
        type: 'text',
        default: 'gpt-4o-mini',
        placeholder: 'gpt-4o-mini'
      },
      {
        key: 'openaiApiUrl',
        label: 'OpenAI Endpoint URL (Optional)',
        type: 'text',
        placeholder: 'https://api.openai.com/v1/chat/completions',
        validate: v => v ? validateSafeUrl(v, { label: 'OpenAI API URL' }) : ''
      },
      {
        key: 'anthropicApiKey',
        label: 'Anthropic Claude API Key',
        type: 'password',
        secret: true,
        placeholder: 'sk-ant-...'
      },
      {
        key: 'anthropicModel',
        label: 'Anthropic Model',
        type: 'text',
        default: 'claude-3-5-sonnet-20241022',
        placeholder: 'claude-3-5-sonnet-20241022'
      },
      {
        key: 'anthropicApiUrl',
        label: 'Anthropic Endpoint URL (Optional)',
        type: 'text',
        placeholder: 'https://api.anthropic.com/v1/messages',
        validate: v => v ? validateSafeUrl(v, { label: 'Anthropic API URL' }) : ''
      },
      {
        key: 'geminiApiKey',
        label: 'Google Gemini API Key',
        type: 'password',
        secret: true,
        placeholder: 'AIzaSy...'
      },
      {
        key: 'geminiModel',
        label: 'Google Gemini Model',
        type: 'text',
        default: 'gemini-1.5-flash',
        placeholder: 'gemini-1.5-flash'
      },
      {
        key: 'geminiApiUrl',
        label: 'Google Gemini Endpoint URL (Optional)',
        type: 'text',
        placeholder: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'
      },
      {
        key: 'grokApiKey',
        label: 'xAI Grok API Key',
        type: 'password',
        secret: true,
        placeholder: 'xai-...'
      },
      {
        key: 'grokModel',
        label: 'xAI Grok Model',
        type: 'text',
        default: 'grok-2-latest',
        placeholder: 'grok-2-latest'
      },
      {
        key: 'grokApiUrl',
        label: 'xAI Grok Endpoint URL (Optional)',
        type: 'text',
        placeholder: 'https://api.x.ai/v1/chat/completions',
        validate: v => v ? validateSafeUrl(v, { label: 'Grok API URL' }) : ''
      }
    ],
    envFallback: {
      defaultProvider: () => process.env.AI_DEFAULT_PROVIDER || 'openai',
      openaiApiKey: () => process.env.OPENAI_API_KEY || process.env.AI_PROVIDER_API_KEY || '',
      openaiModel: () => process.env.OPENAI_MODEL || process.env.AI_MODEL || 'gpt-4o-mini',
      anthropicApiKey: () => process.env.ANTHROPIC_API_KEY || '',
      anthropicModel: () => process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      geminiApiKey: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
      geminiModel: () => process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      grokApiKey: () => process.env.GROK_API_KEY || process.env.XAI_API_KEY || '',
      grokModel: () => process.env.GROK_MODEL || 'grok-2-latest'
    }
  },
  {
    id: 'resume_scanner',
    category: 'Resume & Security',
    name: 'Resume Parsing & Malware Scanning',
    description: 'Secures candidate resume processing with quarantine isolation, magic-byte format validation, and malware scanning.',
    isExternal: false,
    capabilities: [
      'PDF and DOCX text extraction with structured normalization',
      'Quarantine file isolation before extraction and storage',
      'File signature, extension, and magic-byte validation',
      'Fail-closed antivirus enforcement policy option'
    ],
    fallbackPolicy: 'Local file signatures and heuristics operate locally. If antivirus is required and scanner is offline, uploads fail closed.',
    fields: [
      {
        key: 'scannerMode',
        label: 'Scanner Architecture',
        type: 'select',
        default: 'local',
        options: [
          { value: 'local', label: 'Local File Signature & Heuristic Scanner (In-house)' },
          { value: 'clamav', label: 'ClamAV Antivirus Daemon' },
          { value: 'external', label: 'External REST Antivirus API' }
        ]
      },
      {
        key: 'antivirusRequired',
        label: 'Enforce Antivirus (Fail closed on scanner unavailability)',
        type: 'checkbox',
        default: false
      },
      {
        key: 'antivirusEndpoint',
        label: 'Antivirus Service URL (Optional for ClamAV / External)',
        type: 'text',
        placeholder: 'http://localhost:3310',
        validate: v => v ? validateSafeUrl(v, { label: 'Antivirus Endpoint', allowLocal: true }) : ''
      },
      {
        key: 'antivirusApiKey',
        label: 'Antivirus Service API Key (Optional)',
        type: 'password',
        secret: true,
        placeholder: ''
      },
      {
        key: 'maxSizeBytes',
        label: 'Maximum Upload Size (Bytes)',
        type: 'number',
        default: 5242880,
        min: 1048576,
        max: 20971520,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 1048576 || n > 20971520) throw new HttpError(400, 'Max size must be between 1MB and 20MB.');
          return n;
        }
      },
      {
        key: 'timeoutMs',
        label: 'Scan Timeout (ms)',
        type: 'number',
        default: 10000,
        min: 1000,
        max: 60000,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 1000 || n > 60000) throw new HttpError(400, 'Timeout must be between 1000 and 60000 ms.');
          return n;
        }
      }
    ],
    envFallback: {
      scannerMode: () => 'local',
      antivirusRequired: () => process.env.ANTIVIRUS_REQUIRED === 'true',
      maxSizeBytes: () => Number(process.env.MAX_RESUME_SIZE_BYTES || 5242880)
    }
  },
  {
    id: 'signature',
    category: 'Signatures & Documents',
    name: 'In-house E-Signature Solution',
    description: 'Self-hosted, legally defensible digital offer letter signing with typed, drawn, and image signatures and cryptographic audit hashing.',
    isExternal: false,
    capabilities: [
      'In-house digital offer document generation and signing portal',
      'Typed font, drawn canvas, and PNG image signature capture',
      'PDF placement and cryptographic stamping with signer coordinates',
      'SHA-256 pre/post signature integrity hashing and immutable audit log'
    ],
    fallbackPolicy: 'Fully self-contained in-house service. Operates entirely locally without mandatory third-party subscriptions.',
    fields: [
      {
        key: 'storageDirectory',
        label: 'Document Storage Path',
        type: 'text',
        default: 'data/signatures',
        placeholder: 'data/signatures',
        validate: v => String(v || '').trim() || 'data/signatures'
      },
      {
        key: 'tokenExpiryDays',
        label: 'Signer Link Expiration (Days)',
        type: 'number',
        default: 7,
        min: 1,
        max: 90,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 1 || n > 90) throw new HttpError(400, 'Token expiry must be between 1 and 90 days.');
          return n;
        }
      },
      {
        key: 'requireConsentCheckbox',
        label: 'Require Explicit Electronic Consent Confirmation',
        type: 'checkbox',
        default: true
      },
      {
        key: 'externalTimestampingUrl',
        label: 'RFC 3161 Timestamping Authority URL (Optional)',
        type: 'text',
        placeholder: 'https://...',
        validate: v => v ? validateSafeUrl(v, { label: 'Timestamping URL' }) : ''
      }
    ],
    envFallback: {
      storageDirectory: () => 'data/signatures',
      tokenExpiryDays: () => 7,
      requireConsentCheckbox: () => true
    }
  },
  {
    id: 'fraud_review',
    category: 'Risk & Compliance',
    name: 'Fraud & Risk Review',
    description: 'Monitors incoming candidate profiles for timeline inconsistencies, credential inflation, and cross-application duplicates.',
    isExternal: false,
    capabilities: [
      'Automated resume experience and timeline inconsistency detection',
      'Cross-requisition duplicate candidate matching',
      'Risk-level classification (Low, Medium, High)',
      'Recruiter human review and audit-logged resolution workflow'
    ],
    fallbackPolicy: 'Runs in-house rule-based heuristic algorithms without sending confidential candidate data to external services.',
    fields: [
      {
        key: 'enabled',
        label: 'Enable Automated Risk Detection',
        type: 'checkbox',
        default: true
      },
      {
        key: 'mediumRiskThreshold',
        label: 'Medium Risk Flag Threshold',
        type: 'number',
        default: 2,
        min: 1,
        max: 10,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 1 || n > 10) throw new HttpError(400, 'Threshold must be between 1 and 10.');
          return n;
        }
      },
      {
        key: 'highRiskThreshold',
        label: 'High Risk Flag Threshold',
        type: 'number',
        default: 4,
        min: 2,
        max: 20,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 2 || n > 20) throw new HttpError(400, 'High threshold must be between 2 and 20.');
          return n;
        }
      },
      {
        key: 'duplicateCrossRequisition',
        label: 'Flag Cross-Requisition Duplicates',
        type: 'checkbox',
        default: true
      },
      {
        key: 'externalVerificationUrl',
        label: 'External Identity Verification API (Optional)',
        type: 'text',
        placeholder: 'https://...',
        validate: v => v ? validateSafeUrl(v, { label: 'External Verification URL' }) : ''
      },
      {
        key: 'externalApiKey',
        label: 'External Verification API Key (Optional)',
        type: 'password',
        secret: true,
        placeholder: ''
      }
    ],
    envFallback: {
      enabled: () => process.env.ENABLE_FRAUD_REVIEW !== 'false',
      mediumRiskThreshold: () => 2,
      highRiskThreshold: () => 4
    }
  },
  {
    id: 'agency_portal',
    category: 'Agency & Partners',
    name: 'External Agency Recruiter Portal',
    description: 'Isolated partner portal providing third-party recruitment agencies controlled access to assigned requisitions and candidate submissions.',
    isExternal: false,
    capabilities: [
      'Multi-tenant agency portal with strict tenant isolation',
      'Controlled requisition assignments and sourcing instruction delivery',
      'Candidate submission with duplicate ownership protection window',
      'Recruiter feedback publishing and placement status synchronization'
    ],
    fallbackPolicy: 'Operates in-house with strict role separation. Agency members have no access to internal ATS routes.',
    fields: [
      {
        key: 'enabled',
        label: 'Enable Agency Partner Portal',
        type: 'checkbox',
        default: true
      },
      {
        key: 'ownershipProtectionDays',
        label: 'Candidate Ownership Protection Window (Days)',
        type: 'number',
        default: 180,
        min: 30,
        max: 730,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 30 || n > 730) throw new HttpError(400, 'Protection window must be between 30 and 730 days.');
          return n;
        }
      },
      {
        key: 'maxSubmissionsPerRole',
        label: 'Maximum Submissions Per Agency Per Job',
        type: 'number',
        default: 5,
        min: 1,
        max: 50,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 1 || n > 50) throw new HttpError(400, 'Max submissions must be between 1 and 50.');
          return n;
        }
      },
      {
        key: 'partnerTermsUrl',
        label: 'Agency Partner Terms URL (Optional)',
        type: 'text',
        placeholder: 'https://mechlin.com/agency-agreement',
        validate: v => v ? validateSafeUrl(v, { label: 'Partner Terms URL' }) : ''
      }
    ],
    envFallback: {
      enabled: () => true,
      ownershipProtectionDays: () => 180,
      maxSubmissionsPerRole: () => 5
    }
  },
  {
    id: 'hrms',
    category: 'HRMS & Core Systems',
    name: 'In-house HRMS / Core HR Integration',
    description: 'Post-offer employee onboarding dispatch sending approved hire records to your enterprise HRMS API.',
    isExternal: true,
    capabilities: [
      'Automated new hire data handoff upon successful offer acceptance',
      'Employee profile provisioning and initial system assignment',
      'Idempotent dispatch with secure credential headers and timeout handling',
      'Safe validation preventing SSRF and internal infrastructure probing'
    ],
    fallbackPolicy: 'HRMS integration remains inactive until configured and verified. Orbit workflows continue normally without error.',
    fields: [
      {
        key: 'baseUrl',
        label: 'HRMS Base API URL',
        type: 'text',
        required: true,
        placeholder: 'https://hrms.internal.company.com/api/v1',
        helpText: 'Base HTTPS endpoint of the enterprise HRMS.',
        validate: v => validateSafeUrl(v, { label: 'HRMS Base URL', requireHttps: true })
      },
      {
        key: 'resourcePath',
        label: 'Handoff Resource Path',
        type: 'text',
        default: '/hires',
        placeholder: '/hires',
        validate: v => {
          const path = String(v || '').trim();
          if (!path.startsWith('/')) throw new HttpError(400, 'Resource path must start with "/".');
          return path;
        }
      },
      {
        key: 'authType',
        label: 'Authentication Scheme',
        type: 'select',
        required: true,
        default: 'bearer',
        options: [
          { value: 'bearer', label: 'Bearer Token (Authorization: Bearer <token>)' },
          { value: 'api_key', label: 'API Key Header (X-API-Key: <key>)' },
          { value: 'basic', label: 'HTTP Basic Auth (Authorization: Basic <base64>)' }
        ]
      },
      {
        key: 'apiKey',
        label: 'API Key / Secret Token',
        type: 'password',
        secret: true,
        required: true,
        placeholder: '••••••••',
        helpText: 'Secret credentials for HRMS API access.'
      },
      {
        key: 'timeoutMs',
        label: 'Request Timeout (ms)',
        type: 'number',
        default: 10000,
        min: 1000,
        max: 60000,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 1000 || n > 60000) throw new HttpError(400, 'Timeout must be between 1000 and 60000 ms.');
          return n;
        }
      },
      {
        key: 'maxRetries',
        label: 'Max Retries',
        type: 'number',
        default: 2,
        min: 0,
        max: 5,
        validate: v => {
          const n = Number(v);
          if (isNaN(n) || n < 0 || n > 5) throw new HttpError(400, 'Retries must be between 0 and 5.');
          return n;
        }
      },
      {
        key: 'syncEnabled',
        label: 'Enable Automated Handoff on Candidate Hire',
        type: 'checkbox',
        default: false
      }
    ],
    envFallback: {
      baseUrl: () => process.env.HRMS_BASE_URL || '',
      resourcePath: () => process.env.HRMS_RESOURCE_PATH || '/hires',
      authType: () => process.env.HRMS_AUTH_TYPE || 'bearer',
      apiKey: () => process.env.HRMS_API_KEY || ''
    }
  }
];

export function getRegistryItem(id) {
  const item = INTEGRATION_REGISTRY.find(i => i.id === id);
  if (!item) throw new HttpError(404, `Integration "${id}" is not supported.`);
  return item;
}
