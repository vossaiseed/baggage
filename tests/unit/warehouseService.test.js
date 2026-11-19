import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../shared/store.js';
import { seedDeparture, SAMPLE_TAG_FILES } from '../../shared/seed/departure.js';
import * as be from '../../shared/services/backendService.js';
import * as tags from '../../shared/services/tagService.js';
import * as ck from '../../shared/services/checkinService.js';
import * as tr from '../../shared/services/transportService.js';
import * as wh from '../../shared/services/warehouseService.js';
import { markRebooked, retagRebooked, BagStateError } from '../../shared/services/bagService.js';
import { PermissionError } from '../../shared/rbac.js';
import { ServiceError } from '../../shared/services/errors.js';
import { WINDOW } from '../../shared/constants.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();
const AZIZIYAH = 'AREA-AZIZIYAH';
const WH = 'WH-MAKKAH';

let s; let BE; let CHK1; let TM; let TS1; let WM; let APC; let OPS;
const ctx = (user, now = NOW) => ({ user, now });
const trav = (nid) => s.travelers.find((t) => t.nusuk_id === nid);
const asg = (nid) => s.collectionAssignments.find((a) => a.traveler_id === trav(nid).id);
const csv = (id) => SAMPLE_TAG_FILES.find((f) => f.id === id).csv;
const label = (bag) => ({ value: bag.tag_no, method: 'HANDHELD', symbology: 'CODE128' });
const bagById = (id) => s.bags.find((b) => b.id === id);

function prepare(code, file) {
  for (const r of be.dataRows(s)) if (r.flight === code && r.match.status === 'matched' && !r.traveler.data_verified) be.matchAndVerify(s, r.traveler.id, ctx(BE));
  tags.importTagBatch(s, { csv: csv(file) }, ctx(BE));
  tags.assignTags(s, code, ctx(BE));
  tags.releaseTags(s, code, ctx(BE));
}

/** Residence check-in → handed to Transport. */
function fullCheckin(nid, user) {
  const a = asg(nid);
  const t = trav(nid);
  ck.startRoute(s, a.id, {}, ctx(user));
  ck.markArrived(s, a.id, { gps: { lat: 21.4, lng: 39.8 } }, ctx(user));
  ck.confirmIdentity(s, a.id, { last4: t.passport.slice(-4), photoOk: true }, ctx(user));
  const bags = ck.activeBags(s, a);
  ck.recordWeights(s, a.id, Object.fromEntries(bags.map((b) => [b.id, 20])), ctx(user));
  for (const b of bags) {
    if (b.airline_tag_no) ck.scanTag(s, a.id, b.id, 'AIRLINE', { value: b.airline_tag_no, method: 'HANDHELD', symbology: 'ITF' }, ctx(user));
    ck.scanTag(s, a.id, b.id, 'INTERNAL', label(b), ctx(user));
  }
  ck.completeCheckin(s, a.id, ctx(user));
  ck.handToTransport(s, a.id, ctx(user));
  return a;
}

/** A collection truck parked at the warehouse gate, with its bags on board. */
function truckAtGate() {
  fullCheckin('2000000001', CHK1);
  const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
  tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(TS1));
  tr.departTrip(s, trip.id, ctx(TS1));
  tr.arriveAtWarehouse(s, trip.id, ctx(TS1));
  return s.trips.find((t) => t.id === trip.id);
}

/** Receives the truck fully: truck QR + every label + count match. */
function receive(trip) {
  wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD', symbology: 'QR' }, ctx(WM));
  for (const id of [...trip.bag_ids]) wh.scanBagAtWarehouse(s, trip.id, label(bagById(id)), ctx(WM));
  return wh.completeReceiving(s, trip.id, ctx(WM));
}

beforeEach(() => {
  s = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(s, { now: NOW });
  BE = s.users.find((u) => u.id === 'BE-001');
  CHK1 = s.users.find((u) => u.id === 'CHK-001');
  TM = s.users.find((u) => u.id === 'TM-001');
  TS1 = s.users.find((u) => u.id === 'TS-001');
  WM = s.users.find((u) => u.id === 'WM-001');
  APC = s.users.find((u) => u.id === 'APC-001');
  OPS = s.users.find((u) => u.id === 'OPS-001');
  prepare('SV 1821', 'sv');
});

