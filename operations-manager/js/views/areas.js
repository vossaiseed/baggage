/**
 * Areas & slots — the residence pickup points and their 2-hour collection slots.
 * Slot times always come from a flight's 8-hour collection window; Ops only sets capacity.
 */
import { S, run, read, chip, levelColor } from '../data.js';
import * as ar from '../../../shared/services/areaService.js';
import { esc, fmtDateTime, fmtTime, openDrawer, closeDrawer, emptyState } from '../ui.js';

let el = null;
let openAreaId = null;

export function render(params, app) { el = app; openAreaId = params?.id || openAreaId; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

function areaCard(r) {
  const a = r.area;
  return `<article class="board-row ${r.alertLevel ? `alert-${r.alertLevel}` : ''}">
    <div class="board-top">
      <div>
        <strong class="fs-lg">${esc(a.name)}</strong>
        <div class="fs-sm muted">${esc(a.district || '')} → ${esc(r.warehouse?.name || 'no warehouse')}${a.lat != null ? ` · ${a.lat}, ${a.lng}` : ''}</div>
      </div>
      <div class="row gap-2 wrap">
        ${r.priorityRank < 99 ? chip(`P${r.priorityRank}`, 'blue') : chip('No live flights', 'grey')}
        ${chip(r.alertLevel ? (r.alertLevel === 'red' ? 'Red' : 'Amber') : 'On schedule', levelColor(r.alertLevel))}
      </div>
    </div>
    <div class="fs-sm muted">
      ${r.checkinStaff} check-in · ${r.transportStaff} transport · ${r.residences} residence(s) ·
      ${r.assignmentsOpen} collection(s) to do · ${r.pendingPickups} bag(s) waiting for pickup · ${r.activeTrips} active trip(s)
    </div>
    <div class="fs-sm">Slots: ${r.slots.booked}/${r.slots.capacity} booked across ${r.slots.total} slot(s)</div>
    <div class="row gap-2 wrap">
      <button type="button" class="btn btn-secondary" data-slots="${esc(a.id)}">Slots</button>
      <button type="button" class="btn btn-ghost" data-edit="${esc(a.id)}">Edit</button>
      <button type="button" class="btn btn-ghost" data-detail="${esc(a.id)}">Collections</button>
    </div>
  </article>`;
}

function draw() {
  if (!el) return;
  const rows = read((s, u) => ar.listAreas(s, u, { now: Date.now() }), []) || [];
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Areas &amp; slots</h1><p class="page-subtitle">Residence pickup points · 2-hour slots inside each flight's 8-hour collection window</p></div>
      <div class="row gap-2">
        <button type="button" class="btn btn-secondary" id="gen">Generate slots</button>
        <button type="button" class="btn btn-primary" id="new">New area</button>
      </div>
    </div>
    <div class="stack gap-3">${rows.map(areaCard).join('') || emptyState({ message: 'No collection areas yet.' })}</div>`;

  el.querySelector('#new').addEventListener('click', openCreate);
  el.querySelector('#gen').addEventListener('click', openGenerate);
  el.querySelectorAll('[data-slots]').forEach((b) => b.addEventListener('click', () => openSlots(b.getAttribute('data-slots'))));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEdit(b.getAttribute('data-edit'))));
  el.querySelectorAll('[data-detail]').forEach((b) => b.addEventListener('click', () => openDetail(b.getAttribute('data-detail'))));
  if (openAreaId) { const id = openAreaId; openAreaId = null; openSlots(id); }
}

function openCreate() {
  const d = openDrawer({
    title: 'New collection area',
    bodyHtml: `
      <div class="field"><label for="a-name">Name <span class="req">*</span></label><input id="a-name" placeholder="Al Kakiyah" /></div>
      <div class="field"><label for="a-district">District</label><input id="a-district" /></div>
      <div class="field"><label for="a-wh">Warehouse <span class="req">*</span></label>
        <select id="a-wh">${S().warehouses.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="row gap-2">
        <div class="field grow"><label for="a-lat">Latitude</label><input id="a-lat" inputmode="decimal" placeholder="21.42" /></div>
        <div class="field grow"><label for="a-lng">Longitude</label><input id="a-lng" inputmode="decimal" placeholder="39.87" /></div>
      </div>
      <p class="fs-xs muted">The area gets the 2-hour slots of every flight that is still collecting. Its id is fixed at creation, because bags, users and scans point at it.</p>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="a-go">Create area</button>',
  });
  const val = (sel) => /** @type {HTMLInputElement} */ (d.el.querySelector(sel)).value;
  d.el.querySelector('#a-go').addEventListener('click', () => run((s, c) => ar.createArea(s, {
    name: val('#a-name'), district: val('#a-district'), warehouse_id: val('#a-wh'),
    lat: val('#a-lat') ? Number(val('#a-lat')) : undefined, lng: val('#a-lng') ? Number(val('#a-lng')) : undefined,
  }, c), (res) => `${res.area.name} created (${res.area.id}) with ${res.slotsCreated} slot(s).`, () => { closeDrawer(); draw(); }));
}

