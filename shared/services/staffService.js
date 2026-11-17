/**
 * staffService — create / disable / enable / reset PIN / move area for staff accounts.
 * Every change is RBAC-checked (can staff:manage + manages[role]) and audit-logged.
 */
import { ROLE_PRESETS, PermissionError, canManageRole, assertCan } from '../rbac.js';
import { makeUser } from '../models.js';
import { audit, nextCounter } from './audit.js';

export class StaffError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'StaffError'; this.code = code; }
}

/** @param {object} state @param {string} role @returns {string} next free employee id, e.g. CHK-004 */
export function nextEmployeeId(state, role) {
  const preset = ROLE_PRESETS[role];
  if (!preset?.prefix) throw new StaffError('NO_PREFIX', `Role "${role}" has no employee-id prefix.`);
  const used = (state.users || []).map((u) => u.employee_id).filter((id) => id?.startsWith(`${preset.prefix}-`))
    .map((id) => Number(id.split('-')[1])).filter(Number.isFinite);
  const n = Math.max(0, ...used) + 1;
  return `${preset.prefix}-${String(n).padStart(3, '0')}`;
}

function mustManage(actor, role) {
  if (!ROLE_PRESETS[role]) throw new StaffError('UNKNOWN_ROLE', `Unknown role "${role}".`);
  if (!canManageRole(actor, role)) {
    throw new PermissionError(`${actor?.role || 'anonymous'} may not manage ${role} accounts`, { permission: 'staff:manage', role: actor?.role });
  }
}

function findUser(state, id) {
  const u = (state.users || []).find((x) => x.id === id || x.employee_id === id);
  if (!u) throw new StaffError('NOT_FOUND', `User ${id} not found.`);
  return u;
}

/**
 * @param {object} state
 * @param {{ role:string, name:string, phone?:string, employee_id?:string, area_id?:string|null, warehouse_id?:string|null, airport_id?:string|null, pin?:string }} input
 * @param {{ user: object, now?: any }} ctx
 */
export function createStaff(state, input, ctx) {
  mustManage(ctx.user, input.role);
  if (!input.name?.trim()) throw new StaffError('INVALID', 'Name is required.');
  const prefix = ROLE_PRESETS[input.role].prefix;
  const employee_id = (input.employee_id || nextEmployeeId(state, input.role)).toUpperCase();
  if (!new RegExp(`^${prefix}-\\d{3,}$`).test(employee_id)) {
    throw new StaffError('INVALID_PREFIX', `Employee ID for ${ROLE_PRESETS[input.role].label} must start with ${prefix}-.`);
  }
  if (state.users.some((u) => u.employee_id === employee_id)) throw new StaffError('DUPLICATE', `Employee ID ${employee_id} already exists.`);
  if (input.role === ROLE_PRESETS.checkin?.id && !input.area_id) throw new StaffError('INVALID', 'Check-in staff must be assigned to a collection area.');
  if (input.pin != null && !/^\d{4}$/.test(String(input.pin))) throw new StaffError('INVALID', 'PIN must be 4 digits.');
  const user = makeUser({
    id: employee_id, employee_id, name: input.name.trim(), role: input.role, phone: input.phone, pin: input.pin ?? '1234',
    area_id: input.area_id ?? null, warehouse_id: input.warehouse_id ?? null, airport_id: input.airport_id ?? null,
  });
  state.users.push(user);
  nextCounter(state, 'staff');
  audit(state, ctx, { action: 'staff.create', entity: 'User', entityId: user.id, after: { role: user.role, name: user.name, area_id: user.area_id } });
  return user;
}

/** @param {object} state @param {string} id @param {string} reason @param {{user:object, now?:any}} ctx */
export function disableStaff(state, id, reason, ctx) {
  const u = findUser(state, id);
  mustManage(ctx.user, u.role);
  if (!reason?.trim()) throw new StaffError('INVALID', 'A reason is required to disable an account.');
  const before = { status: u.status };
  u.status = 'Disabled';
  u.disabled_reason = reason.trim();
  audit(state, ctx, { action: 'staff.disable', entity: 'User', entityId: u.id, before, after: { status: u.status }, note: u.disabled_reason });
  return u;
}

/** @param {object} state @param {string} id @param {{user:object, now?:any}} ctx */
export function enableStaff(state, id, ctx) {
  const u = findUser(state, id);
  mustManage(ctx.user, u.role);
  const before = { status: u.status };
  u.status = 'Active';
  u.disabled_reason = null;
  audit(state, ctx, { action: 'staff.enable', entity: 'User', entityId: u.id, before, after: { status: u.status } });
  return u;
}

/** @param {object} state @param {string} id @param {string} newPin @param {{user:object, now?:any}} ctx */
export function resetPin(state, id, newPin, ctx) {
  const u = findUser(state, id);
  mustManage(ctx.user, u.role);
  if (!/^\d{4}$/.test(String(newPin))) throw new StaffError('INVALID', 'PIN must be 4 digits.');
  u.pin = String(newPin);
  audit(state, ctx, { action: 'staff.reset_pin', entity: 'User', entityId: u.id }); // never log the PIN itself
  return u;
}

/** @param {object} state @param {string} id @param {string} areaId @param {{user:object, now?:any}} ctx */
export function moveArea(state, id, areaId, ctx) {
  const u = findUser(state, id);
  mustManage(ctx.user, u.role);
  if (!(state.collectionAreas || []).some((a) => a.id === areaId)) throw new StaffError('NOT_FOUND', `Collection area ${areaId} not found.`);
  const before = { area_id: u.area_id };
  u.area_id = areaId;
  audit(state, ctx, { action: 'staff.move_area', entity: 'User', entityId: u.id, before, after: { area_id: areaId } });
  return u;
}

/**
 * PIN login helper shared by every departure app. Accepts the v7 id or the legacy id (e.g. WH-001 for WM-001).
 * @returns {object|null} the user (without trusting the caller to hide the pin)
 */
export function authenticate(state, employeeId, pin) {
  const id = String(employeeId || '').trim().toLowerCase();
  const u = (state.users || []).find((x) => x.employee_id?.toLowerCase() === id || x.legacy_id?.toLowerCase() === id);
  if (!u || u.pin !== String(pin)) return null;
  if (u.status === 'Disabled') throw new StaffError('DISABLED', u.disabled_reason ? `Account disabled: ${u.disabled_reason}.` : 'Account disabled.');
  if (!ROLE_PRESETS[u.role]) return null;
  return u;
}

export { assertCan };