describe('upcoming trucks', () => {
  it('shows a dispatched collection truck heading to my warehouse, with its flight priority', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(TS1));
    const rows = wh.upcomingTrucks(s, WM, { now: NOW });
    const row = rows.find((r) => r.trip.id === trip.id);
    expect(row).toBeTruthy();
    expect(row.bags).toBe(2);
    expect(row.priority).toBe(1); // SV 1821 has the earliest cut-off
    expect(row.area.id).toBe(AZIZIYAH);
  });

  it('a truck only reaches the receiving queue once it has arrived, and leaves it once received', () => {
    fullCheckin('2000000001', CHK1);
    const trip = tr.dispatchCollectionTrip(s, AZIZIYAH, { driverId: 'DRV-001', truckId: 'TRK-001' }, ctx(TM));
    tr.loadCollectionTrip(s, trip.id, { presented: 2 }, ctx(TS1));
    expect(wh.receivingQueue(s, WM, { now: NOW })).toHaveLength(0);
    tr.departTrip(s, trip.id, ctx(TS1));
    tr.arriveAtWarehouse(s, trip.id, ctx(TS1));
    expect(wh.receivingQueue(s, WM, { now: NOW }).map((r) => r.trip.id)).toEqual([trip.id]);
    receive(s.trips.find((t) => t.id === trip.id));
    expect(wh.receivingQueue(s, WM, { now: NOW })).toHaveLength(0);
  });
});

