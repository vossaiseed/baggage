import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../shared/store.js';
import { seedDeparture, SAMPLE_TAG_FILES } from '../../shared/seed/departure.js';
import * as be from '../../shared/services/backendService.js';
import * as tags from '../../shared/services/tagService.js';
import * as ck from '../../shared/services/checkinService.js';
import * as fl from '../../shared/services/flightService.js';
import * as wh from '../../shared/services/warehouseService.js';
import { retagRebooked } from '../../shared/services/bagService.js';
import { raiseException } from '../../shared/services/exceptionService.js';
import { PermissionError } from '../../shared/rbac.js';
import { ServiceError } from '../../shared/services/errors.js';
import { SIDE_STATUSES } from '../../shared/constants.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();
const H = 3600e3;
const SV = 'FLT-SV-1821';     // cut-off NOW + 6 h
const CANCELLED = 'FLT-SV-1944'; // seeded Cancelled, 8 bags already at the warehouse
const PK = 'FLT-PK-760';      // cut-off NOW + 20 h

let s; let BE; let CHK1; let WM; let OPS;
const ctx = (user, now = NOW) => ({ user, now });
const trav = (nid) => s.travelers.find((t) => t.nusuk_id === nid);
const asg = (nid) => s.collectionAssignments.find((a) => a.traveler_id === trav(nid).id);
const csv = (id) => SAMPLE_TAG_FILES.find((f) => f.id === id).csv;
const label = (bag) => ({ value: bag.tag_no, method: 'HANDHELD', symbology: 'CODE128' });
const flight = (id) => s.flights.find((f) => f.id === id);
const row = (rows, id) => rows.find((r) => r.flight.id === id);

function prepare(code, file) {
  for (const r of be.dataRows(s)) if (r.flight === code && r.match.status === 'matched' && !r.traveler.data_verified) be.matchAndVerify(s, r.traveler.id, ctx(BE));
  tags.importTagBatch(s, { csv: csv(file) }, ctx(BE));
  tags.assignTags(s, code, ctx(BE));
  tags.releaseTags(s, code, ctx(BE));
}

