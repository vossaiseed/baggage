/** Transport Manager: truck roster — create, set Available/Off duty (Busy trucks must be rerouted off their trip first). */
import { S, run, pillClass } from '../../data.js';
import * as tr from '../../../../shared/services/transportService.js';
import { esc, openDrawer, closeDrawer } from '../../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

function row(t) {
  const driver = S().drivers.find((d) => d.id === t.driver_id);
  return `<tr>
    <td class="mono">${esc(t.id)}</td><td>${esc(t.plate_no)}</td><td>${t.capacity_bags}</td>
    <td><span class="${pillClass(t.status)}">${esc(t.status)}</span></td><td>${esc(driver?.name || '—')}</td>
    <td>${t.status !== 'Busy' ? `<button type="button" class="btn btn-ghost" data-toggle="${esc(t.id)}" data-to="${t.status === 'Available' ? 'Off duty' : 'Available'}">${t.status === 'Available' ? 'Set off duty' : 'Set available'}</button>` : '<span class="fs-xs muted">On an active trip</span>'}</td></tr>`;
}

function draw() {
  if (!el) return;
  const rows = [...S().trucks].sort((a, b) => a.id.localeCompare(b.id));
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Trucks</h1><p class="page-subtitle">Fleet for Collection and Airport trips</p></div></div>
    <div class="toolbar"><button type="button" class="btn btn-primary" id="new">New truck</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>Plate</th><th>Capacity (bags)</th><th>Status</th><th>Driver</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(row).join('') || '<tr><td colspan="6" class="muted">No trucks yet.</td></tr>'}</tbody></table></div>`;
  el.querySelector('#new').addEventListener('click', openCreate);
  el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => run((s, c) => tr.setTruckStatus(s, b.dataset.toggle, b.dataset.to, c), (t) => `${t.id} is now ${t.status}.`, draw)));
}

function openCreate() {
  const d = openDrawer({ title: 'New truck', bodyHtml: `
    <div class="field"><label for="n-plate">Plate number <span class="req">*</span></label><input id="n-plate" /></div>
    <div class="field"><label for="n-cap">Capacity (bags)</label><input id="n-cap" type="number" value="80" min="1" /></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="n-go">Create</button>' });
  d.el.querySelector('#n-go').addEventListener('click', () => run(
    (s, c) => tr.createTruck(s, { plate_no: d.el.querySelector('#n-plate').value, capacity_bags: d.el.querySelector('#n-cap').value }, c),
    (t) => `${t.id} added.`, () => { closeDrawer(); draw(); },
  ));
}
