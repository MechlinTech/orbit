import { audit, id, now, transaction } from './db.js';
import {
  HttpError, isSystemRolePermissionsEditable, legacyCapabilitiesForPermissions,
  permissionById, permissionIds, roleScopes, text
} from './policy.js';

const uniquePermissions = values => {
  if (!Array.isArray(values)) throw new HttpError(400, 'Permissions must be a list.');
  const result = [...new Set(values.map(value => {
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Permission identifiers must be non-empty text.');
    return value.trim();
  }))];
  for (const permission of result) {
    if (!Object.hasOwn(permissionById, permission)) throw new HttpError(400, `Unknown permission: ${permission}`);
    if (!permissionById[permission].assignable) throw new HttpError(400, `Permission ${permission} cannot be assigned.`);
  }
  return result;
};

const roleName = (value, optional = false) => text(value, 'Role name', 80, optional);
const roleDescription = value => text(value ?? '', 'Description', 500, true);

export function roleByName(db, name) {
  if (!name) return null;
  return db.prepare('SELECT * FROM rbac_roles WHERE name=?').get(name) || null;
}

export function roleForUser(db, user) {
  if (!user) return null;
  if (user.role_id) {
    const byId = db.prepare('SELECT * FROM rbac_roles WHERE id=?').get(user.role_id);
    if (byId) return byId;
  }
  return roleByName(db, user.role);
}

export function permissionsForRole(db, roleId) {
  return db.prepare('SELECT permission FROM rbac_role_permissions WHERE role_id=? ORDER BY permission')
    .all(roleId).map(row => row.permission);
}

/**
 * Attach the effective authorization context to the request user. The
 * properties are non-enumerable so they never leak through JSON responses.
 */
export function hydrateUser(db, user) {
  if (!user) return null;
  const role = roleForUser(db, user);
  const grants = role && !role.archived_at ? permissionsForRole(db, role.id) : [];
  // Legacy capabilities are derived from the persisted grants even for built-in
  // roles. This keeps removals authoritative when a system role is customized.
  const legacy = legacyCapabilitiesForPermissions(grants);
  Object.defineProperties(user, {
    _role: { value: role, writable: true, configurable: true, enumerable: false },
    _grants: { value: new Set(grants), writable: true, configurable: true, enumerable: false },
    _legacy: { value: new Set(legacy), writable: true, configurable: true, enumerable: false },
    _scope: { value: role?.scope || 'none', writable: true, configurable: true, enumerable: false }
  });
  return user;
}

export function roleView(db, role, { includePermissions = true } = {}) {
  if (!role) return null;
  const assignedUsers = db.prepare('SELECT count(*) n FROM users WHERE role_id=? OR (role_id IS NULL AND role=?)').get(role.id, role.name).n;
  const permissions = includePermissions ? permissionsForRole(db, role.id) : undefined;
  return {
    ...role,
    is_system: Boolean(role.is_system),
    archived: Boolean(role.archived_at),
    permissions_editable: !role.is_system || isSystemRolePermissionsEditable(role),
    permissions_customized: Boolean(role.permissions_customized),
    assigned_users: assignedUsers,
    permission_count: permissions ? permissions.length : db.prepare('SELECT count(*) n FROM rbac_role_permissions WHERE role_id=?').get(role.id).n,
    ...(permissions ? { permissions } : {})
  };
}

export function listRoles(db, { includeArchived = false } = {}) {
  const rows = db.prepare(`SELECT * FROM rbac_roles ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY is_system DESC, name COLLATE NOCASE`).all();
  return rows.map(row => roleView(db, row));
}

export function accessSummary(db) {
  const roles = listRoles(db, { includeArchived: true });
  const users = db.prepare('SELECT status,role_id,role FROM users').all();
  const activeRoles = roles.filter(role => !role.archived);
  const customRoles = activeRoles.filter(role => !role.is_system);
  const elevated = activeRoles.filter(role => role.permissions.some(permission => permissionById[permission]?.sensitive));
  const recentChanges = db.prepare(`SELECT id,actor,event,target,detail,at FROM audit
    WHERE event LIKE 'role.%' OR event LIKE 'admin.user_%' OR event LIKE 'admin.updated'
    ORDER BY id DESC LIMIT 8`).all().map(row => ({ ...row, detail: safeDetail(row.detail) }));
  const missingRole = users.filter(user => !roles.some(role => role.id === user.role_id || role.name === user.role) && user.status === 'active').length;
  return {
    active_roles: activeRoles.length,
    custom_roles: customRoles.length,
    assignments: users.filter(user => user.status === 'active').length,
    elevated_roles: elevated.length,
    unassigned_users: missingRole,
    recent_changes: recentChanges
  };
}