/** Residence check-in → bags "Checked-in" and handed to Transport. */
function fullCheckin(nid, user = CHK1) {
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

beforeEach(() => {
  s = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(s, { now: NOW });
  BE = s.users.find((u) => u.id === 'BE-001');
  CHK1 = s.users.find((u) => u.id === 'CHK-001');
  WM = s.users.find((u) => u.id === 'WM-001');
  OPS = s.users.find((u) => u.id === 'OPS-001');
});

describe('flight board', () => {
  it('lists live flights by cut-off with their bag groups, cancelled/closed last', () => {
    const rows = fl.listFlights(s, OPS, { now: NOW });
    const ids = rows.map((r) => r.flight.id);
    expect(ids[0]).toBe(SV);                       // earliest cut-off
    expect(ids.indexOf(CANCELLED)).toBe(ids.length - 1); // cancelled sinks to the bottom
    expect(row(rows, SV).priorityRank).toBe(1);
    expect(row(rows, CANCELLED).counts.total).toBe(8);
    expect(row(rows, CANCELLED).counts.toMove).toBe(8); // at the warehouse, not yet held
    expect(row(rows, SV).window.cutOff).toBe(flight(SV).cut_off_at);
  });

  it('the 24 h forecast ranks by cut-off and reports the worst alert level', () => {
    const board = fl.forecastBoard(s, OPS, { now: NOW });
    expect(board.map((r) => r.flight.id)).not.toContain(CANCELLED); // cancelled flights are not forecast
    expect(board[0].flight.id).toBe(SV);
    expect(board[0].level).toBe('green'); // 6 h to go, nothing is late yet
    // 30 minutes before the cut-off, bags that are not at the airport turn the row red
    const late = fl.forecastBoard(s, OPS, { now: NOW + 5.75 * H });
    expect(row(late, SV).level).toBe('red');
  });

  it('flightDetail lists the bags with their travelers, newest status first', () => {
    const d = fl.flightDetail(s, CANCELLED, OPS, { now: NOW });
    expect(d.bags).toHaveLength(8);
    expect(d.bags.every((b) => b.traveler)).toBe(true);
    expect(d.counts.byStatus['Received at Warehouse']).toBe(8);
  });

  it('leaves pre-v7 (legacy) bags out of every count — they can never move through the v7 line', () => {
    s.bags.push({ id: 'BAG-OLD-1', traveler_id: 'TRV-OLD', flight_id: SV, status: 'Checked-in', legacy: true, status_history: [] });
    const before = row(fl.listFlights(s, OPS, { now: NOW }), SV).counts.total;
    expect(before).toBe(s.bags.filter((b) => b.flight_id === SV && !b.legacy).length);
    expect(fl.flightDetail(s, SV, OPS, { now: NOW }).bags.map((b) => b.bag.id)).not.toContain('BAG-OLD-1');
    // and it must never block a closure
    expect(fl.closureChecklist(s, SV, OPS, { now: NOW }).outstanding.map((o) => o.bag.id)).not.toContain('BAG-OLD-1');
  });

  it('only a role with flight:read may see the board', () => {
    expect(() => fl.listFlights(s, trav('2000000001'), { now: NOW })).toThrow(PermissionError);
  });
});

describe('createFlight', () => {
  it('creates a "New" flight with a 12 h window and slots in every area', () => {
    const areas = s.collectionAreas.length;
    const { flight: f, slotsCreated } = fl.createFlight(s, { code: 'sv 7777', airline_code: 'sv', route: 'JED → KUL', cut_off_at: NOW + 18 * H }, ctx(OPS));
    expect(f.id).toBe('FLT-SV-7777');
    expect(f.code).toBe('SV 7777');
    expect(f.status).toBe('New');
    expect(new Date(f.window_start_at).getTime()).toBe(new Date(f.cut_off_at).getTime() - 12 * H);
    expect(slotsCreated).toBe(areas * 4); // 8 h collection window / 2 h slots
    expect(s.notifications.some((n) => n.title.includes('New flight SV 7777'))).toBe(true);
  });

  it('refuses a bad code, an unknown airline, a duplicate and a cut-off in the past', () => {
    expect(() => fl.createFlight(s, { code: 'nope', airline_code: 'SV', cut_off_at: NOW + H }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => fl.createFlight(s, { code: 'ZZ 100', airline_code: 'ZZ', cut_off_at: NOW + H }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'NO_AIRLINE' }));
    expect(() => fl.createFlight(s, { code: 'SV 1821', airline_code: 'SV', cut_off_at: NOW + H }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'DUPLICATE' }));
    expect(() => fl.createFlight(s, { code: 'SV 7778', airline_code: 'SV', cut_off_at: NOW - H }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => fl.createFlight(s, { code: 'SV 7779', airline_code: 'SV', cut_off_at: NOW + H }, ctx(CHK1))).toThrow(PermissionError);
  });
});

describe('updateFlight', () => {
  it('moving the cut-off re-derives the window and flags collections left outside it', () => {
    const a = asg('2000000001'); // booked inside SV 1821's current collection window
    const res = fl.updateFlight(s, SV, { cut_off_at: NOW + 20 * H }, ctx(OPS));
    expect(new Date(res.flight.window_start_at).getTime()).toBe(NOW + 8 * H);
    expect(res.slotsOutsideWindow.map((x) => x.assignment_id)).toContain(a.id);
    expect(s.collectionAssignments.find((x) => x.id === a.id).slot_outside_window).toBe(true);
    expect(s.notifications.some((n) => n.traveler_id === a.traveler_id && /pick a new slot/i.test(n.body))).toBe(true);
  });

  it('refuses a cancelled or closed flight, and a cut-off in the past', () => {
    expect(() => fl.updateFlight(s, CANCELLED, { route: 'JED → DAC' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'FLIGHT_CLOSED' }));
    expect(() => fl.updateFlight(s, SV, { cut_off_at: NOW - H }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
  });
});

describe('cancelFlight', () => {
  it('calls off the collections that have not happened, frees their slots and leaves the bags where they are', () => {
    const a = asg('2000000001');
    const slot = s.collectionSlots.find((x) => x.id === a.slot_id);
    const booked = slot.booked_count;
    const bagsBefore = s.bags.filter((b) => b.flight_id === SV).map((b) => b.status);

    const res = fl.cancelFlight(s, SV, { reason: 'Airline cancelled the departure.' }, ctx(OPS));

    expect(flight(SV).status).toBe('Cancelled');
    expect(flight(SV).cancel_reason).toBe('Airline cancelled the departure.');
    expect(flight(SV).cancelled_at).toBeTruthy();
    expect(res.assignmentsCancelled).toContain(a.id);
    expect(s.collectionAssignments.find((x) => x.id === a.id).status).toBe('Cancelled');
    expect(slot.booked_count).toBe(booked - 1);
    expect(s.bags.filter((b) => b.flight_id === SV).map((b) => b.status)).toEqual(bagsBefore); // no bag moved
    expect(res.bagsToHold).toHaveLength(0); // nothing was checked in yet
  });

  it('hands the bags already in the line to the warehouse holding queue', () => {
    prepare('SV 1821', 'sv');
    const a = fullCheckin('2000000001');
    const res = fl.cancelFlight(s, SV, { reason: 'Technical failure on the aircraft.' }, ctx(OPS));
    expect(res.bagsToHold).toHaveLength(2);
    expect(res.assignmentsCancelled).not.toContain(a.id); // already collected — nothing to call off
    expect(res.warehouses).toContain('WH-MAKKAH');
    // (the 8 bags of the seeded cancelled flight are in this queue too)
    const held = wh.holdingQueue(s, WM).toHold.map((b) => b.id);
    expect(held).toEqual(expect.arrayContaining(res.bagsToHold));
  });

  it('tells every operational role and every affected traveler (in-app + SMS)', () => {
    const before = s.notifications.length;
    const res = fl.cancelFlight(s, SV, { reason: 'Operational cancellation.' }, ctx(OPS));
    const added = s.notifications.slice(before);
    const roleFanout = added.find((n) => (n.roles || []).includes('warehouse_manager'));
    expect(roleFanout.severity).toBe('critical');
    expect(roleFanout.roles).toEqual(expect.arrayContaining(['backend', 'checkin', 'transport_manager', 'transport_staff', 'warehouse_manager', 'airport_coordinator', 'window_monitor', 'ops_manager']));
    expect(res.travelersNotified).toBeGreaterThan(0);
    const t = s.travelers.find((x) => x.flight_id === SV);
    expect(added.some((n) => n.traveler_id === t.id && n.channel === 'in-app')).toBe(true);
    expect(added.some((n) => n.traveler_id === t.id && n.channel === 'sms')).toBe(true);
  });

  it('needs a reason, refuses a second cancellation and refuses a closed flight', () => {
    expect(() => fl.cancelFlight(s, SV, { reason: '' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'REASON_REQUIRED' }));
    expect(() => fl.cancelFlight(s, CANCELLED, { reason: 'Again please' }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'ALREADY_CANCELLED' }));
    expect(() => fl.cancelFlight(s, SV, { reason: 'Not my job' }, ctx(WM))).toThrow(PermissionError);
  });

  it('a cancelled flight cannot be booked and drops out of the forecast', () => {
    fl.cancelFlight(s, PK, { reason: 'Airline withdrew the flight.' }, ctx(OPS));
    expect(fl.forecastBoard(s, OPS, { now: NOW }).map((r) => r.flight.id)).not.toContain(PK);
  });
});

describe('rebookBags', () => {
  /** The seeded cancelled flight, racked by the Warehouse Manager. */
  function heldBags() {
    const ids = s.bags.filter((b) => b.flight_id === CANCELLED).map((b) => b.id);
    wh.holdBags(s, ids, { rack: 'R1' }, ctx(WM));
    return ids;
  }

  it('moves held bags to a new flight, requires a re-tag and takes the traveler with them', () => {
    const ids = heldBags();
    const t = s.bags.find((b) => b.id === ids[0]).traveler_id;
    const theirs = s.bags.filter((b) => b.traveler_id === t).map((b) => b.id);
    const res = fl.rebookBags(s, { bagIds: theirs, newFlightId: PK }, ctx(OPS));
    expect(res.rebooked.sort()).toEqual([...theirs].sort());
    expect(res.travelersMoved).toContain(t);
    expect(s.travelers.find((x) => x.id === t).flight_id).toBe(PK);
    for (const id of theirs) {
      const b = s.bags.find((x) => x.id === id);
      expect(b.status).toBe(SIDE_STATUSES.REBOOKED);
      expect(b.retag_required).toBe(true);
      expect(b.flight_id).toBe(PK);
    }
    expect(s.notifications.some((n) => (n.roles || []).includes('backend') && /rebooked/i.test(n.title))).toBe(true);
  });

  it('records where a whole cancelled flight went, once no held bag is left', () => {
    const ids = heldBags();
    expect(flight(CANCELLED).rebooked_to_flight_id).toBeFalsy();
    fl.rebookBags(s, { bagIds: ids.slice(0, 2), newFlightId: PK }, ctx(OPS));
    expect(flight(CANCELLED).rebooked_to_flight_id).toBeFalsy(); // 6 still held
    fl.rebookBags(s, { bagIds: ids.slice(2), newFlightId: PK }, ctx(OPS));
    expect(flight(CANCELLED).rebooked_to_flight_id).toBe(PK);
  });

  it('skips a bag that is not held, and refuses a cancelled target or an empty selection', () => {
    const ids = heldBags();
    const other = s.bags.find((b) => b.flight_id === SV).id;
    const res = fl.rebookBags(s, { bagIds: [ids[0], other], newFlightId: PK }, ctx(OPS));
    expect(res.rebooked).toEqual([ids[0]]);
    expect(res.skipped[0]).toMatchObject({ bag_id: other });
    expect(() => fl.rebookBags(s, { bagIds: [ids[1]], newFlightId: CANCELLED }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'FLIGHT_CANCELLED' }));
    expect(() => fl.rebookBags(s, { bagIds: [], newFlightId: PK }, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'NOTHING_SELECTED' }));
    expect(() => fl.rebookBags(s, { bagIds: [ids[2]], newFlightId: PK }, ctx(WM))).toThrow(PermissionError);
  });

  it('a rebooked bag re-enters the line once Backend re-tags it', () => {
    const ids = heldBags();
    fl.rebookBags(s, { bagIds: [ids[0]], newFlightId: PK }, ctx(OPS));
    retagRebooked(s, ids[0], { tagNo: 'RBL-D-900001', airlineTagNo: '2140030099' }, ctx(BE));
    expect(s.bags.find((b) => b.id === ids[0]).status).toBe('Tag Assigned');
    expect(wh.holdingQueue(s, WM).readyToRelease.map((b) => b.id)).toContain(ids[0]);
  });
});

