/**
 * Operations Manager app shell (departure v7). Ops owns the schedule and the exceptions:
 * Flights · Forecast · Exceptions · Areas & slots · Staff · Reports · Closure.
 * Pre-v7 screens (cut-offs, reconciliation, trucks, stakeholders, bags, handover) are hidden and
 * unreachable; their code stays on disk as `legacy-*.js` and their data is read-only.
 */
import { isAuthed, getSession } from './session.js';
import { logout, user, myNotifications, markNotificationsRead } from './data.js';
import { route, setGuard, setNotFound, startRouter, navigate, getCurrent } from './router.js';
import { icon, esc } from './ui.js';

import * as loginView from './views/login.js';
import * as flightsView from './views/flights.js';
import * as forecastView from './views/forecast.js';
import * as exceptionsView from './views/exceptions.js';
import * as areasView from './views/areas.js';
import * as staffView from './views/staff.js';
import * as reportsView from './views/reports.js';
import * as closureView from './views/closure.js';

const NAV = [
  { hash: '#/', match: '/', label: 'Flights', iconName: 'plane' },
  { hash: '#/forecast', match: '/forecast', label: 'Forecast', iconName: 'clock' },
  { hash: '#/exceptions', match: '/exceptions', label: 'Exceptions', iconName: 'alert-triangle' },
  { hash: '#/areas', match: '/areas', label: 'Areas & slots', iconName: 'map-pin' },
  { hash: '#/staff', match: '/staff', label: 'Staff', iconName: 'users' },
  { hash: '#/reports', match: '/reports', label: 'Reports', iconName: 'bar-chart-3' },
  { hash: '#/closure', match: '/closure', label: 'Closure', iconName: 'check-circle' },
];

/** Pre-v7 screens: code kept on disk (data read-only, labelled Legacy) but never routable. */
const LEGACY_PATHS = ['/bags', '/cutoffs', '/reconciliation', '/trucks', '/stakeholders', '/handover'];

let shellMounted = false;
const path = () => (location.hash.replace(/^#/, '') || '/').split('?')[0];
const renderIcons = () => window.lucide?.createIcons?.();

function navHtml() {
  const p = path();
  return NAV.map((n) => {
    const current = n.match === '/' ? p === '/' || p.startsWith('/flights') : p.startsWith(n.match);
    return `<a class="nav-item" href="${n.hash}" data-nav-hash="${n.hash}" ${current ? 'aria-current="page"' : ''}>${icon(n.iconName, 20)}<span class="nav-label-text">${esc(n.label)}</span></a>`;
  }).join('');
}

/** Clicking the route you are already on fires no hashchange — force a re-render so a screen resets. */
function wireNavLinks(root) {
  root?.querySelectorAll('[data-nav-hash]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(a.getAttribute('data-nav-hash'));
  }));
}

function mountShell() {
  if (shellMounted) { updateNav(); return; }
  shellMounted = true;
  const s = getSession();
  document.body.innerHTML = `
    <a href="#main" class="skip-link">Skip to main content</a>
    <div id="app-shell">
      <nav class="sidebar" aria-label="Primary">
        <div class="brand"><span class="brand-name">Rabel</span><span class="brand-ar">Operations</span></div>
        <div class="stack gap-1" id="nav-list">${navHtml()}</div>
      </nav>
      <header class="topbar">
        <div class="row gap-3 wrap">
          <span class="badge-env">DEMO</span>
          <span class="fs-sm fw-semibold">${esc(s?.name || '')}</span>
          <span class="fs-sm muted">${esc(user()?.employee_id || '')}</span>
        </div>
        <div class="row gap-3">
          <div class="bell-wrap">
            <button type="button" class="btn btn-ghost btn-icon" id="bell-btn" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
              ${icon('bell', 20)}<span class="bell-badge visually-hidden" id="bell-badge-count"></span>
            </button>
          </div>
          <button type="button" class="btn btn-secondary" id="logout">${icon('log-out', 16)} Sign out</button>
        </div>
      </header>
      <main id="app" tabindex="-1"></main>
    </div>
    <div id="toast-root" aria-live="polite" aria-atomic="true"></div>`;
  document.getElementById('logout').addEventListener('click', () => { logout(); navigate('#/login'); });
  document.getElementById('bell-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleBell(); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.bell-dropdown, #bell-btn')) closeBell(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBell(); });
  renderIcons();
  wireNavLinks(document.getElementById('nav-list'));
  refreshBell();
}

