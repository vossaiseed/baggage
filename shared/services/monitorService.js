/**
 * monitorService — the read-only wall board (Window Monitor role).
 *
 *   wallBoard(state, user, { now })   everything the board shows, in one read
 *   alertOps(state, input, ctx)       the one thing a monitor may write: raise a flight to Ops
 *
 * The board composes the same read models the working roles use (forecastBoard, listAreas,
 * exceptionSummary) so a number on the wall can never disagree with the number on a console.
 */
import { ROLE, WINDOW } from '../constants.js';
import { assertCan } from '../rbac.js';
import { forecastBoard } from './flightService.js';
import { listAreas } from './areaService.js';
import { exceptionSummary, exceptionQueue } from './exceptionService.js';
import { audit, nowIso } from './audit.js';
import { notify } from './notify.js';
import { ServiceError } from './errors.js';

const ACTIVE_TRIP_STATUSES = ['Dispatched', 'Loaded', 'En Route'];

/**
 * @param {object} state @param {object} user @param {{ now?: number|string|Date }} [opts]
 * @returns {{ at: string, refreshMin: number, flights: any[], areas: any[], trips: any, exceptions: any,
 *             totals: { flights:number, bagsToMove:number, red:number, amber:number }, worstLevel: 'green'|'amber'|'red' }}
 */
export function wallBoard(state, user, { now = Date.now() } = {}) {
  assertCan(user, 'flight:read');
  const flights = forecastBoard(state, user, { now });
  const areas = listAreas(state, user, { now });
  const exceptions = exceptionSummary(state, user, { now });
  const trips = (state.trips || []).filter((t) => ACTIVE_TRIP_STATUSES.includes(t.status));
  const red = flights.filter((f) => f.level === 'red').length;
  const amber = flights.filter((f) => f.level === 'amber').length;
  return {
    at: nowIso({ now }),
    refreshMin: WINDOW.forecastRefreshMin,
    flights,
    areas,
    trips: {
      active: trips.length,
      collection: trips.filter((t) => t.type === 'Collection').length,
      airport: trips.filter((t) => t.type === 'Airport').length,
      rows: trips,
    },
    exceptions: {
      ...exceptions,
      critical: exceptionQueue(state, user, { now, severity: 'Critical' }),
      high: exceptionQueue(state, user, { now, severity: 'High' }),
    },
    totals: {
      flights: flights.length,
      bagsToMove: flights.reduce((n, f) => n + f.bagsToMove, 0),
      red,
      amber,
    },
    worstLevel: red ? 'red' : (amber ? 'amber' : 'green'),
  };
}

/**
 * The monitor sees a flight going red and tells Ops. It changes nothing else — the board is
 * read-only by design (the role preset is `readOnly: true`).
 * @param {object} state @param {{ flightId: string, message: string }} input @param {object} ctx
 */
export function alertOps(state, input, ctx) {
  assertCan(ctx.user, 'ops:notify');
  const flight = (state.flights || []).find((f) => f.id === input?.flightId);
  if (!flight) throw new ServiceError('NOT_FOUND', `Flight ${input?.flightId} not found.`);
  const message = String(input?.message || '').trim();
  if (message.length < 4) throw new ServiceError('INVALID', 'Say what Ops needs to look at.');
  const row = notify(state, {
    role_list: [ROLE.OPS_MANAGER], severity: 'critical',
    title: `Window Monitor: ${flight.code}`,
    body: message,
  }, ctx);
  audit(state, ctx, { action: 'monitor.alert_ops', entity: 'Flight', entityId: flight.id, after: { message } });
  return row;
}
