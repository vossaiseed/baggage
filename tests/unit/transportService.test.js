import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../shared/store.js';
import { seedDeparture, SAMPLE_TAG_FILES } from '../../shared/seed/departure.js';
import * as be from '../../shared/services/backendService.js';
import * as tags from '../../shared/services/tagService.js';
import * as ck from '../../shared/services/checkinService.js';
import * as tr from '../../shared/services/transportService.js';
import { PermissionError } from '../../shared/rbac.js';
import { ServiceError } from '../../shared/services/errors.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();
let s; let BE; let CHK1; let CHK2; let TM; let TS1; let TS2; let OPS;
const ctx = (user) => ({ user, now: NOW });
const trav = (nid) => s.travelers.find((t) => t.nusuk_id === nid);
const asg = (nid) => s.collectionAssignments.find((a) => a.traveler_id === trav(nid).id);
const csv = (id) => SAMPLE_TAG_FILES.find((f) => f.id === id).csv;
const AZIZIYAH = 'AREA-AZIZIYAH';

function prepare(code, file) {
  for (const r of be.dataRows(s)) if (r.flight === code && r.match.status === 'matched' && !r.traveler.data_verified) be.matchAndVerify(s, r.traveler.id, ctx(BE));
  tags.importTagBatch(s, { csv: csv(file) }, ctx(BE));
  tags.assignTags(s, code, ctx(BE));
  tags.releaseTags(s, code, ctx(BE));
}

/** Drives a prebooked traveler all the way to "handed to Transport" at the residence. */
function fullCheckin(nid, user) {
  const a = asg(nid);
  const t = trav(nid);
  ck.startRoute(s, a.id, {}, ctx(user));
  ck.markArrived(s, a.id, { gps: { lat: 21.4, lng: 39.8 } }, ctx(user));
  ck.confirmIdentity(s, a.id, { last4: t.passport.slice(-4), photoOk: true }, ctx(user));
  const bags = ck.activeBags(s, a);
  ck.recordWeights(s, a.id, Object.fromEntries(bags.map((b) => [b.id, 20])), ctx(user));
  for (const b of bags) {
    if (b.airline_tag_no) expect(ck.scanTag(s, a.id, b.id, 'AIRLINE', { value: b.airline_tag_no, method: 'HANDHELD', symbology: 'ITF' }, ctx(user)).ok).toBe(true);
    expect(ck.scanTag(s, a.id, b.id, 'INTERNAL', { value: b.tag_no, method: 'HANDHELD', symbology: 'CODE128' }, ctx(user)).ok).toBe(true);
  }
  ck.completeCheckin(s, a.id, ctx(user));
  ck.handToTransport(s, a.id, ctx(user));
  return a;
}

beforeEach(() => {
  s = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(s, { now: NOW });
  BE = s.users.find((u) => u.id === 'BE-001');
  CHK1 = s.users.find((u) => u.id === 'CHK-001'); // Aziziyah
  CHK2 = s.users.find((u) => u.id === 'CHK-002'); // Al-Awali
  TM = s.users.find((u) => u.id === 'TM-001');
  TS1 = s.users.find((u) => u.id === 'TS-001'); // Aziziyah
  TS2 = s.users.find((u) => u.id === 'TS-002'); // Al-Awali
  OPS = s.users.find((u) => u.id === 'OPS-001');
  prepare('SV 1821', 'sv'); // flight of traveler 2000000001 (Aziziyah, P1)
});

