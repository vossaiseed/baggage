/** Run one Collection trip: count match at the pickup point -> load -> depart -> arrive at the warehouse. */
import { S, run, chip } from '../../data.js';
import * as tr from '../../../../shared/services/transportService.js';
import { esc, fmtDateTime, toast } from '../../ui.js';
import { navigate } from '../../router.js';

let el = null;
let tripId = null;
export function render(params, app) { el = app; tripId = params.id; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; tripId = null; }

function draw() {
  if (!el) return;
  const trip = S().trips.find((t) => t.id === tripId);
  if (!trip) { el.innerHTML = '<div class="state-block"><p>Trip not found.</p><a class="btn btn-primary" href="#/trips">Back to trips</a></div>'; return; }
  const area = S().collectionAreas.find((a) => a.id === trip.area_from);
  const truck = S().trucks.find((t) => t.id === trip.truck_id);
  const driver = S().drivers.find((d) => d.id === trip.driver_id);
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">${esc(area?.name || '')} pickup</h1>
      <p class="page-subtitle">${esc(trip.id)} · ${esc(truck?.id || '')} / ${esc(driver?.name || '')} · ${chip(trip.status, trip.status === 'Arrived' ? 'green' : 'blue')}</p></div></div>
    ${body(trip)}
    <p class="fs-xs muted mt">Dispatched ${esc(fmtDateTime(trip.dispatched_at))}</p>
    <a class="btn btn-ghost mt" href="#/trips">&larr; Back to trips</a>`;
  wire(trip);
}

function body(trip) {
  if (trip.status === 'Dispatched') {
    return `<div class="card count-entry">
      <h2 class="section-title">Pickup count</h2>
      <p class="fs-sm muted">The check-in log shows <strong>${trip.expected_count}</strong> bag(s) handed over at this pickup point. Count what's actually presented and enter it below — a mismatch raises an exception and holds the truck here.</p>
      <form id="count-form" class="stack gap-3" style="align-items:center;margin-block-start:var(--s4)">
        <input type="number" id="presented" min="0" value="${trip.expected_count}" />
        <button type="submit" class="btn btn-primary btn-lg">Confirm count &amp; load</button>
      </form>
    </div>`;
  }
  if (trip.status === 'Loaded') {
    return `<div class="card stack gap-3">
      <h2 class="section-title">Loaded — ${trip.bag_ids.length} bag(s)</h2>
      <p class="fs-sm muted">Bags are on the truck. Depart when ready to drive to the warehouse.</p>
      <button type="button" class="btn btn-primary btn-lg" id="depart">Depart for warehouse</button>
    </div>`;
  }
  if (trip.status === 'En Route') {
    return `<div class="card stack gap-3">
      <h2 class="section-title">En route — ${trip.bag_ids.length} bag(s)</h2>
      <p class="fs-sm muted">Mark arrival once you reach the warehouse gate.</p>
      <button type="button" class="btn btn-primary btn-lg" id="arrive">Arrived at warehouse</button>
    </div>`;
  }
  return `<div class="card stack gap-2"><h2 class="section-title">Trip complete</h2><p class="fs-sm muted">${trip.bag_ids.length} bag(s) handed off at the warehouse gate.</p></div>`;
}

function wire(trip) {
  el.querySelector('#count-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const presented = Number(el.querySelector('#presented').value);
    const r = run((s, c) => tr.loadCollectionTrip(s, trip.id, { presented }, c));
    if (!r) return; // threw — run() already toasted the error
    toast(r.ok ? `${r.bagsLoaded} bag(s) loaded.` : r.message, r.ok ? 'success' : 'error');
    draw();
  });
  el.querySelector('#depart')?.addEventListener('click', () => run((s, c) => tr.departTrip(s, trip.id, c), 'Departed for the warehouse.', draw));
  el.querySelector('#arrive')?.addEventListener('click', () => run((s, c) => tr.arriveAtWarehouse(s, trip.id, c), 'Arrived — trip complete.', () => { draw(); setTimeout(() => navigate('#/trips'), 1200); }));
}
