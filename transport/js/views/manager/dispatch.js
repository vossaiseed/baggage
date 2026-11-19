/** Transport Manager home: pending pickups per area, dispatch a driver + truck, reroute an active trip. */
import { S, user, run, chip } from '../../data.js';
import * as tr from '../../../../shared/services/transportService.js';
import { esc, openDrawer, closeDrawer } from '../../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

const ALERT_LABEL = { red: 'Red — bags behind schedule', amber: 'Amber — a stage is running late' };

function tripLine(t) {
  const driver = S().drivers.find((d) => d.id === t.driver_id);
  const truck = S().trucks.find((x) => x.id === t.truck_id);
  return `<li class="row gap-2 wrap fs-sm" style="justify-content:space-between">
    <span><strong>${esc(t.id)}</strong> · ${chip(t.status, t.status === 'En Route' ? 'blue' : 'amber')} · ${esc(truck?.id || '')} / ${esc(driver?.name || '')}</span>
    <button type="button" class="btn btn-ghost" data-reroute="${esc(t.id)}">Reroute</button>
  </li>`;
}

function row(r) {
  const alertClass = r.alertLevel ? `alert-${r.alertLevel}` : '';
  return `<div class="board-row ${alertClass}">
    <div class="board-top">
      <strong>${esc(r.area.name)}</strong>
      <span class="row gap-2 wrap">
        ${r.priorityRank < 99 ? chip(`P${r.priorityRank}`, 'blue') : ''}
        ${r.alertLevel ? chip(ALERT_LABEL[r.alertLevel], r.alertLevel) : ''}
        <span class="fs-sm muted">${r.pendingPickups} bag(s) waiting</span>
      </span>
    </div>
    ${r.openTrips.length ? `<ul class="stack gap-2">${r.openTrips.map(tripLine).join('')}</ul>` : ''}
    ${r.pendingPickups > 0 && !r.openTrips.length ? `
      <form class="row gap-2 wrap" data-dispatch="${esc(r.area.id)}">
        <select name="driverId" aria-label="Driver">${S().drivers.filter((d) => d.status === 'Available').map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('') || '<option value="">No driver available</option>'}</select>
        <select name="truckId" aria-label="Truck">${S().trucks.filter((t) => t.status === 'Available').map((t) => `<option value="${esc(t.id)}">${esc(t.id)} (${t.capacity_bags} bags)</option>`).join('') || '<option value="">No truck available</option>'}</select>
        <button type="submit" class="btn btn-primary">Dispatch</button>
      </form>` : ''}
  </div>`;
}

/**
 * Airport runs (Phase 5): the warehouse screens bags and asks for a truck; the Manager dispatches one
 * here. The warehouse then loads it and closes the load; driving it is Phase 6.
 */
function airportRow(wh) {
  const waiting = S().bags.filter((b) => b.warehouse_id === wh.id && b.status === 'Screened').length;
  const open = S().trips.filter((t) => t.type === 'Airport' && t.warehouse_id === wh.id && ['Dispatched', 'Loaded', 'En Route'].includes(t.status));
  if (!waiting && !open.length) return '';
  return `<div class="board-row">
    <div class="board-top"><strong>${esc(wh.name)}</strong>
      <span class="row gap-2 wrap"><span class="fs-sm muted">${waiting} screened bag(s) waiting for the airport</span></span></div>
    ${open.length ? `<ul class="stack gap-2">${open.map(tripLine).join('')}</ul>` : ''}
    ${waiting > 0 && !open.length ? `
      <form class="row gap-2 wrap" data-airport="${esc(wh.id)}">
        <select name="driverId" aria-label="Driver">${S().drivers.filter((d) => d.status === 'Available').map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('') || '<option value="">No driver available</option>'}</select>
        <select name="truckId" aria-label="Truck">${S().trucks.filter((t) => t.status === 'Available').map((t) => `<option value="${esc(t.id)}">${esc(t.id)} (${t.capacity_bags} bags)</option>`).join('') || '<option value="">No truck available</option>'}</select>
        <button type="submit" class="btn btn-primary">Dispatch airport truck</button>
      </form>` : ''}
  </div>`;
}