describe('receiving: truck QR once + every internal label once', () => {
  it('refuses a QR that is not this truck, and refuses bag scans before the truck scan', () => {
    const trip = truckAtGate();
    const bad = wh.startReceiving(s, trip.id, { value: 'TRK-999', method: 'HANDHELD', symbology: 'QR' }, ctx(WM));
    expect(bad).toMatchObject({ ok: false, result: 'UNKNOWN' });
    expect(() => wh.scanBagAtWarehouse(s, trip.id, label(bagById(trip.bag_ids[0])), ctx(WM))).toThrow(/truck QR/i);
    expect(s.scanEvents.some((e) => e.step === 'WAREHOUSE_TRUCK_QR' && e.result === 'UNKNOWN')).toBe(true);
  });

  it('accepts the truck plate as well as its id', () => {
    const trip = truckAtGate();
    const r = wh.startReceiving(s, trip.id, { value: 'rbl 1001', method: 'CAMERA', symbology: 'QR' }, ctx(WM));
    expect(r.ok).toBe(true);
  });

  it('records every scan with its method and refuses a duplicate label', () => {
    const trip = truckAtGate();
    wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD', symbology: 'QR' }, ctx(WM));
    const first = bagById(trip.bag_ids[0]);
    expect(wh.scanBagAtWarehouse(s, trip.id, label(first), ctx(WM))).toMatchObject({ ok: true, scanned: 1, expected: 2 });
    expect(wh.scanBagAtWarehouse(s, trip.id, label(first), ctx(WM))).toMatchObject({ ok: false, result: 'DUPLICATE' });
    const events = s.scanEvents.filter((e) => e.step === 'WAREHOUSE_INTERNAL_LABEL');
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.method).toBeTruthy();
  });

  it('refuses an unknown label and a label from another truck (raising Count Mismatch for the latter)', () => {
    const trip = truckAtGate();
    wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD', symbology: 'QR' }, ctx(WM));
    expect(wh.scanBagAtWarehouse(s, trip.id, { value: 'RBL-D-999999', method: 'HANDHELD' }, ctx(WM))).toMatchObject({ ok: false, result: 'UNKNOWN' });
    const other = s.bags.find((b) => !trip.bag_ids.includes(b.id) && b.tag_no);
    const r = wh.scanBagAtWarehouse(s, trip.id, label(other), ctx(WM));
    expect(r).toMatchObject({ ok: false, result: 'WRONG_STEP' });
    expect(s.exceptions.some((e) => e.type === 'Count Mismatch' && e.bag_id === other.id)).toBe(true);
  });

  it('blocks the receipt on a short count, naming the missing label', () => {
    const trip = truckAtGate();
    wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD', symbology: 'QR' }, ctx(WM));
    wh.scanBagAtWarehouse(s, trip.id, label(bagById(trip.bag_ids[0])), ctx(WM));
    const missing = bagById(trip.bag_ids[1]);
    const r = wh.completeReceiving(s, trip.id, ctx(WM));
    expect(r).toMatchObject({ ok: false, expected: 2, scanned: 1 });
    expect(r.missing).toEqual([missing.tag_no]);
    expect(s.exceptions.some((e) => e.type === 'Count Mismatch' && e.severity === 'High')).toBe(true);
    expect(bagById(trip.bag_ids[0]).status).toBe('Loaded to Collection Truck'); // nothing moved
  });

  it('receives every bag on a matching count and stamps the warehouse clock', () => {
    const trip = truckAtGate();
    const r = receive(trip);
    expect(r).toMatchObject({ ok: true, received: 2 });
    for (const id of trip.bag_ids) {
      const b = bagById(id);
      expect(b.status).toBe('Received at Warehouse');
      expect(b.warehouse_id).toBe(WH);
      expect(b.received_at_warehouse_at).toBeTruthy();
    }
    expect(s.trips.find((t) => t.id === trip.id).receiving.completed_at).toBeTruthy();
    expect(() => wh.completeReceiving(s, trip.id, ctx(WM))).toThrow(/already been received/);
  });

  it('RBAC: Transport Staff and the Airport Coordinator cannot receive at the warehouse', () => {
    const trip = truckAtGate();
    expect(() => wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD' }, ctx(TS1))).toThrow(PermissionError);
    expect(() => wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD' }, ctx(APC))).toThrow(PermissionError);
  });
});

describe('monitor (2 h warehouse stage)', () => {
  it('counts the bags at each stage per flight, most urgent flight first', () => {
    receive(truckAtGate());
    const rows = wh.monitorRows(s, WM, { now: NOW });
    expect(rows[0].priority).toBe(1);
    const sv = rows.find((r) => r.flight.code === 'SV 1821');
    expect(sv).toMatchObject({ received: 2, screened: 0, loaded: 0, inWarehouse: 2 });
    const cancelled = rows.find((r) => r.flight.code === 'SV 1944');
    expect(cancelled.received).toBe(8); // the seeded cancelled flight is already at the warehouse
  });

  it('turns the warehouse timer amber at 90 min and red at 120 min', () => {
    const trip = truckAtGate();
    receive(trip);
    const sv = (now) => wh.monitorRows(s, WM, { now }).find((r) => r.flight.code === 'SV 1821');
    expect(sv(NOW).timerLevel).toBeNull();
    expect(sv(NOW + (WINDOW.warehouseAmberMin + 1) * 60e3).timerLevel).toBe('amber');
    const red = sv(NOW + (WINDOW.warehouseRedMin + 1) * 60e3);
    expect(red.timerLevel).toBe('red');
    expect(red.dwellMinutes).toBeGreaterThanOrEqual(WINDOW.warehouseRedMin);
  });

  it('times a bag that has no received_at stamp (seeded/migrated) from its status history', () => {
    const seeded = s.bags.find((b) => b.flight_id === 'FLT-SV-1944');
    expect(seeded.received_at_warehouse_at).toBeUndefined();
    const row = (now) => wh.monitorRows(s, WM, { now }).find((r) => r.flight.code === 'SV 1944');
    expect(row(NOW).dwellMinutes).toBe(0);
    expect(row(NOW + (WINDOW.warehouseRedMin + 1) * 60e3).timerLevel).toBe('red');
  });

  it('summary tiles follow the bags through the warehouse', () => {
    const trip = truckAtGate();
    expect(wh.warehouseSummary(s, WM, { now: NOW })).toMatchObject({ atGate: 1, toScreen: 0 });
    receive(trip);
    const after = wh.warehouseSummary(s, WM, { now: NOW });
    expect(after).toMatchObject({ atGate: 0, toScreen: 2, toLoad: 0 });
    expect(after.held).toBe(0);
  });
});

describe('screening', () => {
  it('queues received bags but never cancelled-flight bags', () => {
    receive(truckAtGate());
    const q = wh.screeningQueue(s, WM, { now: NOW });
    expect(q.map((g) => g.flight.code)).toEqual(['SV 1821']);
    expect(q[0].bags).toHaveLength(2);
  });

  it('screens the selected bags (Received at Warehouse → Screened)', () => {
    const trip = truckAtGate();
    receive(trip);
    const r = wh.screenBags(s, trip.bag_ids, ctx(WM));
    expect(r).toMatchObject({ screened: 2 });
    expect(r.skipped).toHaveLength(0);
    for (const id of trip.bag_ids) expect(bagById(id).status).toBe('Screened');
  });

  it('skips a cancelled-flight bag with a reason instead of screening it, and refuses an empty selection', () => {
    const cancelledBag = s.bags.find((b) => b.flight_id === 'FLT-SV-1944');
    const r = wh.screenBags(s, [cancelledBag.id], ctx(WM));
    expect(r.screened).toBe(0);
    expect(r.skipped[0].reason).toMatch(/cancelled/i);
    expect(() => wh.screenBags(s, [], ctx(WM))).toThrow(ServiceError);
  });

  it('RBAC: only the Warehouse Manager screens', () => {
    const trip = truckAtGate();
    receive(trip);
    expect(() => wh.screenBags(s, trip.bag_ids, ctx(TS1))).toThrow(PermissionError);
  });
});

describe('loading onto the airport truck', () => {
  function screened() {
    const trip = truckAtGate();
    receive(trip);
    wh.screenBags(s, trip.bag_ids, ctx(WM));
    return trip;
  }

  it('asks Transport for a truck once bags are screened', () => {
    expect(() => wh.requestAirportTruck(s, {}, ctx(WM))).toThrow(/No screened bags/);
    screened();
    expect(wh.requestAirportTruck(s, { note: 'Bay 2' }, ctx(WM))).toEqual({ bags: 2 });
    expect(s.notifications.some((n) => n.roles.includes('transport_manager') && /Airport truck needed/.test(n.title))).toBe(true);
  });

  it('the Transport Manager dispatches an airport truck, and only one per warehouse at a time', () => {
    screened();
    const trip = tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002' }, ctx(TM));
    expect(trip).toMatchObject({ type: 'Airport', status: 'Dispatched', warehouse_id: WH, airport_id: 'JED', expected_count: 2 });
    expect(s.drivers.find((d) => d.id === 'DRV-002').status).toBe('Busy');
    expect(() => tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-003', truckId: 'TRK-003' }, ctx(TM))).toThrow(/already open/);
    expect(() => tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-003', truckId: 'TRK-003' }, ctx(WM))).toThrow(PermissionError);
  });

  it('refuses to dispatch an airport truck with nothing screened', () => {
    expect(() => tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002' }, ctx(TM))).toThrow(/No screened bags/);
  });

  it('loads a screened bag per label scan and refuses duplicates, unscreened and cancelled bags', () => {
    const collection = screened();
    const trip = tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002' }, ctx(TM));
    const first = bagById(collection.bag_ids[0]);
    const ok = wh.scanBagToAirportTruck(s, trip.id, label(first), ctx(WM));
    expect(ok).toMatchObject({ ok: true, loaded: 1 });
    expect(bagById(first.id).status).toBe('Loaded to Airport Truck');
    expect(bagById(first.id).airport_trip_id).toBe(trip.id);
    expect(wh.scanBagToAirportTruck(s, trip.id, label(first), ctx(WM))).toMatchObject({ ok: false, result: 'DUPLICATE' });
    const cancelledBag = s.bags.find((b) => b.flight_id === 'FLT-SV-1944');
    expect(wh.scanBagToAirportTruck(s, trip.id, label(cancelledBag), ctx(WM))).toMatchObject({ ok: false, result: 'WRONG_FLIGHT' });
    expect(s.scanEvents.filter((e) => e.step === 'WAREHOUSE_LOAD_LABEL')).toHaveLength(3);
  });

  it('closes the load, telling Transport and the Airport Coordinator what is coming', () => {
    const collection = screened();
    const trip = tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002' }, ctx(TM));
    expect(() => wh.closeAirportLoad(s, trip.id, ctx(WM))).toThrow(/at least one bag/);
    for (const id of collection.bag_ids) wh.scanBagToAirportTruck(s, trip.id, label(bagById(id)), ctx(WM));
    const closed = wh.closeAirportLoad(s, trip.id, ctx(WM));
    expect(closed.status).toBe('Loaded');
    expect(closed.bag_ids).toHaveLength(2);
    expect(s.notifications.some((n) => n.roles.includes('airport_coordinator'))).toBe(true);
    expect(() => wh.scanBagToAirportTruck(s, trip.id, label(bagById(collection.bag_ids[0])), ctx(WM))).toThrow(/already closed/);
  });

  it('the loading queue tracks what is waiting and which truck is open', () => {
    const collection = screened();
    let q = wh.loadingQueue(s, WM, { now: NOW });
    expect(q.waiting).toBe(2);
    expect(q.trips).toHaveLength(0);
    const trip = tr.dispatchAirportTrip(s, { warehouseId: WH, driverId: 'DRV-002', truckId: 'TRK-002' }, ctx(TM));
    wh.scanBagToAirportTruck(s, trip.id, label(bagById(collection.bag_ids[0])), ctx(WM));
    q = wh.loadingQueue(s, WM, { now: NOW });
    expect(q.waiting).toBe(1);
    expect(q.trips.map((t) => t.id)).toEqual([trip.id]);
  });
});

describe('holding area (cancelled flights only)', () => {
  it('offers only cancelled-flight bags for holding', () => {
    receive(truckAtGate());
    const q = wh.holdingQueue(s, WM);
    expect(q.toHold).toHaveLength(8);
    expect(q.toHold.every((b) => b.flight_id === 'FLT-SV-1944')).toBe(true);
    expect(q.held).toHaveLength(0);
  });

  it('stores them on a named rack and requires the rack', () => {
    const ids = wh.holdingQueue(s, WM).toHold.map((b) => b.id);
    expect(() => wh.holdBags(s, ids, { rack: '' }, ctx(WM))).toThrow(/rack/i);
    const r = wh.holdBags(s, ids, { area: 'Holding area', rack: 'R-04' }, ctx(WM));
    expect(r.held).toBe(8);
    const q = wh.holdingQueue(s, WM);
    expect(q.held).toHaveLength(8);
    expect(q.held[0]).toMatchObject({ holding_area: 'Holding area', holding_rack: 'R-04', held_from_status: 'Received at Warehouse' });
    expect(wh.warehouseSummary(s, WM, { now: NOW }).held).toBe(8);
  });

  it('returns a held bag to its traveler only with an ID check and a signature', () => {
    const ids = wh.holdingQueue(s, WM).toHold.map((b) => b.id);
    wh.holdBags(s, ids, { rack: 'R-04' }, ctx(WM));
    expect(() => wh.returnBag(s, ids[0], { idChecked: true }, ctx(WM))).toThrow(BagStateError);
    const bag = wh.returnBag(s, ids[0], { idChecked: true, signature: 'data:image/png;base64,AA' }, ctx(WM));
    expect(bag.status).toBe('Returned to Traveler');
    expect(s.notifications.some((n) => n.traveler_id === bag.traveler_id && /returned/i.test(n.title))).toBe(true);
  });

  it('a rebooked bag: held → rebooked by Ops → re-tagged by Backend → released straight back to Screened', () => {
    const ids = wh.holdingQueue(s, WM).toHold.map((b) => b.id);
    wh.holdBags(s, ids, { rack: 'R-04' }, ctx(WM));
    const bagId = ids[0];
    markRebooked(s, bagId, 'FLT-GA-981', { user: OPS, now: NOW });
    expect(wh.holdingQueue(s, WM).awaitingRetag.map((b) => b.id)).toContain(bagId);
    expect(() => wh.releaseRebooked(s, bagId, ctx(WM))).toThrow(BagStateError); // not re-tagged yet

    retagRebooked(s, bagId, { tagNo: 'RBL-D-900001', airlineTagNo: '1260029999' }, { user: BE, now: NOW });
    expect(bagById(bagId).status).toBe('Tag Assigned');
    expect(wh.holdingQueue(s, WM).readyToRelease.map((b) => b.id)).toContain(bagId);

    // It was held from "Received at Warehouse", so it re-enters there — it still has to be screened.
    const released = wh.releaseRebooked(s, bagId, ctx(WM));
    expect(released.status).toBe('Received at Warehouse');
    expect(released.holding_rack).toBeNull();
    expect(wh.screeningQueue(s, WM, { now: NOW }).some((g) => g.bags.some((b) => b.id === bagId))).toBe(true);
    wh.screenBags(s, [bagId], ctx(WM));
    expect(wh.loadingQueue(s, WM, { now: NOW }).waiting).toBe(1);
  });

  it('a bag held AFTER screening goes straight back to "Screened" — it is not screened twice', () => {
    const trip = truckAtGate();
    receive(trip);
    const bagId = trip.bag_ids[0];
    wh.screenBags(s, [bagId], ctx(WM));
    expect(bagById(bagId).status).toBe('Screened');

    s.flights.find((f) => f.id === bagById(bagId).flight_id).status = 'Cancelled'; // flight cancelled after screening
    wh.holdBags(s, [bagId], { rack: 'R-09' }, ctx(WM));
    markRebooked(s, bagId, 'FLT-GA-981', { user: OPS, now: NOW });
    retagRebooked(s, bagId, { tagNo: 'RBL-D-900003' }, { user: BE, now: NOW });
    expect(wh.releaseRebooked(s, bagId, ctx(WM)).status).toBe('Screened');
  });

  it('a bag that was only checked in cannot be released to loading (it must take the normal steps)', () => {
    fullCheckin('2000000001', CHK1);
    const bag = s.bags.find((b) => b.status === 'Checked-in');
    s.flights.find((f) => f.id === bag.flight_id).status = 'Cancelled';
    wh.holdBags(s, [bag.id], { rack: 'R-01' }, ctx(WM));
    markRebooked(s, bag.id, 'FLT-GA-981', { user: OPS, now: NOW });
    retagRebooked(s, bag.id, { tagNo: 'RBL-D-900002' }, { user: BE, now: NOW });
    expect(() => wh.releaseRebooked(s, bag.id, ctx(WM))).toThrow(/normal steps/);
  });

  it('RBAC: Transport Staff cannot hold, return or release bags', () => {
    const ids = wh.holdingQueue(s, WM).toHold.map((b) => b.id);
    expect(() => wh.holdBags(s, ids, { rack: 'R-04' }, ctx(TS1))).toThrow(PermissionError);
    wh.holdBags(s, ids, { rack: 'R-04' }, ctx(WM));
    expect(() => wh.returnBag(s, ids[0], { idChecked: true, signature: 'x' }, ctx(TS1))).toThrow(PermissionError);
  });
});

describe('exceptions (read-only for the Warehouse Manager)', () => {
  it('lists open exceptions on my bags', () => {
    const trip = truckAtGate();
    wh.startReceiving(s, trip.id, { value: trip.truck_id, method: 'HANDHELD', symbology: 'QR' }, ctx(WM));
    wh.completeReceiving(s, trip.id, ctx(WM)); // nothing scanned → Count Mismatch
    const rows = wh.warehouseExceptions(s, WM);
    expect(rows.some((e) => e.type === 'Count Mismatch')).toBe(true);
    expect(rows.every((e) => e.status === 'Open')).toBe(true);
  });
});

describe('scope', () => {
  it('a Warehouse Manager of another warehouse sees nothing of mine', () => {
    receive(truckAtGate());
    const other = { ...WM, id: 'WM-900', employee_id: 'WM-900', warehouse_id: 'WH-OTHER' };
    expect(wh.monitorRows(s, other, { now: NOW })).toHaveLength(0);
    expect(wh.screeningQueue(s, other, { now: NOW })).toHaveLength(0);
    expect(wh.holdingQueue(s, other).toHold).toHaveLength(0);
  });

  it('Ops (scope: all) can read the warehouse monitor', () => {
    receive(truckAtGate());
    expect(wh.monitorRows(s, OPS, { now: NOW }).length).toBeGreaterThan(0);
  });
});