function openEdit(id) {
  const a = S().collectionAreas.find((x) => x.id === id);
  const d = openDrawer({
    title: `Edit ${a.name}`,
    bodyHtml: `
      <div class="field"><label for="e-name">Name</label><input id="e-name" value="${esc(a.name)}" /></div>
      <div class="field"><label for="e-district">District</label><input id="e-district" value="${esc(a.district || '')}" /></div>
      <div class="field"><label for="e-wh">Warehouse</label>
        <select id="e-wh">${S().warehouses.map((w) => `<option value="${esc(w.id)}" ${w.id === a.warehouse_id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
      <div class="row gap-2">
        <div class="field grow"><label for="e-lat">Latitude</label><input id="e-lat" inputmode="decimal" value="${esc(a.lat ?? '')}" /></div>
        <div class="field grow"><label for="e-lng">Longitude</label><input id="e-lng" inputmode="decimal" value="${esc(a.lng ?? '')}" /></div>
      </div>
      <p class="fs-xs muted">The id <span class="mono">${esc(a.id)}</span> never changes.</p>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="e-go">Save</button>',
  });
  const val = (sel) => /** @type {HTMLInputElement} */ (d.el.querySelector(sel)).value;
  d.el.querySelector('#e-go').addEventListener('click', () => run((s, c) => ar.updateArea(s, id, {
    name: val('#e-name'), district: val('#e-district'), warehouse_id: val('#e-wh'),
    lat: val('#e-lat') === '' ? null : Number(val('#e-lat')), lng: val('#e-lng') === '' ? null : Number(val('#e-lng')),
  }, c), 'Area saved.', () => { closeDrawer(); draw(); }));
}

function openSlots(areaId) {
  const area = S().collectionAreas.find((x) => x.id === areaId);
  const rows = read((s, u) => ar.listSlots(s, u, { areaId, now: Date.now() }), []) || [];
  const d = openDrawer({
    title: `${area.name} — collection slots`,
    large: true,
    bodyHtml: rows.length ? `
      <p class="fs-sm muted">Future slots only. Capacity can never go below what is already booked.</p>
      <div class="table-wrap"><table><thead><tr><th>Slot</th><th>Booked</th><th>Capacity</th><th>Bags</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(fmtDateTime(r.slot.start))} – ${esc(fmtTime(r.slot.end))}</td>
          <td>${r.booked}${r.full ? ` ${chip('full', 'amber')}` : ''}</td>
          <td><input type="number" min="${r.booked}" max="200" step="1" value="${r.slot.capacity_travelers}" data-cap="${esc(r.slot.id)}" style="width:90px" /></td>
          <td>${r.bags}</td>
          <td><button type="button" class="btn btn-ghost" data-save="${esc(r.slot.id)}">Save</button></td></tr>`).join('')}</tbody></table></div>`
      : emptyState({ message: 'No future slots. Use “Generate slots” to create them for a flight.' }),
  });
  d.el.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', () => {
    const id = b.getAttribute('data-save');
    const input = /** @type {HTMLInputElement} */ (d.el.querySelector(`[data-cap="${id}"]`));
    run((s, c) => ar.setSlotCapacity(s, id, Number(input.value), c), 'Capacity updated.', () => { closeDrawer(); draw(); });
  }));
}

function openGenerate() {
  const flights = S().flights.filter((f) => f.cut_off_at && !['Cancelled', 'Completed'].includes(f.status))
    .sort((a, b) => String(a.cut_off_at).localeCompare(String(b.cut_off_at)));
  const d = openDrawer({
    title: 'Generate collection slots',
    bodyHtml: `
      <div class="field"><label for="g-flight">Flight <span class="req">*</span></label>
        <select id="g-flight">${flights.map((f) => `<option value="${esc(f.id)}">${esc(f.code)} — cut-off ${esc(fmtDateTime(f.cut_off_at))}</option>`).join('')}</select></div>
      <div class="field"><label for="g-area">Area</label>
        <select id="g-area"><option value="">Every area</option>${S().collectionAreas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="g-cap">Travelers per slot</label><input id="g-cap" type="number" min="1" max="200" value="6" /></div>
      <p class="fs-xs muted">Four 2-hour slots per area, inside the flight's 8-hour collection window. Existing slots keep their bookings and are never shrunk.</p>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="g-go">Generate</button>',
  });
  d.el.querySelector('#g-go').addEventListener('click', () => run((s, c) => ar.generateSlots(s, {
    flightId: /** @type {HTMLSelectElement} */ (d.el.querySelector('#g-flight')).value,
    areaId: /** @type {HTMLSelectElement} */ (d.el.querySelector('#g-area')).value || undefined,
    capacity: Number(/** @type {HTMLInputElement} */ (d.el.querySelector('#g-cap')).value),
  }, c), (res) => `${res.created} new slot(s) across ${res.areas} area(s) for ${res.flight.code}.`, () => { closeDrawer(); draw(); }));
}

function openDetail(areaId) {
  const d = read((s, u) => ar.areaDetail(s, areaId, u, { now: Date.now() }), null);
  if (!d) return;
  openDrawer({
    title: `${d.area.name} — collections`,
    large: true,
    bodyHtml: `
      <div class="table-wrap"><table><thead><tr><th>Traveler</th><th>Flight</th><th>Slot</th><th>Bags</th><th>Status</th></tr></thead>
        <tbody>${d.assignmentRows.map((r) => `<tr>
          <td>${esc(r.traveler?.name || '—')}</td>
          <td>${esc(r.flight?.code || '—')}</td>
          <td>${r.slot ? `${esc(fmtDateTime(r.slot.start))} – ${esc(fmtTime(r.slot.end))}` : '—'}</td>
          <td>${r.assignment.bags_declared ?? '—'}</td>
          <td>${esc(r.assignment.status)}${r.assignment.slot_outside_window ? ` ${chip('slot outside window', 'amber')}` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">No collections booked in this area.</td></tr>'}</tbody></table></div>`,
  });
}
