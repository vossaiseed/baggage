import { describe, it, expect } from 'vitest';
import { advanceBag, holdForCancelledFlight, markRebooked, retagRebooked, returnToTraveler, BagStateError } from '../../shared/services/bagService.js';
import { PermissionError } from '../../shared/rbac.js';
import { BAG_STATUSES, SIDE_STATUSES } from '../../shared/constants.js';
import { stateWithBag, users } from './helpers.js';

const actorFor = {
  'Data Verified': users.backend, 'Tag Assigned': users.backend, 'Checked-in': users.checkin,
  'Loaded to Collection Truck': users.tstaff, 'Received at Warehouse': users.wm, 'Screened': users.wm,
  'Loaded to Airport Truck': users.wm, 'In Transit to Airport': users.tstaff, 'Received at Airport': users.apc,
  'Handed to Airport Authority': users.apc, 'SGS Voucher Accepted': users.apc, 'Loaded on Aircraft': users.backend,
};
const ctxFull = (user) => ({ user, countMatch: true, voucherCountMatch: true });

describe('advanceBag — forward only, one step at a time', () => {
  it('walks all 13 statuses in order, with the right role at each step, and records history + audit', () => {
    const s = stateWithBag();
    for (const status of BAG_STATUSES.slice(1)) {
      const { bag, changed } = advanceBag(s, 'B1', status, ctxFull(actorFor[status]));
      expect(changed).toBe(true);
      expect(bag.status).toBe(status);
    }
    expect(s.bags[0].status_history.map((h) => h.to)).toEqual(BAG_STATUSES.slice(1));
    expect(s.auditLog.filter((a) => a.action === 'bag.advance')).toHaveLength(12);
  });

  it('rejects skipping a step', () => {
    const s = stateWithBag();
    expect(() => advanceBag(s, 'B1', 'Tag Assigned', ctxFull(users.backend))).toThrowError(expect.objectContaining({ code: 'SKIP_STEP' }));
    expect(s.bags[0].status).toBe('Declared');
  });

  it('rejects moving backward', () => {
    const s = stateWithBag({ status: 'Screened' });
    expect(() => advanceBag(s, 'B1', 'Received at Warehouse', ctxFull(users.wm))).toThrowError(expect.objectContaining({ code: 'BACKWARD' }));
  });

  it('rejects advancing to the current status (except the idempotent trip start)', () => {
    const s = stateWithBag({ status: 'Screened' });
    expect(() => advanceBag(s, 'B1', 'Screened', ctxFull(users.wm))).toThrowError(expect.objectContaining({ code: 'NOT_FORWARD' }));
    const t = stateWithBag({ status: 'In Transit to Airport' });
    const r = advanceBag(t, 'B1', 'In Transit to Airport', ctxFull(users.tstaff));
    expect(r.changed).toBe(false);
    expect(t.bags[0].status_history).toHaveLength(0);
  });

  it('rejects unknown statuses and unknown bags', () => {
    const s = stateWithBag();
    expect(() => advanceBag(s, 'B1', 'Teleported', ctxFull(users.backend))).toThrowError(expect.objectContaining({ code: 'UNKNOWN_STATUS' }));
    expect(() => advanceBag(s, 'NOPE', 'Data Verified', ctxFull(users.backend))).toThrowError(expect.objectContaining({ code: 'BAG_NOT_FOUND' }));
  });

  it('side statuses can NOT be reached or left through advanceBag', () => {
    const s = stateWithBag({ status: 'Screened' });
    for (const side of Object.values(SIDE_STATUSES)) {
      expect(() => advanceBag(s, 'B1', side, ctxFull(users.ops))).toThrowError(expect.objectContaining({ code: 'SIDE_STATUS' }));
    }
    const held = stateWithBag({ status: SIDE_STATUSES.HELD });
    expect(() => advanceBag(held, 'B1', 'Loaded to Airport Truck', ctxFull(users.wm))).toThrowError(expect.objectContaining({ code: 'SIDE_STATUS' }));
  });

  it('enforces RBAC: wrong role and out-of-scope staff are blocked', () => {
    const s = stateWithBag({ status: 'Tag Assigned' });
    expect(() => advanceBag(s, 'B1', 'Checked-in', ctxFull(users.wm))).toThrow(PermissionError);
    expect(() => advanceBag(s, 'B1', 'Checked-in', ctxFull(users.checkinB))).toThrow(PermissionError); // other area
    expect(() => advanceBag(s, 'B1', 'Checked-in', ctxFull(users.ops))).toThrow(PermissionError);
    expect(() => advanceBag(s, 'B1', 'Checked-in', { countMatch: true })).toThrow(PermissionError); // no user
    expect(s.bags[0].status).toBe('Tag Assigned');
  });

  it('a disabled user cannot advance a bag', () => {
    const s = stateWithBag({ status: 'Tag Assigned' });
    expect(() => advanceBag(s, 'B1', 'Checked-in', ctxFull({ ...users.checkin, status: 'Disabled' }))).toThrow(PermissionError);
  });

  describe('guards (preconditions)', () => {
    it('Checked-in needs weight, airline criteria, scanned tag and count match', () => {
      const run = (over, ctx = { countMatch: true }) => {
        const s = stateWithBag({ status: 'Tag Assigned', ...over });
        return () => advanceBag(s, 'B1', 'Checked-in', { user: users.checkin, ...ctx });
      };
      expect(run({ weight_kg: null })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
      expect(run({ meets_airline_criteria: false })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
      expect(run({ tag_verified: false })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
      expect(run({}, {})).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
      expect(run({})).not.toThrow();
    });
    it('Tag Assigned needs an internal tag; SGS voucher needs a count match', () => {
      const s = stateWithBag({ status: 'Data Verified', tag_no: null });
      expect(() => advanceBag(s, 'B1', 'Tag Assigned', { user: users.backend })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
      const t = stateWithBag({ status: 'Handed to Airport Authority' });
      expect(() => advanceBag(t, 'B1', 'SGS Voucher Accepted', { user: users.apc })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
    });
    it('Received at Warehouse / Airport and Loaded to Collection Truck need a count match', () => {
      for (const [from, to, u] of [['Checked-in', 'Loaded to Collection Truck', users.tstaff], ['Loaded to Collection Truck', 'Received at Warehouse', users.wm], ['In Transit to Airport', 'Received at Airport', users.apc]]) {
        const s = stateWithBag({ status: from });
        expect(() => advanceBag(s, 'B1', to, { user: u })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
        expect(() => advanceBag(s, 'B1', to, { user: u, countMatch: true })).not.toThrow();
      }
    });
  });
});

describe('named side-status helpers', () => {
  it('holdForCancelledFlight: only cancelled-flight bags, from Checked-in..Received at Airport, with area + rack', () => {
    const ok = stateWithBag({ status: 'Received at Warehouse', flight_id: 'FC' });
    const bag = holdForCancelledFlight(ok, 'B1', { user: users.wm, holdingArea: 'HOLD-1', holdingRack: 'R3' });
    expect(bag.status).toBe(SIDE_STATUSES.HELD);
    expect([bag.holding_area, bag.holding_rack]).toEqual(['HOLD-1', 'R3']);

    const active = stateWithBag({ status: 'Received at Warehouse', flight_id: 'F1' });
    expect(() => holdForCancelledFlight(active, 'B1', { user: users.wm })).toThrowError(expect.objectContaining({ code: 'FLIGHT_NOT_CANCELLED' }));
    const early = stateWithBag({ status: 'Declared', flight_id: 'FC' });
    expect(() => holdForCancelledFlight(early, 'B1', { user: users.wm })).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    const wrongRole = stateWithBag({ status: 'Screened', flight_id: 'FC' });
    expect(() => holdForCancelledFlight(wrongRole, 'B1', { user: users.checkin })).toThrow(PermissionError);
  });

  it('rebook -> Rebooked, then re-tag with a NEW tag re-enters at Tag Assigned', () => {
    const s = stateWithBag({ status: SIDE_STATUSES.HELD, flight_id: 'FC' });
    markRebooked(s, 'B1', 'F2', { user: users.ops });
    expect(s.bags[0]).toMatchObject({ status: SIDE_STATUSES.REBOOKED, flight_id: 'F2', previous_flight_id: 'FC', retag_required: true });
    expect(() => retagRebooked(s, 'B1', { tagNo: 'RBL-D-000001' }, { user: users.backend })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
    retagRebooked(s, 'B1', { tagNo: 'RBL-D-000002', airlineTagNo: '0650012345' }, { user: users.backend });
    expect(s.bags[0]).toMatchObject({ status: 'Tag Assigned', tag_no: 'RBL-D-000002', airline_tag_no: '0650012345', tag_verified: false, retag_required: false });
    expect(s.bags[0].previous_tags).toHaveLength(1);
    // and it then continues forward normally
    expect(() => advanceBag(s, 'B1', 'Checked-in', { user: { ...users.checkin }, countMatch: true })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
  });

  it('rebook only from Held, only onto a live flight, only by someone with flight rights', () => {
    const notHeld = stateWithBag({ status: 'Screened' });
    expect(() => markRebooked(notHeld, 'B1', 'F2', { user: users.ops })).toThrowError(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
    const held = stateWithBag({ status: SIDE_STATUSES.HELD, flight_id: 'FC' });
    expect(() => markRebooked(held, 'B1', 'FC', { user: users.ops })).toThrowError(expect.objectContaining({ code: 'FLIGHT_CANCELLED' }));
    expect(() => markRebooked(held, 'B1', 'NOPE', { user: users.ops })).toThrowError(expect.objectContaining({ code: 'FLIGHT_NOT_FOUND' }));
    expect(() => markRebooked(held, 'B1', 'F2', { user: users.checkin })).toThrow(PermissionError);
  });

  it('returnToTraveler needs ID check + signature, and only from Held', () => {
    const s = stateWithBag({ status: SIDE_STATUSES.HELD });
    expect(() => returnToTraveler(s, 'B1', { user: users.wm })).toThrowError(expect.objectContaining({ code: 'GUARD_FAILED' }));
    returnToTraveler(s, 'B1', { user: users.wm, idChecked: true, signature: 'data:sig' });
    expect(s.bags[0].status).toBe(SIDE_STATUSES.RETURNED);
    const bad = stateWithBag({ status: 'Screened' });
    expect(() => returnToTraveler(bad, 'B1', { user: users.wm, idChecked: true, signature: 'x' })).toThrow(BagStateError);
  });

  it('every side-status change is audit-logged', () => {
    const s = stateWithBag({ status: 'Screened', flight_id: 'FC' });
    holdForCancelledFlight(s, 'B1', { user: users.wm });
    expect(s.auditLog.map((a) => a.action)).toEqual(['bag.hold']);
  });
});