describe('fleet management', () => {
  it('lists the seeded drivers and trucks', () => {
    expect(tr.listDrivers(s, TM).map((d) => d.id)).toEqual(['DRV-001', 'DRV-002', 'DRV-003']);
    expect(tr.listTrucks(s, TM).map((t) => t.id)).toEqual(['TRK-001', 'TRK-002', 'TRK-003']);
  });
  it('Transport Manager creates drivers and trucks; Transport Staff cannot', () => {
    const d = tr.createDriver(s, { name: 'New Driver', phone: '+966500000199' }, ctx(TM));
    expect(d.id).toBe('DRV-004');
    expect(d.status).toBe('Available');
    const t = tr.createTruck(s, { plate_no: 'RBL 1099' }, ctx(TM));
    expect(t.id).toBe('TRK-004');
    expect(() => tr.createDriver(s, { name: 'Nope' }, ctx(TS1))).toThrow(PermissionError);
    expect(() => tr.createTruck(s, { plate_no: 'X' }, ctx(TS1))).toThrow(PermissionError);
  });
  it('rejects a busy driver/truck status change until rerouted off their trip', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    expect(trip.driver_id).toBe('DRV-001');
    expect(() => tr.setDriverStatus(s, 'DRV-001', 'Off duty', ctx(TM))).toThrow(ServiceError);
    expect(() => tr.setTruckStatus(s, 'TRK-001', 'Off duty', ctx(TM))).toThrow(ServiceError);
  });
});

describe('window board', () => {
  it('shows no pending pickups before any hand-off', () => {
    const board = tr.windowBoard(s, TM, { now: NOW });
    const row = board.find((r) => r.area.id === AZIZIYAH);
    expect(row.pendingPickups).toBe(0);
  });
  it('shows pending pickups and priority once bags are handed to Transport', () => {
    fullCheckin('2000000001', CHK1); // SV 1821 is priority 1
    const board = tr.windowBoard(s, TM, { now: NOW });
    const row = board.find((r) => r.area.id === AZIZIYAH);
    expect(row.pendingPickups).toBe(2);
    expect(row.priorityRank).toBe(1);
  });
});

describe('dispatch', () => {
  it('refuses to dispatch an area with nothing waiting', () => {
    expect(() => tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM))).toThrow(ServiceError);
  });
  it('dispatches a driver + truck, marking both Busy', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    expect(trip).toMatchObject({ type: 'Collection', status: 'Dispatched', area_from: AZIZIYAH, expected_count: 2 });
    expect(s.drivers.find((d) => d.id === 'DRV-001').status).toBe('Busy');
    expect(s.trucks.find((t) => t.id === 'TRK-001').status).toBe('Busy');
  });
  it('refuses a driver/truck that is not available, and refuses to double-dispatch an area', () => {
    fullCheckin('2000000001', CHK1);
    fullCheckin('2000000002', CHK2); // Al-Awali, same flight
    tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    expect(() => tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-002', truckId: 'TRK-002' }, ctx(TM))).toThrow(ServiceError); // already dispatched
    expect(() => tr.dispatchCollectionTrip(s, 'AREA-AL-AWALI', { driverId: 'DRV-001', truckId: 'TRK-002' }, ctx(TM))).toThrow(/not available/); // DRV-001 is Busy
  });
  it('RBAC: only the Transport Manager may dispatch', () => {
    fullCheckin('2000000001', CHK1);
    expect(() => tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TS1))).toThrow(PermissionError);
    expect(() => tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(CHK1))).toThrow(PermissionError);
  });
});

