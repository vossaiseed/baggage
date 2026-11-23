/**
 * Roles — read-only. Every row is derived from shared/rbac.js ROLE_PRESETS, which is the one
 * place permissions are defined, so this screen can never drift from what the system enforces.
 */
import { S, chip } from '../data.js';
import { ROLE_PRESETS, rolesThatCanAdvanceTo } from '../../../shared/rbac.js';
import { BAG_STATUSES } from '../../../shared/constants.js';
import { esc } from '../ui.js';

let el = null;

export function render(params, app) { el = app; draw(); return { destroy, refresh: draw }; }
export function destroy() { el = null; }

const SCOPE_TEXT = {
  own: 'Only their own records', area: 'Their collection area', warehouse: 'Their warehouse',
  airport: 'Their airport', all: 'Everything',
};

function roleCard(p) {
  // A Traveler is not a staff account — they sign in as themselves and act through a pseudo-user
  // (travelerService), so count the traveler records instead of the (always empty) user rows.
  const traveler = p.id === 'traveler';
  const users = S().users.filter((u) => u.role === p.id);
  const active = traveler ? S().travelers.filter((t) => !t.legacy).length : users.filter((u) => u.status !== 'Disabled').length;
  const statuses = BAG_STATUSES.filter((st) => rolesThatCanAdvanceTo(st).includes(p.id));
  return `<article class="card role-card">
    <div class="row wrap" style="justify-content:space-between;gap:var(--s3)">
      <div>
        <h2 class="fs-lg" style="margin:0">${esc(p.label)}</h2>
        <div class="fs-sm muted">${p.prefix ? `${esc(p.prefix)}-xxx · ` : 'No employee ID — signs in as themselves · '}${esc(p.folder)}/ · home ${esc(p.home)}</div>
      </div>
      <div class="row gap-2 wrap">
        ${chip(traveler ? `${active} traveler(s)` : `${active} active`, active ? 'green' : 'grey')}
        ${!traveler && users.length - active ? chip(`${users.length - active} disabled`, 'red') : ''}
        ${p.readOnly ? chip('Read-only', 'blue') : ''}
      </div>
    </div>
    <div class="fs-sm"><span class="muted">Sees:</span> ${esc(SCOPE_TEXT[p.scope] || p.scope)}</div>
    ${statuses.length ? `<div class="fs-sm"><span class="muted">Sets bag status:</span> ${statuses.map((x) => esc(x)).join(' · ')}</div>` : ''}
    ${p.manages.length ? `<div class="fs-sm"><span class="muted">Manages accounts:</span> ${p.manages.map((m) => esc(ROLE_PRESETS[m].label)).join(', ')}</div>` : ''}
    <details class="fs-sm"><summary class="muted">Permissions (${p.permissions.length})</summary>
      <div class="perm-list">${p.permissions.map((x) => `<code>${esc(x)}</code>`).join(' ')}</div></details>
  </article>`;
}

function draw() {
  if (!el) return;
  el.innerHTML = `
    <div class="page-header">
      <div><h1 class="page-title">Roles</h1>
        <p class="page-subtitle">Read-only — generated from <span class="mono">shared/rbac.js</span>, the one place permissions are decided</p></div>
    </div>
    <div class="stack gap-3">${Object.values(ROLE_PRESETS).map(roleCard).join('')}</div>`;
}
