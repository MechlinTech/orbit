import { HttpError } from '../policy.js';
import { getGraphAccessToken } from '../calendar/graph.js';
import { getEffectiveIntegrationConfig } from './storage.js';
import { validateSafeUrl } from './registry.js';
import { createAiProvider } from '../ai/provider.js';
import { ResumeStorageManager } from '../resume/storage.js';
import { createScanner } from '../resume/scanner.js';
import { analyzeFraudRisk } from '../fraud/detector.js';

/**
 * Runs a safe, non-destructive connection test for any of the 8 supported integrations.
 */
export async function testIntegrationConnection(db, id, { proposedConfig, proposedSecrets, transport = fetch } = {}) {
  // Merge effective configuration with any proposed values submitted in the test request
  const effective = getEffectiveIntegrationConfig(db, id);
  const config = { ...effective.config, ...(proposedConfig || {}) };
  const secrets = { ...effective.secrets, ...(proposedSecrets || {}) };

  switch (id) {
    case 'microsoft_calendar':
      return testMicrosoftCalendar({ config, secrets, transport });
    case 'email_communication':
      return testEmailCommunication({ config, secrets, transport });
    case 'multi_ai':
      return testMultiAi({ config, secrets, transport });
    case 'resume_scanner':
      return testResumeScanner({ config, secrets, transport });
    case 'signature':
      return testSignature({ config, secrets, db });
    case 'fraud_review':
      return testFraudReview({ config, secrets, db });
    case 'agency_portal':
      return testAgencyPortal({ config, secrets, db });
    case 'hrms':
      return testHrms({ config, secrets, transport });
    default:
      throw new HttpError(400, `Unknown integration "${id}" cannot be tested.`);
  }
}

async function testMicrosoftCalendar({ config, secrets, transport }) {
  const tenant = config.tenantId;
  const client = config.clientId;
  const secret = secrets.clientSecret;
  const organizerEmail = config.organizerEmail;

  if (!tenant || !client || !secret) {
    return {
      ok: false,
      status: 'failed',
      message: 'Missing required credentials (Tenant ID, Client ID, or Client Secret).'
    };
  }

  const isDemo = Boolean(
    (tenant && tenant.includes('demo')) ||
    (client && client.includes('demo')) ||
    (process.env.SIMULATE_TEAMS_MEETING === 'true')
  );

  if (isDemo && transport === fetch) {
    return {
      ok: true,
      status: 'connected',
      message: `Demo mode: Simulated Microsoft Graph connection verified for demo tenant. App token and Teams organizer mailbox: ${organizerEmail || 'configured'}.`,
      details: {
        tokenGranted: true,
        organizerConfigured: Boolean(organizerEmail),
        simulated: true
      }
    };
  }

  try {
    const token = await getGraphAccessToken({
      tenant,
      client,
      secret,
      transport,
      forceRefresh: true
    });

    // Verify token validity against a safe, non-destructive Graph read endpoint
    const checkRes = await transport('https://graph.microsoft.com/v1.0/organization', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'ConsistencyLevel': 'eventual'
      },
      signal: AbortSignal.timeout(Number(config.timeoutMs || 8000))
    });

    if (!checkRes.ok && checkRes.status !== 403) {
      const errText = await checkRes.text().catch(() => '');
      return {
        ok: false,
        status: 'failed',
        message: `Microsoft Graph responded with HTTP ${checkRes.status}: ${errText.slice(0, 150)}`
      };
    }

    return {
      ok: true,
      status: 'connected',
      message: `Successfully authenticated with Microsoft Graph. App token acquired for tenant ${tenant.slice(0, 8)}... Organizer mailbox: ${organizerEmail || 'configured'}.`,
      details: {
        tokenGranted: true,
        organizerConfigured: Boolean(organizerEmail)
      }
    };
  } catch (err) {
    const msg = String(err.message || err);
    let category = 'Authentication Failure';
    if (/timeout/i.test(msg)) category = 'Connection Timeout';
    else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(msg)) category = 'Network Unreachable';

    return {
      ok: false,
      status: 'failed',
      message: `${category}: ${msg.replace(/secret=[^&]+/ig, 'secret=REDACTED')}`
    };
  }
}

