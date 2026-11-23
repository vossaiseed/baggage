/**
 * reportService — read-only roll-ups for the Ops "Reports" screen (and the Admin/Monitor views).
 * Nothing here writes to the store.
 *
 *   opsReport      one object with every section the Reports screen shows
 *   bagLedger / exceptionLedger / scanLedger   flat rows, ready for CSV
 *   toCsv          the only CSV writer (RFC-4180 quoting)
 */
import { BAG_STATUSES, SIDE_STATUS_LIST, ACCOUNTED_STATUSES, SCAN_METHODS, WINDOW } from '../constants.js';
import { assertCan, scopeFilter } from '../rbac.js';
import { computeAlerts, windowFor, stageAt } from '../time/window.js';
import { bagGroups } from './flightService.js';
import { isOpenException } from './exceptionService.js';
import { reportSummary } from './transportService.js';

const ms = (d) => new Date(d).getTime();
const H = 3600e3;
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** When a bag first reached a status (from its own history), or null. */
export function reachedAt(bag, status) {
  return (bag.status_history || []).find((h) => h.to === status)?.at ?? null;
}

/** Minutes a bag spent between two statuses, or null when it has not done both. */
function minutesBetween(bag, from, to) {
  const a = reachedAt(bag, from);
  const b = reachedAt(bag, to);
  return a && b ? Math.round((ms(b) - ms(a)) / 60000) : null;
}

/**
 * Everything the Reports screen shows, for one time range (default: the last 24 h).
 * @param {object} state @param {object} user
 * @param {{ now?: number|string|Date, sinceHours?: number, since?: string|number|Date, until?: string|number|Date }} [opts]
 */
export function opsReport(state, user, opts = {}) {
  assertCan(user, 'report:read');
  const now = ms(opts.now ?? Date.now());
  const since = opts.since != null ? ms(opts.since) : now - (opts.sinceHours ?? 24) * H;
  const until = opts.until != null ? ms(opts.until) : now;
  const inRange = (iso) => !!iso && ms(iso) >= since && ms(iso) <= until;

  const bags = scopeFilter(user, 'bags', state.bags).filter((b) => !b.legacy);
  const flights = scopeFilter(user, 'flights', state.flights).filter((f) => !f.legacy);
  const assignments = scopeFilter(user, 'collectionAssignments', state.collectionAssignments);
  const exceptions = scopeFilter(user, 'exceptions', state.exceptions);
  const scans = (state.scanEvents || []).filter((s) => inRange(s.at));

  // ── flights: progress and window compliance
  const flightRows = flights.map((f) => {
    const mine = bags.filter((b) => b.flight_id === f.id);
    const alerts = computeAlerts(now, f, mine);
    return {
      flight: f,
      counts: bagGroups(mine),
      window: f.cut_off_at ? windowFor(f.cut_off_at) : null,
      stage: f.cut_off_at ? stageAt(now, f.cut_off_at) : null,
      alerts,
      level: alerts.some((a) => a.level === 'red') ? 'red' : (alerts.length ? 'amber' : 'green'),
      avgResidenceToWarehouseMin: avg(mine.map((b) => minutesBetween(b, 'Checked-in', 'Received at Warehouse')).filter((n) => n != null)),
      avgWarehouseDwellMin: avg(mine.map((b) => minutesBetween(b, 'Received at Warehouse', 'Loaded to Airport Truck')).filter((n) => n != null)),
      avgWarehouseToAirportMin: avg(mine.map((b) => minutesBetween(b, 'In Transit to Airport', 'Received at Airport')).filter((n) => n != null)),
    };
  }).sort((a, b) => ms(a.flight.cut_off_at || 0) - ms(b.flight.cut_off_at || 0));

  // ── bags: where everything is right now, and what moved in the range
  const byStatus = Object.fromEntries([...BAG_STATUSES, ...SIDE_STATUS_LIST].map((s) => [s, bags.filter((b) => b.status === s).length]));
  const movedInRange = bags.filter((b) => (b.status_history || []).some((h) => inRange(h.at))).length;

  // ── check-in at the residence
  const byAssignmentStatus = /** @type {Record<string, number>} */ ({});
  for (const a of assignments) byAssignmentStatus[a.status] = (byAssignmentStatus[a.status] || 0) + 1;

  // ── warehouse stage timings (over every bag that has been through it)
  const dwell = bags.map((b) => minutesBetween(b, 'Received at Warehouse', 'Loaded to Airport Truck')).filter((n) => n != null);

  // ── exceptions
  const open = exceptions.filter(isOpenException);
  const byType = /** @type {Record<string, number>} */ ({});
  for (const e of exceptions) byType[e.type] = (byType[e.type] || 0) + 1;
  const resolvedInRange = exceptions.filter((e) => inRange(e.resolved_at));

  // ── scans
  const byMethod = Object.fromEntries(SCAN_METHODS.map((m) => [m, scans.filter((s) => s.method === m).length]));
  const byStep = /** @type {Record<string, number>} */ ({});
  for (const s of scans) byStep[s.step] = (byStep[s.step] || 0) + 1;

  return {
    range: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), hours: Math.round((until - since) / H) },
    flights: flightRows,
    totals: {
      flights: flights.length,
      flightsLive: flights.filter((f) => !['Cancelled', 'Completed'].includes(f.status)).length,
      flightsCancelled: flights.filter((f) => f.status === 'Cancelled').length,
      flightsClosed: flights.filter((f) => f.status === 'Completed').length,
      bags: bags.length,
      bagsAccounted: bags.filter((b) => ACCOUNTED_STATUSES.includes(b.status)).length,
      bagsToMove: bags.filter((b) => !ACCOUNTED_STATUSES.includes(b.status)).length,
      bagsMovedInRange: movedInRange,
      travelers: (state.travelers || []).filter((t) => !t.legacy).length,
    },
    bags: { byStatus },
    checkin: {
      byStatus: byAssignmentStatus,
      collected: assignments.filter((a) => ['Collected', 'Handed to Transport'].includes(a.status)).length,
      absent: assignments.filter((a) => a.status === 'Traveler Absent').length,
      cancelled: assignments.filter((a) => a.status === 'Cancelled').length,
    },
    transport: reportSummary(state, { since: new Date(since).toISOString() }),
    warehouse: {
      received: bags.filter((b) => inRange(reachedAt(b, 'Received at Warehouse'))).length,
      screened: bags.filter((b) => inRange(reachedAt(b, 'Screened'))).length,
      loaded: bags.filter((b) => inRange(reachedAt(b, 'Loaded to Airport Truck'))).length,
      held: bags.filter((b) => b.status === 'Held – Cancelled Flight').length,
      avgDwellMin: avg(dwell),
      overTimerNow: bags.filter((b) => {
        const at = b.received_at_warehouse_at || reachedAt(b, 'Received at Warehouse');
        return at && b.status === 'Received at Warehouse' && (now - ms(at)) / 60000 > WINDOW.warehouseRedMin;
      }).length,
    },
    airport: {
      receivedAtAirport: bags.filter((b) => inRange(reachedAt(b, 'Received at Airport'))).length,
      handedOver: bags.filter((b) => inRange(reachedAt(b, 'Handed to Airport Authority'))).length,
      vouchersAccepted: (state.sgsVouchers || []).filter((v) => inRange(v.accepted_at)).length,
      vouchersPending: (state.sgsVouchers || []).filter((v) => v.status === 'Pending').length,
      loadedOnAircraft: bags.filter((b) => inRange(reachedAt(b, 'Loaded on Aircraft'))).length,
    },
    exceptions: {
      total: exceptions.length, open: open.length, byType,
      bySeverity: { Critical: open.filter((e) => e.severity === 'Critical').length, High: open.filter((e) => e.severity === 'High').length, Medium: open.filter((e) => e.severity === 'Medium').length, Low: open.filter((e) => e.severity === 'Low').length },
      resolvedInRange: resolvedInRange.length,
      avgResolutionMin: avg(resolvedInRange.map((e) => Math.round((ms(e.resolved_at) - ms(e.time)) / 60000))),
    },
    scans: { total: scans.length, byMethod, byStep, failed: scans.filter((s) => s.result !== 'OK').length },
  };
}

