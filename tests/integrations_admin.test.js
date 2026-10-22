import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, user, testConfig } from './helpers.js';
import { service } from '../src/service.js';
import { HrmsAdapter, AdapterNotConfigured } from '../src/adapters.js';
import { encryptSecret, decryptSecret, isMasked, MASKED_VALUE } from '../src/integrations/crypto.js';
import { INTEGRATION_REGISTRY, validateSafeUrl } from '../src/integrations/registry.js';
import { getEffectiveIntegrationConfig } from '../src/integrations/storage.js';

const call = (f, u, m, p, b, q, c) => service(f.db, u, m, p, b, q, c || f.config);

test('Integrations Security & RBAC: Only System Admin can access admin integrations APIs', async () => {
  const f = fixture();
  f.config = testConfig();

  // 1. System Admin succeeds
  const list = await call(f, f.admin, 'GET', 'admin/integrations');
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 8);

  const item = await call(f, f.admin, 'GET', 'admin/integrations/microsoft_calendar');
  assert.ok(item);
  assert.equal(item.id, 'microsoft_calendar');

  // 2. Non-admin roles (Recruiter, Manager, Interviewer, Finance) must be rejected with 403
  for (const nonAdmin of [f.recruiter, f.manager, f.interviewer, f.finance]) {
    await assert.rejects(
      async () => call(f, nonAdmin, 'GET', 'admin/integrations'),
      err => err.status === 403,
      `Expected ${nonAdmin.role} to receive 403 on GET admin/integrations`
    );

    await assert.rejects(
      async () => call(f, nonAdmin, 'GET', 'admin/integrations/microsoft_calendar'),
      err => err.status === 403,
      `Expected ${nonAdmin.role} to receive 403 on GET admin/integrations/:id`
    );

    await assert.rejects(
      async () => call(f, nonAdmin, 'PUT', 'admin/integrations/microsoft_calendar', { config: {} }),
      err => err.status === 403,
      `Expected ${nonAdmin.role} to receive 403 on PUT admin/integrations/:id`
    );

    await assert.rejects(
      async () => call(f, nonAdmin, 'POST', 'admin/integrations/microsoft_calendar/test', {}),
      err => err.status === 403,
      `Expected ${nonAdmin.role} to receive 403 on POST admin/integrations/:id/test`
    );

    await assert.rejects(
      async () => call(f, nonAdmin, 'POST', 'admin/integrations/microsoft_calendar/toggle', { enabled: true }),
      err => err.status === 403,
      `Expected ${nonAdmin.role} to receive 403 on POST admin/integrations/:id/toggle`
    );
  }

  f.db.close();
});

test('Integrations Registry: All 8 core integrations are represented with capabilities and metadata', async () => {
  const f = fixture();
  f.config = testConfig();

  const list = await call(f, f.admin, 'GET', 'admin/integrations');
  const ids = list.map(i => i.id);

  const expectedIds = [
    'microsoft_calendar',
    'email_communication',
    'multi_ai',
    'resume_scanner',
    'signature',
    'fraud_review',
    'agency_portal',
    'hrms'
  ];

  for (const id of expectedIds) {
    assert.ok(ids.includes(id), `Missing integration id: ${id}`);
    const item = list.find(i => i.id === id);
    assert.ok(item.name);
    assert.ok(item.category);
    assert.ok(item.description);
    assert.ok(Array.isArray(item.capabilities) && item.capabilities.length > 0);
    assert.ok(item.fallbackPolicy);
  }

  f.db.close();
});

