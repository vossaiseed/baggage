/**
 * One residence collection, start to finish (mobile-first, one-hand use):
 * Start route → Arrived (GPS) → identity → bag count → weigh → attach & scan tags → count match →
 * Complete check-in → hand bags to Transport → Next assignment.
 */
import { S, me, run } from '../v7.js';
import * as ck from '../../../shared/services/checkinService.js';
import { airlinePolicyFor } from '../../../shared/services/travelerService.js';
import { createScanner } from '../../../shared/ui/scanner.js';
import { esc, icon, fmtTime, fmtDate, toast, confirmDialog, openModal } from '../ui.js';
import { navigate } from '../router.js';

let el = null;
let id = null;
let scanner = null;
let weightDraft = {};
let absent = null; // result of markAbsent, shown until the staff leaves

export function render(params, app) {
  el = app; id = params.id; weightDraft = {}; absent = null;
  draw();
  return { destroy, refresh: draw };
}
export function destroy() { scanner?.destroy(); scanner = null; el = null; }

const asg = () => S().collectionAssignments.find((a) => a.id === id);
const ctxUser = () => me();

function gps() {
  return new Promise((resolve) => {
    const a = asg();
    const res = S().residences.find((r) => r.id === a.residence_id);
    const fallback = () => resolve({ lat: res?.lat ?? null, lng: res?.lng ?? null, accuracy: null, simulated: true });
    if (!navigator.geolocation) { fallback(); return; }
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, simulated: false }), fallback, { timeout: 4000, maximumAge: 60000 });
  });
}

function draw() {
  if (!el) return;
  scanner?.destroy(); scanner = null;
  const a = asg();
  if (!a) { el.innerHTML = '<div class="state-block"><p>Assignment not found.</p><a class="btn btn-primary" href="#/">Back to assignments</a></div>'; return; }
  const state = S();
  const t = state.travelers.find((x) => x.id === a.traveler_id);
  const res = state.residences.find((r) => r.id === a.residence_id);
  const flight = state.flights.find((f) => f.id === a.flight_id);
  const slot = state.collectionSlots.find((s) => s.id === a.slot_id);
  const pol = airlinePolicyFor(state, t);
  const bags = ck.activeBags(state, a);
  const cm = ck.countMatch(state, a.id);
  const inProgress = a.status === 'Arrived';
  const verified = !!a.identity?.verified;

  el.innerHTML = `<div class="page-wrap">
    <a href="#/" class="btn btn-ghost" style="margin-block-end:var(--s3)">${icon('arrow-left', 16)} Assignments</a>
    <div class="step-card">
      <div class="asg-top"><strong class="fs-lg">${esc(t.name)}</strong><span class="chip chip-blue">${esc(a.status)}</span></div>
      <div class="asg-meta">${esc(flight?.code || '')} · ${esc(flight?.route || '')} · ${slot ? `${esc(fmtDate(slot.start))}, ${esc(fmtTime(slot.start))}–${esc(fmtTime(slot.end))}` : ''}</div>
      <div class="asg-meta" style="margin-block-start:var(--s2)"><strong>${esc(res?.building || '')}</strong>, flat ${esc(res?.flat_no || '')} · ${esc(res?.street || '')}, ${esc(res?.district || '')}${res?.landmark ? ` · ${esc(res.landmark)}` : ''}<br>${icon('phone', 14)} ${esc(res?.contact_phone || '')}</div>
      <div class="chips" style="margin-block-start:var(--s2)"><span class="chip chip-blue">${bags.length} bag(s)</span>
        <span class="chip chip-grey">Max ${pol.max_bag_weight_kg} kg / bag (${esc(pol.airline.code)})</span>
        ${a.extra_bags ? `<span class="chip chip-amber">${a.extra_bags} extra — approval ${esc(String(a.extra_approval || '').toLowerCase())}</span>` : ''}
        <span class="chip chip-${t.boarding_pass_verified ? 'green' : t.boarding_pass_flag ? 'red' : 'grey'}">Boarding pass: ${t.boarding_pass_verified ? 'Verified' : t.boarding_pass_flag ? 'Flagged' : 'Not verified'}</span></div>
      ${res?.lat != null ? `<a class="btn btn-secondary" style="margin-block-start:var(--s3)" href="https://www.google.com/maps?q=${res.lat},${res.lng}" target="_blank" rel="noopener">${icon('map-pin', 16)} Open in Maps</a>` : ''}
    </div>
    ${routeSection(a, t)}
    ${inProgress && verified ? countSection(a, bags) : ''}
    ${inProgress && verified ? `<div class="step-card" id="weigh-card"></div>` : ''}
    ${inProgress && verified ? `<div class="step-card" id="tags-card"><h2>${icon('scan-line', 18)} Attach &amp; scan tags</h2><div id="scanner-host"></div><div id="bag-rows" style="margin-block-start:var(--s3)"></div></div>` : ''}
    ${inProgress && verified ? `<div class="step-card ${cm.ok ? 'done' : ''}" id="match-card"></div>` : ''}
    ${a.status === 'Collected' ? receiptSection(a) : ''}
    ${a.status === 'Handed to Transport' ? doneSection(a) : ''}
  </div>`;
  wire(a);
  if (inProgress && verified) { drawWeigh(); drawBags(true); drawMatch(); }
}