/* ───────────────────────── flat rows for CSV ───────────────────────── */

/** @param {object} state @param {object} user @param {{ flightId?: string }} [filters] */
export function bagLedger(state, user, filters = {}) {
  assertCan(user, 'report:read');
  return scopeFilter(user, 'bags', state.bags)
    .filter((b) => (filters.flightId ? b.flight_id === filters.flightId : true))
    .map((b) => {
      const t = (state.travelers || []).find((x) => x.id === b.traveler_id) || null;
      const f = (state.flights || []).find((x) => x.id === b.flight_id) || null;
      return {
        bag_id: b.id, tag_no: b.tag_no || '', airline_tag_no: b.airline_tag_no || '', status: b.status,
        traveler: t?.name || '', nusuk_id: t?.nusuk_id || '', flight: f?.code || '', flight_status: f?.status || '',
        area: b.collection_area_id || '', weight_kg: b.weight_kg ?? '', extra: b.extra ? 'yes' : 'no',
        checked_in_at: reachedAt(b, 'Checked-in') || '', received_at_warehouse_at: reachedAt(b, 'Received at Warehouse') || '',
        screened_at: reachedAt(b, 'Screened') || '', received_at_airport_at: reachedAt(b, 'Received at Airport') || '',
        loaded_on_aircraft_at: reachedAt(b, 'Loaded on Aircraft') || '', updated_at: b.updated_at || '',
      };
    })
    .sort((a, b) => a.bag_id.localeCompare(b.bag_id));
}

/** @param {object} state @param {object} user */
export function exceptionLedger(state, user) {
  assertCan(user, 'report:read');
  return scopeFilter(user, 'exceptions', state.exceptions).map((e) => ({
    id: e.id, type: e.type, severity: e.severity, status: e.status, raised_at: e.time,
    raised_by: e.raised_by || '', owner: e.owner || e.owner_team || '', bag_id: e.bag_id || '',
    flight_id: e.flight_id || '', area_id: e.area_id || '', value: e.value || '', notes: e.notes || '',
    resolution: e.resolution || '', resolved_at: e.resolved_at || '', closed_at: e.closed_at || '',
  })).sort((a, b) => a.id.localeCompare(b.id));
}

/** @param {object} state @param {object} user @param {{ since?: string|number|Date }} [filters] */
export function scanLedger(state, user, filters = {}) {
  assertCan(user, 'report:read');
  const since = filters.since != null ? ms(filters.since) : 0;
  return (state.scanEvents || []).filter((s) => ms(s.at) >= since).map((s) => ({
    id: s.id, at: s.at, step: s.step, method: s.method, symbology: s.symbology || '', result: s.result,
    raw_value: s.raw_value, user_id: s.user_id || '', bag_id: s.bag_id || '', flight_id: s.flight_id || '', device_id: s.device_id || '',
  }));
}

/**
 * RFC-4180 CSV. `columns` keeps the order and the header names.
 * @param {string[]} columns @param {Record<string, any>[]} rows @returns {string}
 */
export function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...(rows || []).map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n');
}
