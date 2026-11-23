/** Upcoming — collection trucks heading here, most urgent flight first. Read-only until they arrive. */
import { S, user, chip, esc, levelColor } from '../data.js';
import { upcomingTrucks } from '../../../shared/services/warehouseService.js';
import { fmtRelative, fmtDateTime } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, poll: draw, refresh: draw }; }
export function destroy() { el = null; }

const TRIP_COLOR = { Dispatched: 'blue', Loaded: 'blue', 'En Route': 'amber', Arrived: 'green' };

function card(r) {
  const t = r.trip;
  const atGate = t.status === 'Arrived';
  return `<div class="card stack gap-2">
    <div class="row gap-2 wrap" style="align-items:center">
      <strong class="fs-md">${esc(t.truck_id)}</strong>
      ${chip(t.status, TRIP_COLOR[t.status] || 'grey')}
      ${r.priority <= 3 ? chip(`P${r.priority}`, 'blue') : ''}
      ${r.alertLevel ? chip(r.alertLevel === 'red' ? 'Overdue' : 'Running late', levelColor(r.alertLevel)) : ''}
    </div>
    <div class="fs-sm">${esc(r.area?.name || 'Unknown area')} → here · <strong>${r.bags}</strong> bag(s) · ${esc(r.driver?.name || 'no driver')}</div>
    <div class="fs-xs muted">Dispatched ${esc(fmtDateTime(t.dispatched_at))}${t.departed_at ? ` · departed ${esc(fmtRelative(t.departed_at))}` : ''}${t.arrived_at ? ` · arrived ${esc(fmtRelative(t.arrived_at))}` : ''}</div>
    ${atGate ? `<button type="button" class="btn btn-primary" data-receive="${esc(t.id)}">Receive this truck</button>`
      : '<p class="fs-xs muted">Transport will mark it arrived at the gate.</p>'}
  </div>`;
}

function draw() {
  if (!el) return;
  let rows;
  try { rows = upcomingTrucks(S(), user(), { now: Date.now() }); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`;
    return;
  }
  const atGate = rows.filter((r) => r.trip.status === 'Arrived').length;
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Upcoming trucks</h1>
      <p class="page-subtitle">${rows.length} inbound · ${atGate} at the gate</p></div></div>
    ${rows.length ? `<div class="grid grid-cols-2 gap-3">${rows.map(card).join('')}</div>`
      : '<div class="state-block"><p>No trucks on the way. Transport dispatches a collection truck once check-in staff hand bags over at a residence pickup point.</p></div>'}`;
  el.querySelectorAll('[data-receive]').forEach((b) => b.addEventListener('click', () => navigate(`#/receiving/${/** @type {HTMLElement} */ (b).dataset.receive}`)));
}
