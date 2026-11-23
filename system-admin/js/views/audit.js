/** Audit — every service writes here through shared/services/audit.js. Read-only, newest first. */
import { S, read } from '../data.js';
import * as adm from '../../../shared/services/adminService.js';
import { esc, fmtDateTime, emptyState, downloadBlob } from '../ui.js';
import { toCsv } from '../../../shared/services/reportService.js';

let el = null;
let filters = { q: '', action: '', entity: '', limit: 200 };

export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

const short = (v) => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
};

function row(r) {
  const a = r.entry;
  return `<tr>
    <td class="mono fs-xs">${esc(fmtDateTime(a.at))}</td>
    <td class="mono fs-xs">${esc(a.action)}</td>
    <td>${esc(a.entity)} <span class="mono fs-xs muted">${esc(a.entity_id || '')}</span></td>
    <td>${esc(r.by?.name || a.user_id || 'system')} <span class="fs-xs muted">${esc(a.role || '')}</span></td>
    <td class="fs-xs">${esc(short(a.before))}</td>
    <td class="fs-xs">${esc(short(a.after))}</td>
    <td class="fs-xs">${esc(a.note || '')}</td>
  </tr>`;
}

function draw() {
  if (!el) return;
  const facets = read((s, u) => adm.auditFacets(s, u), { actions: [], entities: [] });
  const rows = read((s, u) => adm.auditTrail(s, u, filters), []) || [];
  if (!facets) return;
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Audit</h1>
        <p class="page-subtitle">${S().auditLog.length} entr${S().auditLog.length === 1 ? 'y' : 'ies'} · every service writes here · PINs are never recorded</p></div>
      <button type="button" class="btn btn-secondary" id="csv">Export CSV</button>
    </div>
    <div class="toolbar">
      <input type="search" id="f-q" placeholder="Search id, entity, user, note…" value="${esc(filters.q)}" />
      <select id="f-action"><option value="">Every action</option>${facets.actions.map((x) => `<option ${filters.action === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <select id="f-entity"><option value="">Every entity</option>${facets.entities.map((x) => `<option ${filters.entity === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <span class="fs-sm muted">${rows.length} shown (newest ${filters.limit})</span>
    </div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Entity</th><th>By</th><th>Before</th><th>After</th><th>Note</th></tr></thead>
      <tbody>${rows.map(row).join('') || `<tr><td colspan="7">${emptyState({ message: 'Nothing matches those filters.' })}</td></tr>`}</tbody></table></div>`;

  const q = /** @type {HTMLInputElement} */ (el.querySelector('#f-q'));
  q.addEventListener('input', () => {
    const caret = q.selectionStart;
    filters.q = q.value;
    draw();
    const again = /** @type {HTMLInputElement} */ (el.querySelector('#f-q'));
    again.focus();
    again.setSelectionRange(caret, caret);
  });
  el.querySelector('#f-action').addEventListener('change', (e) => { filters.action = /** @type {HTMLSelectElement} */ (e.target).value; draw(); });
  el.querySelector('#f-entity').addEventListener('change', (e) => { filters.entity = /** @type {HTMLSelectElement} */ (e.target).value; draw(); });
  el.querySelector('#csv').addEventListener('click', () => {
    const all = read((s, u) => adm.auditTrail(s, u, { ...filters, limit: undefined }), []) || [];
    const flat = all.map((r) => ({ ...r.entry, before: JSON.stringify(r.entry.before ?? ''), after: JSON.stringify(r.entry.after ?? ''), by: r.by?.name || '' }));
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadBlob(`rabel-audit-${stamp}.csv`, toCsv(['id', 'at', 'action', 'entity', 'entity_id', 'user_id', 'role', 'by', 'before', 'after', 'note'], flat), 'text/csv');
  });
}
