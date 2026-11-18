/** Transport Manager: create / disable / enable / reset PIN / move area for Transport Staff accounts. */
import { S, run, chip } from '../../data.js';
import * as staff from '../../../../shared/services/staffService.js';
import { ROLE } from '../../../../shared/constants.js';
import { esc, openDrawer, closeDrawer } from '../../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

function row(u) {
  const area = S().collectionAreas.find((a) => a.id === u.area_id);
  return `<tr>
    <td class="mono">${esc(u.id)}</td><td>${esc(u.name)}</td><td>${esc(area?.name || '—')}</td>
    <td>${u.status === 'Disabled' ? chip(`Disabled${u.disabled_reason ? ` — ${u.disabled_reason}` : ''}`, 'red') : chip('Active', 'green')}</td>
    <td><div class="row gap-2 wrap">
      <select data-move="${esc(u.id)}">${S().collectionAreas.map((a) => `<option value="${esc(a.id)}" ${a.id === u.area_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <button type="button" class="btn btn-ghost" data-pin="${esc(u.id)}">Reset PIN</button>
      ${u.status === 'Disabled' ? `<button type="button" class="btn btn-secondary" data-enable="${esc(u.id)}">Enable</button>` : `<button type="button" class="btn btn-ghost" data-disable="${esc(u.id)}">Disable</button>`}
    </div></td></tr>`;
}

function draw() {
  if (!el) return;
  const rows = S().users.filter((u) => u.role === ROLE.TRANSPORT_STAFF).sort((a, b) => a.id.localeCompare(b.id));
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Staff</h1><p class="page-subtitle">Transport Staff accounts, one per collection area</p></div></div>
    <div class="toolbar"><button type="button" class="btn btn-primary" id="new">New Transport Staff</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>Name</th><th>Area</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(row).join('') || '<tr><td colspan="5" class="muted">No Transport Staff yet.</td></tr>'}</tbody></table></div>`;

  el.querySelector('#new').addEventListener('click', openCreate);
  el.querySelectorAll('[data-move]').forEach((sel) => sel.addEventListener('change', (e) => run((s, c) => staff.moveArea(s, sel.dataset.move, e.target.value, c), 'Area updated.', draw)));
  el.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', () => run((s, c) => staff.resetPin(s, b.dataset.pin, '1234', c), 'PIN reset to 1234.', draw)));
  el.querySelectorAll('[data-enable]').forEach((b) => b.addEventListener('click', () => run((s, c) => staff.enableStaff(s, b.dataset.enable, c), 'Account enabled.', draw)));
  el.querySelectorAll('[data-disable]').forEach((b) => b.addEventListener('click', () => openDisable(b.dataset.disable)));
}

function openCreate() {
  const d = openDrawer({ title: 'New Transport Staff', bodyHtml: `
    <div class="field"><label for="n-name">Name <span class="req">*</span></label><input id="n-name" /></div>
    <div class="field"><label for="n-phone">Phone</label><input id="n-phone" /></div>
    <div class="field"><label for="n-area">Collection area <span class="req">*</span></label><select id="n-area">${S().collectionAreas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="n-go">Create</button>' });
  d.el.querySelector('#n-go').addEventListener('click', () => run(
    (s, c) => staff.createStaff(s, { role: ROLE.TRANSPORT_STAFF, name: d.el.querySelector('#n-name').value, phone: d.el.querySelector('#n-phone').value, area_id: d.el.querySelector('#n-area').value }, c),
    (u) => `${u.name} created as ${u.id} (PIN 1234).`, () => { closeDrawer(); draw(); },
  ));
}

function openDisable(id) {
  const d = openDrawer({ title: 'Disable account', bodyHtml: '<div class="field"><label for="d-why">Reason <span class="req">*</span></label><input id="d-why" /></div>',
    footerHtml: '<button type="button" class="btn btn-danger" id="d-go">Disable</button>' });
  d.el.querySelector('#d-go').addEventListener('click', () => run((s, c) => staff.disableStaff(s, id, d.el.querySelector('#d-why').value, c), 'Account disabled.', () => { closeDrawer(); draw(); }));
}
