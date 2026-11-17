import { describe, it, expect } from 'vitest';
import {
  ROLE_PRESETS, ROLE_IDS, can, assertCan, scopeFilter, PermissionError, roleFromEmployeeId, rolesThatCanAdvanceTo, canManageRole, EMPLOYEE_PREFIXES,
} from '../../shared/rbac.js';
import { BAG_STATUSES, ROLE } from '../../shared/constants.js';
import { users } from './helpers.js';

describe('rbac presets', () => {
  it('has exactly the 10 departure roles with the specified homes and prefixes', () => {
    expect([...ROLE_IDS].sort()).toEqual(Object.values(ROLE).sort());
    const homes = Object.fromEntries(Object.values(ROLE_PRESETS).map((p) => [p.id, p.home]));
    expect(homes).toEqual({
      traveler: '/', backend: '/backend', checkin: '/staff', transport_manager: '/transport', transport_staff: '/transport/trips',
      warehouse_manager: '/warehouse', airport_coordinator: '/airport', window_monitor: '/monitor', ops_manager: '/ops', system_admin: '/admin',
    });
    expect(EMPLOYEE_PREFIXES).toEqual({ BE: 'backend', CHK: 'checkin', TM: 'transport_manager', TS: 'transport_staff', WM: 'warehouse_manager', APC: 'airport_coordinator', MON: 'window_monitor', OPS: 'ops_manager', ADM: 'system_admin' });
  });

  it('there is no Driver login role and no Group Ameer role', () => {
    expect(ROLE_IDS.some((r) => /driver|ameer/i.test(r))).toBe(false);
  });

  it('every main-line status after Declared has at least one owning role, and the owner matches the spec', () => {
    const owners = Object.fromEntries(BAG_STATUSES.slice(1).map((s) => [s, rolesThatCanAdvanceTo(s)]));
    expect(owners).toEqual({
      'Data Verified': ['backend'], 'Tag Assigned': ['backend'], 'Checked-in': ['checkin'],
      'Loaded to Collection Truck': ['transport_staff'], 'Received at Warehouse': ['warehouse_manager'], 'Screened': ['warehouse_manager'],
      'Loaded to Airport Truck': ['warehouse_manager'], 'In Transit to Airport': ['transport_staff'], 'Received at Airport': ['airport_coordinator'],
      'Handed to Airport Authority': ['airport_coordinator'], 'SGS Voucher Accepted': ['airport_coordinator'], 'Loaded on Aircraft': ['backend'],
    });
  });

  it('Window Monitor is strictly read-only', () => {
    const grants = ROLE_PRESETS.window_monitor.permissions;
    expect(grants.every((g) => /:(read|notify)$/.test(g))).toBe(true);
    expect(can(users.monitor, 'bag:advance:Screened')).toBe(false);
    expect(can(users.monitor, 'flight:create')).toBe(false);
  });

  it('roleFromEmployeeId reads the prefix', () => {
    expect(roleFromEmployeeId('CHK-001')).toBe('checkin');
    expect(roleFromEmployeeId('wm-002')).toBe('warehouse_manager');
    expect(roleFromEmployeeId('DRV-001')).toBeNull();
    expect(roleFromEmployeeId('WH-001')).toBeNull();
  });
});

