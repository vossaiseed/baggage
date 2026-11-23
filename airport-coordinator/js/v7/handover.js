/**
 * Departure — SGS handover: the airline-tag manifest for one flight, reconciled to what the Airport
 * Authority actually counts. The list is reconciled as a list; only a DISPUTED bag is scanned again.
 * Completing the handover moves every undisputed bag to "Handed to Airport Authority" and asks SGS
 * for the voucher that clears them.
 */
import { S, user, run, runScan, chip, esc, blockedHtml } from './data.js';
import * as ap from '../../../shared/services/airportService.js';
import { createScanner } from '../../../shared/ui/scanner.js';
import { fmtDateTime, toast } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
let handoverId = null;
let scanner = null;
let scanOpen = false;

export function render(params, app) {
  el = app;
  handoverId = params.id || null;
  scanOpen = false;
  draw();
  return { destroy, poll: () => { if (!handoverId) draw(); }, refresh: draw };
}
export function destroy() { scanner?.destroy(); scanner = null; el = null; handoverId = null; }

const handover = () => (S().handovers || []).find((h) => h.id === handoverId);

/* ───────── queue: one card per flight standing here ───────── */

function drawQueue() {
  const groups = ap.handoverQueue(S(), user(), { now: Date.now() });
  const recent = ap.listHandovers(S(), user()).filter((h) => h.status === 'Handed').slice(0, 6);
  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title">SGS handover</h1>
      <p class="page-subtitle">${groups.length} flight(s) waiting to be handed to the Airport Authority</p></div></div>
    ${groups.length ? `<div class="grid grid-cols-2 gap-3">${groups.map((g) => `
      <div class="card stack gap-2 ${g.alerts.some((a) => a.level === 'red') ? 'alert-red' : g.alerts.length ? 'alert-amber' : ''}">
        <div class="row gap-2 wrap" style="align-items:center"><strong class="fs-md mono">${esc(g.flight?.code || '—')}</strong>
          ${g.priority <= 3 ? chip(`P${g.priority}`, 'blue') : ''}
          ${g.noAirlineTag ? chip(`${g.noAirlineTag} with no airline tag`, 'amber') : ''}
          ${g.handover ? chip('Manifest open', 'blue') : ''}</div>
        <div class="fs-sm"><strong>${g.bags.length}</strong> bag(s) standing at the airport · cut-off ${esc(fmtDateTime(g.flight?.cut_off_at))}</div>
        ${g.alerts.length ? `<div class="fs-xs" style="color:var(--danger)">${esc(g.alerts[0].message)}</div>` : ''}
        <button type="button" class="btn btn-primary" data-flight="${esc(g.flight?.id || '')}" data-open="${esc(g.handover?.id || '')}">
          ${g.handover ? 'Continue the manifest' : 'Start the handover'}</button>
      </div>`).join('')}</div>`
    : '<div class="state-block"><p>No bags are waiting to be handed over. Bags arrive here once a truck has been offloaded — see <a href="#/dep/offload">Offload</a>.</p></div>'}
    ${recent.length ? `<h2 class="section-title" style="margin-block-start:var(--s6)">Handed over</h2>
      <div class="table-wrap"><table><thead><tr><th>Handover</th><th>Flight</th><th>Bags</th><th>Officer</th><th>When</th><th>Voucher</th></tr></thead>
      <tbody>${recent.map((h) => `<tr><td class="mono fs-sm">${esc(h.id)}</td>
        <td class="mono">${esc(S().flights.find((f) => f.id === h.flight_id)?.code || '—')}</td><td>${h.bag_ids.length}</td>
        <td>${esc(h.officer || '—')}</td><td>${esc(fmtDateTime(h.handed_at))}</td>
        <td><a href="#/dep/voucher">${esc(S().sgsVouchers.find((v) => v.id === h.voucher_id)?.voucher_no || '—')}</a></td></tr>`).join('')}</tbody></table></div>` : ''}`;

  el.querySelectorAll('[data-flight]').forEach((b) => b.addEventListener('click', () => {
    const open = /** @type {HTMLElement} */ (b).dataset.open;
    if (open) { navigate(`#/dep/handover/${open}`); return; }
    const h = run((s, c) => ap.startHandover(s, /** @type {HTMLElement} */ (b).dataset.flight, c), 'Manifest opened.');
    if (h) navigate(`#/dep/handover/${h.id}`);
  }));
}

/* ───────── one manifest ───────── */

function manifestRows(h) {
  return h.bag_ids.map((id) => {
    const bag = S().bags.find((b) => b.id === id);
    if (!bag) return '';
    const dispute = h.disputed.find((d) => d.bag_id === id && !d.resolved_at);
    const cleared = h.disputed.find((d) => d.bag_id === id && d.resolved_at);
    return `<tr>
      <td class="mono fs-sm">${esc(bag.airline_tag_no || `${bag.tag_no} (no airline tag)`)}</td>
      <td class="mono fs-sm">${esc(bag.tag_no || '—')}</td>
      <td>${esc(bag.status)}</td>
      <td>${dispute ? chip(`Disputed — ${dispute.reason}`, 'red') : cleared ? chip('Dispute cleared', 'green') : chip('On the manifest', 'grey')}</td>
      <td>${h.status === 'Open' && !dispute && !cleared ? `<button type="button" class="btn btn-ghost" data-dispute="${esc(id)}">Dispute</button>` : ''}</td>
    </tr>`;
  }).join('');
}

