/**
 * Exceptions — every role raises them by working; Ops is the only role that works them off.
 * Open → Assigned → (Escalated) → Resolved → Closed, with the reason kept on the row.
 */
import { S, run, read, chip, severityColor } from '../data.js';
import * as ex from '../../../shared/services/exceptionService.js';
import { EXCEPTION_TYPES_V7, EXCEPTION_SEVERITIES } from '../../../shared/constants.js';
import { esc, fmtDateTime, fmtRelative, openDrawer, closeDrawer, emptyState } from '../ui.js';
import { kpiTile } from '../components/kpi-tile.js';

let el = null;
let filters = { q: '', type: '', severity: '', status: '', includeClosed: false };

export function render(params, app) { el = app; draw(); return { destroy, refresh: draw, poll: draw }; }
export function destroy() { el = null; }

function ageText(mins) {
  if (mins < 60) return `${mins}m old`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m old`;
}

function row(r) {
  const e = r.exception;
  const open = ex.isOpenException(e);
  return `<article class="exc-row sev-${String(e.severity).toLowerCase()}">
    <div class="row wrap" style="justify-content:space-between;gap:var(--s3)">
      <div>
        <strong>${esc(e.type)}</strong> <span class="mono fs-xs muted">${esc(e.id)}</span>
        <div class="fs-sm muted">${[
    r.flight?.code, r.area?.name, r.traveler?.name,
    r.bag ? `bag ${r.bag.tag_no || r.bag.id}` : null, e.value,
  ].filter(Boolean).map(esc).join(' · ') || 'No bag or flight attached'}</div>
        ${e.notes ? `<div class="fs-sm">${esc(e.notes)}</div>` : ''}
      </div>
      <div class="row gap-2 wrap" style="align-items:flex-start">
        ${chip(e.severity, severityColor(e.severity))}
        ${chip(e.status, open ? (e.status === 'Open' ? 'red' : 'amber') : 'green')}
        ${chip(ageText(r.ageMinutes), 'grey')}
      </div>
    </div>
    <div class="fs-xs muted">
      Raised ${esc(fmtRelative(e.time))} by ${esc(r.raisedBy?.name || e.raised_by || 'unknown')}
      ${e.owner || e.owner_team ? ` · owner ${esc(S().users.find((u) => u.id === e.owner)?.name || e.owner || e.owner_team)}` : ''}
      ${e.due_at ? ` · due ${esc(fmtDateTime(e.due_at))}` : ''}
      ${e.resolution ? ` · resolved: ${esc(e.resolution)}` : ''}
    </div>
    ${(e.updates || []).length ? `<ul class="exc-log">${e.updates.slice(-3).map((u) => `<li>${esc(fmtRelative(u.at))} — ${esc(u.text)}</li>`).join('')}</ul>` : ''}
    <div class="row gap-2 wrap">
      ${open ? `<button type="button" class="btn btn-secondary" data-assign="${esc(e.id)}">Assign</button>` : ''}
      ${open ? `<button type="button" class="btn btn-ghost" data-note="${esc(e.id)}">Add note</button>` : ''}
      ${open ? `<button type="button" class="btn btn-ghost" data-escalate="${esc(e.id)}">Escalate</button>` : ''}
      ${open ? `<button type="button" class="btn btn-primary" data-resolve="${esc(e.id)}">Resolve</button>` : ''}
      ${e.status === 'Resolved' ? `<button type="button" class="btn btn-primary" data-close="${esc(e.id)}">Close</button>` : ''}
      ${!open ? `<button type="button" class="btn btn-ghost" data-reopen="${esc(e.id)}">Reopen</button>` : ''}
    </div>
  </article>`;
}

function draw() {
  if (!el) return;
  const sum = read((s, u) => ex.exceptionSummary(s, u, { now: Date.now() }), null);
  const rows = read((s, u) => ex.exceptionQueue(s, u, { now: Date.now(), ...filters }), []) || [];
  if (!sum) return;
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Exceptions</h1><p class="page-subtitle">Raised by every role as they work — resolved here</p></div>
    </div>
    <div class="grid grid-cols-4 mb">
      ${kpiTile({ label: 'Open', value: sum.open })}
      ${kpiTile({ label: 'Critical / High', value: sum.bySeverity.Critical + sum.bySeverity.High })}
      ${kpiTile({ label: 'Unassigned', value: sum.unassigned })}
      ${kpiTile({ label: 'Oldest open', value: sum.oldest ? ageText(sum.oldest.ageMinutes) : '—' })}
    </div>
    <div class="toolbar">
      <input type="search" id="f-q" placeholder="Search id, bag, traveler, flight…" value="${esc(filters.q)}" />
      <select id="f-type"><option value="">Every type</option>${EXCEPTION_TYPES_V7.map((t) => `<option ${filters.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="f-sev"><option value="">Every severity</option>${EXCEPTION_SEVERITIES.map((t) => `<option ${filters.severity === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <label class="checkbox-row"><input type="checkbox" id="f-closed" ${filters.includeClosed ? 'checked' : ''} /> Show resolved &amp; closed</label>
    </div>
    <div class="card" style="padding:0">${rows.map(row).join('') || emptyState({ message: filters.includeClosed ? 'No exceptions.' : 'Nothing open — every exception has been worked off.' })}</div>`;

  const q = /** @type {HTMLInputElement} */ (el.querySelector('#f-q'));
  q.addEventListener('input', () => {
    const caret = q.selectionStart;
    filters.q = q.value;
    draw();
    const again = /** @type {HTMLInputElement} */ (el.querySelector('#f-q'));
    again.focus();
    again.setSelectionRange(caret, caret);
  });
  el.querySelector('#f-type').addEventListener('change', (e) => { filters.type = /** @type {HTMLSelectElement} */ (e.target).value; draw(); });
  el.querySelector('#f-sev').addEventListener('change', (e) => { filters.severity = /** @type {HTMLSelectElement} */ (e.target).value; draw(); });
  el.querySelector('#f-closed').addEventListener('change', (e) => { filters.includeClosed = /** @type {HTMLInputElement} */ (e.target).checked; draw(); });

  el.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => openAssign(b.getAttribute('data-assign'))));
  el.querySelectorAll('[data-note]').forEach((b) => b.addEventListener('click', () => openText(b.getAttribute('data-note'), 'Add a note', 'What happened?', (id, text) => (s, c) => ex.addExceptionNote(s, id, text, c), 'Note added.')));
  el.querySelectorAll('[data-escalate]').forEach((b) => b.addEventListener('click', () => openText(b.getAttribute('data-escalate'), 'Escalate', 'Why is this being escalated?', (id, text) => (s, c) => ex.escalateException(s, id, text, c), 'Escalated.')));
  el.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', () => openText(b.getAttribute('data-resolve'), 'Resolve', 'How was this resolved?', (id, text) => (s, c) => ex.resolveException(s, id, { resolution: text }, c), 'Resolved.')));
  el.querySelectorAll('[data-reopen]').forEach((b) => b.addEventListener('click', () => openText(b.getAttribute('data-reopen'), 'Reopen', 'Why is this being reopened?', (id, text) => (s, c) => ex.reopenException(s, id, text, c), 'Reopened.')));
  el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => run((s, c) => ex.closeException(s, b.getAttribute('data-close'), c), 'Closed.', draw)));
}

