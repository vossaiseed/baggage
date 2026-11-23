/**
 * Staff — the accounts Ops manages: Check-in Staff, Warehouse Managers, Backend Team and
 * Window Monitors (Transport accounts belong to the Transport Manager; admins to System Admin).
 */
import { S, run, chip } from '../data.js';
import * as staff from '../../../shared/services/staffService.js';
import { ROLE_PRESETS, canManageRole } from '../../../shared/rbac.js';
import { user } from '../data.js';
import { esc, openDrawer, closeDrawer, emptyState } from '../ui.js';

let el = null;
let roleFilter = '';

/** The roles this Ops account may actually manage, in menu order. */
const managed = () => Object.values(ROLE_PRESETS).filter((p) => canManageRole(user(), p.id));

export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

function scopeCell(u) {
  if (u.area_id) return S().collectionAreas.find((a) => a.id === u.area_id)?.name || u.area_id;
  if (u.warehouse_id) return S().warehouses.find((w) => w.id === u.warehouse_id)?.name || u.warehouse_id;
  if (u.airport_id) return u.airport_id;
  return '—';
}

function row(u) {
  const preset = ROLE_PRESETS[u.role];
  return `<tr>
    <td class="mono">${esc(u.employee_id || u.id)}</td>
    <td>${esc(u.name)}</td>
    <td>${esc(preset?.label || u.role)}</td>
    <td>${esc(scopeCell(u))}</td>
    <td>${u.status === 'Disabled' ? chip(`Disabled${u.disabled_reason ? ` — ${u.disabled_reason}` : ''}`, 'red') : chip('Active', 'green')}</td>
    <td><div class="row gap-2 wrap">
      ${u.role === 'checkin' ? `<select data-move="${esc(u.id)}" aria-label="Move ${esc(u.name)} to another area">
        ${S().collectionAreas.map((a) => `<option value="${esc(a.id)}" ${a.id === u.area_id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : ''}
      <button type="button" class="btn btn-ghost" data-pin="${esc(u.id)}">Reset PIN</button>
      ${u.status === 'Disabled'
    ? `<button type="button" class="btn btn-secondary" data-enable="${esc(u.id)}">Enable</button>`
    : `<button type="button" class="btn btn-ghost" data-disable="${esc(u.id)}">Disable</button>`}
    </div></td></tr>`;
}

function draw() {
  if (!el) return;
  const roles = managed().map((p) => p.id);
  const rows = S().users
    .filter((u) => roles.includes(u.role) && (roleFilter ? u.role === roleFilter : true))
    .sort((a, b) => String(a.employee_id).localeCompare(String(b.employee_id)));
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Staff</h1><p class="page-subtitle">Check-in, Warehouse, Backend and Monitor accounts · demo PIN 1234</p></div>
      <button type="button" class="btn btn-primary" id="new">New account</button>
    </div>
    <div class="toolbar">
      <select id="f-role"><option value="">Every role I manage</option>${managed().map((p) => `<option value="${esc(p.id)}" ${roleFilter === p.id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
    </div>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Area / site</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(row).join('') || `<tr><td colspan="6">${emptyState({ message: 'No accounts in this view.' })}</td></tr>`}</tbody></table></div>`;

  el.querySelector('#f-role').addEventListener('change', (e) => { roleFilter = /** @type {HTMLSelectElement} */ (e.target).value; draw(); });
  el.querySelector('#new').addEventListener('click', openCreate);
  el.querySelectorAll('[data-move]').forEach((sel) => sel.addEventListener('change', (e) => run(
    (s, c) => staff.moveArea(s, sel.getAttribute('data-move'), /** @type {HTMLSelectElement} */ (e.target).value, c), 'Area updated.', draw)));
  el.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', () => run(
    (s, c) => staff.resetPin(s, b.getAttribute('data-pin'), '1234', c), 'PIN reset to 1234.', draw)));
  el.querySelectorAll('[data-enable]').forEach((b) => b.addEventListener('click', () => run(
    (s, c) => staff.enableStaff(s, b.getAttribute('data-enable'), c), 'Account enabled.', draw)));
  el.querySelectorAll('[data-disable]').forEach((b) => b.addEventListener('click', () => openDisable(b.getAttribute('data-disable'))));
}

function openCreate() {
  const d = openDrawer({
    title: 'New account',
    bodyHtml: `
      <div class="field"><label for="n-role">Role <span class="req">*</span></label>
        <select id="n-role">${managed().map((p) => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.prefix)}-)</option>`).join('')}</select></div>
      <div class="field"><label for="n-name">Name <span class="req">*</span></label><input id="n-name" /></div>
      <div class="field"><label for="n-phone">Phone</label><input id="n-phone" /></div>
      <div class="field" id="scope-area"><label for="n-area">Collection area <span class="req">*</span></label>
        <select id="n-area">${S().collectionAreas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field" id="scope-wh" hidden><label for="n-wh">Warehouse <span class="req">*</span></label>
        <select id="n-wh">${S().warehouses.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></div>
      <p class="fs-xs muted">The employee ID is issued automatically from the role prefix. The account starts with PIN 1234.</p>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="n-go">Create account</button>',
  });
  const roleSel = /** @type {HTMLSelectElement} */ (d.el.querySelector('#n-role'));
  const sync = () => {
    d.el.querySelector('#scope-area').hidden = roleSel.value !== 'checkin';
    d.el.querySelector('#scope-wh').hidden = roleSel.value !== 'warehouse_manager';
  };
  roleSel.addEventListener('change', sync);
  sync();
  d.el.querySelector('#n-go').addEventListener('click', () => run((s, c) => staff.createStaff(s, {
    role: roleSel.value,
    name: /** @type {HTMLInputElement} */ (d.el.querySelector('#n-name')).value,
    phone: /** @type {HTMLInputElement} */ (d.el.querySelector('#n-phone')).value,
    area_id: roleSel.value === 'checkin' ? /** @type {HTMLSelectElement} */ (d.el.querySelector('#n-area')).value : null,
    warehouse_id: roleSel.value === 'warehouse_manager' ? /** @type {HTMLSelectElement} */ (d.el.querySelector('#n-wh')).value : null,
  }, c), (u) => `${u.name} created as ${u.employee_id} (PIN 1234).`, () => { closeDrawer(); draw(); }));
}

function openDisable(id) {
  const d = openDrawer({
    title: 'Disable account',
    bodyHtml: '<div class="field"><label for="d-why">Reason <span class="req">*</span></label><input id="d-why" placeholder="End of season" /></div>',
    footerHtml: '<button type="button" class="btn btn-danger" id="d-go">Disable</button>',
  });
  d.el.querySelector('#d-go').addEventListener('click', () => run(
    (s, c) => staff.disableStaff(s, id, /** @type {HTMLInputElement} */ (d.el.querySelector('#d-why')).value, c),
    'Account disabled.', () => { closeDrawer(); draw(); }));
}
