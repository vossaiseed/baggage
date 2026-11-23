/**
 * Reports — one roll-up over a chosen time range, plus CSV exports of the bag, exception and
 * scan ledgers. Every number comes from shared/services/reportService.js.
 */
import { read, chip, levelColor } from '../data.js';
import * as rep from '../../../shared/services/reportService.js';
import { esc, fmtDateTime, downloadBlob, emptyState } from '../ui.js';
import { kpiTile } from '../components/kpi-tile.js';

let el = null;
let hours = 24;

export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

const stat = (k, v) => `<div><span class="k">${esc(k)}</span><span class="v">${esc(v ?? '—')}</span></div>`;
const mins = (n) => (n == null ? '—' : `${n} min`);

function section(title, body) {
  return `<section class="card"><h2 class="section-title">${esc(title)}</h2>${body}</section>`;
}

function flightTable(r) {
  return `<div class="table-wrap"><table><thead><tr>
      <th>Flight</th><th>Cut-off</th><th class="num">Bags</th><th class="num">To move</th><th class="num">Accounted</th>
      <th class="num">Residence→WH</th><th class="num">WH dwell</th><th class="num">WH→Airport</th><th>State</th></tr></thead>
    <tbody>${r.flights.map((f) => `<tr>
      <td>${esc(f.flight.code)}</td>
      <td>${esc(fmtDateTime(f.flight.cut_off_at))}</td>
      <td class="num">${f.counts.total}</td>
      <td class="num">${f.counts.toMove}</td>
      <td class="num">${f.counts.accounted}</td>
      <td class="num">${esc(mins(f.avgResidenceToWarehouseMin))}</td>
      <td class="num">${esc(mins(f.avgWarehouseDwellMin))}</td>
      <td class="num">${esc(mins(f.avgWarehouseToAirportMin))}</td>
      <td>${['Cancelled', 'Completed'].includes(f.flight.status)
    ? chip(f.flight.status, f.flight.status === 'Cancelled' ? 'red' : 'green')
    : chip(f.level === 'green' ? 'On schedule' : f.level === 'red' ? 'Red' : 'Amber', levelColor(f.level === 'green' ? null : f.level))}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="muted">No flights.</td></tr>'}</tbody></table></div>`;
}