test('Integrations Encryption & Secret Protection: Secrets are encrypted at rest with AES-256-GCM and masked in API', async () => {
  const f = fixture();
  f.config = testConfig();

  const liveSecret = 'azure-production-super-secret-key-12345';

  // 1. Update configuration with a secret value
  await call(f, f.admin, 'PUT', 'admin/integrations/microsoft_calendar', {
    enabled: true,
    config: {
      tenantId: '00000000-0000-0000-0000-000000000001',
      clientId: '00000000-0000-0000-0000-000000000002',
      organizerEmail: 'interviews@mechlin.com'
    },
    secrets: {
      clientSecret: liveSecret
    }
  });

  // 2. Inspect raw database record in SQLite: verify plaintext is NOT present
  const rawRow = f.db.prepare('SELECT encrypted_secrets_json FROM integration_configs WHERE id = ?').get('microsoft_calendar');
  assert.ok(rawRow);
  assert.ok(!rawRow.encrypted_secrets_json.includes(liveSecret), 'Raw DB contains plaintext secret! Must be encrypted.');

  const parsed = JSON.parse(rawRow.encrypted_secrets_json);
  assert.ok(parsed.clientSecret);
  const parts = parsed.clientSecret.split(':');
  assert.equal(parts.length, 3, 'Encrypted secret must be stored as iv:tag:ciphertext');

  // Verify it decrypts correctly with the internal decryption utility
  assert.equal(decryptSecret(parsed.clientSecret), liveSecret);

  // 3. API endpoint GET /api/admin/integrations/microsoft_calendar must return masked value
  const details = await call(f, f.admin, 'GET', 'admin/integrations/microsoft_calendar');
  const secretField = details.fields.find(f => f.key === 'clientSecret');
  assert.ok(secretField);
  assert.equal(secretField.value, MASKED_VALUE);
  assert.equal(secretField.hasSavedSecret, true);

  // 4. Update without changing secret (leave blank or masked): verify secret is preserved
  await call(f, f.admin, 'PUT', 'admin/integrations/microsoft_calendar', {
    enabled: true,
    config: {
      tenantId: '00000000-0000-0000-0000-000000000001',
      clientId: '00000000-0000-0000-0000-000000000002',
      organizerEmail: 'new-interviews@mechlin.com'
    },
    secrets: {
      clientSecret: MASKED_VALUE // submitted masked value or empty
    }
  });

  const preservedRow = f.db.prepare('SELECT encrypted_secrets_json FROM integration_configs WHERE id = ?').get('microsoft_calendar');
  const preservedParsed = JSON.parse(preservedRow.encrypted_secrets_json);
  assert.equal(decryptSecret(preservedParsed.clientSecret), liveSecret, 'Secret was accidentally erased or corrupted on edit!');

  // 5. Explicit removal: removeSecrets = ['clientSecret']
  await call(f, f.admin, 'PUT', 'admin/integrations/microsoft_calendar', {
    enabled: false,
    config: {
      tenantId: '00000000-0000-0000-0000-000000000001',
      clientId: '00000000-0000-0000-0000-000000000002',
      organizerEmail: 'new-interviews@mechlin.com'
    },
    removeSecrets: ['clientSecret']
  });

  const clearedRow = f.db.prepare('SELECT encrypted_secrets_json FROM integration_configs WHERE id = ?').get('microsoft_calendar');
  const clearedParsed = JSON.parse(clearedRow.encrypted_secrets_json);
  assert.equal(clearedParsed.clientSecret, undefined, 'Secret was not removed when explicitly requested.');

  f.db.close();
});

test('Integrations Validation: Rejects invalid URLs, out-of-range bounds, and malformed emails', async () => {
  const f = fixture();
  f.config = testConfig();

  // Invalid email format for organizerEmail
  await assert.rejects(
    async () => call(f, f.admin, 'PUT', 'admin/integrations/microsoft_calendar', {
      config: { organizerEmail: 'not-an-email' }
    }),
    err => err.status === 400 && /email/i.test(err.message)
  );

  // Out of bounds timeout (< 1000ms or > 60000ms)
  await assert.rejects(
    async () => call(f, f.admin, 'PUT', 'admin/integrations/microsoft_calendar', {
      config: { timeoutMs: 500 }
    }),
    err => err.status === 400 && /timeout/i.test(err.message)
  );

  // Out of bounds max retries (< 0 or > 5)
  await assert.rejects(
    async () => call(f, f.admin, 'PUT', 'admin/integrations/microsoft_calendar', {
      config: { retryCount: 10 }
    }),
    err => err.status === 400 && /retries/i.test(err.message)
  );

  // Invalid URL for HRMS
  await assert.rejects(
    async () => call(f, f.admin, 'PUT', 'admin/integrations/hrms', {
      config: { baseUrl: 'ftp://insecure-hrms.local' }
    }),
    err => err.status === 400 && /http/i.test(err.message)
  );

  // Activation blocked when required fields are missing
  await assert.rejects(
    async () => call(f, f.admin, 'POST', 'admin/integrations/hrms/toggle', { enabled: true }),
    err => err.status === 400 && /missing/i.test(err.message)
  );

  f.db.close();
});

