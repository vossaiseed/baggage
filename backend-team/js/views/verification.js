import { S, chip } from '../data.js';
import { tagVerification } from '../../../shared/services/tagService.js';
import { esc, fmtDateTime } from '../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

function draw() {
  if (!el) return;
  const flights = S().flights.filter((f) => !f.legacy);
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Tag verification</h1><p class="page-subtitle">Released vs attached vs scanned, per flight</p></div></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Flight</th><th>Released</th><th>Attached</th><th>Scanned</th><th>Unused</th><th>Void</th><th>Problem scans</th></tr></thead><tbody>
    ${flights.map((f) => { const v = tagVerification(S(), f.id); return `<tr><td><strong>${esc(f.code)}</strong> ${f.no_airline_tag ? '<span class="badge-noairline">No airline tag</span>' : ''}</td>
      <td>${v.released}</td><td>${v.attached}</td><td>${v.scanned}</td><td>${v.unused ? chip(v.unused, 'amber') : 0}</td><td>${v.void}</td><td>${v.issues.length ? chip(v.issues.length, 'red') : 0}</td></tr>`; }).join('')}
    </tbody></table></div>
    <h2 class="section-title mt">Unused, duplicate and wrong-flight scans</h2>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>When</th><th>Value</th><th>Step</th><th>Result</th></tr></thead><tbody>
    ${S().scanEvents.filter((e) => e.result !== 'OK').slice(-50).reverse().map((e) => `<tr><td>${esc(fmtDateTime(e.at))}</td><td class="mono">${esc(e.raw_value)}</td><td>${esc(e.step || '')}</td><td>${chip(e.result, 'red')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No problem scans. Scans appear here once check-in staff start attaching tags.</td></tr>'}
    </tbody></table></div>`;
}