function draw() {
  if (!el) return;
  let board;
  try { board = tr.windowBoard(S(), user(), { now: Date.now() }); }
  catch (err) { el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }
  // Collection *and* airport runs (reportSummary only covers collection trips).
  const activeTrips = S().trips.filter((t) => ['Dispatched', 'Loaded', 'En Route'].includes(t.status)).length;
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Dispatch</h1><p class="page-subtitle">Pending pickups by collection area — assign a driver and truck</p></div></div>
    <div class="kpi-grid">
      <div class="tile"><span class="n">${board.reduce((n, r) => n + r.pendingPickups, 0)}</span><span class="l">Bags waiting for pickup</span></div>
      <div class="tile ${activeTrips ? 'warn' : 'ok'}"><span class="n">${activeTrips}</span><span class="l">Active trips</span></div>
      <div class="tile"><span class="n">${S().drivers.filter((d) => d.status === 'Available').length}</span><span class="l">Drivers available</span></div>
      <div class="tile"><span class="n">${S().trucks.filter((t) => t.status === 'Available').length}</span><span class="l">Trucks available</span></div>
    </div>
    <div class="stack gap-3">${board.map(row).join('')}</div>
    ${S().warehouses.map(airportRow).join('').trim() ? `<h2 class="section-title" style="margin-block-start:var(--s6)">Airport runs</h2>
      <div class="stack gap-3">${S().warehouses.map(airportRow).join('')}</div>` : ''}`;

  el.querySelectorAll('[data-dispatch]').forEach((form) => form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const driverId = fd.get('driverId'); const truckId = fd.get('truckId');
    if (!driverId || !truckId) return;
    run((s, c) => tr.dispatchCollectionTrip(s, form.dataset.dispatch, { driverId, truckId }, c), 'Trip dispatched.', draw);
  }));
  el.querySelectorAll('[data-airport]').forEach((form) => form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const driverId = fd.get('driverId'); const truckId = fd.get('truckId');
    if (!driverId || !truckId) return;
    run((s, c) => tr.dispatchAirportTrip(s, { warehouseId: form.dataset.airport, driverId, truckId }, c), 'Airport truck dispatched to the warehouse.', draw);
  }));
  el.querySelectorAll('[data-reroute]').forEach((b) => b.addEventListener('click', () => openReroute(b.dataset.reroute)));
}

function openReroute(tripId) {
  const trip = S().trips.find((t) => t.id === tripId);
  const driver = S().drivers.find((d) => d.id === trip.driver_id);
  const truck = S().trucks.find((t) => t.id === trip.truck_id);
  const d = openDrawer({ title: `Reroute ${tripId}`, bodyHtml: `
    <p class="fs-sm muted">Currently ${esc(truck?.id || '')} / ${esc(driver?.name || '')}. Swap the driver and/or truck (the replaced one goes "Off duty").</p>
    <div class="field"><label for="rr-driver">New driver</label><select id="rr-driver"><option value="">— keep current —</option>${S().drivers.filter((x) => x.status === 'Available').map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="rr-truck">New truck</label><select id="rr-truck"><option value="">— keep current —</option>${S().trucks.filter((x) => x.status === 'Available').map((x) => `<option value="${esc(x.id)}">${esc(x.id)} (${x.capacity_bags} bags)</option>`).join('')}</select></div>
    <div class="field"><label for="rr-why">Reason <span class="req">*</span></label><input id="rr-why" placeholder="e.g. Truck breakdown" /></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="rr-go">Reroute</button>' });
  d.el.querySelector('#rr-go').addEventListener('click', () => {
    const newDriverId = d.el.querySelector('#rr-driver').value || undefined;
    const newTruckId = d.el.querySelector('#rr-truck').value || undefined;
    const reason = d.el.querySelector('#rr-why').value;
    run((s, c) => tr.rerouteTrip(s, tripId, { reason, newDriverId, newTruckId }, c), 'Trip rerouted.', () => { closeDrawer(); draw(); });
  });
}