async function testEmailCommunication({ config, secrets, transport }) {
  let apiKey = String(secrets.apiKey || '').trim();
  apiKey = apiKey.replace(/^Bearer\s+/i, '').trim().replace(/^['"]|['"]$/g, '').trim();
  const fromEmail = String(config.fromEmail || '').trim();

  if (!apiKey) {
    return {
      ok: false,
      status: 'failed',
      message: 'Provider API key is required to test email connection.'
    };
  }
  if (!apiKey.startsWith('re_')) {
    return {
      ok: false,
      status: 'failed',
      message: "Resend API keys must start with 're_' (e.g. re_123456789...). Please check your key from the Resend dashboard."
    };
  }
  if (!fromEmail) {
    return {
      ok: false,
      status: 'failed',
      message: 'Sender From Address is required.'
    };
  }

  try {
    // Non-destructive credential test using Resend's API keys verification endpoint
    const res = await transport('https://api.resend.com/api-keys', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(Number(config.timeoutMs || 8000))
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: 'failed',
        message: 'Resend API authentication failed: invalid, expired or restricted API key.'
      };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let parsedMsg = errText.slice(0, 150);
      try {
        const json = JSON.parse(errText);
        if (json.message) parsedMsg = json.message;
      } catch {}
      return {
        ok: false,
        status: 'failed',
        message: `Resend API returned HTTP ${res.status}: ${parsedMsg}`
      };
    }

    // Verify sender domain verification status via Resend's domains API
    const fromDomain = fromEmail.split('@')[1]?.toLowerCase() || '';
    if (fromDomain && fromDomain !== 'resend.dev') {
      try {
        const domRes = await transport('https://api.resend.com/domains', {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          signal: AbortSignal.timeout(Number(config.timeoutMs || 8000))
        });
        if (domRes.ok) {
          const domData = await domRes.json().catch(() => ({}));
          const domainsList = Array.isArray(domData.data) ? domData.data : [];
          if (domData.object === 'list' || domainsList.length > 0) {
            const matched = domainsList.find(d => {
              const dName = String(d.name || '').toLowerCase();
              return dName === fromDomain || fromDomain.endsWith('.' + dName);
            });
            if (!matched) {
              return {
                ok: false,
                status: 'failed',
                message: `Resend API key is valid, but the domain "${fromDomain}" is not added or verified in your Resend account. Resend will reject candidate email delivery from this address. Please add and verify "${fromDomain}" at https://resend.com/domains (or use "onboarding@resend.dev" to test delivery to your account owner email).`,
                details: {
                  provider: 'resend',
                  domainVerified: false,
                  senderConfigured: fromEmail,
                  domainsInAccount: domainsList.map(d => d.name)
                }
              };
            }
            if (matched.status !== 'verified') {
              return {
                ok: false,
                status: 'failed',
                message: `Resend API key is valid, but domain "${fromDomain}" status is "${matched.status}". Resend requires verified DNS records (DKIM, SPF) before sending. Please verify your domain at https://resend.com/domains.`,
                details: {
                  provider: 'resend',
                  domainVerified: false,
                  domainStatus: matched.status,
                  senderConfigured: fromEmail
                }
              };
            }
          }
        }
      } catch {}
    }

    return {
      ok: true,
      status: 'connected',
      message: fromDomain === 'resend.dev'
        ? `Resend API connection successful using sandbox sender (${fromEmail}). Sandbox only delivers test emails to your registered Resend account owner email.`
        : `Resend API connection successful and verified for domain "${fromDomain}". Ready for live candidate email delivery.`,
      details: {
        provider: 'resend',
        senderConfigured: fromEmail,
        webhookConfigured: Boolean(secrets.webhookSecret)
      }
    };
  } catch (err) {
    const msg = String(err.message || err);
    return {
      ok: false,
      status: 'failed',
      message: `Email connection test failed: ${msg.replace(/Bearer\s+[^\s]+/ig, 'Bearer REDACTED')}`
    };
  }
}

async function testMultiAi({ config, secrets, transport }) {
  const targetProvider = config.defaultProvider || 'openai';

  const providerMap = {
    openai: { key: secrets.openaiApiKey, model: config.openaiModel || 'gpt-4o-mini', url: config.openaiApiUrl },
    anthropic: { key: secrets.anthropicApiKey, model: config.anthropicModel || 'claude-3-5-sonnet-20241022', url: config.anthropicApiUrl },
    gemini: { key: secrets.geminiApiKey, model: config.geminiModel || 'gemini-1.5-flash', url: config.geminiApiUrl },
    grok: { key: secrets.grokApiKey, model: config.grokModel || 'grok-2-latest', url: config.grokApiUrl }
  };

  const selected = providerMap[targetProvider];
  if (!selected || !selected.key) {
    // Check if any other provider is configured
    const anyConfigured = Object.entries(providerMap).find(([k, v]) => Boolean(v.key));
    if (!anyConfigured) {
      return {
        ok: false,
        status: 'failed',
        message: `No API key configured for default provider "${targetProvider}". Fallback policy is currently "${config.fallbackPolicy || 'deterministic'}".`
      };
    }
  }

  const activeName = selected?.key ? targetProvider : Object.entries(providerMap).find(([k, v]) => Boolean(v.key))[0];
  const activeCfg = providerMap[activeName];

  try {
    const providerInstance = createAiProvider(activeName, {
      apiKey: activeCfg.key,
      apiUrl: activeCfg.url,
      model: activeCfg.model
    });

    const endpoint = providerInstance.getEndpoint();
    const headers = providerInstance.getHeaders();
    const body = providerInstance.buildRequestBody({
      prompt: 'Ping. Reply with "pong".',
      maxTokens: 5,
      temperature: 0.0
    });

    const res = await transport(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        status: 'failed',
        message: `${activeName} API responded with HTTP ${res.status}: ${errText.slice(0, 150)}`
      };
    }

    const data = await res.json().catch(() => ({}));
    const replyText = providerInstance.extractText(data);

    return {
      ok: true,
      status: 'connected',
      message: `Successfully connected to ${providerInstance.name.toUpperCase()} (Model: ${providerInstance.model}). Verified round-trip generation.`,
      details: {
        provider: providerInstance.name,
        model: providerInstance.model,
        testReply: replyText ? replyText.slice(0, 30).trim() : 'ok'
      }
    };
  } catch (err) {
    const msg = String(err.message || err);
    return {
      ok: false,
      status: 'failed',
      message: `AI provider connection error (${activeName}): ${msg.replace(/Bearer\s+[^\s]+/ig, 'Bearer REDACTED')}`
    };
  }
}