function drawManifest() {
  scanner?.destroy(); scanner = null;
  const h = handover();
  if (!h) { el.innerHTML = '<div class="state-block"><p>Handover not found.</p><a class="btn btn-primary" href="#/dep/handover">Back to handover</a></div>'; return; }
  const flight = S().flights.find((f) => f.id === h.flight_id);
  const open = h.status === 'Open';
  const unresolved = h.disputed.filter((d) => !d.resolved_at);

  el.innerHTML = `
    <div class="page-header"><div><h1 class="page-title mono">${esc(flight?.code || '')}</h1>
      <p class="page-subtitle">${esc(h.id)} · ${h.bag_ids.length} bag(s) · ${chip(open ? 'Open' : 'Handed over', open ? 'blue' : 'green')}</p></div></div>
    ${open ? `<div class="card stack gap-2" style="margin-block-end:var(--s4)">
        <h2 class="section-title">Reconcile the list</h2>
        <p class="fs-sm muted">Read the manifest against the Authority's count. Anything they will not accept — a tag they cannot read, a bag they cannot find — gets disputed, and only those bags are scanned again.</p>
        ${unresolved.length ? `<div class="row gap-2 wrap"><strong class="fs-sm" style="color:var(--danger)">${unresolved.length} disputed bag(s)</strong>
          <button type="button" class="btn btn-secondary" id="scan-toggle">${scanOpen ? 'Hide the scanner' : 'Scan a disputed tag'}</button></div>
          ${scanOpen ? '<div id="scanner-host" style="margin-block-start:var(--s3)"></div>' : ''}` : ''}
      </div>` : ''}
    <div class="table-wrap"><table>
      <thead><tr><th>Airline tag</th><th>Rabel label</th><th>Status</th><th>Reconciliation</th><th></th></tr></thead>
      <tbody>${manifestRows(h)}</tbody></table></div>
    ${open ? `<div class="card stack gap-3" style="margin-block-start:var(--s4)">
        <h2 class="section-title">Hand over</h2>
        <p class="fs-sm muted">The Authority officer signs for ${h.bag_ids.length - unresolved.length} bag(s).
          ${unresolved.length ? `The ${unresolved.length} disputed bag(s) stay with Rabel and raise an exception for Ops.` : ''}</p>
        <form id="hand-form" class="stack gap-3">
          <div class="field"><label for="officer">Authority officer <span class="req">*</span></label><input id="officer" name="officer" type="text" autocomplete="off" required /></div>
          <div class="field"><label for="signature">Signature / reference <span class="req">*</span></label><input id="signature" name="signature" type="text" autocomplete="off" required />
            <div class="hint">The officer's signature reference on the handover sheet.</div></div>
          <button type="submit" class="btn btn-primary btn-lg">Hand over and request the voucher</button>
        </form>
      </div>`
    : `<div class="card stack gap-2" style="margin-block-start:var(--s4)">
        <h2 class="section-title">Handed over</h2>
        <p class="fs-sm">${h.bag_ids.length} bag(s) signed for by ${esc(h.officer || '—')} at ${esc(fmtDateTime(h.handed_at))}.</p>
        <a class="btn btn-primary" href="#/dep/voucher">Go to the voucher</a></div>`}
    <a class="btn btn-ghost mt" href="#/dep/handover">&larr; Back to handover</a>`;

  el.querySelectorAll('[data-dispute]').forEach((b) => b.addEventListener('click', () => {
    const reason = window.prompt('What does the Authority dispute about this bag?');
    if (reason === null) return;
    run((s, c) => ap.disputeBag(s, h.id, /** @type {HTMLElement} */ (b).dataset.dispute, { reason }, c), 'Dispute recorded.', draw);
  }));

  el.querySelector('#scan-toggle')?.addEventListener('click', () => { scanOpen = !scanOpen; draw(); });
  const host = el.querySelector('#scanner-host');
  if (host) {
    scanner = createScanner(host, {
      hint: 'Scan the disputed airline tag',
      onScan: (scan) => {
        const r = runScan((s, c) => ap.scanDisputedTag(s, h.id, scan, c));
        if (r.ok) setTimeout(draw, 700);
        return { ok: r.ok, message: r.message };
      },
    });
  }

  el.querySelector('#hand-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(/** @type {HTMLFormElement} */ (e.target));
    const r = run((s, c) => ap.completeHandover(s, h.id, { officer: String(fd.get('officer') || ''), signature: String(fd.get('signature') || '') }, c));
    if (!r) return;
    toast(`${r.handed} bag(s) handed over — voucher ${r.voucher.voucher_no} issued.`, 'success');
    navigate('#/dep/voucher');
  });
}

function draw() {
  if (!el) return;
  const blocked = blockedHtml('No airport is assigned to this account, so there is nothing to hand over.');
  if (blocked) { el.innerHTML = blocked; return; }
  try { if (handoverId) drawManifest(); else drawQueue(); } catch (err) {
    el.innerHTML = `<div class="state-block error-state"><p>${esc(err.message)}</p><a class="btn btn-primary" href="#/dep/handover">Back to handover</a></div>`;
  }
}
