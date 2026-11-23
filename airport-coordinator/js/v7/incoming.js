/**
 * Departure — Incoming: every airport truck on its way here or standing at the gate, most urgent
 * flight first, plus the open exceptions on bags at this airport. Read-only; the work starts on
 * the Seal and Offload screens.
 */
import { S, user, chip, esc, blockedHtml } from './data.js';
import * as ap from '../../../shared/services/airportService.js';
import { fmtDateTime, fmtRelative, icon } from '../ui.js';
import { kpiTile } from '../components/kpi-tile.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

const STAGE = {
  Dispatched: ['Loading at the warehouse', 'grey'],
  Loaded: ['Loaded — waiting to depart', 'blue'],
  'En Route': ['En route', 'amber'],
  Arrived: ['At the gate', 'amber'],
};

function truckCard(r) {
  const [label, colour] = STAGE[r.trip.status] || [r.trip.status, 'grey'];
  const next = r.trip.status === 'Arrived'
    ? (r.sealChecked ? '<a class="btn btn-primary" href="#/dep/offload">Offload</a>' : '<a class="btn btn-primary" href="#/dep/seal">Check the seal</a>')
    : '';
  return `<div class="card stack gap-2 ${r.alertLevel ? `alert-${r.alertLevel}` : ''}">
    <div class="row gap-2 wrap" style="align-items:center">
      <strong class="fs-md">${esc(r.truck?.id || r.trip.truck_id)}</strong>
      ${chip(label, colour)}
      ${r.priority <= 3 ? chip(`P${r.priority}`, 'blue') : ''}
      ${r.alertLevel ? chip(r.alertLevel === 'red' ? 'Behind schedule' : 'Running late', r.alertLevel) : ''}
      ${r.trip.seal_check && !r.trip.seal_check.intact ? chip('Seal problem', 'red') : ''}
    </div>
    <div class="fs-sm">${esc(r.warehouse?.name || 'Warehouse')} · <strong>${r.bags.length || r.trip.expected_count || 0}</strong> bag(s) · ${esc(r.flights.join(', ') || 'no flight yet')}</div>
    <div class="fs-xs muted">${esc(r.driver?.name || '')}${r.trip.seal_no ? ` · seal ${esc(r.trip.seal_no)}` : ''}
      ${r.trip.departed_at ? ` · left the warehouse ${esc(fmtRelative(r.trip.departed_at))}` : ''}
      ${r.trip.arrived_at ? ` · at the gate since ${esc(fmtDateTime(r.trip.arrived_at))}` : ''}</div>
    ${next ? `<div class="row gap-2">${next}</div>` : ''}
  </div>`;
}

function draw() {
  if (!el) return;
  const blocked = blockedHtml('No airport is assigned to this account, so no trucks are routed here.');
  if (blocked) { el.innerHTML = blocked; return; }
  let rows; let sum; let exceptions;
  try {
    rows = ap.incomingTrips(S(), user(), { now: Date.now() });
    sum = ap.airportSummary(S(), user(), { now: Date.now() });
    exceptions = ap.airportExceptions(S(), user());
  } catch (err) { el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }

  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Incoming trucks</h1>
      <p class="page-subtitle">${rows.length} airport truck(s) inbound or at the gate</p></div></div>
    <div class="grid grid-auto" style="margin-block-end:var(--s6)">
      ${kpiTile({ label: 'En route', value: sum.enRoute })}
      ${kpiTile({ label: 'Awaiting seal check', value: sum.atGate })}
      ${kpiTile({ label: 'Ready to offload', value: sum.toOffload })}
      ${kpiTile({ label: 'At the airport', value: sum.atAirport })}
      ${kpiTile({ label: 'With the Authority', value: sum.awaitingVoucher })}
      ${kpiTile({ label: 'Voucher accepted', value: sum.accepted })}
    </div>
    ${exceptions.length ? `<div class="card stack gap-2 alert-red" style="margin-block-end:var(--s6)">
      <div class="row gap-2" style="align-items:center">${icon('alert-triangle', 18)}<strong>${exceptions.length} open exception(s) on bags here</strong></div>
      <ul class="stack gap-1 fs-sm">${exceptions.slice(0, 5).map((e) => `<li><span class="mono">${esc(e.id)}</span> · ${esc(e.type)} — ${esc(e.notes || '')}</li>`).join('')}</ul>
      <p class="fs-xs muted">Only the Operations Manager closes these; keep the bags together and carry on.</p>
    </div>` : ''}
    ${rows.length ? `<div class="grid grid-cols-2 gap-3">${rows.map(truckCard).join('')}</div>`
    : `<div class="state-block"><p>Nothing inbound. Trucks appear here as soon as a warehouse closes a load for ${esc(S().airports.find((a) => a.id === user().airport_id)?.code || 'this airport')}.</p></div>`}`;
}
