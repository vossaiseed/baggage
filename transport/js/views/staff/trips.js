/** Transport Staff home: Collection trips (my area) and Airport runs assigned to me. */
import { S, user } from '../../data.js';
import * as tr from '../../../../shared/services/transportService.js';
import { esc, fmtRelative, icon } from '../../ui.js';
import { navigate } from '../../router.js';

let el = null;
let tab = 'collection';
export function render(params, app) { el = app; tab = params?.tab === 'airport' ? 'airport' : 'collection'; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

const STATUS_COLOR = { Dispatched: 'blue', Loaded: 'amber', 'En Route': 'amber', Arrived: 'green' };

function card(title, meta, trip) {
  return `<div class="trip-card" role="button" tabindex="0" data-open="${esc(trip.id)}">
    <div class="trip-top"><strong>${esc(title)}</strong><span class="chip chip-${STATUS_COLOR[trip.status] || 'grey'}">${esc(trip.status)}</span></div>
    <div class="trip-meta">${esc(meta)}</div>
  </div>`;
}

function collectionCard(t) {
  const area = S().collectionAreas.find((a) => a.id === t.area_from);
  const truck = S().trucks.find((x) => x.id === t.truck_id);
  return card(area?.name || '', `${truck?.id || ''} · ${t.expected_count} bag(s) expected · dispatched ${fmtRelative(t.dispatched_at)}`, t);
}

function airportCard(t) {
  const warehouse = S().warehouses.find((w) => w.id === t.warehouse_id);
  const airport = S().airports.find((a) => a.id === t.airport_id);
  const truck = S().trucks.find((x) => x.id === t.truck_id);
  const onBoard = t.bag_ids.length || t.expected_count || 0;
  return card(
    `${warehouse?.name || 'Warehouse'} → ${airport?.code || 'airport'}`,
    `${truck?.id || ''} · ${onBoard} bag(s)${t.seal_no ? ` · seal ${t.seal_no}` : ''} · dispatched ${fmtRelative(t.dispatched_at)}`,
    t,
  );
}

function draw() {
  if (!el) return;
  let collection; let airport;
  try {
    collection = tr.listMyTrips(S(), user(), { includeDone: true });
    airport = tr.listMyAirportTrips(S(), user(), { includeDone: true });
  } catch (err) { el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`; return; }

  const open = (list) => list.filter((t) => ['Dispatched', 'Loaded', 'En Route'].includes(t.status)).length;
  const count = (n) => (n ? ` <span class="chip chip-blue">${n}</span>` : '');
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Trips</h1><p class="page-subtitle">Residence pickups for your area, and the airport runs assigned to you</p></div></div>
    <div class="tabs" role="tablist">
      <button type="button" class="tab" role="tab" aria-selected="${tab === 'collection'}" data-tab="collection">Collection trips${count(open(collection))}</button>
      <button type="button" class="tab" role="tab" aria-selected="${tab === 'airport'}" data-tab="airport">Airport trips${count(open(airport))}</button>
    </div>
    ${tab === 'collection' ? list(collection, collectionCard, 'No collection trips yet. Your manager dispatches a trip once bags are handed to Transport at the residence pickup point.')
      : list(airport, airportCard, 'No airport runs assigned to you. Your manager assigns one when a warehouse has screened bags ready for the airport.')}`;

  el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => navigate(`#/trips${b.dataset.tab === 'airport' ? '?tab=airport' : ''}`)));
  el.querySelectorAll('[data-open]').forEach((c) => {
    const go = () => navigate(`#/trips/${c.dataset.open}`);
    c.addEventListener('click', go);
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

function list(trips, cardFn, emptyText) {
  if (!trips.length) return `<div class="placeholder-card">${icon('route', 28)}<p class="mt">${esc(emptyText)}</p></div>`;
  return `<div class="stack gap-3">${trips.map(cardFn).join('')}</div>`;
}
