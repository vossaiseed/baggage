/**
 * Airline policy — bags allowed, extra bags, maximum weight, the BTIC issuer codes that make an
 * airline tag valid, and whether the airline's data feed is connected. These are the numbers the
 * traveler's booking, the residence weigh-in and the tag validator all read.
 */
import { run, read, chip } from '../data.js';
import * as adm from '../../../shared/services/adminService.js';
import { esc, openDrawer, closeDrawer, emptyState } from '../ui.js';

let el = null;

export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

function row(r) {
  const a = r.airline;
  return `<tr>
    <td class="mono">${esc(a.code)}</td>
    <td>${esc(a.name)}</td>
    <td class="num">${a.bags_allowed}</td>
    <td class="num">${a.extra_bags_max}</td>
    <td class="num">${a.max_bag_weight_kg} kg</td>
    <td class="mono">${(a.btic_codes || []).map(esc).join(', ') || '—'}</td>
    <td>${chip(a.data_feed_status, a.data_feed_status === 'Connected' ? 'green' : 'grey')}</td>
    <td class="num">${r.flights}</td>
    <td class="num">${r.travelers}</td>
    <td><button type="button" class="btn btn-ghost" data-edit="${esc(a.code)}">Edit</button></td>
  </tr>`;
}

function draw() {
  if (!el) return;
  const rows = read((s, u) => adm.listAirlines(s, u), []) || [];
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Airline policy</h1>
        <p class="page-subtitle">What each airline allows, and which issuer codes its tags must start with</p></div>
      <button type="button" class="btn btn-primary" id="new">Add airline</button>
    </div>
    <div class="table-wrap"><table><thead><tr>
        <th>Code</th><th>Airline</th><th class="num">Bags</th><th class="num">Extra</th><th class="num">Max weight</th>
        <th>BTIC codes</th><th>Data feed</th><th class="num">Flights</th><th class="num">Travelers</th><th></th></tr></thead>
      <tbody>${rows.map(row).join('') || `<tr><td colspan="10">${emptyState({ message: 'No airlines yet.' })}</td></tr>`}</tbody></table></div>
    <p class="fs-sm muted mt">A change applies to what happens next — bookings and weigh-ins from now on. A bag already weighed at a
    residence keeps the verdict it was given there.</p>`;

  el.querySelector('#new').addEventListener('click', openCreate);
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEdit(b.getAttribute('data-edit'), rows)));
}

const fields = (a = {}) => `
  <div class="row gap-2">
    <div class="field grow"><label for="p-bags">Bags allowed</label><input id="p-bags" type="number" min="0" max="9" value="${a.bags_allowed ?? 2}" /></div>
    <div class="field grow"><label for="p-extra">Extra bags allowed</label><input id="p-extra" type="number" min="0" max="9" value="${a.extra_bags_max ?? 0}" /></div>
  </div>
  <div class="field"><label for="p-weight">Maximum bag weight (kg)</label><input id="p-weight" type="number" min="1" max="50" step="0.5" value="${a.max_bag_weight_kg ?? 23}" /></div>
  <div class="field"><label for="p-btic">BTIC issuer codes</label>
    <input id="p-btic" value="${esc((a.btic_codes || []).join(', '))}" placeholder="065, 126" />
    <div class="fs-xs muted">The first 3 digits of this airline's 10-digit tags. Comma-separated, 3 digits each.</div></div>
  <div class="field"><label for="p-feed">Data feed</label>
    <select id="p-feed">
      <option ${a.data_feed_status === 'Connected' ? 'selected' : ''}>Connected</option>
      <option ${a.data_feed_status !== 'Connected' ? 'selected' : ''}>Not connected</option>
    </select>
    <div class="fs-xs muted">"Not connected" means Backend cannot pull this airline's manifest — the flight falls back to internal tags only.</div></div>`;

const readFields = (d) => ({
  bags_allowed: Number(/** @type {HTMLInputElement} */ (d.el.querySelector('#p-bags')).value),
  extra_bags_max: Number(/** @type {HTMLInputElement} */ (d.el.querySelector('#p-extra')).value),
  max_bag_weight_kg: Number(/** @type {HTMLInputElement} */ (d.el.querySelector('#p-weight')).value),
  btic_codes: /** @type {HTMLInputElement} */ (d.el.querySelector('#p-btic')).value,
  data_feed_status: /** @type {HTMLSelectElement} */ (d.el.querySelector('#p-feed')).value,
});

function openCreate() {
  const d = openDrawer({
    title: 'Add airline',
    bodyHtml: `
      <div class="row gap-2">
        <div class="field" style="flex:0 0 120px"><label for="p-code">Code <span class="req">*</span></label><input id="p-code" maxlength="2" placeholder="EK" /></div>
        <div class="field grow"><label for="p-name">Name</label><input id="p-name" placeholder="Emirates" /></div>
      </div>${fields()}`,
    footerHtml: '<button type="button" class="btn btn-primary" id="p-go">Add airline</button>',
  });
  d.el.querySelector('#p-go').addEventListener('click', () => run((s, c) => adm.createAirline(s, {
    code: /** @type {HTMLInputElement} */ (d.el.querySelector('#p-code')).value,
    name: /** @type {HTMLInputElement} */ (d.el.querySelector('#p-name')).value,
    ...readFields(d),
  }, c), (a) => `${a.code} added.`, () => { closeDrawer(); draw(); }));
}

function openEdit(code, rows) {
  const a = rows.find((r) => r.airline.code === code).airline;
  const d = openDrawer({
    title: `${a.code} — ${a.name}`,
    bodyHtml: fields(a),
    footerHtml: '<button type="button" class="btn btn-primary" id="p-go">Save policy</button>',
  });
  d.el.querySelector('#p-go').addEventListener('click', () => run(
    (s, c) => adm.updateAirlinePolicy(s, code, readFields(d), c), 'Policy saved.', () => { closeDrawer(); draw(); }));
}