function updateNav() {
  const list = document.getElementById('nav-list');
  if (list) { list.innerHTML = navHtml(); renderIcons(); wireNavLinks(list); }
}

function refreshBell() {
  const unread = myNotifications().filter((n) => n.unread).length;
  const badge = document.getElementById('bell-badge-count');
  if (!badge) return;
  if (unread) { badge.textContent = String(unread); badge.classList.remove('visually-hidden'); } else badge.classList.add('visually-hidden');
}

const closeBell = () => {
  document.querySelectorAll('.bell-dropdown').forEach((x) => x.remove());
  document.getElementById('bell-btn')?.setAttribute('aria-expanded', 'false');
};

function toggleBell() {
  if (document.querySelector('.bell-dropdown')) { closeBell(); return; }
  const btn = document.getElementById('bell-btn');
  btn.setAttribute('aria-expanded', 'true');
  const list = myNotifications().slice(0, 12);
  const dd = document.createElement('div');
  dd.className = 'bell-dropdown';
  dd.innerHTML = list.length ? `
    <div class="row" style="justify-content:space-between;padding:var(--s3) var(--s4);border-bottom:1px solid var(--border)">
      <strong class="fs-sm">Notifications</strong>
      <button type="button" class="btn btn-ghost" style="height:28px;padding-inline:8px;font-size:12px" data-act="mark-all">Mark all read</button>
    </div>
    ${list.map((n) => `<a class="bell-item ${n.unread ? 'unread' : ''}" href="${esc(n.link || '#/')}" data-notif="${esc(n.id)}">
      <span style="flex:1"><strong class="fs-sm">${esc(n.title)}</strong><div class="fs-xs muted">${esc(n.body)}</div></span></a>`).join('')}`
    : '<div class="bell-item"><span class="muted fs-sm">No notifications.</span></div>';
  btn.parentElement.appendChild(dd);
  dd.querySelector('[data-act="mark-all"]')?.addEventListener('click', (e) => { e.preventDefault(); markNotificationsRead('all'); closeBell(); refreshBell(); });
  dd.querySelectorAll('[data-notif]').forEach((a) => a.addEventListener('click', () => { markNotificationsRead(a.getAttribute('data-notif')); refreshBell(); }));
}

const wrap = (view) => (params) => {
  mountShell();
  updateNav();
  const r = view.render(params, document.getElementById('app'));
  renderIcons();
  return r || { destroy: view.destroy };
};

route('/login', (params) => {
  shellMounted = false;
  document.body.innerHTML = '<div id="bare-root"><main id="app" tabindex="-1"></main></div><div id="toast-root" aria-live="polite" aria-atomic="true"></div>';
  return loginView.render(params, document.getElementById('app'));
});
route('/', wrap(flightsView));
route('/flights/:id', wrap(flightsView));
route('/forecast', wrap(forecastView));
route('/exceptions', wrap(exceptionsView));
route('/areas', wrap(areasView));
route('/areas/:id', wrap(areasView));
route('/staff', wrap(staffView));
route('/reports', wrap(reportsView));
route('/closure', wrap(closureView));
route('/closure/:flightId', wrap(closureView));

setNotFound((app) => {
  mountShell();
  app.innerHTML = '<div class="state-block"><h1 class="fs-xl">404 — Page not found</h1><p>The page you’re looking for doesn’t exist.</p><a class="btn btn-primary" href="#/">Back to flights</a></div>';
});

setGuard((p) => {
  if (LEGACY_PATHS.some((x) => p === x || p.startsWith(`${x}/`))) return '#/';
  if (p !== '/login' && (!isAuthed() || !user())) return '#/login';
  if (p === '/login' && isAuthed() && user()) return '#/';
  return true;
});

startRouter();

/** Poll, but never while the user is typing or a dialog is open. */
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (document.querySelector('.overlay, .drawer-overlay, .bell-dropdown')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  getCurrent()?.poll?.();
  if (shellMounted) { refreshBell(); updateNav(); }
}, 15000);
