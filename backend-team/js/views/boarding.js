import { S, run, chip } from '../data.js';
import * as be from '../../../shared/services/backendService.js';
import { esc, openDrawer, closeDrawer } from '../ui.js';

let el = null;
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

function draw() {
  if (!el) return;
  const rows = S().travelers.filter((t) => !t.legacy);
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Boarding pass</h1><p class="page-subtitle">Verify each boarding-pass number against airline data</p></div></div>
    <div class="toolbar"><button type="button" class="btn btn-secondary" id="verify-all">Verify all with airline data</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Traveler</th><th>Flight</th><th>Boarding pass</th><th>Airline data</th><th>Status</th><th>Actions</th></tr></thead><tbody>
    ${rows.map((t) => {
      const f = S().flights.find((x) => x.id === t.flight_id);
      return `<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(f?.code || '—')}</td><td class="mono">${esc(t.boarding_pass_no || '—')}</td><td class="mono">${esc(t.airline?.boarding_pass_no || 'no airline data')}</td>
        <td>${t.boarding_pass_verified ? chip('Verified', 'green') : t.boarding_pass_flag ? chip(t.boarding_pass_flag, 'amber') : chip('Not verified', 'grey')}</td>
        <td><div class="row gap-2 wrap"><button type="button" class="btn btn-secondary" data-verify="${esc(t.id)}" ${t.airline?.boarding_pass_no ? '' : 'disabled'}>Verify</button>
        ${t.boarding_pass_flag ? `<button type="button" class="btn btn-primary" data-fix="${esc(t.id)}">Fix &amp; re-verify</button>` : ''}</div></td></tr>`;
    }).join('')}</tbody></table></div>`;
  el.querySelector('#verify-all').addEventListener('click', () => run((s, c) => {
    let ok = 0; let flagged = 0;
    for (const t of s.travelers.filter((x) => !x.legacy && x.airline?.boarding_pass_no && !x.boarding_pass_verified)) { const r = be.verifyBoardingPass(s, t.id, c); if (r.boarding_pass_verified) ok++; else flagged++; }
    return { ok, flagged };
  }, (r) => `${r.ok} verified, ${r.flagged} flagged for the check-in supervisor.`, draw));
  el.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', () => run((s, c) => be.verifyBoardingPass(s, b.dataset.verify, c), (t) => (t.boarding_pass_verified ? 'Boarding pass verified.' : 'Flagged for check-in supervisor.'), draw)));
  el.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => {
    const t = S().travelers.find((x) => x.id === b.dataset.fix);
    const d = openDrawer({ title: `Fix boarding pass — ${t.name}`, bodyHtml: `
      <p class="fs-sm">Airline data: <span class="mono">${esc(t.airline?.boarding_pass_no)}</span></p>
      <div class="field"><label for="n">Correct number <span class="req">*</span></label><input id="n" class="mono" value="${esc(t.airline?.boarding_pass_no || '')}" /></div>
      <div class="field"><label for="why">Reason <span class="req">*</span></label><textarea id="why" rows="3"></textarea></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="save">Save &amp; re-verify</button>' });
    d.el.querySelector('#save').addEventListener('click', () => run((s, c) => be.fixBoardingPass(s, t.id, d.el.querySelector('#n').value, d.el.querySelector('#why').value, c),
      (r) => (r.boarding_pass_verified ? 'Fixed and verified.' : 'Still does not match airline data.'), () => { closeDrawer(); draw(); }));
  }));
}
