import { describe, it, expect } from 'vitest';
import { createStaff, disableStaff, enableStaff, resetPin, moveArea, nextEmployeeId, authenticate, StaffError } from '../../shared/services/staffService.js';
import { PermissionError } from '../../shared/rbac.js';
import { freshState, users } from './helpers.js';

describe('staffService', () => {
  it('generates the next id per prefix and creates audit-logged staff', () => {
    const s = freshState();
    s.collectionAreas.push({ id: 'AREA-A' });
    const u1 = createStaff(s, { role: 'checkin', name: 'Omar', area_id: 'AREA-A' }, { user: users.ops });
    const u2 = createStaff(s, { role: 'checkin', name: 'Yusuf', area_id: 'AREA-A' }, { user: users.ops });
    expect([u1.employee_id, u2.employee_id]).toEqual(['CHK-001', 'CHK-002']);
    expect(nextEmployeeId(s, 'checkin')).toBe('CHK-003');
    expect(createStaff(s, { role: 'backend', name: 'B' }, { user: users.ops }).employee_id).toBe('BE-001');
    expect(s.auditLog.filter((a) => a.action === 'staff.create')).toHaveLength(3);
  });

  it('enforces prefix, uniqueness, area for check-in staff, and who may manage whom', () => {
    const s = freshState();
    s.collectionAreas.push({ id: 'AREA-A' });
    expect(() => createStaff(s, { role: 'checkin', name: 'X', employee_id: 'WH-001', area_id: 'AREA-A' }, { user: users.ops })).toThrowError(expect.objectContaining({ code: 'INVALID_PREFIX' }));
    expect(() => createStaff(s, { role: 'checkin', name: 'X' }, { user: users.ops })).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    createStaff(s, { role: 'checkin', name: 'X', employee_id: 'CHK-010', area_id: 'AREA-A' }, { user: users.ops });
    expect(() => createStaff(s, { role: 'checkin', name: 'Y', employee_id: 'CHK-010', area_id: 'AREA-A' }, { user: users.ops })).toThrowError(expect.objectContaining({ code: 'DUPLICATE' }));
    expect(() => createStaff(s, { role: 'checkin', name: 'Z', area_id: 'AREA-A' }, { user: users.tm })).toThrow(PermissionError);
    expect(() => createStaff(s, { role: 'ops_manager', name: 'Z' }, { user: users.ops })).toThrow(PermissionError);
    expect(createStaff(s, { role: 'ops_manager', name: 'Z' }, { user: users.admin }).employee_id).toBe('OPS-001');
    expect(createStaff(s, { role: 'transport_staff', name: 'T' }, { user: users.tm }).employee_id).toBe('TS-001');
  });

  it('disable needs a reason; enable, reset PIN, move area are audited; PIN is never logged', () => {
    const s = freshState();
    s.collectionAreas.push({ id: 'AREA-A' }, { id: 'AREA-B' });
    const u = createStaff(s, { role: 'checkin', name: 'Omar', area_id: 'AREA-A' }, { user: users.ops });
    expect(() => disableStaff(s, u.id, ' ', { user: users.ops })).toThrow(StaffError);
    disableStaff(s, u.id, 'On leave', { user: users.ops });
    expect(u).toMatchObject({ status: 'Disabled', disabled_reason: 'On leave' });
    enableStaff(s, u.id, { user: users.ops });
    expect(u.status).toBe('Active');
    resetPin(s, u.id, '4321', { user: users.ops });
    expect(u.pin).toBe('4321');
    expect(() => resetPin(s, u.id, '12', { user: users.ops })).toThrow(StaffError);
    moveArea(s, u.id, 'AREA-B', { user: users.ops });
    expect(u.area_id).toBe('AREA-B');
    expect(() => moveArea(s, u.id, 'NOPE', { user: users.ops })).toThrow(StaffError);
    expect(JSON.stringify(s.auditLog)).not.toContain('4321');
    expect(s.auditLog.map((a) => a.action)).toEqual(['staff.create', 'staff.disable', 'staff.enable', 'staff.reset_pin', 'staff.move_area']);
  });

  it('authenticate: legacy WH- id logs in as WM-, wrong PIN fails, disabled accounts are refused', () => {
    const s = freshState();
    s.users.push({ id: 'WM-001', employee_id: 'WM-001', legacy_id: 'WH-001', role: 'warehouse_manager', pin: '1234', status: 'Active' });
    s.users.push({ id: 'DRV-001', employee_id: 'DRV-001', role: 'driver_legacy', pin: '1234', status: 'Disabled', disabled_reason: 'Moved to Driver records' });
    expect(authenticate(s, 'WH-001', '1234').employee_id).toBe('WM-001');
    expect(authenticate(s, 'wm-001', '1234')).not.toBeNull();
    expect(authenticate(s, 'WM-001', '0000')).toBeNull();
    expect(() => authenticate(s, 'DRV-001', '1234')).toThrowError(/Moved to Driver records/);
  });
});

describe('base accounts', () => {
  it('provide every v7 role, are idempotent and never overwrite existing data', async () => {
    const { createStore } = await import('../../shared/store.js');
    const { ROLE_PRESETS, roleFromEmployeeId } = await import('../../shared/rbac.js');
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    const store = createStore({ storage, baseAccounts: true });
    const s = store.get();
    const roles = new Set(s.users.map((u) => u.role));
    for (const r of Object.keys(ROLE_PRESETS).filter((x) => x !== 'traveler')) expect(roles.has(r)).toBe(true);
    expect(s.users.every((u) => u.pin === '1234' && roleFromEmployeeId(u.employee_id) === u.role)).toBe(true);
    expect(s.collectionAreas.map((a) => a.name)).toEqual(['Aziziyah', 'Al-Awali', 'Shisha']);
    s.users.find((u) => u.id === 'CHK-001').name = 'Edited';
    store.save();
    const n = s.users.length;
    const again = createStore({ storage, baseAccounts: true }).get();
    expect(again.users).toHaveLength(n);
    expect(again.users.find((u) => u.id === 'CHK-001').name).toBe('Edited');
  });
});