describe('can / assertCan', () => {
  it('grants exact and wildcard permissions', () => {
    expect(can(users.tm, 'trip:assign')).toBe(true); // trip:*
    expect(can(users.ops, 'flight:cancel')).toBe(true); // flight:*
    expect(can(users.backend, 'tag:release')).toBe(true);
    expect(can(users.backend, 'trip:assign')).toBe(false);
    expect(can(users.admin, 'integration:manage')).toBe(true);
    expect(can(users.ops, 'integration:manage')).toBe(false);
  });

  it('denies anonymous, unknown-role and Disabled users', () => {
    expect(can(null, 'bag:read')).toBe(false);
    expect(can({ role: 'driver_legacy' }, 'bag:read')).toBe(false);
    expect(can({ ...users.ops, status: 'Disabled' }, 'flight:read')).toBe(false);
  });

  it('enforces row scope when a resource is given', () => {
    expect(can(users.checkin, 'assignment:update', { collection_area_id: 'AREA-A' })).toBe(true);
    expect(can(users.checkin, 'assignment:update', { collection_area_id: 'AREA-B' })).toBe(false);
    expect(can(users.wm, 'bag:update', { warehouse_id: 'WH-1' })).toBe(true);
    expect(can(users.wm, 'bag:update', { warehouse_id: 'WH-2' })).toBe(false);
    expect(can(users.ops, 'bag:read', { warehouse_id: 'WH-2' })).toBe(true); // scope: all
  });

  it('assertCan throws PermissionError with code FORBIDDEN', () => {
    expect(() => assertCan(users.checkin, 'flight:cancel')).toThrow(PermissionError);
    try { assertCan(users.checkin, 'flight:cancel'); } catch (e) { expect(e.code).toBe('FORBIDDEN'); expect(e.role).toBe('checkin'); }
    expect(() => assertCan(users.ops, 'flight:cancel')).not.toThrow();
  });

  it('staff management matrix: Ops, Transport Manager and Admin manage the right roles', () => {
    expect(canManageRole(users.ops, 'checkin')).toBe(true);
    expect(canManageRole(users.ops, 'window_monitor')).toBe(true);
    expect(canManageRole(users.ops, 'ops_manager')).toBe(false);
    expect(canManageRole(users.tm, 'transport_staff')).toBe(true);
    expect(canManageRole(users.tm, 'checkin')).toBe(false);
    expect(canManageRole(users.admin, 'ops_manager')).toBe(true);
    expect(canManageRole(users.admin, 'transport_manager')).toBe(true);
    expect(canManageRole(users.checkin, 'checkin')).toBe(false);
  });
});

describe('scopeFilter', () => {
  const rows = [
    { id: 1, collection_area_id: 'AREA-A', warehouse_id: 'WH-1', airport_id: 'JED', traveler_id: 'TRV-1' },
    { id: 2, collection_area_id: 'AREA-B', warehouse_id: 'WH-2', airport_id: 'MED', traveler_id: 'TRV-2' },
  ];
  const ids = (r) => r.map((x) => x.id);

  it('own: traveler sees only own rows', () => expect(ids(scopeFilter(users.traveler, 'bags', rows))).toEqual([1]));
  it('area: check-in staff sees only their area', () => {
    expect(ids(scopeFilter(users.checkin, 'collectionAssignments', rows))).toEqual([1]);
    expect(ids(scopeFilter(users.checkinB, 'bags', rows))).toEqual([2]);
  });
  it('warehouse and airport scopes', () => {
    expect(ids(scopeFilter(users.wm, 'bags', rows))).toEqual([1]);
    expect(ids(scopeFilter(users.apc, 'trips', rows))).toEqual([1]);
  });
  it('all: ops, backend, monitor, transport manager see everything', () => {
    for (const u of [users.ops, users.backend, users.monitor, users.tm, users.admin]) expect(ids(scopeFilter(u, 'bags', rows))).toEqual([1, 2]);
  });
  it('deny by default: unmapped collection for a scoped role returns nothing', () => {
    expect(scopeFilter(users.checkin, 'sgsVouchers', rows)).toEqual([]);
    expect(scopeFilter(users.wm, 'collectionAssignments', rows)).toEqual([]);
  });
  it('lookup data (airlines, flights) is readable by scoped staff but travelers only get their own flight', () => {
    const flights = [{ id: 'F1' }, { id: 'F2' }];
    expect(scopeFilter(users.checkin, 'flights', flights)).toHaveLength(2);
    expect(ids(scopeFilter(users.traveler, 'flights', flights.map((f, i) => ({ ...f, id: f.id, n: i }))).map((f) => ({ id: f.id })))).toEqual(['F1']);
  });
  it('a scoped user with no scope value, or a disabled user, sees nothing', () => {
    expect(scopeFilter({ ...users.checkin, area_id: null }, 'bags', rows)).toEqual([]);
    expect(scopeFilter({ ...users.checkin, status: 'Disabled' }, 'bags', rows)).toEqual([]);
  });
});