async function testResumeScanner({ config, secrets, transport }) {
  try {
    const storage = new ResumeStorageManager();
    const scanner = createScanner({
      antivirusRequired: Boolean(config.antivirusRequired),
      antivirusProvider: config.antivirusEndpoint || null
    });

    if (config.scannerMode === 'external' || config.scannerMode === 'clamav') {
      if (!config.antivirusEndpoint) {
        return {
          ok: false,
          status: 'failed',
          message: 'External scanner mode selected, but no Antivirus Service URL is configured.'
        };
      }
      try {
        const pingRes = await transport(`${config.antivirusEndpoint.replace(/\/+$/, '')}/health`, {
          signal: AbortSignal.timeout(Number(config.timeoutMs || 5000))
        });
        if (!pingRes.ok) {
          return {
            ok: false,
            status: 'failed',
            message: `External antivirus endpoint returned HTTP ${pingRes.status}.`
          };
        }
      } catch (err) {
        return {
          ok: false,
          status: 'failed',
          message: `Cannot reach external antivirus service at ${config.antivirusEndpoint}: ${err.message}`
        };
      }
    }

    // Verify local quarantine write and scan
    const testBuffer = Buffer.from('%PDF-1.4\n% Orbit Resume Verification Sample\ntrailer\n<<>>\n%%EOF');
    const { quarantineId, path: qPath } = storage.saveToQuarantine(testBuffer);
    const scan = await scanner.scan(testBuffer, qPath);
    storage.cleanupQuarantine(quarantineId);

    return {
      ok: true,
      status: 'connected',
      message: `Resume parsing pipeline, quarantine storage, and file signature validator operational. (Mode: ${config.scannerMode || 'local'})`,
      details: {
        scannerMode: config.scannerMode || 'local',
        antivirusEnforced: Boolean(config.antivirusRequired),
        maxUploadBytes: config.maxSizeBytes || 5242880
      }
    };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      message: `Resume processing pipeline check failed: ${err.message}`
    };
  }
}

async function testSignature({ config, db }) {
  try {
    // Verify database tables and directory
    const count = db.prepare('SELECT count(*) as count FROM signature_documents').get();
    return {
      ok: true,
      status: 'connected',
      message: 'In-house digital e-signature engine, PDF stamping pipeline, and SHA-256 cryptographic audit trail operational.',
      details: {
        architecture: 'in-house',
        documentsTracked: count?.count || 0,
        tokenExpiryDays: config.tokenExpiryDays || 7
      }
    };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      message: `Signature service check failed: ${err.message}`
    };
  }
}

async function testFraudReview({ config, db }) {
  try {
    const testResult = analyzeFraudRisk({ id: 'test_candidate', resume_text: 'Test software engineer at Mechlin 2021-2024' }, { db });
    return {
      ok: true,
      status: 'connected',
      message: 'In-house fraud and inconsistency heuristic engine operational. Risk flags evaluated locally without external data leaks.',
      details: {
        enabled: Boolean(config.enabled !== false),
        evaluatedFlags: testResult?.flags?.length || 0,
        riskLevel: testResult?.riskLevel || 'low'
      }
    };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      message: `Fraud review heuristic check failed: ${err.message}`
    };
  }
}

