/** Data collection: Sync Nusuk, Import airline file, match & verify, fix / reject, unmapped addresses. */
import { S, run, chip, flightOptions } from '../data.js';
import * as be from '../../../shared/services/backendService.js';
import { esc, openDrawer, closeDrawer, toast } from '../ui.js';

let el = null;
let flightId = '';
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

const COLOR = { matched: 'green', mismatch: 'amber', missing: 'red' };

function draw() {
  if (!el) return;
  const rows = be.dataRows(S(), { flightId: flightId || null });
  const unmapped = be.unmappedAddresses(S());
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Data collection</h1><p class="page-subtitle">Nusuk + airline data → matched, mismatch or missing</p></div></div>
    <div class="toolbar">
      <button type="button" class="btn btn-primary" id="sync">Sync Nusuk</button>
      <button type="button" class="btn btn-secondary" id="import">Import airline file</button>
      <button type="button" class="btn btn-secondary" id="verify-all">Verify all matched</button>
      <select id="flt" aria-label="Flight"><option value="">All flights</option>${flightOptions(flightId)}</select>
    </div>
    ${unmapped.length ? `<div class="card" style="margin-block-end:var(--s5)"><h2 class="section-title">Unmapped address <span class="chip chip-red">${unmapped.length}</span></h2>
      <p class="fs-sm muted">Every traveler needs a residence linked to a collection area before collection can be booked.</p>
      <ul class="stack gap-2">${unmapped.map((u) => `<li class="row" style="justify-content:space-between;gap:var(--s3);flex-wrap:wrap"><span><strong>${esc(u.traveler.name)}</strong> · ${esc(u.flight)} · ${u.residence ? `${esc(u.residence.building)}, ${esc(u.residence.district)}` : 'no residence'}</span>
        <span class="row gap-2"><select data-area="${esc(u.traveler.id)}">${S().collectionAreas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select><button type="button" class="btn btn-secondary" data-map="${esc(u.traveler.id)}">Link area</button></span></li>`).join('')}</ul></div>` : ''}
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Traveler</th><th>Flight</th><th>Address (residence)</th><th>Data</th><th>Verified</th><th>Actions</th></tr></thead>
      <tbody>${rows.map((r) => {
        const t = r.traveler;
        const detail = r.match.status === 'mismatch' ? ` · ${r.match.fields.join(', ')}` : r.match.status === 'missing' ? ` · not in ${r.match.missing_from}` : '';
        return `<tr><td><strong>${esc(t.name)}</strong><div class="fs-xs muted">${esc(t.nusuk_id || t.booking_ref || '')} · ${esc(t.source)}</div></td>
          <td>${esc(r.flight)}</td>
          <td>${r.address ? esc(r.address) : '—'} ${r.mapped ? '' : chip('Unmapped', 'red')}</td>
          <td>${chip(r.match.status + detail, COLOR[r.match.status])}${t.data_rejected ? ' ' + chip('Rejected', 'red') : ''}</td>
          <td>${t.data_verified ? chip('Verified', 'green') : chip('Pending', 'amber')}</td>
          <td><div class="row gap-2 wrap">
            ${r.match.status === 'matched' && !t.data_verified && !t.data_rejected ? `<button type="button" class="btn btn-primary" data-verify="${esc(t.id)}">Match &amp; verify</button>` : ''}
            ${r.match.status === 'mismatch' ? `<button type="button" class="btn btn-secondary" data-fix="${esc(t.id)}">Fix</button>` : ''}
            ${r.match.status !== 'matched' && !t.data_rejected ? `<button type="button" class="btn btn-ghost" data-reject="${esc(t.id)}">Reject</button>` : ''}
          </div></td></tr>`;
      }).join('') || '<tr><td colspan="6" class="muted">No travelers.</td></tr>'}</tbody></table></div>`;

  el.querySelector('#flt').addEventListener('change', (e) => { flightId = e.target.value; draw(); });
  el.querySelector('#sync').addEventListener('click', () => run((s, c) => be.syncNusuk(s, c), (r) => `Nusuk: ${r.checked} checked, ${r.created} new, ${r.updated} updated.`, draw));
  el.querySelector('#verify-all').addEventListener('click', () => run((s, c) => be.verifyAllMatched(s, flightId || null, c), (r) => `${r.verified} traveler(s) verified.`, draw));
  el.querySelector('#import').addEventListener('click', openImport);
  el.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', () => run((s, c) => be.matchAndVerify(s, b.dataset.verify, c), (r) => `Verified — ${r.bagsVerified} bag(s) now "Data Verified".`, draw)));
  el.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => openFix(b.dataset.fix)));
  el.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => openReject(b.dataset.reject)));
  el.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => {
    const area = el.querySelector(`[data-area="${b.dataset.map}"]`).value;
    run((s, c) => be.mapResidence(s, b.dataset.map, area, c), 'Address linked to the collection area.', draw);
  }));
}

function openImport() {
  const d = openDrawer({ title: 'Import airline file', bodyHtml: `
    <p class="fs-sm muted">CSV columns: <span class="mono">booking_ref, passport, name, flight, boarding_pass_no</span>. Leave empty to use the simulated airline feed.</p>
    <div class="field"><label for="f">File</label><input id="f" type="file" accept=".csv,text/csv" /></div>
    <div class="field"><label for="t">…or paste CSV</label><textarea id="t" class="mono-area"></textarea></div>`,
    footerHtml: '<button type="button" class="btn btn-secondary" id="feed">Use simulated airline feed</button><button type="button" class="btn btn-primary" id="go">Import</button>' });
  d.el.querySelector('#f').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) d.el.querySelector('#t').value = await f.text(); });
  const go = (csv) => run((s, c) => be.importAirlineFile(s, csv, c), (r) => `Airline data: ${r.rows} rows (${r.created} new).`, () => { closeDrawer(); draw(); });
  d.el.querySelector('#feed').addEventListener('click', () => go(''));
  d.el.querySelector('#go').addEventListener('click', () => { const v = d.el.querySelector('#t').value; if (!v.trim()) { toast('Choose a file, paste CSV or use the simulated feed.', 'error'); return; } go(v); });
}

function openFix(id) {
  const t = S().travelers.find((x) => x.id === id);
  const m = be.matchStatus(t);
  const d = openDrawer({ title: `Fix mismatch — ${t.name}`, bodyHtml: `
    ${m.fields.map((f) => `<fieldset class="card" style="margin-block-end:var(--s3)"><legend class="fw-semibold">${esc(f)}</legend>
      ${['nusuk', 'airline'].map((src) => `<label class="row gap-2" style="padding:6px 0"><input type="radio" name="c-${f}" value="${src}" /> <span><strong>${src === 'nusuk' ? 'Nusuk' : 'Airline'}:</strong> ${esc(f === 'flight' ? t[src].flight_code : t[src][f])}</span></label>`).join('')}</fieldset>`).join('')}
    <div class="field"><label for="why">Reason <span class="req">*</span></label><textarea id="why" rows="3"></textarea></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="save">Apply fix</button>' });
  d.el.querySelector('#save').addEventListener('click', () => {
    const choices = Object.fromEntries(m.fields.map((f) => [f, d.el.querySelector(`input[name="c-${f}"]:checked`)?.value]));
    run((s, c) => be.fixMismatch(s, id, choices, d.el.querySelector('#why').value, c), 'Mismatch fixed — you can now match & verify.', () => { closeDrawer(); draw(); });
  });
}

function openReject(id) {
  const t = S().travelers.find((x) => x.id === id);
  const d = openDrawer({ title: `Reject — ${t.name}`, bodyHtml: '<div class="field"><label for="n">Note to Operations <span class="req">*</span></label><textarea id="n" rows="4"></textarea></div>',
    footerHtml: '<button type="button" class="btn btn-danger" id="rej">Reject &amp; notify Ops</button>' });
  d.el.querySelector('#rej').addEventListener('click', () => run((s, c) => be.rejectTraveler(s, id, d.el.querySelector('#n').value, c), 'Rejected — Ops notified.', () => { closeDrawer(); draw(); }));
}