/* ───────── route / arrival / identity ───────── */
function routeSection(a, t) {
  if (a.status === 'Assigned' || a.status === 'Rescheduled') {
    return `<div class="step-card"><h2>${icon('navigation', 18)} Route</h2>
      <p class="fs-sm muted">Travelers get an ETA when you start. Stops are ordered by flight priority, then distance.</p>
      <button type="button" class="btn btn-primary big-btn" data-act="start">Start route</button></div>`;
  }
  if (a.status === 'En Route') {
    return `<div class="step-card"><h2>${icon('navigation', 18)} On the way</h2>
      <p class="fs-sm">ETA ${esc(fmtTime(a.eta))}${a.route_order ? ` · stop ${a.route_order}` : ''}</p>
      <button type="button" class="btn btn-primary big-btn" data-act="arrived">Arrived — capture location</button>
      <button type="button" class="btn btn-secondary big-btn" style="margin-block-start:var(--s2)" data-act="absent">Traveler not at residence</button></div>`;
  }
  if (a.status === 'Arrived') {
    if (a.identity?.verified) {
      return `<div class="step-card done"><h2>${icon('badge-check', 18)} Identity confirmed <span class="chip chip-green">Verified by Backend ✓</span></h2>
        <p class="fs-sm muted">Arrived ${esc(fmtTime(a.arrived_at))}${a.gps ? ` · GPS ${a.gps.simulated ? '(simulated) ' : ''}${esc(String(a.gps.lat ?? '—'))}, ${esc(String(a.gps.lng ?? '—'))}` : ''}</p>
        <button type="button" class="btn btn-ghost" data-act="absent">Traveler left / not at residence</button></div>`;
    }
    if (!t.data_verified) {
      return `<div class="step-card"><h2>${icon('user-check', 18)} Confirm identity</h2>
        <div class="stopper" role="alert"><strong>Call supervisor — stop.</strong><p class="fs-sm">This traveler has not been verified by Backend. Do not continue check-in.${a.supervisor_called ? ' Operations has been notified.' : ''}</p></div>
        <button type="button" class="btn btn-danger big-btn" data-act="identity-stop">${a.supervisor_called ? 'Notify Operations again' : 'Call supervisor'}</button>
        <button type="button" class="btn btn-secondary big-btn" style="margin-block-start:var(--s2)" data-act="absent">Traveler not at residence</button></div>`;
    }
    return `<div class="step-card"><h2>${icon('user-check', 18)} Confirm identity <span class="chip chip-green">Verified by Backend ✓</span></h2>
      <div class="field"><label for="last4">Passport — last 4 characters</label><input id="last4" maxlength="4" autocomplete="off" style="text-transform:uppercase" /></div>
      <div class="field"><label for="photo">Photo (optional, not stored)</label><input id="photo" type="file" accept="image/*" capture="environment" /></div>
      <label class="checkbox-row"><input type="checkbox" id="photo-ok" /> Photo / ID matches the traveler</label>
      <button type="button" class="btn btn-primary big-btn" style="margin-block-start:var(--s3)" data-act="identity">Confirm identity</button>
      <button type="button" class="btn btn-secondary big-btn" style="margin-block-start:var(--s2)" data-act="absent">Traveler not at residence</button></div>`;
  }
  return '';
}

function absentSection() {
  if (!absent) return '';
  return `<div class="step-card"><h2>${icon('clock', 18)} Traveler absent</h2>
    ${absent.rescheduleOffered ? `<p class="fs-sm">The traveler was told to choose a new slot. Or book one now:</p>
      <div class="asg-list">${absent.slots.map((s) => `<button type="button" class="btn btn-secondary" data-slot="${esc(s.id)}">${esc(fmtDate(s.start))}, ${esc(fmtTime(s.start))}–${esc(fmtTime(s.end))} (${s.remaining} left)</button>`).join('')}</div>`
      : '<p class="fs-sm"><strong>The flight window is closing.</strong> No slot is left, so Operations has been notified.</p>'}
    <a class="btn btn-primary big-btn" style="margin-block-start:var(--s3)" href="#/">Next assignment</a></div>`;
}

