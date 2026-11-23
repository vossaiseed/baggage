import { describe, it, expect } from 'vitest';
import { migrateStatus } from '../../shared/migrations/statusMap.js';
import { runMigrations, MIGRATIONS, LATEST_VERSION } from '../../shared/migrations/index.js';
import { createEmptyState, createStore } from '../../shared/store.js';
import { BAG_STATUSES, LEGACY_STATUSES, SIDE_STATUSES } from '../../shared/constants.js';

describe('status migration map', () => {
  it('Tagged -> Checked-in', () => expect(migrateStatus('Tagged')).toBe('Checked-in'));
  it('Tag Pre-printed -> Tag Assigned', () => expect(migrateStatus('Tag Pre-printed')).toBe('Tag Assigned'));
  it('Handed to Airline -> Handed to Airport Authority', () => expect(migrateStatus('Handed to Airline')).toBe('Handed to Airport Authority'));
  it('Stored -> Held – Cancelled Flight when flight cancelled', () => {
    expect(migrateStatus('Stored', { flightCancelled: true })).toBe(SIDE_STATUSES.HELD);
  });
  it('Stored -> Screened otherwise', () => {
    expect(migrateStatus('Stored', { flightCancelled: false })).toBe('Screened');
    expect(migrateStatus('Stored')).toBe('Screened');
  });
  it('old untagged Checked-in -> Data Verified; tagged stays Checked-in', () => {
    expect(migrateStatus('Checked-in', { hasTag: false })).toBe('Data Verified');
    expect(migrateStatus('Checked-in', { hasTag: true })).toBe('Checked-in');
  });
  it('v7 statuses are unchanged; unknown values are never dropped', () => {
    for (const s of BAG_STATUSES.filter((x) => x !== 'Checked-in')) expect(migrateStatus(s)).toBe(s);
    expect(migrateStatus('Something Odd')).toBe('Something Odd');
  });
  it('every legacy status maps to a known v7 status', () => {
    for (const s of LEGACY_STATUSES) {
      const out = migrateStatus(s, { hasTag: true });
      expect(BAG_STATUSES.includes(out) || out === SIDE_STATUSES.HELD).toBe(true);
    }
  });
});

describe('migrations', () => {
  it('run on a fresh DB: all collections + counters exist, version latest', () => {
    const s = runMigrations(createEmptyState(), {});
    expect(s.__v).toBe(LATEST_VERSION);
    for (const c of ['users', 'flights', 'bags', 'bagTags', 'scanEvents', 'trips', 'auditLog']) expect(Array.isArray(s[c])).toBe(true);
    expect(s.counters.internalTag).toBe(0);
  });

  it('are idempotent (re-running changes nothing)', () => {
    const s = runMigrations(createEmptyState(), {});
    const snap = JSON.stringify(s);
    runMigrations(s, {});
    expect(JSON.stringify(s)).toBe(snap);
  });

  it('versions are unique and strictly ascending', () => {
    const vs = MIGRATIONS.map((m) => m.v);
    expect(vs).toEqual([...vs].sort((a, b) => a - b));
    expect(new Set(vs).size).toBe(vs.length);
  });

  it('normalises legacy bag statuses in existing state (migration 003)', () => {
    const s = { __v: 2, bags: [
      { id: 'a', status: 'Tagged', tag_no: 'x' }, { id: 'b', status: 'Stored', flight_id: 'FC', tag_no: 'x' },
      { id: 'c', status: 'Stored', flight_id: 'F1' }, { id: 'd', status: 'Handed to Airline' },
    ], flights: [{ id: 'FC', status: 'Cancelled' }, { id: 'F1', status: 'Scheduled' }] };
    runMigrations(s, {});
    expect(s.bags.map((b) => b.status)).toEqual(['Checked-in', SIDE_STATUSES.HELD, 'Screened', 'Handed to Airport Authority']);
    expect(s.bags[0].legacy_status).toBe('Tagged');
  });
});

/** In-memory localStorage with the real shape of the old per-app stores. */
function memStorage(data = {}) {
  const m = new Map(Object.entries(data).map(([k, v]) => [k, JSON.stringify(v)]));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), dump: () => Object.fromEntries(m) };
}

