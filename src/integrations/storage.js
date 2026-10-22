import { now, audit } from '../db.js';
import { HttpError } from '../policy.js';
import { encryptSecret, decryptSecret, isMasked, maskSecret, MASKED_VALUE } from './crypto.js';
import { INTEGRATION_REGISTRY, getRegistryItem } from './registry.js';

export function ensureIntegrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_configs (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      encrypted_secrets_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'unconfigured',
      last_test_at TEXT,
      last_test_status TEXT,
      last_error TEXT,
      updated_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_integration_configs_category ON integration_configs(category);
  `);
}

/**
 * Returns the raw record for an integration from the database.
 */
export function getRawIntegrationRecord(db, id) {
  ensureIntegrationTable(db);
  const row = db.prepare('SELECT * FROM integration_configs WHERE id = ?').get(id);
  if (!row) return null;
  let config = {};
  let encryptedSecrets = {};
  try { config = JSON.parse(row.config_json || '{}'); } catch {}
  try { encryptedSecrets = JSON.parse(row.encrypted_secrets_json || '{}'); } catch {}
  return {
    ...row,
    enabled: Boolean(row.enabled),
    config,
    encryptedSecrets
  };
}

/**
 * Returns the decrypted secrets dictionary for an integration.
 */
export function getDecryptedSecrets(encryptedSecrets = {}) {
  const decrypted = {};
  for (const [key, ciphertext] of Object.entries(encryptedSecrets)) {
    if (ciphertext) {
      try {
        decrypted[key] = decryptSecret(ciphertext);
      } catch {
        decrypted[key] = '';
      }
    }
  }
  return decrypted;
}

/**
 * Returns the effective runtime configuration for an integration,
 * honoring the precedence model:
 * 1. Database-managed configuration (when present and enabled).
 * 2. Environment variable fallback (when DB is unconfigured or partially defined).
 */
export function getEffectiveIntegrationConfig(db, id, env = process.env) {
  const item = getRegistryItem(id);
  const record = getRawIntegrationRecord(db, id);

  const envValues = {};
  if (item.envFallback) {
    for (const [k, fn] of Object.entries(item.envFallback)) {
      envValues[k] = fn();
    }
  }

  // If DB record exists
  if (record) {
    const decryptedSecrets = getDecryptedSecrets(record.encryptedSecrets);
    const mergedConfig = { ...record.config };
    const mergedSecrets = { ...decryptedSecrets };

    // Check completeness
    let requiredFieldsMissing = false;
    for (const f of item.fields) {
      if (f.required) {
        const val = f.secret ? mergedSecrets[f.key] : mergedConfig[f.key];
        if (!val && !envValues[f.key]) {
          requiredFieldsMissing = true;
        } else if (!val && envValues[f.key]) {
          if (f.secret) mergedSecrets[f.key] = envValues[f.key];
          else mergedConfig[f.key] = envValues[f.key];
        }
      }
    }

    const isConfigured = !requiredFieldsMissing;
    return {
      id,
      enabled: record.enabled,
      config: mergedConfig,
      secrets: mergedSecrets,
      isConfigured,
      source: record.enabled ? 'database' : 'disabled',
      rawRecord: record
    };
  }

  // Fallback to environment variables
  const envConfig = {};
  const envSecrets = {};
  let envHasRequired = true;

  for (const f of item.fields) {
    const val = envValues[f.key] || '';
    if (f.secret) {
      envSecrets[f.key] = val;
    } else {
      envConfig[f.key] = val || f.default;
    }
    if (f.required && !val) {
      envHasRequired = false;
    }
  }

  // For in-house integrations, they are enabled and configured by default
  const isInHouse = !item.isExternal;
  const isConfigured = isInHouse || envHasRequired;

  return {
    id,
    enabled: isInHouse || isConfigured,
    config: envConfig,
    secrets: envSecrets,
    isConfigured,
    source: isConfigured ? 'environment' : 'unconfigured',
    rawRecord: null
  };
}

/**
 * Returns a summary of all integrations for the System Admin view.
 */
export function listIntegrationSummaries(db, env = process.env) {
  ensureIntegrationTable(db);
  const rows = db.prepare('SELECT * FROM integration_configs').all();
  const dbMap = new Map(rows.map(r => [r.id, r]));

  return INTEGRATION_REGISTRY.map(item => {
    const row = dbMap.get(item.id);
    let parsedConfig = {};
    let parsedSecrets = {};
    if (row) {
      try { parsedConfig = JSON.parse(row.config_json || '{}'); } catch {}
      try { parsedSecrets = JSON.parse(row.encrypted_secrets_json || '{}'); } catch {}
    }

    const effective = getEffectiveIntegrationConfig(db, item.id, env);

    // Compute configured status
    let status = 'unconfigured';
    if (row) {
      if (!row.enabled) {
        status = 'disabled';
      } else if (row.status === 'connected') {
        status = 'connected';
      } else if (row.status === 'failed') {
        status = 'failed';
      } else if (effective.isConfigured) {
        status = 'configured';
      }
    } else if (effective.isConfigured) {
      status = item.isExternal ? 'configured' : 'connected';
    }

    return {
      id: item.id,
      category: item.category,
      name: item.name,
      description: item.description,
      isExternal: item.isExternal,
      enabled: row ? Boolean(row.enabled) : effective.enabled,
      configured: effective.isConfigured,
      status,
      lastTestAt: row?.last_test_at || null,
      lastTestStatus: row?.last_test_status || null,
      lastError: row?.last_error || null,
      updatedAt: row?.updated_at || null,
      effectiveSource: effective.source,
      capabilities: item.capabilities,
      fallbackPolicy: item.fallbackPolicy
    };
  });
}

/**
 * Returns the detailed edit view for an integration, with all secrets masked.
 */
export function getIntegrationDetails(db, id, env = process.env) {
  const item = getRegistryItem(id);
  const record = getRawIntegrationRecord(db, id);
  const effective = getEffectiveIntegrationConfig(db, item.id, env);

  const fieldsWithValues = item.fields.map(field => {
    let rawVal;
    let hasSavedSecret = false;

    if (field.secret) {
      hasSavedSecret = Boolean(record?.encryptedSecrets?.[field.key] || effective.secrets?.[field.key]);
      rawVal = hasSavedSecret ? MASKED_VALUE : '';
    } else {
      rawVal = record?.config?.[field.key] ?? effective.config?.[field.key] ?? field.default ?? '';
    }

    return {
      key: field.key,
      label: field.label,
      type: field.type,
      secret: Boolean(field.secret),
      required: Boolean(field.required),
      default: field.default,
      placeholder: field.placeholder,
      helpText: field.helpText,
      options: field.options,
      value: rawVal,
      hasSavedSecret
    };
  });

  return {
    id: item.id,
    category: item.category,
    name: item.name,
    description: item.description,
    isExternal: item.isExternal,
    enabled: record ? Boolean(record.enabled) : effective.enabled,
    configured: effective.isConfigured,
    status: record?.status || (effective.isConfigured ? 'configured' : 'unconfigured'),
    lastTestAt: record?.last_test_at || null,
    lastTestStatus: record?.last_test_status || null,
    lastError: record?.last_error || null,
    effectiveSource: effective.source,
    updatedAt: record?.updated_at || null,
    capabilities: item.capabilities,
    fallbackPolicy: item.fallbackPolicy,
    fields: fieldsWithValues
  };
}

/**
 * Persists an integration configuration with encrypted secrets.
 */
export function saveIntegrationConfig(db, id, { enabled, config = {}, secrets = {}, removeSecrets = [] } = {}, actor = 'system') {
  const item = getRegistryItem(id);
  const existing = getRawIntegrationRecord(db, id);
  const validatedConfig = {};
  const currentEncryptedSecrets = existing ? { ...existing.encryptedSecrets } : {};

  // Validate non-secret fields
  for (const field of item.fields) {
    if (!field.secret) {
      let val = config[field.key];
      if (val === undefined || val === null || val === '') {
        if (field.required && enabled) {
          throw new HttpError(400, `Field "${field.label}" is required.`);
        }
        val = field.default !== undefined ? field.default : '';
      }
      if (field.validate && val !== '') {
        val = field.validate(val, config);
      }
      validatedConfig[field.key] = val;
    }
  }

  // Handle secrets
  for (const secretKey of removeSecrets) {
    delete currentEncryptedSecrets[secretKey];
  }

  for (const field of item.fields) {
    if (field.secret) {
      const incomingVal = secrets[field.key];
      // If a new, non-empty, unmasked string was submitted -> encrypt and save
      if (incomingVal && !isMasked(incomingVal) && String(incomingVal).trim()) {
        currentEncryptedSecrets[field.key] = encryptSecret(String(incomingVal).trim());
      } else if (!currentEncryptedSecrets[field.key] && field.required && enabled) {
        // Missing required secret on activation
        throw new HttpError(400, `Secret "${field.label}" is required to activate this integration.`);
      }
      // If incomingVal is masked or empty, preserve currentEncryptedSecrets[field.key]
    }
  }

  const nowStr = now();
  const configJson = JSON.stringify(validatedConfig);
  const secretsJson = JSON.stringify(currentEncryptedSecrets);
  const isEnabledInt = enabled ? 1 : 0;

  if (existing) {
    db.prepare(`
      UPDATE integration_configs
      SET enabled = ?, config_json = ?, encrypted_secrets_json = ?, updated_by = ?, updated_at = ?
      WHERE id = ?
    `).run(isEnabledInt, configJson, secretsJson, actor, nowStr, id);
  } else {
    db.prepare(`
      INSERT INTO integration_configs(id, category, name, enabled, config_json, encrypted_secrets_json, status, updated_by, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, 'unconfigured', ?, ?, ?)
    `).run(id, item.category, item.name, isEnabledInt, configJson, secretsJson, actor, nowStr, nowStr);
  }

  audit(db, actor, 'integration.configured', id, {
    enabled: Boolean(enabled),
    fieldsUpdated: Object.keys(config),
    secretsUpdated: Object.keys(secrets).filter(k => secrets[k] && !isMasked(secrets[k]))
  });

  return getIntegrationDetails(db, id);
}

/**
 * Toggles an integration's enabled state.
 */
export function toggleIntegrationStatus(db, id, enabled, actor = 'system') {
  const item = getRegistryItem(id);
  ensureIntegrationTable(db);
  const nowStr = now();
  const existing = getRawIntegrationRecord(db, id);

  if (enabled) {
    // Validate that it has minimal requirements before turning on
    const effective = getEffectiveIntegrationConfig(db, id);
    if (!effective.isConfigured) {
      throw new HttpError(400, `Cannot activate "${item.name}": required configuration fields or secrets are missing.`);
    }
  }

  if (existing) {
    db.prepare('UPDATE integration_configs SET enabled = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, actor, nowStr, id);
  } else {
    // Create new record with defaults
    db.prepare(`
      INSERT INTO integration_configs(id, category, name, enabled, config_json, encrypted_secrets_json, status, updated_by, created_at, updated_at)
      VALUES(?, ?, ?, ?, '{}', '{}', 'configured', ?, ?, ?)
    `).run(id, item.category, item.name, enabled ? 1 : 0, actor, nowStr, nowStr);
  }

  audit(db, actor, enabled ? 'integration.activated' : 'integration.deactivated', id, { enabled });
  return { ok: true, id, enabled: Boolean(enabled) };
}

/**
 * Updates diagnostic test results after a connection test run.
 */
export function recordTestResult(db, id, { ok, status, message, error }, actor = 'system') {
  ensureIntegrationTable(db);
  const nowStr = now();
  const row = db.prepare('SELECT id FROM integration_configs WHERE id = ?').get(id);
  const item = getRegistryItem(id);

  const testStatus = ok ? 'success' : 'failed';
  const overallStatus = ok ? 'connected' : 'failed';
  const lastError = error ? String(error).slice(0, 500) : null;

  if (row) {
    db.prepare(`
      UPDATE integration_configs
      SET status = ?, last_test_at = ?, last_test_status = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(overallStatus, nowStr, testStatus, lastError, nowStr, id);
  } else {
    db.prepare(`
      INSERT INTO integration_configs(id, category, name, enabled, config_json, encrypted_secrets_json, status, last_test_at, last_test_status, last_error, updated_by, created_at, updated_at)
      VALUES(?, ?, ?, 0, '{}', '{}', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, item.category, item.name, overallStatus, nowStr, testStatus, lastError, actor, nowStr, nowStr);
  }

  audit(db, actor, 'integration.tested', id, { ok, testStatus, message });
}