/* ───────── bag count ───────── */
function countSection(a, bags) {
  const c = a.count_check;
  const outcomeText = c ? ({
    ok: 'Count matches the booking.', fewer: `${c.withdrawn} bag(s) not presented — left out.`,
    extra_requested: `${c.extraRequested} extra bag(s) accepted — tag request sent to Backend.${c.leftWithTraveler ? ` ${c.leftWithTraveler} stay with the traveler (over the limit).` : ''}`,
    over_limit: `Over the airline limit — ${c.leftWithTraveler} bag(s) stay with the traveler.`,
  }[c.outcome]) : '';
  return `<div class="step-card ${c ? 'done' : ''}"><h2>${icon('luggage', 18)} Bag count</h2>
    <p class="fs-sm muted">Declared ${bags.length}. Count the bags the traveler presents.</p>
    <div class="field"><label for="presented">Bags presented</label><input id="presented" type="number" min="0" max="10" inputmode="numeric" class="weigh-input" value="${c ? c.presented : bags.length}" /></div>
    <button type="button" class="btn btn-secondary big-btn" data-act="count">Check count</button>
    ${c ? `<p class="fs-sm" style="margin-block-start:var(--s2)">${esc(outcomeText)}</p>` : ''}</div>`;
}

/* ───────── weigh ───────── */
function drawWeigh() {
  const host = el?.querySelector('#weigh-card');
  if (!host) return;
  const a = asg();
  const state = S();
  const max = airlinePolicyFor(state, state.travelers.find((x) => x.id === a.traveler_id)).max_bag_weight_kg;
  const bags = ck.activeBags(state, a);
  const crit = (w) => (w > 0 ? (w <= max ? `<span class="crit-ok" data-crit>Meets airline criteria ✓ (max ${max} kg)</span>` : `<span class="crit-bad" data-crit>Meets airline criteria ✗ (max ${max} kg) — Repack required</span>`) : '<span class="muted" data-crit>Enter the weight</span>');
  host.innerHTML = `<h2>${icon('scale', 18)} Weigh all bags</h2>
    ${bags.map((b, i) => { const w = weightDraft[b.id] ?? (b.weight_kg ?? ''); const n = Number(w);
      return `<div class="bag-row ${n > max ? 'bad' : ''}" data-row="${esc(b.id)}"><div><strong>Bag ${i + 1}</strong>${b.extra ? ' <span class="chip chip-amber">Extra</span>' : ''}<div class="fs-xs muted">${esc(b.tag_no || 'no label yet')}</div></div>
        <input class="weigh-input" type="number" step="0.1" min="0" inputmode="decimal" data-w="${esc(b.id)}" value="${esc(String(w))}" placeholder="kg" aria-label="Weight of bag ${i + 1} in kg" />
        <div class="fs-sm">${crit(n)}</div></div>`; }).join('')}
    <button type="button" class="btn btn-primary big-btn" data-act="weigh">Save weights</button>`;
  host.querySelectorAll('[data-w]').forEach((inp) => inp.addEventListener('input', () => {
    weightDraft[inp.dataset.w] = inp.value;
    const row = inp.closest('.bag-row'); const n = Number(inp.value);
    row.classList.toggle('bad', n > max);
    row.querySelector('[data-crit]').outerHTML = crit(n);
  }));
  host.querySelector('[data-act="weigh"]').addEventListener('click', () => {
    const rows = run((s, c) => ck.recordWeights(s, a.id, weightDraft, c), (r) => (r.some((x) => x.repack) ? `${r.filter((x) => x.repack).length} bag(s) over the limit — repack required.` : 'Weights saved.'));
    if (rows) { weightDraft = {}; drawWeigh(); drawBags(false); drawMatch(); }
  });
}

/* ───────── attach & scan ───────── */
/** The next pending scan: first bag still missing a scan, airline tag first. */
function nextTarget() {
  const bags = ck.activeBags(S(), asg());
  for (const b of bags) {
    if (b.status !== 'Tag Assigned') continue;
    if (ck.needsAirlineScan(b) && !b.airline_scanned) return { bag: b, kind: 'AIRLINE', n: bags.indexOf(b) + 1 };
    if (!b.internal_scanned) return { bag: b, kind: 'INTERNAL', n: bags.indexOf(b) + 1 };
  }
  return null;
}
let forced = null; // bag the staff tapped to re-scan