/** One text-field drawer used by note / escalate / resolve / reopen. */
function openText(id, title, label, fn, okMsg) {
  const d = openDrawer({
    title: `${title} — ${id}`,
    bodyHtml: `<div class="field"><label for="t-text">${esc(label)} <span class="req">*</span></label><textarea id="t-text" rows="4"></textarea></div>`,
    footerHtml: `<button type="button" class="btn btn-primary" id="t-go">${esc(title)}</button>`,
  });
  d.el.querySelector('#t-go').addEventListener('click', () => {
    const text = /** @type {HTMLTextAreaElement} */ (d.el.querySelector('#t-text')).value;
    run(fn(id, text), okMsg, () => { closeDrawer(); draw(); });
  });
}

function openAssign(id) {
  const people = S().users.filter((u) => u.status !== 'Disabled').sort((a, b) => a.id.localeCompare(b.id));
  const d = openDrawer({
    title: `Assign ${id}`,
    bodyHtml: `
      <div class="field"><label for="a-owner">Owner</label>
        <select id="a-owner"><option value="">— none —</option>${people.map((u) => `<option value="${esc(u.id)}">${esc(u.id)} — ${esc(u.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="a-team">…or a team</label><input id="a-team" placeholder="Backend, Warehouse, Transport…" /></div>
      <div class="field"><label for="a-due">Due</label><input id="a-due" type="datetime-local" /></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" id="a-go">Assign</button>',
  });
  d.el.querySelector('#a-go').addEventListener('click', () => {
    const due = /** @type {HTMLInputElement} */ (d.el.querySelector('#a-due')).value;
    run((s, c) => ex.assignException(s, id, {
      owner: /** @type {HTMLSelectElement} */ (d.el.querySelector('#a-owner')).value || null,
      team: /** @type {HTMLInputElement} */ (d.el.querySelector('#a-team')).value || null,
      dueAt: due ? new Date(due).toISOString() : null,
    }, c), 'Assigned.', () => { closeDrawer(); draw(); });
  });
}
