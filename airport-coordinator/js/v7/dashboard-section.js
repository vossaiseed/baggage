/**
 * The departure half of the Coordinator's dashboard, read from the shared v7 store. The arrival
 * half is untouched and still comes from this app's own api.js.
 */
import { S, user, chip, esc, blockedHtml } from './data.js';
import * as ap from '../../../shared/services/airportService.js';
import { fmtDateTime } from '../ui.js';
import { kpiTile } from '../components/kpi-tile.js';

/** @returns {string} HTML for the departure section (never throws — a dead board is still a board) */
export function departureSectionHtml() {
  const blocked = blockedHtml('No airport is assigned to this account, so no departures are routed here.');
  if (blocked) return blocked;
  let sum; let groups; let incoming;
  try {
    const now = Date.now();
    sum = ap.airportSummary(S(), user(), { now });
    groups = ap.handoverQueue(S(), user(), { now });
    incoming = ap.incomingTrips(S(), user(), { now });
  } catch (err) {
    return `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`;
  }
  return `
    <div class="grid grid-auto" style="margin-block-end:var(--s6)">
      ${kpiTile({ label: 'En route', value: sum.enRoute })}
      ${kpiTile({ label: 'Awaiting seal check', value: sum.atGate })}
      ${kpiTile({ label: 'Ready to offload', value: sum.toOffload })}
      ${kpiTile({ label: 'At the airport', value: sum.atAirport })}
      ${kpiTile({ label: 'With the Authority', value: sum.awaitingVoucher })}
      ${kpiTile({ label: 'Open exceptions', value: sum.openExceptions })}
    </div>
    <div class="card" style="margin-block-end:var(--s6)">
      <div class="section-title">Flights waiting for handover</div>
      ${groups.length ? `<div class="stack gap-2">${groups.map((g) => `
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:var(--s2);padding:var(--s2) 0;border-bottom:1px solid var(--border)">
          <div><strong class="mono">${esc(g.flight?.code || '—')}</strong>
            <span class="fs-xs muted">&middot; ${g.bags.length} bag${g.bags.length === 1 ? '' : 's'} &middot; cut-off ${esc(fmtDateTime(g.flight?.cut_off_at))}</span></div>
          <div class="row gap-2 wrap">${g.alerts.length ? chip(g.alerts[0].level === 'red' ? 'Behind schedule' : 'Running late', g.alerts[0].level) : chip('On time', 'green')}
            ${g.handover ? chip('Manifest open', 'blue') : ''}</div>
        </div>`).join('')}</div>`
    : '<p class="fs-sm muted">Nothing is waiting to be handed over.</p>'}
    </div>
    <div class="card" style="margin-block-end:var(--s6)">
      <div class="section-title">Trucks on the way</div>
      ${incoming.length ? `<div class="stack gap-2">${incoming.map((r) => `
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:var(--s2);padding:var(--s2) 0;border-bottom:1px solid var(--border)">
          <div><strong class="mono">${esc(r.trip.truck_id)}</strong>
            <span class="fs-xs muted">&middot; ${r.bags.length || r.trip.expected_count || 0} bag${(r.bags.length || r.trip.expected_count) === 1 ? '' : 's'} &middot; ${esc(r.flights.join(', ') || '—')}</span></div>
          ${chip(r.trip.status, r.trip.status === 'Arrived' ? 'amber' : 'blue')}
        </div>`).join('')}</div>`
    : '<p class="fs-sm muted">No airport trucks are inbound.</p>'}
    </div>`;
}
