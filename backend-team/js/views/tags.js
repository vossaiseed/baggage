/** Tags: import airline tag list, assign, release, internal-only flights, damaged tag void/replace, internal label sheets. */
import { S, run, chip } from '../data.js';
import * as tags from '../../../shared/services/tagService.js';
import { SAMPLE_TAG_FILES } from '../../../shared/seed/departure.js';
import { esc, openDrawer, closeDrawer, toast, fmtDateTime } from '../ui.js';

let el = null;
let sheet = null; // { areaId, slotId }
export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

const liveFlights = () => S().flights.filter((f) => !f.legacy && !['Cancelled', 'Completed'].includes(f.status));
const lpnTags = (fid) => S().bagTags.filter((t) => t.tag_type === 'IATA_LPN' && t.flight_id === fid);

function flightCard(f) {
  const ts = lpnTags(f.id);
  const n = (s) => ts.filter((t) => t.status === s).length;
  const bags = S().bags.filter((b) => b.flight_id === f.id && !b.legacy);
  const verified = bags.filter((b) => b.status === 'Data Verified' && !b.airline_tag_no).length;
  const internalOnly = f.no_airline_tag || ts.length === 0;
  return `<div class="card flight-card">
    <div class="row" style="justify-content:space-between;gap:var(--s2);flex-wrap:wrap"><h2 class="section-title" style="margin:0">${esc(f.code)} <span class="muted fs-sm">${esc(f.route || '')}</span></h2>
      ${f.no_airline_tag ? '<span class="badge-noairline">No airline tag</span>' : ''}</div>
    <div class="pill-row">${chip(`Imported ${n('Imported')}`)} ${chip(`Assigned ${n('Assigned')}`, 'blue')} ${chip(`Released ${n('Released')}`, 'green')} ${chip(`Void ${n('Void')}`, n('Void') ? 'red' : 'grey')} ${chip(`${verified} bag(s) awaiting a tag`, verified ? 'amber' : 'grey')}</div>
    <div class="row gap-2 wrap">
      <button type="button" class="btn btn-primary" data-import="${esc(f.id)}">Import tag list</button>
      <button type="button" class="btn btn-secondary" data-assign="${esc(f.id)}" ${n('Imported') ? '' : 'disabled'}>Assign</button>
      <button type="button" class="btn btn-secondary" data-release="${esc(f.id)}" ${n('Assigned') ? '' : 'disabled'}>Release to check-in</button>
      ${ts.length === 0 ? `<button type="button" class="btn btn-ghost" data-internal="${esc(f.id)}" ${verified ? '' : 'disabled'}>Issue internal tags only</button>` : ''}
    </div>
    ${internalOnly && ts.length === 0 ? '<p class="fs-xs muted">No airline tag list imported — you can issue Rabel internal tags only; the flight is flagged for Ops.</p>' : ''}
  </div>`;
}