describe('Collection trip flow (Transport Staff)', () => {
  function dispatched() {
    fullCheckin('2000000001', CHK1);
    return tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
  }

  it('scopes trips by area: TS1 (Aziziyah) sees it, TS2 (Al-Awali) does not', () => {
    const trip = dispatched();
    expect(tr.listMyTrips(s, TS1).map((t) => t.id)).toContain(trip.id);
    expect(tr.listMyTrips(s, TS2).map((t) => t.id)).not.toContain(trip.id);
  });

  it('blocks loading on a count mismatch and raises an exception', () => {
    const trip = dispatched();
    const r = tr.loadCollectionTrip(s, trip.id, { presented: 1 }, ctx(TS1));
    expect(r).toMatchObject({ ok: false, expected: 2, presented: 1 });
    expect(s.exceptions.some((e) => e.type === 'Count Mismatch' && e.area_id === AZIZIYAH)).toBe(true);
    expect(s.trips.find((t) => t.id === trip.id).status).toBe('Dispatched');
  });

  it('loads on a matching count: bags advance, area pending_pickups clears, trip is Loaded', () => {
    const trip = dispatched();
    const area = s.collectionAreas.find((a) => a.id === AZIZIYAH);
    expect(area.pending_pickups).toBe(2);
    const r = tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(TS1));
    expect(r).toMatchObject({ ok: true, bagsLoaded: 2 });
    expect(area.pending_pickups).toBe(0);
    const loaded = s.trips.find((t) => t.id === trip.id);
    expect(loaded.status).toBe('Loaded');
    expect(loaded.bag_ids).toHaveLength(2);
    for (const bagId of loaded.bag_ids) expect(s.bags.find((b) => b.id === bagId).status).toBe('Loaded to Collection Truck');
  });

  it('depart then arrive: bag flow completes and the driver/truck free up', () => {
    const trip = dispatched();
    tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(TS1));
    expect(() => tr.arriveAtWarehouse(s, trip.id, ctx(TS1))).toThrow(ServiceError); // not departed yet
    const departed = tr.departTrip(s, trip.id, ctx(TS1));
    expect(departed.status).toBe('En Route');
    expect(s.notifications.some((n) => n.roles.includes('warehouse_manager'))).toBe(true);
    const arrived = tr.arriveAtWarehouse(s, trip.id, ctx(TS1));
    expect(arrived.status).toBe('Arrived');
    expect(s.drivers.find((d) => d.id === 'DRV-001').status).toBe('Available');
    expect(s.trucks.find((t) => t.id === 'TRK-001').status).toBe('Available');
  });

  it('RBAC: Check-in Staff cannot operate a transport trip', () => {
    const trip = dispatched();
    expect(() => tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(CHK1))).toThrow(PermissionError);
  });
});

describe('reroute', () => {
  it('swaps the truck mid-trip, freeing the old one and logging the change', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    const { trip: rerouted, log } = tr.rerouteTrip(s, trip.id, { reason: 'Breakdown', newTruckId: 'TRK-002' }, ctx(TM));
    expect(rerouted.truck_id).toBe('TRK-002');
    expect(s.trucks.find((t) => t.id === 'TRK-001').status).toBe('Off duty');
    expect(s.trucks.find((t) => t.id === 'TRK-002').status).toBe('Busy');
    expect(log).toMatchObject({ trip_id: trip.id, from_truck_id: 'TRK-001', to_truck_id: 'TRK-002' });
    expect(s.rerouteLogs).toHaveLength(1);
  });
  it('requires a reason, a real change, and an available replacement', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    expect(() => tr.rerouteTrip(s, trip.id, { newTruckId: 'TRK-002' }, ctx(TM))).toThrow(/reason/i);
    expect(() => tr.rerouteTrip(s, trip.id, { reason: 'x', newTruckId: 'TRK-001' }, ctx(TM))).toThrow(ServiceError); // no change
    s.trucks.find((t) => t.id === 'TRK-003').status = 'Off duty';
    expect(() => tr.rerouteTrip(s, trip.id, { reason: 'x', newTruckId: 'TRK-003' }, ctx(TM))).toThrow(/not available/);
  });
  it('cannot reroute a trip that has already arrived', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(TS1));
    tr.departTrip(s, trip.id, ctx(TS1));
    tr.arriveAtWarehouse(s, trip.id, ctx(TS1));
    expect(() => tr.rerouteTrip(s, trip.id, { reason: 'late', newTruckId: 'TRK-002' }, ctx(TM))).toThrow(ServiceError);
  });
  it('RBAC: Transport Staff cannot reroute', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    expect(() => tr.rerouteTrip(s, trip.id, { reason: 'x', newTruckId: 'TRK-002' }, ctx(TS1))).toThrow(PermissionError);
  });
});

describe('reports', () => {
  it('summarizes dispatched/arrived trips and bags moved', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(TS1));
    tr.departTrip(s, trip.id, ctx(TS1));
    tr.arriveAtWarehouse(s, trip.id, ctx(TS1));
    const r = tr.reportSummary(s, {});
    expect(r).toMatchObject({ tripsDispatched: 1, tripsArrived: 1, tripsActive: 0, bagsMoved: 2 });
    expect(r.avgMinutes).not.toBeNull();
  });
});

describe('Operations Manager visibility', () => {
  it('OPS can read the window board (scope: all)', () => {
    expect(() => tr.windowBoard(s, OPS, { now: NOW })).not.toThrow();
  });
});
