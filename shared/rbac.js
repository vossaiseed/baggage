/**
 * Departure v7 RBAC — the ONLY place permissions are decided.
 *
 *   can(user, permission, resource?)   -> boolean
 *   assertCan(user, permission, resource?) -> void | throws PermissionError
 *   scopeFilter(user, collection, rows)    -> rows the user may see
 *
 * Permissions are strings `resource:verb[:detail]`. A preset may hold
 * wildcards: `*`, `trip:*`, `bag:advance:*`.
 * Scope decides WHICH rows: own | area | warehouse | airport | all.
 * Anything not mapped for a scoped role is denied by default.
 */
import { ROLE, BAG_STATUSES, SIDE_STATUSES } from './constants.js';

export class PermissionError extends Error {
  /** @param {string} message @param {{ permission?: string, role?: string }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = 'PermissionError';
    this.code = 'FORBIDDEN';
    this.permission = info.permission;
    this.role = info.role;
  }
}

const adv = (...statuses) => statuses.map((s) => `bag:advance:${s}`);

/**
 * @typedef {{
 *  id: string, label: string, prefix: string, home: string, folder: string,
 *  scope: 'own'|'area'|'warehouse'|'airport'|'all', readOnly?: boolean,
 *  permissions: string[], manages: string[]
 * }} RolePreset
 */

/** @type {Record<string, RolePreset>} */
export const ROLE_PRESETS = Object.freeze({
  [ROLE.TRAVELER]: {
    id: ROLE.TRAVELER, label: 'Traveler', prefix: '', home: '/', folder: 'pilgrim', scope: 'own',
    permissions: [
      'traveler:read', 'traveler:edit_contact', 'nusuk:sync', 'assignment:read', 'assignment:book', 'assignment:reschedule',
      'bag:read', 'bag:create', 'flight:read', 'notification:read', 'support:create', 'tag:read',
    ],
    manages: [],
  },
  [ROLE.BACKEND]: {
    id: ROLE.BACKEND, label: 'Backend Team', prefix: 'BE', home: '/backend', folder: 'backend-team', scope: 'all',
    permissions: [
      'traveler:read', 'traveler:verify', 'traveler:fix', 'nusuk:sync', 'airline_file:import',
      'tag:read', 'tag:import', 'tag:assign', 'tag:release', 'tag:void', 'tag:issue_internal', 'tag:print_labels',
      'boarding_pass:verify', 'manifest:read', 'manifest:confirm', 'manifest:notify_ops',
      'flight:read', 'bag:read', 'exception:create', 'exception:read', 'residence:read', 'assignment:read',
      ...adv('Data Verified', 'Tag Assigned', 'Loaded on Aircraft'),
      'bag:rebook_retag',
    ],
    manages: [],
  },
  [ROLE.CHECKIN]: {
    id: ROLE.CHECKIN, label: 'Check-in Staff', prefix: 'CHK', home: '/staff', folder: 'checkin-staff', scope: 'area',
    permissions: [
      'traveler:read', 'assignment:read', 'assignment:update', 'residence:read', 'collectionSlot:read',
      'bag:read', 'bag:update', 'tag:read', 'tag:attach', 'tag:request_replacement', 'scan:record',
      'exception:create', 'exception:read', 'flight:read', 'handover:write',
      ...adv('Checked-in'),
    ],
    manages: [],
  },
  [ROLE.TRANSPORT_MANAGER]: {
    id: ROLE.TRANSPORT_MANAGER, label: 'Transport Manager', prefix: 'TM', home: '/transport', folder: 'transport', scope: 'all',
    permissions: [
      'trip:*', 'driver:*', 'truck:*', 'dispatch:assign', 'reroute:create', 'report:read', 'staff:manage',
      'flight:read', 'bag:read', 'assignment:read', 'exception:read', 'exception:create', 'collectionArea:read',
    ],
    manages: [ROLE.TRANSPORT_STAFF],
  },
  [ROLE.TRANSPORT_STAFF]: {
    id: ROLE.TRANSPORT_STAFF, label: 'Transport Staff', prefix: 'TS', home: '/transport/trips', folder: 'transport', scope: 'area',
    permissions: [
      'trip:read', 'trip:update', 'bag:read', 'flight:read', 'scan:record', 'exception:create', 'collectionArea:read',
      ...adv('Loaded to Collection Truck', 'In Transit to Airport'),
    ],
    manages: [],
  },
  [ROLE.WAREHOUSE_MANAGER]: {
    id: ROLE.WAREHOUSE_MANAGER, label: 'Warehouse Manager', prefix: 'WM', home: '/warehouse', folder: 'warehouse-staff', scope: 'warehouse',
    permissions: [
      'trip:read', 'trip:update', 'bag:read', 'bag:update', 'bag:hold', 'bag:return_to_traveler', 'bag:release_to_loading',
      'scan:record', 'exception:create', 'exception:read', 'flight:read', 'truck:request', 'handover:write',
      ...adv('Received at Warehouse', 'Screened', 'Loaded to Airport Truck'),
    ],
    manages: [],
  },
  [ROLE.AIRPORT_COORDINATOR]: {
    id: ROLE.AIRPORT_COORDINATOR, label: 'Airport Coordinator', prefix: 'APC', home: '/airport', folder: 'airport-coordinator', scope: 'airport',
    permissions: [
      'trip:read', 'trip:update', 'trip:accept', 'bag:read', 'bag:hold', 'seal:check', 'voucher:create', 'voucher:accept',
      'scan:record', 'exception:create', 'exception:read', 'flight:read', 'return_trip:request', 'handover:write',
      ...adv('Received at Airport', 'Handed to Airport Authority', 'SGS Voucher Accepted'),
    ],
    manages: [],
  },
  [ROLE.WINDOW_MONITOR]: {
    id: ROLE.WINDOW_MONITOR, label: 'Window Monitor', prefix: 'MON', home: '/monitor', folder: 'window-monitor', scope: 'all', readOnly: true,
    permissions: ['flight:read', 'bag:read', 'trip:read', 'exception:read', 'ops:notify', 'collectionArea:read'],
    manages: [],
  },
  [ROLE.OPS_MANAGER]: {
    id: ROLE.OPS_MANAGER, label: 'Operations Manager', prefix: 'OPS', home: '/ops', folder: 'operations-manager', scope: 'all',
    permissions: [
      'flight:*', 'staff:manage', 'collectionArea:*', 'collectionSlot:*', 'exception:*', 'report:read', 'demo:reset',
      'bag:read', 'trip:read', 'traveler:read', 'assignment:read', 'tag:read', 'audit:read', 'seal:release', 'handover:write',
      'notification:send',
    ],
    manages: [ROLE.CHECKIN, ROLE.WAREHOUSE_MANAGER, ROLE.BACKEND, ROLE.WINDOW_MONITOR],
  },
  [ROLE.SYSTEM_ADMIN]: {
    id: ROLE.SYSTEM_ADMIN, label: 'System Admin', prefix: 'ADM', home: '/admin', folder: 'system-admin', scope: 'all',
    permissions: [
      'staff:manage', 'integration:manage', 'airline_policy:manage', 'audit:read', 'demo:reset', 'bag:read', 'flight:read',
      'report:read',
    ],
    manages: [ROLE.SYSTEM_ADMIN, ROLE.OPS_MANAGER, ROLE.TRANSPORT_MANAGER],
  },
});

export const ROLE_IDS = Object.freeze(Object.keys(ROLE_PRESETS));

/** Employee-ID prefixes -> role (Traveler has none). */
export const EMPLOYEE_PREFIXES = Object.freeze(
  Object.fromEntries(Object.values(ROLE_PRESETS).filter((p) => p.prefix).map((p) => [p.prefix, p.id])),
);

/** @param {string} employeeId @returns {string|null} role id */
export function roleFromEmployeeId(employeeId) {
  const m = /^([A-Z]+)-\d+$/i.exec(String(employeeId || '').trim());
  return m ? (EMPLOYEE_PREFIXES[m[1].toUpperCase()] || null) : null;
}

/** permission resource prefix -> collection used for row-scope checks */
const PERM_COLLECTION = Object.freeze({
  bag: 'bags', assignment: 'collectionAssignments', trip: 'trips', traveler: 'travelers', tag: 'bagTags',
  residence: 'residences', collectionSlot: 'collectionSlots', collectionArea: 'collectionAreas', flight: 'flights',
  voucher: 'sgsVouchers',
});

/** Collections every non-"own" role may read in full (lookup data). */
const GLOBAL_READ = Object.freeze(['airlines', 'flights']);

/**
 * scope -> collection -> how a row is matched to the user.
 * `fields`: row fields (any match); `userKey`: user field it must equal;
 * `array`: row field holds an array of ids.
 * A list of rules means "any of these matches" — used where a row can belong to a user by more
 * than one route (an area's Transport Staff also run the airport trip assigned to them by name).
 */
const SCOPE_RULES = Object.freeze({
  own: {
    travelers: { fields: ['id'], userKey: 'traveler_id' },
    bags: { fields: ['traveler_id'], userKey: 'traveler_id' },
    collectionAssignments: { fields: ['traveler_id'], userKey: 'traveler_id' },
    bagTags: { fields: ['traveler_id'], userKey: 'traveler_id' },
    residences: { fields: ['traveler_ids'], userKey: 'traveler_id', array: true },
    flights: { fields: ['id'], userKey: 'flight_id' },
  },
  area: {
    collectionAssignments: { fields: ['collection_area_id'], userKey: 'area_id' },
    collectionSlots: { fields: ['collection_area_id'], userKey: 'area_id' },
    residences: { fields: ['collection_area_id'], userKey: 'area_id' },
    bags: [
      { fields: ['collection_area_id'], userKey: 'area_id' },
      // Bags loaded onto the airport truck this staff member is driving: the run starts at the
      // warehouse, so it has no collection area of its own.
      { fields: ['airport_trip_staff_id'], userKey: 'id' },
    ],
    bagTags: { fields: ['collection_area_id'], userKey: 'area_id' },
    travelers: { fields: ['collection_area_id'], userKey: 'area_id' },
    collectionAreas: { fields: ['id'], userKey: 'area_id' },
    trips: [
      { fields: ['area_from', 'area_to'], userKey: 'area_id' },
      { fields: ['staff_id'], userKey: 'id' },
    ],
    exceptions: { fields: ['area_id'], userKey: 'area_id' },
  },
  warehouse: {
    bags: { fields: ['warehouse_id'], userKey: 'warehouse_id' },
    trips: { fields: ['warehouse_id'], userKey: 'warehouse_id' },
    collectionAreas: { fields: ['warehouse_id'], userKey: 'warehouse_id' },
  },
  airport: {
    trips: { fields: ['airport_id'], userKey: 'airport_id' },
    bags: { fields: ['airport_id'], userKey: 'airport_id' },
    sgsVouchers: { fields: ['airport_id'], userKey: 'airport_id' },
  },
});

/** @param {string} role @returns {RolePreset|undefined} */
export function getPreset(role) { return ROLE_PRESETS[role]; }

/** @param {{status?:string}|null|undefined} user */
function isActive(user) { return !!user && user.status !== 'Disabled'; }

/** @param {string[]} grants @param {string} permission */
function granted(grants, permission) {
  if (grants.includes('*') || grants.includes(permission)) return true;
  const parts = permission.split(':');
  for (let i = parts.length - 1; i >= 1; i--) {
    if (grants.includes(`${parts.slice(0, i).join(':')}:*`)) return true;
  }
  return false;
}

/**
 * Row predicate for a user + collection, or null when the collection is not
 * visible at all for that user.
 * @returns {((row:object)=>boolean)|null}
 */
function scopePredicate(user, collection) {
  const preset = ROLE_PRESETS[user.role];
  if (!preset) return null;
  if (preset.scope === 'all') return () => true;
  const rule = SCOPE_RULES[preset.scope]?.[collection];
  if (rule) {
    const rules = (Array.isArray(rule) ? rule : [rule])
      .map((r) => ({ ...r, want: user[r.userKey] }))
      .filter((r) => r.want != null); // a scoped user without that scope value matches nothing through it
    if (!rules.length) return () => false;
    return (row) => rules.some((r) => r.fields.some((f) => (r.array ? (row?.[f] || []).includes(r.want) : row?.[f] === r.want)));
  }
  if (preset.scope !== 'own' && GLOBAL_READ.includes(collection)) return () => true;
  return null;
}

/**
 * @param {object} user @param {string} collection @param {object[]} rows
 * @returns {object[]}
 */
export function scopeFilter(user, collection, rows) {
  if (!isActive(user)) return [];
  const pred = scopePredicate(user, collection);
  if (!pred) return [];
  return (rows || []).filter(pred);
}

/**
 * @param {object|null|undefined} user @param {string} permission
 * @param {object} [resource] a row; when given, scope is enforced on it
 * @returns {boolean}
 */
export function can(user, permission, resource) {
  if (!isActive(user)) return false;
  const preset = ROLE_PRESETS[user.role];
  if (!preset) return false;
  if (!granted(preset.permissions, permission)) return false;
  if (resource === undefined || preset.scope === 'all') return true;
  const collection = PERM_COLLECTION[permission.split(':')[0]];
  if (!collection) return true;
  const pred = scopePredicate(user, collection);
  return !!pred && pred(resource);
}

/**
 * @param {object|null|undefined} user @param {string} permission @param {object} [resource]
 * @throws {PermissionError}
 */
export function assertCan(user, permission, resource) {
  if (!can(user, permission, resource)) {
    throw new PermissionError(
      `${user?.role || 'anonymous'} is not allowed to ${permission}`,
      { permission, role: user?.role },
    );
  }
}

/** Which role may set a given bag status (derived from presets). @param {string} status @returns {string[]} */
export function rolesThatCanAdvanceTo(status) {
  return ROLE_IDS.filter((r) => granted(ROLE_PRESETS[r].permissions, `bag:advance:${status}`));
}

/** May `actor` manage (create/disable/move) a user of `targetRole`? */
export function canManageRole(actor, targetRole) {
  if (!can(actor, 'staff:manage')) return false;
  return ROLE_PRESETS[actor.role].manages.includes(targetRole);
}

/** Sanity export for tests: every v7 status must be settable by someone (except Declared, set by creation). */
export const STATUSES_WITH_OWNER = BAG_STATUSES.filter((s) => s !== 'Declared');
export const SIDE_STATUS_VALUES = Object.values(SIDE_STATUSES);
