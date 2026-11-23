/**
 * Accounts — the roles System Admin owns (other admins, Operations Managers, Transport
 * Managers). Check-in, Warehouse, Backend and Monitor accounts belong to Ops; Transport Staff
 * to the Transport Manager. Who may manage whom comes from ROLE_PRESETS.manages, never a list
 * written here.
 */
import { S, run, chip, user } from '../data.js';
import * as staff from '../../../shared/services/staffService.js';
import { ROLE_PRESETS, canManageRole } from '../../../shared/rbac.js';
import { esc, fmtDateTime, openDrawer, closeDrawer, emptyState } from '../ui.js';

let el = null;
let showAll = false;

const managed = () => Object.values(ROLE_PRESETS).filter((p) => canManageRole(user(), p.id));

export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

function scopeCell(u) {
  if (u.area_id) return S().collectionAreas.find((a) => a.id === u.area_id)?.name || u.area_id;
  if (u.warehouse_id) return S().warehouses.find((w) => w.id === u.warehouse_id)?.name || u.warehouse_id;
  if (u.airport_id) return u.airport_id;
  return '—';
}

function row(u, mine) {
  const preset = ROLE_PRESETS[u.role];
  return `<tr>
    <td class="mono">${esc(u.employee_id || u.id)}</td>
    <td>${esc(u.name)}${u.legacy_id ? ` <span class="fs-xs muted">(was ${esc(u.legacy_id)})</span>` : ''}</td>
    <td>${esc(preset?.label || u.role)}</td>
    <td>${esc(scopeCell(u))}</td>
    <td>${u.status === 'Disabled' ? chip(`Disabled${u.disabled_reason ? ` — ${u.disabled_reason}` : ''}`, 'red') : chip('Active', 'green')}</td>
    <td>${esc(fmtDateTime(u.created_at))}</td>
    <td>${mine ? `<div class="row gap-2 wrap">
      <button type="button" class="btn btn-ghost" data-pin="${esc(u.id)}">Reset PIN</button>
      ${u.status === 'Disabled'
    ? `<button type="button" class="btn btn-secondary" data-enable="${esc(u.id)}">Enable</button>`
    : `<button type="button" class="btn btn-ghost" data-disable="${esc(u.id)}">Disable</button>`}
    </div>` : '<span class="fs-xs muted">Managed elsewhere</span>'}</td>
  </tr>`;
}

function draw() {
  if (!el) return;
  const mineRoles = managed().map((p) => p.id);
  const users = [...S().users]
    .filter((u) => showAll || mineRoles.includes(u.role))
    .sort((a, b) => String(a.employee_id).localeCompare(String(b.employee_id)));
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Accounts</h1>
        <p class="page-subtitle">System Admin owns ${managed().map((p) => p.label).join(', ')} accounts · demo PIN 1234</p></div>
      <button type="button" class="btn btn-primary" id="new">New account</button>
    </div>
    <div class="toolbar">
      <label class="checkbox-row"><input type="checkbox" id="f-all" ${showAll ? 'checked' : ''} /> Show every account in the system</label>
    </div>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Area / site</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${users.map((u) => row(u, mineRoles.includes(u.role))).join('') || `<tr><td colspan="7">${emptyState({ message: 'No accounts.' })}</td></tr>`}</tbody></table></div>`;

  el.querySelector('#f-all').addEventListener('change', (e) => { showAll = /** @type {HTMLInputElement} */ (e.target).checked; draw(); });
  el.querySelector('#new').addEventListener('click', openCreate);
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
      <p class="fs-xs muted">The employee ID is issued from the role prefix. The account starts with PIN 1234; the holder changes it on first sign-in in a real deployment.</p>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="n-go">Create account</button>',
  });
  d.el.querySelector('#n-go').addEventListener('click', () => run((s, c) => staff.createStaff(s, {
    role: /** @type {HTMLSelectElement} */ (d.el.querySelector('#n-role')).value,
    name: /** @type {HTMLInputElement} */ (d.el.querySelector('#n-name')).value,
    phone: /** @type {HTMLInputElement} */ (d.el.querySelector('#n-phone')).value,
  }, c), (u) => `${u.name} created as ${u.employee_id} (PIN 1234).`, () => { closeDrawer(); draw(); }));
}

function openDisable(id) {
  const d = openDrawer({
    title: 'Disable account',
    bodyHtml: '<div class="field"><label for="d-why">Reason <span class="req">*</span></label><input id="d-why" placeholder="Left the programme" /></div>',
    footerHtml: '<button type="button" class="btn btn-danger" id="d-go">Disable</button>',
  });
  d.el.querySelector('#d-go').addEventListener('click', () => run(
    (s, c) => staff.disableStaff(s, id, /** @type {HTMLInputElement} */ (d.el.querySelector('#d-why')).value, c),
    'Account disabled.', () => { closeDrawer(); draw(); }));
}