function draw() {
  if (!el) return;
  const batches = [...S().tagImportBatches].reverse();
  const extra = tags.extraBagRequests(S());
  const damaged = S().exceptions.filter((e) => e.type === 'Damaged Tag' && e.status === 'Open');
  const areas = S().collectionAreas;
  sheet = sheet || { areaId: areas[0]?.id, slotId: '' };
  const slots = S().collectionSlots.filter((s) => s.collection_area_id === sheet.areaId).sort((a, b) => a.start.localeCompare(b.start));
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">Tags</h1><p class="page-subtitle">Airline tags (LPN) are imported, assigned and released — Rabel cannot create them</p></div></div>
    <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:var(--s4)">${liveFlights().map(flightCard).join('')}</div>

    ${extra.length ? `<h2 class="section-title mt">Extra-bag tag requests <span class="chip chip-amber">${extra.length}</span></h2>
    <div class="card stack gap-2"><p class="fs-sm muted">Check-in staff accepted extra bag(s) at the residence (within the airline's extra-bag limit). Issue an airline tag from the flight's pool (or an internal tag if the flight has no list).</p>
      ${extra.map((x) => `<div class="row gap-2 wrap" style="justify-content:space-between"><span><strong>${esc(x.traveler.name)}</strong> · ${esc(x.flight?.code || '')} · ${x.bags.length} bag(s)</span><button type="button" class="btn btn-primary" data-extra="${esc(x.traveler.id)}">Issue tag(s)</button></div>`).join('')}</div>` : ''}

    <h2 class="section-title mt">Import history</h2>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Batch</th><th>File</th><th>When</th><th>OK</th><th>Rejected</th><th>Status</th></tr></thead><tbody>
      ${batches.map((b) => `<tr><td class="mono">${esc(b.id)}</td><td>${esc(b.file_name)}</td><td>${esc(fmtDateTime(b.at))}</td><td>${b.rows_ok}</td>
        <td>${b.rows_rejected}${b.rejected_rows.length ? `<ul class="rej">${b.rejected_rows.map((r) => `<li>line ${r.line ?? '?'}: <span class="mono">${esc(r.lpn || '—')}</span> — ${esc(r.reason)}</li>`).join('')}</ul>` : ''}</td>
        <td>${chip(b.status, b.status === 'Completed' ? 'green' : b.status === 'Partial' ? 'amber' : 'red')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No imports yet.</td></tr>'}
    </tbody></table></div>

    <h2 class="section-title mt">Damaged tag — void &amp; replace</h2>
    <div class="card stack gap-3">
      <p class="fs-sm muted">Check-in staff report a damaged tag; you void the old LPN and a spare from the same batch is assigned and released.</p>
      ${damaged.length ? `<ul class="stack gap-2">${damaged.map((e) => `<li class="row gap-2 wrap fs-sm" style="justify-content:space-between"><span>${esc(e.notes || e.id)}</span>${e.tag_id ? `<button type="button" class="btn btn-primary" data-void-exc="${esc(e.id)}">Void &amp; replace</button>` : ''}</li>`).join('')}</ul>` : '<p class="fs-sm muted">No open requests from check-in.</p>'}
      <form class="row gap-2 wrap" id="void-form"><input id="void-lpn" class="mono" placeholder="10-digit tag number" maxlength="10" style="min-width:200px" />
        <input id="void-why" placeholder="Reason (required)" style="min-width:220px" /><button type="submit" class="btn btn-secondary">Void &amp; replace</button></form>
    </div>

    <h2 class="section-title mt">Internal label sheet</h2>
    <div class="card stack gap-3">
      <div class="row gap-2 wrap">
        <select id="sh-area" aria-label="Collection area">${areas.map((a) => `<option value="${esc(a.id)}" ${a.id === sheet.areaId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
        <select id="sh-slot" aria-label="Slot"><option value="">All slots</option>${slots.map((s) => `<option value="${esc(s.id)}" ${s.id === sheet.slotId ? 'selected' : ''}>${esc(fmtDateTime(s.start))}</option>`).join('')}</select>
        <button type="button" class="btn btn-secondary" id="sh-go">Generate sheet</button><button type="button" class="btn btn-primary" id="sh-print">Print</button></div>
      <div id="label-print"><div class="label-sheet" id="label-sheet"></div></div>
    </div>`;

  el.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', () => openImport(b.dataset.import)));
  el.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => run((s, c) => tags.assignTags(s, b.dataset.assign, c), (r) => `${r.assigned} tag(s) assigned${r.shortage ? ` — ${r.shortage} bag(s) still need a tag` : ''}.`, draw)));
  el.querySelectorAll('[data-release]').forEach((b) => b.addEventListener('click', () => run((s, c) => tags.releaseTags(s, b.dataset.release, c), (r) => `${r.released} tag(s) released — bags are now "Tag Assigned".`, draw)));
  el.querySelectorAll('[data-internal]').forEach((b) => b.addEventListener('click', () => run((s, c) => tags.issueInternalOnly(s, b.dataset.internal, c), (r) => `${r.issued} bag(s) tagged with internal tags only.`, draw)));
  el.querySelectorAll('[data-extra]').forEach((b) => b.addEventListener('click', () => run((s, c) => tags.issueExtraBagTags(s, b.dataset.extra, c), (r) => `${r.issued} extra bag(s) tagged${r.waiting ? `, ${r.waiting} waiting for a spare tag` : ''}.`, draw)));
  el.querySelectorAll('[data-void-exc]').forEach((b) => b.addEventListener('click', () => {
    const e = S().exceptions.find((x) => x.id === b.dataset.voidExc);
    run((s, c) => tags.voidAndReplace(s, e.tag_id, 'Damaged at the residence', c), (r) => `Voided ${r.voided.lpn}; replacement ${r.replacement.lpn} released.`, draw);
  }));
  el.querySelector('#void-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const lpn = el.querySelector('#void-lpn').value.trim();
    const t = S().bagTags.find((x) => x.lpn === lpn);
    if (!t) { toast('No tag with that number.', 'error'); return; }
    run((s, c) => tags.voidAndReplace(s, t.id, el.querySelector('#void-why').value, c), (r) => `Voided ${lpn}; replaced by ${r.replacement.lpn}.`, draw);
  });
  el.querySelector('#sh-area').addEventListener('change', (e) => { sheet = { areaId: e.target.value, slotId: '' }; draw(); });
  el.querySelector('#sh-slot').addEventListener('change', (e) => { sheet.slotId = e.target.value; });
  el.querySelector('#sh-go').addEventListener('click', renderSheet);
  el.querySelector('#sh-print').addEventListener('click', () => { renderSheet(); window.print(); });
}

function renderSheet() {
  const root = el.querySelector('#label-sheet');
  let rows = [];
  try { rows = tags.labelSheet(S(), { areaId: sheet.areaId, slotId: sheet.slotId || null }, { user: S().users.find((u) => u.role === 'backend') }); } catch (err) { toast(err.message, 'error'); return; }
  root.innerHTML = rows.length ? rows.map((r, i) => `<div class="label"><strong class="fs-sm">${esc(r.tag_no)}</strong><svg class="bc" id="bc-${i}"></svg><div class="qr" id="qr-${i}"></div><span class="fs-xs">${esc(r.traveler)} · ${esc(r.flight)}</span></div>`).join('')
    : '<p class="fs-sm muted">No labels yet for this area/slot — verify travelers first (internal labels are issued at "Data Verified").</p>';
  rows.forEach((r, i) => {
    try { window.JsBarcode?.(root.querySelector(`#bc-${i}`), r.tag_no, { format: 'CODE128', displayValue: false, height: 40, margin: 0 }); } catch { /* library unavailable offline */ }
    try { if (window.QRCode) new window.QRCode(root.querySelector(`#qr-${i}`), { text: r.tag_no, width: 64, height: 64 }); } catch { /* library unavailable offline */ }
  });
}

function openImport(flightId) {
  const f = S().flights.find((x) => x.id === flightId);
  const d = openDrawer({ title: `Import airline tag list — ${f.code}`, bodyHtml: `
    <p class="fs-sm muted">CSV columns: <span class="mono">booking_ref, flight, lpn</span>. Each tag must be exactly 10 digits (a leading zero is kept), use an issuer code from the airline's list (${esc((S().airlines.find((a) => a.code === f.airline_code)?.btic_codes || []).join(', '))}) and be unique.</p>
    <div class="field"><label for="f">File</label><input id="f" type="file" accept=".csv,text/csv" /></div>
    <div class="field"><label for="s">Demo sample file</label><select id="s"><option value="">— none —</option>${SAMPLE_TAG_FILES.map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</select></div>
    <div class="field"><label for="t">CSV</label><textarea id="t" class="mono-area"></textarea></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="go">Validate &amp; import</button>' });
  let fileName = 'tags.csv';
  d.el.querySelector('#f').addEventListener('change', async (e) => { const file = e.target.files[0]; if (file) { fileName = file.name; d.el.querySelector('#t').value = await file.text(); } });
  d.el.querySelector('#s').addEventListener('change', (e) => { const x = SAMPLE_TAG_FILES.find((s) => s.id === e.target.value); if (x) { d.el.querySelector('#t').value = x.csv; fileName = x.file; } });
  d.el.querySelector('#go').addEventListener('click', () => run((s, c) => tags.importTagBatch(s, { csv: d.el.querySelector('#t').value, fileName }, c),
    (b) => `${b.rows_ok} tag(s) imported, ${b.rows_rejected} rejected.`, () => { closeDrawer(); draw(); }));
}
