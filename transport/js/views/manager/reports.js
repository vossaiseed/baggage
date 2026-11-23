/** Transport Manager: trip-history summary and reroute log. */
import { S, chip } from '../../data.js';
import * as tr from '../../../../shared/services/transportService.js';
import { esc, fmtDateTime } from '../../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

function tripRow(t) {
  const truck = S().trucks.find((x) => x.id === t.truck_id);
  const driver = S().drivers.find((x) => x.id === t.driver_id);
  const route = t.type === 'Airport'
    ? `${S().warehouses.find((w) => w.id === t.warehouse_id)?.name || 'Warehouse'} → ${S().airports.find((a) => a.id === t.airport_id)?.code || 'airport'}`
    : S().collectionAreas.find((a) => a.id === t.area_from)?.name || '—';
  return `<tr><td class="mono">${esc(t.id)}</td><td>${esc(t.type)}</td><td>${esc(route)}</td><td>${esc(truck?.id || '')} / ${esc(driver?.name || '')}</td>
    <td>${t.bag_ids.length}</td><td>${chip(t.status, t.status === 'Arrived' ? 'green' : 'blue')}</td><td>${esc(fmtDateTime(t.dispatched_at))}</td></tr>`;
}

function draw() {
  if (!el) return;
  const r = tr.reportSummary(S(), {});
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Reports</h1><p class="page-subtitle">Collection and airport trip history</p></div></div>
    <div class="kpi-grid">
      <div class="tile"><span class="n">${r.tripsDispatched}</span><span class="l">Trips dispatched</span></div>
      <div class="tile ok"><span class="n">${r.tripsArrived}</span><span class="l">Trips completed</span></div>
      <div class="tile"><span class="n">${r.bagsMoved}</span><span class="l">Bags moved</span></div>
      <div class="tile"><span class="n">${r.avgMinutes ?? '—'}</span><span class="l">Avg. pickup-to-warehouse (min)</span></div>
      <div class="tile ${r.reroutes ? 'warn' : 'ok'}"><span class="n">${r.reroutes}</span><span class="l">Reroutes</span></div>
      <div class="tile"><span class="n">${r.airportTrips}</span><span class="l">Airport runs</span></div>
      <div class="tile ok"><span class="n">${r.airportBagsMoved}</span><span class="l">Bags to the airport</span></div>
    </div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Trip</th><th>Type</th><th>Route</th><th>Truck / Driver</th><th>Bags</th><th>Status</th><th>Dispatched</th></tr></thead>
      <tbody>${r.trips.map(tripRow).join('') || '<tr><td colspan="7" class="muted">No trips yet.</td></tr>'}</tbody></table></div>`;
}