function draw() {
  if (!el) return;
  const r = read((s, u) => rep.opsReport(s, u, { now: Date.now(), sinceHours: hours }), null);
  if (!r) { el.innerHTML = emptyState({ message: 'Reports are not available for this account.' }); return; }
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Reports</h1>
        <p class="page-subtitle">${esc(fmtDateTime(r.range.since))} → ${esc(fmtDateTime(r.range.until))}</p></div>
      <div class="segmented" role="tablist" aria-label="Time range">
        ${[[6, '6 h'], [24, '24 h'], [72, '3 days'], [24 * 30, 'Season']].map(([h, label]) => `
          <button type="button" class="tab" role="tab" aria-selected="${hours === h}" data-hours="${h}">${label}</button>`).join('')}
      </div>
    </div>

    <div class="grid grid-cols-4 mb">
      ${kpiTile({ label: 'Bags in the system', value: r.totals.bags })}
      ${kpiTile({ label: 'Still to move', value: r.totals.bagsToMove })}
      ${kpiTile({ label: 'Live flights', value: r.totals.flightsLive })}
      ${kpiTile({ label: 'Open exceptions', value: r.exceptions.open })}
    </div>

    ${section('Flights and window compliance', flightTable(r))}

    <div class="report-grid mt">
      ${section('Residence check-in', `<div class="stat-list">
        ${stat('Collected', r.checkin.collected)}
        ${stat('Traveler absent', r.checkin.absent)}
        ${stat('Called off (flight cancelled)', r.checkin.cancelled)}
        ${Object.entries(r.checkin.byStatus).map(([k, v]) => stat(k, v)).join('')}
      </div>`)}
      ${section('Transport', `<div class="stat-list">
        ${stat('Collection trips dispatched', r.transport.tripsDispatched)}
        ${stat('Collection trips arrived', r.transport.tripsArrived)}
        ${stat('Airport runs', r.transport.airportTrips)}
        ${stat('Bags moved', r.transport.bagsMoved + r.transport.airportBagsMoved)}
        ${stat('Average pickup → warehouse', mins(r.transport.avgMinutes))}
        ${stat('Reroutes', r.transport.reroutes)}
      </div>`)}
      ${section('Warehouse', `<div class="stat-list">
        ${stat('Received in range', r.warehouse.received)}
        ${stat('Screened in range', r.warehouse.screened)}
        ${stat('Loaded to airport trucks', r.warehouse.loaded)}
        ${stat('In holding now', r.warehouse.held)}
        ${stat('Average dwell', mins(r.warehouse.avgDwellMin))}
        ${stat('Over the 2 h timer now', r.warehouse.overTimerNow)}
      </div>`)}
      ${section('Airport', `<div class="stat-list">
        ${stat('Received at the airport', r.airport.receivedAtAirport)}
        ${stat('Handed to the Airport Authority', r.airport.handedOver)}
        ${stat('SGS vouchers accepted', r.airport.vouchersAccepted)}
        ${stat('Vouchers pending', r.airport.vouchersPending)}
        ${stat('Loaded on aircraft', r.airport.loadedOnAircraft)}
      </div>`)}
      ${section('Exceptions', `<div class="stat-list">
        ${stat('Open', r.exceptions.open)}
        ${stat('Resolved in range', r.exceptions.resolvedInRange)}
        ${stat('Average time to resolve', mins(r.exceptions.avgResolutionMin))}
        ${Object.entries(r.exceptions.byType).map(([k, v]) => stat(k, v)).join('') || stat('By type', 'none')}
      </div>`)}
      ${section('Scans', `<div class="stat-list">
        ${stat('Total in range', r.scans.total)}
        ${stat('Refused', r.scans.failed)}
        ${Object.entries(r.scans.byMethod).map(([k, v]) => stat(k, v)).join('')}
      </div>`)}
      ${section('Bags by status', `<div class="stat-list">
        ${Object.entries(r.bags.byStatus).filter(([, v]) => v > 0).map(([k, v]) => stat(k, v)).join('') || stat('No bags', 0)}
      </div>`)}
    </div>

    <div class="toolbar mt">
      <button type="button" class="btn btn-secondary" data-csv="bags">Export bags CSV</button>
      <button type="button" class="btn btn-secondary" data-csv="exceptions">Export exceptions CSV</button>
      <button type="button" class="btn btn-secondary" data-csv="scans">Export scans CSV</button>
    </div>`;

  el.querySelectorAll('[data-hours]').forEach((b) => b.addEventListener('click', () => { hours = Number(b.getAttribute('data-hours')); draw(); }));
  el.querySelectorAll('[data-csv]').forEach((b) => b.addEventListener('click', () => exportCsv(b.getAttribute('data-csv'))));
}

const COLUMNS = {
  bags: ['bag_id', 'tag_no', 'airline_tag_no', 'status', 'traveler', 'nusuk_id', 'flight', 'flight_status', 'area', 'weight_kg', 'extra',
    'checked_in_at', 'received_at_warehouse_at', 'screened_at', 'received_at_airport_at', 'loaded_on_aircraft_at', 'updated_at'],
  exceptions: ['id', 'type', 'severity', 'status', 'raised_at', 'raised_by', 'owner', 'bag_id', 'flight_id', 'area_id', 'value', 'notes', 'resolution', 'resolved_at', 'closed_at'],
  scans: ['id', 'at', 'step', 'method', 'symbology', 'result', 'raw_value', 'user_id', 'bag_id', 'flight_id', 'device_id'],
};

function exportCsv(kind) {
  const since = Date.now() - hours * 3600e3;
  const rows = read((s, u) => (kind === 'bags' ? rep.bagLedger(s, u, {})
    : kind === 'exceptions' ? rep.exceptionLedger(s, u)
      : rep.scanLedger(s, u, { since })), []);
  if (!rows) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  downloadBlob(`rabel-${kind}-${stamp}.csv`, rep.toCsv(COLUMNS[kind], rows), 'text/csv');
}