function drawBags(mountScanner) {
  const host = el?.querySelector('#bag-rows');
  if (!host) return;
  const a = asg();
  const bags = ck.activeBags(S(), a);
  const t = forced && bags.find((b) => b.id === forced.bagId) ? forced : null;
  const target = t ? { bag: bags.find((b) => b.id === t.bagId), kind: t.kind, n: bags.findIndex((b) => b.id === t.bagId) + 1 } : nextTarget();
  if (mountScanner) {
    scanner = createScanner(el.querySelector('#scanner-host'), {
      hint: hintFor(target),
      onScan: async (scan) => {
        const tg = forced ? { bag: ck.activeBags(S(), asg()).find((b) => b.id === forced.bagId), kind: forced.kind } : nextTarget();
        if (!tg?.bag) return { ok: false, message: 'Nothing left to scan — check the count below.' };
        const r = run((s, c) => ck.scanTag(s, a.id, tg.bag.id, tg.kind, scan, c));
        if (!r) return { ok: false, message: 'Scan could not be processed.' };
        if (r.ok) forced = null;
        drawBags(false); drawMatch();
        scanner?.setHint(hintFor(forced ? { bag: tg.bag, kind: forced.kind, n: 0 } : nextTarget()));
        return { ok: r.ok, message: r.message };
      },
    });
  } else scanner?.setHint(hintFor(target));
  host.innerHTML = bags.map((b, i) => {
    const ready = b.status === 'Tag Assigned';
    const isCur = target?.bag?.id === b.id;
    const airline = ck.needsAirlineScan(b);
    return `<div class="bag-row ${isCur ? 'current' : ''}">
      <div><strong>Bag ${i + 1}</strong>${b.extra ? ' <span class="chip chip-amber">Extra</span>' : ''}<div class="fs-xs muted">${esc(b.status)}</div></div>
      <div class="fs-sm">${airline ? `Airline tag: ${b.airline_scanned ? `<span class="crit-ok">✓ ${esc(b.airline_tag_no)}</span>` : '<span class="muted">to scan</span>'}` : '<span class="chip chip-grey">No airline tag</span>'}<br>
        Rabel label: ${b.internal_scanned ? `<span class="crit-ok">✓ ${esc(b.tag_no)}</span>` : '<span class="muted">to scan</span>'}</div>
      <div class="row gap-2 wrap">
        ${ready ? `${airline && b.airline_scanned ? `<button type="button" class="btn btn-ghost" data-rescan="${esc(b.id)}|AIRLINE">Re-scan tag</button>` : ''}${airline ? `<button type="button" class="btn btn-ghost" data-damaged="${esc(b.id)}">Damaged tag</button>` : ''}`
          : `<span class="chip chip-amber">Waiting for Backend tag</span><button type="button" class="btn btn-ghost" data-leave="${esc(b.id)}">Leave with traveler</button>`}
      </div></div>`;
  }).join('') || '<p class="muted">No bags.</p>';
  host.querySelectorAll('[data-damaged]').forEach((btn) => btn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Report damaged tag?', body: 'Backend will void this airline tag and release a replacement. Re-scan the new tag when it arrives.', confirmLabel: 'Request replacement' });
    if (ok) { run((s, c) => ck.requestDamagedTag(s, btn.dataset.damaged, 'Damaged at the residence', c), 'Replacement requested from Backend.'); drawBags(false); drawMatch(); }
  }));
  host.querySelectorAll('[data-leave]').forEach((btn) => btn.addEventListener('click', () => {
    run((s, c) => ck.withdrawBag(s, btn.dataset.leave, 'Tag not issued by Backend yet', c), 'Bag left with the traveler.');
    draw();
  }));
  host.querySelectorAll('[data-rescan]').forEach((btn) => btn.addEventListener('click', () => { const [bagId, kind] = btn.dataset.rescan.split('|'); forced = { bagId, kind }; drawBags(false); }));
}
function hintFor(target) {
  if (!target) return 'All tags scanned ✓';
  return `Bag ${target.n} — ${target.kind === 'AIRLINE' ? 'Scan airline tag (10 digits)' : 'Scan Rabel label (RBL-D-…)'}`;
}