test('Integrations Safe Connection Testing: Non-destructive tests verify connections without creating business records', async () => {
  const f = fixture();
  f.config = testConfig();

  // Mock transport for external provider tests
  const mockTransport = async (url, opts = {}) => {
    const urlStr = String(url);

    // Microsoft Token acquisition
    if (urlStr.includes('login.microsoftonline.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'mock-graph-token', expires_in: 3600 })
      };
    }
    // Microsoft Graph check
    if (urlStr.includes('graph.microsoft.com/v1.0/organization')) {
      return {
        ok: true,
        status: 200,
        text: async () => '{"value":[]}'
      };
    }
    // Resend API keys check
    if (urlStr.includes('api.resend.com/api-keys')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      };
    }
    // AI provider ping
    if (urlStr.includes('api.openai.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'pong' } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
        })
      };
    }
    // HRMS Health ping
    if (urlStr.includes('/health')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'healthy', version: '1.2.0' })
      };
    }

    return { ok: false, status: 404, text: async () => 'Not found' };
  };

  f.config.transport = mockTransport;

  // 1. Microsoft Calendar Test
  const calTest = await call(f, f.admin, 'POST', 'admin/integrations/microsoft_calendar/test', {
    config: {
      tenantId: '11111111-1111-1111-1111-111111111111',
      clientId: '22222222-2222-2222-2222-222222222222',
      organizerEmail: 'interviews@mechlin.com'
    },
    secrets: {
      clientSecret: 'mock-azure-secret'
    }
  }, null, { transport: mockTransport });

  assert.equal(calTest.ok, true);
  assert.equal(calTest.status, 'connected');
  assert.ok(calTest.message.includes('authenticated with Microsoft Graph'));

  // Verify interview table was untouched (0 meetings created)
  const interviewCount = f.db.prepare('SELECT count(*) as c FROM interviews').get().c;
  assert.equal(interviewCount, 0, 'Connection test must not create meetings!');

  // 2. Email Communication Test
  const emailTest = await call(f, f.admin, 'POST', 'admin/integrations/email_communication/test', {
    config: {
      fromEmail: 'careers@mechlin.com',
      fromName: 'Mechlin Careers'
    },
    secrets: {
      apiKey: 're_mock_api_key'
    }
  }, null, { transport: mockTransport });

  assert.equal(emailTest.ok, true);
  assert.equal(emailTest.status, 'connected');
  assert.ok(emailTest.message.includes('Resend API connection successful'));

  // Verify candidate communications table was untouched (0 emails logged)
  const commsCount = f.db.prepare('SELECT count(*) as c FROM candidate_communications').get().c;
  assert.equal(commsCount, 0, 'Connection test must not send candidate emails!');

  // 3. Multi-AI Test
  const aiTest = await call(f, f.admin, 'POST', 'admin/integrations/multi_ai/test', {
    config: {
      defaultProvider: 'openai',
      openaiModel: 'gpt-4o-mini'
    },
    secrets: {
      openaiApiKey: 'sk-mock-key'
    }
  }, null, { transport: mockTransport });

  assert.equal(aiTest.ok, true);
  assert.equal(aiTest.status, 'connected');
  assert.ok(aiTest.message.includes('OPENAI'));

  // 4. In-house Signatures Test
  const sigTest = await call(f, f.admin, 'POST', 'admin/integrations/signature/test', {});
  assert.equal(sigTest.ok, true);
  assert.equal(sigTest.status, 'connected');

  // 5. In-house Fraud Review Test
  const fraudTest = await call(f, f.admin, 'POST', 'admin/integrations/fraud_review/test', {});
  assert.equal(fraudTest.ok, true);
  assert.equal(fraudTest.status, 'connected');

  // 6. HRMS Test
  const hrmsTest = await call(f, f.admin, 'POST', 'admin/integrations/hrms/test', {
    config: {
      baseUrl: 'https://hrms.corp.mechlin.com/api/v1'
    },
    secrets: {
      apiKey: 'hrms-token-123'
    }
  }, null, { transport: mockTransport });

  assert.equal(hrmsTest.ok, true);
  assert.equal(hrmsTest.status, 'connected');
  assert.ok(hrmsTest.message.includes('HRMS API endpoint verified'));

  f.db.close();
});

