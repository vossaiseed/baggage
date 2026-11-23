/**
 * System Admin app shell (departure v7): Accounts · Roles · Integrations · Airline policy · Audit.
 * Pre-v7 screens (config, health, errors, export, master data, reports, notifications, handover,
 * profile) are guarded to #/ and their views kept on disk as `legacy-*.js`, unimported.
 */
import { isAuthed, getSession } from './session.js';
import { logout, user } from './data.js';
import { route, setGuard, setNotFound, startRouter, navigate, getCurrent } from './router.js';
import { icon, esc } from './ui.js';

import * as loginView from './views/login.js';
import * as accountsView from './views/accounts.js';
import * as rolesView from './views/roles.js';
import * as integrationsView from './views/integrations.js';
import * as airlinesView from './views/airlines.js';
import * as auditView from './views/audit.js';

const NAV = [
  { hash: '#/', match: '/', label: 'Accounts', iconName: 'users' },
  { hash: '#/roles', match: '/roles', label: 'Roles', iconName: 'shield' },
  { hash: '#/integrations', match: '/integrations', label: 'Integrations', iconName: 'plug' },
  { hash: '#/airlines', match: '/airlines', label: 'Airline policy', iconName: 'plane' },
  { hash: '#/audit', match: '/audit', label: 'Audit', iconName: 'scroll-text' },
];

/** Pre-v7 screens: code kept on disk (read-only, labelled Legacy) but never routable. */
const LEGACY_PATHS = ['/config', '/health', '/errors', '/export', '/masterdata', '/reports', '/notifications', '/handover', '/profile', '/users'];

let shellMounted = false;
const path = () => (location.hash.replace(/^#/, '') || '/').split('?')[0];
const renderIcons = () => window.lucide?.createIcons?.();

function navHtml() {
  const p = path();
  return NAV.map((n) => {
    const current = n.match === '/' ? p === '/' : p.startsWith(n.match);
    return `<a class="nav-item" href="${n.hash}" data-nav-hash="${n.hash}" ${current ? 'aria-current="page"' : ''}>${icon(n.iconName, 20)}<span class="nav-label-text">${esc(n.label)}</span></a>`;
  }).join('');
}

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
        <div class="brand"><span class="brand-name">Rabel</span><span class="brand-ar">System Admin</span></div>
        <div class="stack gap-1" id="nav-list">${navHtml()}</div>
      </nav>
      <header class="topbar">
        <div class="row gap-3 wrap">
          <span class="badge-env">DEMO</span>
          <span class="fs-sm fw-semibold">${esc(s?.name || '')}</span>
          <span class="fs-sm muted">${esc(user()?.employee_id || '')}</span>
        </div>
        <button type="button" class="btn btn-secondary" id="logout">${icon('log-out', 16)} Sign out</button>
      </header>
      <main id="app" tabindex="-1"></main>
    </div>
    <div id="toast-root" aria-live="polite" aria-atomic="true"></div>`;
  document.getElementById('logout').addEventListener('click', () => { logout(); navigate('#/login'); });
  renderIcons();
  wireNavLinks(document.getElementById('nav-list'));
}

function updateNav() {
  const list = document.getElementById('nav-list');
  if (list) { list.innerHTML = navHtml(); renderIcons(); wireNavLinks(list); }
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
route('/', wrap(accountsView));
route('/roles', wrap(rolesView));
route('/integrations', wrap(integrationsView));
route('/airlines', wrap(airlinesView));
route('/audit', wrap(auditView));

setNotFound((app) => {
  mountShell();
  app.innerHTML = '<div class="state-block"><h1 class="fs-xl">404 — Page not found</h1><a class="btn btn-primary" href="#/">Back to accounts</a></div>';
});

setGuard((p) => {
  if (LEGACY_PATHS.some((x) => p === x || p.startsWith(`${x}/`))) return '#/';
  if (p !== '/login' && (!isAuthed() || !user())) return '#/login';
  if (p === '/login' && isAuthed() && user()) return '#/';
  return true;
});

startRouter();

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (document.querySelector('.overlay, .drawer-overlay')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  getCurrent()?.poll?.();
}, 15000);