describe('legacy import (existing data)', () => {
  const before = {
    'rabel_ui_checkin-staff': {
      __v: 1,
      centres: [{ id: 'AZIZIYAH', name: 'Aziziyah' }, { id: 'MADINAH', name: 'Madinah' }],
      staff: [{ id: 'CHK-001', employeeId: 'CHK-001', name: 'Omar', pin: '1234', homeCentre: 'AZIZIYAH', role: 'staff' },
        { id: 'CHK-003', employeeId: 'CHK-003', name: 'Bilal', pin: '1234', homeCentre: 'MADINAH', role: 'staff' }],
      flights: [{ code: 'SV 1821' }],
      appointments: [{ id: 'APT-1' }], checkinSessions: [{ id: 'S1' }], carts: [{ id: 'CART-1' }],
      nusukRecords: [{ nusukId: 'NSK1', name: 'Idris', passportNo: 'P1', flightCode: 'SV 1821' }],
      bags: [{ id: 'BAG-1', appointmentId: 'APT-1', centreId: 'AZIZIYAH', flightCode: 'SV 1821', tagNumber: 'RBTAG-1', weightKg: 18, status: 'Tagged' }],
      exceptions: [{ id: 'EXC-1', type: 'Missing Bag' }],
    },
    'rabel_ui_warehouse-staff': {
      __v: 1, warehouse: { name: 'Rabel Central Warehouse — Makkah' },
      staff: [{ id: 'WH-001', employeeId: 'WH-001', name: 'Faisal', pin: '1234' }],
      drivers: [{ id: 'DRV-001', name: 'Tariq' }],
      bags: [{ id: 'WB-1', tagNumber: 'RBTAG-9', flightCode: 'GA 981', status: 'Stored', weightKg: 21 }],
      outboundTrucks: [{ id: 'TRK-41', code: 'TRK-41', status: 'Available' }],
    },
    'rabel_ui_driver': { __v: 1, staff: [{ id: 'DRV-001', employeeId: 'DRV-001', name: 'Tariq', pin: '1234' }], trips: [{ id: 'T1' }] },
    'rabel_ui_system-admin': { __v: 1, users: [
      { employeeId: 'DRV-004', name: 'Sal', roleId: 'driver', pin: '1111', status: 'Active' },
      { employeeId: 'WH-002', name: 'Imran', roleId: 'warehouse', pin: '2222', status: 'Active' },
      { employeeId: 'DLV-001', name: 'Sameer', roleId: 'delivery', pin: '3333', status: 'Active' },
    ] },
  };

  it('imports without touching or deleting old keys', () => {
    const storage = memStorage(before);
    const snap = JSON.stringify(storage.dump());
    const state = createStore({ storage }).get();
    expect(JSON.stringify({ ...storage.dump(), rabel_v7: undefined })).toBe(JSON.stringify({ ...JSON.parse(snap) , rabel_v7: undefined }));
    expect(state.legacy.centres).toHaveLength(2);
    expect(state.legacy.appointments).toHaveLength(1);
    expect(state.legacy.carts).toHaveLength(1);
  });

  it('maps centres to areas, check-in staff to areas, bag statuses to v7, and tags to RBL-D-', () => {
    const state = createStore({ storage: memStorage(before) }).get();
    expect(state.collectionAreas.map((a) => a.id)).toEqual(['AREA-AZIZIYAH']);
    expect(state.users.find((u) => u.id === 'CHK-001').area_id).toBe('AREA-AZIZIYAH');
    expect(state.users.find((u) => u.id === 'CHK-003').area_id).toBeNull();
    const b = state.bags.find((x) => x.id === 'BAG-1');
    expect(b.status).toBe('Checked-in');
    expect(b.tag_no).toBe('RBL-D-000001');
    expect(b.legacy_tag_no).toBe('RBTAG-1');
    expect(state.bags.find((x) => x.id === 'WB-1').status).toBe('Screened');
    expect(state.exceptions.some((e) => e.id === 'EXC-1')).toBe(true);
  });

  it('Warehouse Staff become Warehouse Managers with WM- ids (legacy id kept)', () => {
    const state = createStore({ storage: memStorage(before) }).get();
    const wm = state.users.find((u) => u.employee_id === 'WM-001');
    expect(wm.role).toBe('warehouse_manager');
    expect(wm.legacy_id).toBe('WH-001');
    expect(state.users.find((u) => u.employee_id === 'WM-002').role).toBe('warehouse_manager');
  });

  it('Driver users are Disabled ("Moved to Driver records") with a matching Driver record', () => {
    const state = createStore({ storage: memStorage(before) }).get();
    for (const id of ['DRV-001', 'DRV-004']) {
      const u = state.users.find((x) => x.employee_id === id);
      expect(u.status).toBe('Disabled');
      expect(u.disabled_reason).toBe('Moved to Driver records');
      expect(state.drivers.some((d) => d.id === id)).toBe(true);
    }
    expect(state.legacy.adminUsers.map((u) => u.employeeId)).toEqual(['DLV-001']);
  });

  it('is persisted once and reload does not re-import or duplicate', () => {
    const storage = memStorage(before);
    const a = createStore({ storage }).get();
    const n = a.bags.length;
    const b = createStore({ storage }).get();
    expect(b.bags).toHaveLength(n);
    expect(b.counters.internalTag).toBe(a.counters.internalTag);
  });
});
