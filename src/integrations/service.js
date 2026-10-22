import { HttpError, requirePermission as permit } from '../policy.js';
import {
  listIntegrationSummaries,
  getIntegrationDetails,
  saveIntegrationConfig,
  toggleIntegrationStatus,
  recordTestResult
} from './storage.js';
import { testIntegrationConnection } from './testing.js';
import { getRegistryItem } from './registry.js';

/**
 * Enforces strict System Admin authorization for all integration management functions.
 */
function requireAdmin(user) {
  if (!user || user.role !== 'System Admin' || user.status !== 'active') {
    throw new HttpError(403, 'System Admin access required to manage integrations.');
  }
}

export function listIntegrationsForAdmin(db, user) {
  requireAdmin(user);
  return listIntegrationSummaries(db);
}

export function getIntegrationForAdmin(db, user, id) {
  requireAdmin(user);
  return getIntegrationDetails(db, id);
}

export function updateIntegrationForAdmin(db, user, id, payload = {}) {
  requireAdmin(user);
  getRegistryItem(id); // ensure exists

  return saveIntegrationConfig(db, id, {
    enabled: Boolean(payload.enabled),
    config: payload.config || {},
    secrets: payload.secrets || {},
    removeSecrets: Array.isArray(payload.removeSecrets) ? payload.removeSecrets : []
  }, user.id);
}

export async function testIntegrationForAdmin(db, user, id, payload = {}, transport = fetch) {
  requireAdmin(user);
  getRegistryItem(id); // ensure exists

  const result = await testIntegrationConnection(db, id, {
    proposedConfig: payload.config,
    proposedSecrets: payload.secrets,
    transport
  });

  // Record safe test diagnostic in DB
  recordTestResult(db, id, {
    ok: result.ok,
    status: result.status,
    message: result.message,
    error: result.ok ? null : result.message
  }, user.id);

  return result;
}

export function toggleIntegrationForAdmin(db, user, id, payload = {}) {
  requireAdmin(user);
  const enabled = Boolean(payload.enabled);
  return toggleIntegrationStatus(db, id, enabled, user.id);
}