function safeDetail(value) {
  try {
    const detail = JSON.parse(value || '{}');
    const blocked = /secret|token|password|credential|api[_-]?key/i;
    const clean = {};
    for (const [key, entry] of Object.entries(detail)) {
      if (blocked.test(key)) continue;
      clean[key] = entry;
    }
    return clean;
  } catch {
    return {};
  }
}

function assertCanGrant(actor, permissions) {
  if (actor.role === 'System Admin') return;
  const own = actor._grants instanceof Set ? actor._grants : new Set();
  const beyond = permissions.filter(permission => !own.has(permission));
  if (beyond.length) throw new HttpError(403, `You cannot grant permissions beyond your own authority: ${beyond.slice(0, 5).join(', ')}`);
}

function assertCanUseScope(actor, scope) {
  if (scope === 'organization' && actor.role !== 'System Admin') {
    throw new HttpError(403, 'Only a System Admin can create or assign organization-wide roles.');
  }
}

export function validateRoleInput(body = {}, { partial = false } = {}) {
  const output = {};
  if (!partial || body.name !== undefined) output.name = roleName(body.name);
  if (!partial || body.description !== undefined) output.description = roleDescription(body.description);
  if (!partial || body.scope !== undefined) {
    if (!roleScopes.includes(body.scope)) throw new HttpError(400, 'Select a supported record scope.');
    output.scope = body.scope;
  }
  if (!partial || body.permissions !== undefined) output.permissions = uniquePermissions(body.permissions || []);
  return output;
}

export function createRole(db, actor, body = {}) {
  const input = validateRoleInput(body);
  if (roleByName(db, input.name)) throw new HttpError(409, 'A role with this name already exists.');
  assertCanGrant(actor, input.permissions);
  assertCanUseScope(actor, input.scope);
  const roleId = id(), timestamp = now();
  return transaction(db, () => {
    db.prepare(`INSERT INTO rbac_roles(id,name,description,scope,is_system,version,created_by,created_at,updated_at)
      VALUES(?,?,?,?,0,1,?,?,?)`).run(roleId, input.name, input.description, input.scope, actor.id, timestamp, timestamp);
    const insert = db.prepare('INSERT INTO rbac_role_permissions(role_id,permission) VALUES(?,?)');
    for (const permission of input.permissions) insert.run(roleId, permission);
    audit(db, actor.id, 'role.created', roleId, { name: input.name, scope: input.scope, permissions: input.permissions });
    return roleView(db, db.prepare('SELECT * FROM rbac_roles WHERE id=?').get(roleId));
  });
}

export function updateRole(db, actor, roleId, body = {}) {
  const role = db.prepare('SELECT * FROM rbac_roles WHERE id=?').get(roleId);
  if (!role) throw new HttpError(404, 'Role not found.');
  if (role.is_system && !isSystemRolePermissionsEditable(role)) {
    throw new HttpError(403, 'This protected system role cannot be changed.');
  }
  if (role.archived_at) throw new HttpError(409, 'Archived roles cannot be edited.');
  if (body.version === undefined) throw new HttpError(400, 'A role version is required. Reload the role and try again.');
  if (Number(body.version) !== Number(role.version)) {
    throw new HttpError(409, 'This role changed since you opened it. Reload and try again.');
  }
  if (role.is_system && (
    (body.name !== undefined && roleName(body.name) !== role.name) ||
    (body.description !== undefined && roleDescription(body.description) !== role.description) ||
    (body.scope !== undefined && body.scope !== role.scope)
  )) {
    throw new HttpError(400, 'System role names, descriptions and record scopes are protected. Only permissions can be changed.');
  }
  const previous = permissionsForRole(db, role.id);
  const input = validateRoleInput({
    name: body.name !== undefined ? body.name : role.name,
    description: body.description !== undefined ? body.description : role.description,
    scope: body.scope !== undefined ? body.scope : role.scope,
    permissions: body.permissions !== undefined ? body.permissions : previous
  });
  if (body.name !== undefined) {
    const duplicate = db.prepare('SELECT id FROM rbac_roles WHERE name=? AND id!=?').get(input.name, role.id);
    if (duplicate) throw new HttpError(409, 'A role with this name already exists.');
  }
  assertCanGrant(actor, input.permissions);
  assertCanUseScope(actor, input.scope);
  const timestamp = now();
  return transaction(db, () => {
    const updated = role.is_system
      ? db.prepare('UPDATE rbac_roles SET version=version+1,updated_at=?,permissions_customized=1 WHERE id=? AND version=?')
        .run(timestamp, role.id, role.version)
      : db.prepare('UPDATE rbac_roles SET name=?,description=?,scope=?,version=version+1,updated_at=? WHERE id=? AND version=?')
        .run(input.name, input.description, input.scope, timestamp, role.id, role.version);
    if (updated.changes !== 1) throw new HttpError(409, 'This role changed since you opened it. Reload and try again.');
    if (!role.is_system && input.name !== role.name) db.prepare('UPDATE users SET role=? WHERE role_id=?').run(input.name, role.id);
    db.prepare('DELETE FROM rbac_role_permissions WHERE role_id=?').run(role.id);
    const insert = db.prepare('INSERT INTO rbac_role_permissions(role_id,permission) VALUES(?,?)');
    for (const permission of input.permissions) insert.run(role.id, permission);
    audit(db, actor.id, 'role.updated', role.id, {
      name: input.name,
      previous_name: role.name,
      scope: input.scope,
      system_role: Boolean(role.is_system),
      added: input.permissions.filter(permission => !previous.includes(permission)),
      removed: previous.filter(permission => !input.permissions.includes(permission))
    });
    return roleView(db, db.prepare('SELECT * FROM rbac_roles WHERE id=?').get(role.id));
  });
}