test('HRMS Adapter: Outbound handoff dispatches HTTP with authorization and enforces security policies', async () => {
  // 1. Unconfigured contract test
  const unconfiguredAdapter = new HrmsAdapter();
  await assert.rejects(
    async () => unconfiguredAdapter.handoff({ hireId: 'hire_123' }),
    err => err.code === 'ADAPTER_NOT_CONFIGURED',
    'Unconfigured HRMS adapter must reject with ADAPTER_NOT_CONFIGURED'
  );

  // 2. Configured handoff with mock transport
  let capturedRequest = null;
  const mockTransport = async (url, opts) => {
    capturedRequest = { url, ...opts };
    return {
      ok: true,
      status: 201,
      json: async () => ({ id: 'emp_98765', status: 'created' })
    };
  };

  const adapter = new HrmsAdapter({
    baseUrl: 'https://hrms.corp.mechlin.com/api/v1',
    resourcePath: '/employees/handoff',
    authType: 'bearer',
    apiKey: 'secret_token_bearer_xyz',
    transport: mockTransport
  });

  const result = await adapter.handoff({
    hireId: 'app_hire_555',
    approvedFields: {
      fullName: 'Avery Chen',
      jobTitle: 'Senior Software Engineer',
      salary: 135000,
      currency: 'USD'
    },
    idempotencyKey: 'idemp_key_111'
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'accepted');
  assert.equal(result.providerReference, 'emp_98765');

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.url, 'https://hrms.corp.mechlin.com/api/v1/employees/handoff');
  assert.equal(capturedRequest.method, 'POST');
  assert.equal(capturedRequest.headers['Authorization'], 'Bearer secret_token_bearer_xyz');
  assert.equal(capturedRequest.headers['Idempotency-Key'], 'idemp_key_111');

  const parsedBody = JSON.parse(capturedRequest.body);
  assert.equal(parsedBody.hireId, 'app_hire_555');
  assert.equal(parsedBody.approvedFields.fullName, 'Avery Chen');

  // 3. SSRF Protection: rejects unsafe protocols
  assert.throws(
    () => validateSafeUrl('ftp://internal-server.local', { label: 'HRMS' }),
    err => err.status === 400
  );
});

test('Configuration Precedence: Database-persisted configuration overrides environment variables when enabled', async () => {
  const f = fixture();
  f.config = testConfig();

  // Set initial env var
  process.env.RESEND_FROM_EMAIL = 'env-sender@mechlin.com';
  process.env.RESEND_API_KEY = 're_env_key';

  // 1. Initial effective configuration reads from environment
  const initial = getEffectiveIntegrationConfig(f.db, 'email_communication');
  assert.equal(initial.source, 'environment');
  assert.equal(initial.config.fromEmail, 'env-sender@mechlin.com');

  // 2. Admin saves DB configuration with a different sender
  await call(f, f.admin, 'PUT', 'admin/integrations/email_communication', {
    enabled: true,
    config: {
      provider: 'resend',
      fromEmail: 'db-custom-sender@mechlin.com',
      fromName: 'DB Verified Sender'
    },
    secrets: {
      apiKey: 're_db_custom_key'
    }
  });

  // 3. Database configuration now takes precedence
  const updated = getEffectiveIntegrationConfig(f.db, 'email_communication');
  assert.equal(updated.source, 'database');
  assert.equal(updated.config.fromEmail, 'db-custom-sender@mechlin.com');
  assert.equal(updated.secrets.apiKey, 're_db_custom_key');

  // 4. If admin disables the integration, fallback resumes
  await call(f, f.admin, 'POST', 'admin/integrations/email_communication/toggle', { enabled: false });

  const toggled = getEffectiveIntegrationConfig(f.db, 'email_communication');
  assert.equal(toggled.enabled, false);

  f.db.close();
});