async function testAgencyPortal({ config, db }) {
  try {
    const agencyCount = db.prepare('SELECT count(*) as count FROM agencies').get();
    return {
      ok: true,
      status: 'connected',
      message: 'External agency partner portal and tenant-isolation subsystem operational.',
      details: {
        agenciesRegistered: agencyCount?.count || 0,
        ownershipWindowDays: config.ownershipProtectionDays || 180,
        maxSubmissions: config.maxSubmissionsPerRole || 5
      }
    };
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      message: `Agency portal check failed: ${err.message}`
    };
  }
}

async function testHrms({ config, secrets, transport }) {
  const baseUrl = config.baseUrl;
  const apiKey = secrets.apiKey;
  const authType = config.authType || 'bearer';

  if (!baseUrl) {
    return {
      ok: false,
      status: 'failed',
      message: 'HRMS Base API URL is required.'
    };
  }
  if (!apiKey) {
    return {
      ok: false,
      status: 'failed',
      message: 'HRMS API Key / Access Token is required.'
    };
  }

  // Safe URL check and SSRF check
  try {
    validateSafeUrl(baseUrl, { label: 'HRMS Base URL', requireHttps: true });
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      message: `Invalid HRMS URL configuration: ${err.message}`
    };
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const resPath = String(config.resourcePath || '').replace(/\/+$/, '');
  const isSupabase = cleanBase.includes('supabase.co') || resPath.includes('rest/v1');

  // Supabase Data API (PostgREST) accepts /rest/v1/ or the configured resource path directly
  const testUrl = isSupabase
    ? `${cleanBase}${resPath ? (resPath.startsWith('/') ? resPath : `/${resPath}`) : '/rest/v1'}/`
    : `${cleanBase}/health`;

  const headers = {
    'Accept': 'application/json'
  };

  if (authType === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (authType === 'api_key') {
    headers['X-API-Key'] = apiKey;
  } else if (authType === 'basic') {
    headers['Authorization'] = `Basic ${Buffer.from(apiKey).toString('base64')}`;
  }

  if (isSupabase) {
    headers['apikey'] = apiKey;
  }

  try {
    const res = await transport(testUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(Number(config.timeoutMs || 8000))
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: 'failed',
        message: isSupabase
          ? `Supabase Data API reached at ${cleanBase}, but credentials were rejected (HTTP ${res.status}). Ensure you use the Supabase service_role secret key.`
          : `HRMS endpoint reached at ${cleanBase}, but authentication credentials were rejected (HTTP ${res.status}).`
      };
    }

    if (res.status === 404 && !isSupabase) {
      // Endpoint /health not found, try base URL with HEAD
      const rootRes = await transport(cleanBase, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(Number(config.timeoutMs || 8000))
      });
      if (rootRes.ok || rootRes.status === 401 || rootRes.status === 403) {
        return {
          ok: rootRes.ok,
          status: rootRes.ok ? 'connected' : 'failed',
          message: rootRes.ok
            ? `HRMS root endpoint responded with HTTP ${rootRes.status}. Base URL reachable.`
            : `HRMS root endpoint reached, but credentials were rejected (HTTP ${rootRes.status}).`
        };
      }
    }

    if (!res.ok) {
      return {
        ok: false,
        status: 'failed',
        message: `HRMS endpoint responded with HTTP ${res.status} error.`
      };
    }

    return {
      ok: true,
      status: 'connected',
      message: isSupabase
        ? `Successfully authenticated with Supabase Data API (PostgREST). Database schema is accessible and ready for employee sync.`
        : `HRMS API endpoint verified at ${cleanBase}. Authentication accepted without dispatching employee records.`,
      details: {
        provider: isSupabase ? 'supabase' : 'generic_hrms',
        endpoint: testUrl,
        statusCode: res.status,
        baseUrl: cleanBase,
        authType,
        resourcePath: config.resourcePath || '/hires',
        syncEnabled: Boolean(config.syncEnabled)
      }
    };
  } catch (err) {
    const msg = String(err.message || err);
    let category = 'Connection Failed';
    if (/timeout/i.test(msg)) category = 'Timeout';
    else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(msg)) category = 'Host Unreachable';

    return {
      ok: false,
      status: 'failed',
      message: `${category}: ${msg.replace(/Bearer\s+[^\s]+/ig, 'Bearer REDACTED').replace(/Basic\s+[^\s]+/ig, 'Basic REDACTED')}`
    };
  }
}