export function archiveRole(db, actor, roleId, body = {}) {
  const role = db.prepare('SELECT * FROM rbac_roles WHERE id=?').get(roleId);
  if (!role) throw new HttpError(404, 'Role not found.');
  if (role.is_system) throw new HttpError(403, 'Protected system roles cannot be archived.');
  if (role.archived_at) throw new HttpError(409, 'Role is already archived.');
  const assigned = db.prepare('SELECT count(*) n FROM users WHERE role_id=? OR (role_id IS NULL AND role=?)').get(role.id, role.name).n;
  if (assigned) throw new HttpError(409, `This role is assigned to ${assigned} user(s). Reassign them before archiving.`);
  return transaction(db, () => {
    db.prepare('UPDATE rbac_roles SET archived_at=?,version=version+1,updated_at=? WHERE id=?').run(now(), now(), role.id);
    audit(db, actor.id, 'role.archived', role.id, { name: role.name, reason: String(body.reason || '').slice(0, 500) });
    return roleView(db, db.prepare('SELECT * FROM rbac_roles WHERE id=?').get(role.id));
  });
}

export function duplicateRole(db, actor, roleId, body = {}) {
  const source = db.prepare('SELECT * FROM rbac_roles WHERE id=?').get(roleId);
  if (!source) throw new HttpError(404, 'Role not found.');
  const permissions = permissionsForRole(db, source.id);
  const own = actor._grants instanceof Set ? actor._grants : new Set();
  const grantable = actor.role === 'System Admin' ? permissions : permissions.filter(permission => own.has(permission));
  const omitted = permissions.filter(permission => !grantable.includes(permission));
  let name = text(body.name || `${source.name} copy`, 'Role name', 80);
  if (roleByName(db, name)) name = `${name} ${Date.now().toString().slice(-4)}`;
  return {
    ...createRole(db, actor, {
      name,
      description: text(body.description || source.description, 'Description', 500, true),
      scope: body.scope || source.scope,
      permissions: grantable
    }),
    omitted_permissions: omitted
  };
}

export function resolveRoleForAssignment(db, actor, name) {
  const role = roleByName(db, name);
  if (!role || role.archived_at) throw new HttpError(400, 'Select a supported role.');
  if (['Agency','Agency Admin','Agency Recruiter'].includes(role.name)) throw new HttpError(400, 'Agency access must be managed through the agency portal.');
  if (role.is_system && actor.role !== 'System Admin') throw new HttpError(403, 'Only a System Admin can assign protected system roles.');
  assertCanUseScope(actor, role.scope);
  assertCanGrant(actor, permissionsForRole(db, role.id));
  return role;
}

export function assignmentImpact(db, role) {
  const permissions = permissionsForRole(db, role.id);
  return {
    role: role.name,
    scope: role.scope,
    permission_count: permissions.length,
    sensitive_permissions: permissions.filter(permission => permissionById[permission]?.sensitive),
    assigned_users: db.prepare('SELECT count(*) n FROM users WHERE role_id=? OR (role_id IS NULL AND role=?)').get(role.id, role.name).n
  };
}

export function validateKnownPermissionList(list) {
  return uniquePermissions(list);
}

export { permissionIds };