/* ───────── count match + complete ───────── */
function drawMatch() {
  const host = el?.querySelector('#match-card');
  if (!host) return;
  const a = asg();
  const m = ck.countMatch(S(), a.id);
  host.className = `step-card ${m.ok ? 'done' : ''}`;
  host.innerHTML = `<h2>${icon('equal', 18)} Count match</h2>
    <div class="count-grid"><div><b>${m.declared}</b>declared</div><div><b>${m.weighed}</b>weighed</div><div><b>${m.tagged}</b>tags scanned</div></div>
    ${m.ok ? '<p class="crit-ok" style="margin-block-start:var(--s2)">All counts match ✓</p>' : `<ul class="fs-sm muted" style="margin-block-start:var(--s2)">${m.blockers.map((x) => `<li>• ${esc(x)}</li>`).join('')}</ul>`}
    <button type="button" class="btn btn-primary big-btn" style="margin-block-start:var(--s3)" data-act="complete" ${m.ok ? '' : 'disabled'}>Complete check-in</button>`;
  host.querySelector('[data-act="complete"]').addEventListener('click', () => {
    if (run((s, c) => ck.completeCheckin(s, a.id, c), 'Checked in — digital receipt sent.')) draw();
  });
}

/* ───────── receipt / hand-off / done ───────── */
function receiptSection(a) {
  return `<div class="step-card done"><h2>${icon('receipt', 18)} Digital receipt ${esc(a.receipt.no)}</h2>
    <p class="fs-sm muted">Sent to the traveler (SMS + app).</p>
    <ul class="fs-sm">${a.receipt.bags.map((b, i) => `<li>Bag ${i + 1}: ${esc(b.airline_tag_no || 'no airline tag')} · ${esc(b.tag_no)} · ${esc(String(b.weight_kg))} kg</li>`).join('')}</ul>
    <button type="button" class="btn btn-primary big-btn" data-act="handoff" style="margin-block-start:var(--s3)">Hand bags to Transport (pickup point)</button></div>`;
}
function doneSection(a) {
  return `<div class="step-card done"><h2>${icon('check-circle', 18)} Handed to Transport</h2>
    <p class="fs-sm">${a.handed_bag_ids?.length ?? 0} bag(s) are waiting at the residence pickup point. Transport counts them against your check-in log.</p>
    <button type="button" class="btn btn-primary big-btn" data-act="next">Next assignment</button></div>`;
}

/* ───────── wiring ───────── */
function wire(a) {
  const on = (sel, fn) => el.querySelectorAll(sel).forEach((n) => n.addEventListener('click', fn));
  on('[data-act="start"]', () => { run((s, c) => ck.startRoute(s, a.id, {}, c), 'On the way — the traveler has your ETA.'); draw(); });
  on('[data-act="arrived"]', async () => { const g = await gps(); run((s, c) => ck.markArrived(s, a.id, { gps: g }, c), 'Arrived — location captured.'); draw(); });
  on('[data-act="identity"]', () => {
    const last4 = el.querySelector('#last4').value;
    const photoOk = el.querySelector('#photo-ok').checked;
    const r = run((s, c) => ck.confirmIdentity(s, a.id, { last4, photoOk }, c), 'Identity confirmed.');
    if (r) draw(); else draw(); // redraw also shows the supervisor stop banner when Backend has not verified the traveler
  });
  on('[data-act="identity-stop"]', () => { run((s, c) => ck.confirmIdentity(s, a.id, { last4: '', photoOk: true }, c)); draw(); });
  on('[data-act="count"]', () => { run((s, c) => ck.checkBagCount(s, a.id, { presented: el.querySelector('#presented').value }, c)); draw(); });
  on('[data-act="absent"]', async () => {
    const ok = await confirmDialog({ title: 'Traveler not at residence?', body: 'This is recorded as an exception and the traveler is asked to choose a new slot.', confirmLabel: 'Mark absent', danger: true });
    if (!ok) return;
    const r = run((s, c) => ck.markAbsent(s, a.id, c));
    if (r) { absent = r; el.innerHTML = `<div class="page-wrap"><a href="#/" class="btn btn-ghost">${icon('arrow-left', 16)} Assignments</a>${absentSection()}</div>`; wireAbsent(a); }
  });
  on('[data-act="handoff"]', () => { const r = run((s, c) => ck.handToTransport(s, a.id, c), (x) => `${x.bags} bag(s) handed to Transport.`); if (r) draw(); });
  on('[data-act="next"]', () => navigate('#/'));
}
function wireAbsent(a) {
  el.querySelectorAll('[data-slot]').forEach((b) => b.addEventListener('click', () => {
    if (run((s, c) => ck.offerSlot(s, a.id, b.dataset.slot, c), 'New slot booked for the traveler.')) navigate('#/');
  }));
  void toast; void openModal;
}
