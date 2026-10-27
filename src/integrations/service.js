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
 * Enforces integration permissions. System Admin retains access through the
 * legacy admin token for direct service calls; request routes use granular
 * permissions and are authoritative.
 */
function requireIntegrationAccess(user, ...permissions) {
  if (!user || user.status !== 'active') throw new HttpError(403, 'Integration access required.');
  permit(user, ...permissions, 'admin');
}

export function listIntegrationsForAdmin(db, user) {
  requireIntegrationAccess(user, 'integrations.read', 'integrations.configure', 'integrations.secrets.manage');
  return listIntegrationSummaries(db);
}

export function getIntegrationForAdmin(db, user, id) {
  requireIntegrationAccess(user, 'integrations.read', 'integrations.configure', 'integrations.secrets.manage');
  return getIntegrationDetails(db, id);
}

export function updateIntegrationForAdmin(db, user, id, payload = {}) {
  requireIntegrationAccess(user, 'integrations.configure');
  getRegistryItem(id); // ensure exists

  return saveIntegrationConfig(db, id, {
    enabled: Boolean(payload.enabled),
    config: payload.config || {},
    secrets: payload.secrets || {},
    removeSecrets: Array.isArray(payload.removeSecrets) ? payload.removeSecrets : []
  }, user.id);
}

export async function testIntegrationForAdmin(db, user, id, payload = {}, transport = fetch) {
  requireIntegrationAccess(user, 'integrations.configure');
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
  requireIntegrationAccess(user, 'integrations.configure');
  const enabled = Boolean(payload.enabled);
  return toggleIntegrationStatus(db, id, enabled, user.id);
}
