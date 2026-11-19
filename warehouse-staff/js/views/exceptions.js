/**
 * Exceptions — read-only here. The Warehouse Manager raises exceptions by working (a short count, a
 * label from the wrong truck); only the Operations Manager closes them, so this screen reports rather
 * than edits.
 */
import { S, user, chip, esc } from '../data.js';
import { warehouseExceptions } from '../../../shared/services/warehouseService.js';
import { fmtDateTime } from '../ui.js';

let el = null;
let showClosed = false;
export function render(params, app) { el = app; draw(); return { destroy, poll: draw, refresh: draw }; }
export function destroy() { el = null; }

const SEV = { High: 'red', Medium: 'amber', Low: 'grey' };

function draw() {
  if (!el) return;
  let rows;
  try { rows = warehouseExceptions(S(), user(), { includeClosed: showClosed }); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p></div>`;
    return;
  }
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Exceptions</h1><p class="page-subtitle">${rows.length} ${showClosed ? 'in total' : 'open'} · the Operations Manager resolves them</p></div>
      <button type="button" class="btn btn-secondary" id="toggle">${showClosed ? 'Open only' : 'Include resolved'}</button>
    </div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Raised</th><th>Type</th><th>Severity</th><th>Bag</th><th>Flight</th><th>Notes</th><th>Status</th></tr></thead>
      <tbody>${rows.map((e) => `<tr>
        <td class="fs-xs muted">${esc(fmtDateTime(e.time))}</td>
        <td><strong class="fs-sm">${esc(e.type)}</strong></td>
        <td>${chip(e.severity, SEV[e.severity] || 'grey')}</td>
        <td class="mono fs-sm">${esc(e.bag?.tag_no || e.value || '—')}</td>
        <td>${esc(e.flight?.code || '—')}</td>
        <td class="fs-sm">${esc(e.notes)}</td>
        <td>${chip(e.status, e.status === 'Open' ? 'amber' : 'green')}</td>
      </tr>`).join('')}</tbody></table></div>`
      : `<div class="state-block"><p>No ${showClosed ? '' : 'open '}exceptions on this warehouse's bags.</p></div>`}`;
  el.querySelector('#toggle')?.addEventListener('click', () => { showClosed = !showClosed; draw(); });
}
