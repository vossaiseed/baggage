/** Transport Manager: drivers roster — create, set Available/Off duty (Busy drivers must be rerouted off their trip first). */
import { S, run, pillClass } from '../../data.js';
import * as tr from '../../../../shared/services/transportService.js';
import { esc, openDrawer, closeDrawer } from '../../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

function row(d) {
  const truck = S().trucks.find((t) => t.id === d.truck_id);
  return `<tr>
    <td class="mono">${esc(d.id)}</td><td>${esc(d.name)}</td><td>${esc(d.phone || '—')}</td>
    <td><span class="${pillClass(d.status)}">${esc(d.status)}</span></td><td>${esc(truck?.id || '—')}</td>
    <td>${d.status !== 'Busy' ? `<button type="button" class="btn btn-ghost" data-toggle="${esc(d.id)}" data-to="${d.status === 'Available' ? 'Off duty' : 'Available'}">${d.status === 'Available' ? 'Set off duty' : 'Set available'}</button>` : '<span class="fs-xs muted">On an active trip</span>'}</td></tr>`;
}

function draw() {
  if (!el) return;
  const rows = [...S().drivers].sort((a, b) => a.id.localeCompare(b.id));
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Drivers</h1><p class="page-subtitle">Roster for Collection and Airport trips</p></div></div>
    <div class="toolbar"><button type="button" class="btn btn-primary" id="new">New driver</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>Name</th><th>Phone</th><th>Status</th><th>Truck</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(row).join('') || '<tr><td colspan="6" class="muted">No drivers yet.</td></tr>'}</tbody></table></div>`;
  el.querySelector('#new').addEventListener('click', openCreate);
  el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => run((s, c) => tr.setDriverStatus(s, b.dataset.toggle, b.dataset.to, c), (d) => `${d.name} is now ${d.status}.`, draw)));
}

function openCreate() {
  const d = openDrawer({ title: 'New driver', bodyHtml: `
    <div class="field"><label for="n-name">Name <span class="req">*</span></label><input id="n-name" /></div>
    <div class="field"><label for="n-phone">Phone</label><input id="n-phone" /></div>
    <div class="field"><label for="n-lic">License no.</label><input id="n-lic" /></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="n-go">Create</button>' });
  d.el.querySelector('#n-go').addEventListener('click', () => run(
    (s, c) => tr.createDriver(s, { name: d.el.querySelector('#n-name').value, phone: d.el.querySelector('#n-phone').value, license_no: d.el.querySelector('#n-lic').value }, c),
    (drv) => `${drv.name} added as ${drv.id}.`, () => { closeDrawer(); draw(); },
  ));
}
