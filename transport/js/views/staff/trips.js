/** Transport Staff home: Collection trips (my area) + Airport trips (arrives in Phase 6). */
import { S, user, chip } from '../../data.js';
import * as tr from '../../../../shared/services/transportService.js';
import { esc, fmtRelative, icon } from '../../ui.js';
import { navigate } from '../../router.js';

let el = null;
let tab = 'collection';
export function render(params, app) { el = app; tab = params?.tab === 'airport' ? 'airport' : 'collection'; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

const STATUS_COLOR = { Dispatched: 'blue', Loaded: 'amber', 'En Route': 'amber', Arrived: 'green' };

function tripCard(t) {
  const area = S().collectionAreas.find((a) => a.id === t.area_from);
  const truck = S().trucks.find((x) => x.id === t.truck_id);
  return `<div class="trip-card" role="button" tabindex="0" data-open="${esc(t.id)}">
    <div class="trip-top"><strong>${esc(area?.name || '')}</strong><span class="chip chip-${STATUS_COLOR[t.status] || 'grey'}">${esc(t.status)}</span></div>
    <div class="trip-meta">${esc(truck?.id || '')} · ${t.expected_count} bag(s) expected · dispatched ${esc(fmtRelative(t.dispatched_at))}</div>
  </div>`;
}

function draw() {
  if (!el) return;
  let trips;
  try { trips = tr.listMyTrips(S(), user(), { includeDone: true }); } catch (err) { el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Trips</h1><p class="page-subtitle">Collection runs for your area</p></div></div>
    <div class="tabs" role="tablist">
      <button type="button" class="tab" role="tab" aria-selected="${tab === 'collection'}" data-tab="collection">Collection trips</button>
      <button type="button" class="tab" role="tab" aria-selected="${tab === 'airport'}" data-tab="airport">Airport trips</button>
    </div>
    ${tab === 'collection'
      ? (trips.length ? `<div class="stack gap-3">${trips.map(tripCard).join('')}</div>` : '<div class="state-block"><p>No collection trips yet. Your manager dispatches a trip once bags are handed to Transport at the residence pickup point.</p></div>')
      : `<div class="placeholder-card">${icon('plane', 28)}<p class="mt">No airport trips yet.</p><p class="fs-sm">Airport runs start once the warehouse can load bags onto an airport truck (Phase 6).</p></div>`}`;

  el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => navigate(`#/trips${b.dataset.tab === 'airport' ? '?tab=airport' : ''}`)));
  el.querySelectorAll('[data-open]').forEach((c) => {
    const open = () => navigate(`#/trips/${c.dataset.open}`);
    c.addEventListener('click', open);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  });
}