describe('closure', () => {
  it('blocks while bags are unaccounted for and names what is missing', () => {
    const c = fl.closureChecklist(s, CANCELLED, OPS, { now: NOW });
    expect(c.canClose).toBe(false);
    expect(c.outstanding).toHaveLength(8);
    expect(c.blockers.join(' ')).toMatch(/8 bag\(s\) are not accounted for/);
    expect(() => fl.closeFlight(s, CANCELLED, {}, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'NOT_CLOSEABLE' }));
  });

  it('closes a flight whose bags are all accounted for, and refuses a second closure', () => {
    const ids = s.bags.filter((b) => b.flight_id === CANCELLED).map((b) => b.id);
    wh.holdBags(s, ids, { rack: 'R1' }, ctx(WM));
    const c = fl.closureChecklist(s, CANCELLED, OPS, { now: NOW });
    expect(c.canClose).toBe(true);
    expect(c.counts.held).toBe(8);
    const { flight: f } = fl.closeFlight(s, CANCELLED, { note: 'All bags racked, travelers contacted.' }, ctx(OPS));
    expect(f.status).toBe('Completed');
    expect(f.completed_at).toBeTruthy();
    expect(fl.closedFlights(s, OPS).map((x) => x.id)).toContain(CANCELLED);
    expect(() => fl.closeFlight(s, CANCELLED, {}, ctx(OPS))).toThrowError(expect.objectContaining({ code: 'NOT_CLOSEABLE' }));
  });

  it('a High/Critical open exception blocks the closure; a Medium one only warns', () => {
    const ids = s.bags.filter((b) => b.flight_id === CANCELLED).map((b) => b.id);
    wh.holdBags(s, ids, { rack: 'R1' }, ctx(WM));
    const medium = raiseException(s, { type: 'Data Mismatch', severity: 'Medium', flight_id: CANCELLED, notes: 'Name spelling' }, ctx(OPS));
    expect(fl.closureChecklist(s, CANCELLED, OPS, { now: NOW }).canClose).toBe(true);
    expect(fl.closureChecklist(s, CANCELLED, OPS, { now: NOW }).warnings.map((e) => e.id)).toContain(medium.id);
    raiseException(s, { type: 'Manifest Gap', severity: 'High', flight_id: CANCELLED, notes: '2 bags unexplained' }, ctx(OPS));
    const c = fl.closureChecklist(s, CANCELLED, OPS, { now: NOW });
    expect(c.canClose).toBe(false);
    expect(c.blockers.join(' ')).toMatch(/High\/Critical exception/);
  });

  it('only Ops may close a flight', () => {
    expect(() => fl.closeFlight(s, SV, {}, ctx(WM))).toThrow(PermissionError);
    expect(ServiceError).toBeTruthy();
  });
});
