/**
 * Shared v7 store: ONE localStorage key used by every departure app
 * (same origin), so check-in → transport → warehouse → airport share data.
 * Arrival apps keep their own `rabel_ui_*` stores and are untouched.
 */
import { runMigrations } from './migrations/index.js';
import { ensureBaseAccounts } from './seed/baseAccounts.js';
import { seedDeparture, SEED_VERSION } from './seed/departure.js';

export const STORE_KEY = 'rabel_v7';

/** @returns {object} an empty, unmigrated state (version 0) */
export function createEmptyState() { return { __v: 0 }; }

/** @param {object|null} existing @param {{storage?:any, baseAccounts?:boolean}} ctx */
function boot(existing, ctx) {
  const state = existing && typeof existing === 'object' ? existing : createEmptyState();
  runMigrations(state, ctx);
  if (!ctx.baseAccounts) return state;
  ensureBaseAccounts(state);
  if ((state.seed_version || 0) < SEED_VERSION) seedDeparture(state);
  return state;
}

/**
 * @param {{ storage?: {getItem:Function,setItem:Function}|null, key?: string, baseAccounts?: boolean }} [opts]
 * Storage is injectable so tests (and node) can use an in-memory one.
 * `baseAccounts: true` also upserts the demo accounts/areas (browser default).
 */
export function createStore(opts = {}) {
  const storage = opts.storage ?? null;
  const key = opts.key || STORE_KEY;
  const baseAccounts = !!opts.baseAccounts;
  let state = null;

  function readRaw() {
    try {
      const raw = storage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function writeRaw() {
    try { storage?.setItem(key, JSON.stringify(state)); } catch { /* quota / private mode: keep working in memory */ }
  }

  return {
    /** @returns {object} the live state (loaded + migrated on first call) */
    get() {
      if (!state) { state = boot(readRaw(), { storage, baseAccounts }); writeRaw(); }
      return state;
    },
    save() { if (state) writeRaw(); },
    /** Drops v7 data and rebuilds from scratch (old per-app keys are re-imported, never deleted). */
    reset() { state = boot(null, { storage, baseAccounts }); writeRaw(); return state; },
    /** Replace state wholesale (used by the seed). */
    replace(next) { state = next; writeRaw(); return state; },
  };
}

/**
 * `?seed=departure` on any departure app rebuilds the demo store before the app reads it — the
 * URL form of the Ops/Admin "Reset demo data" action, for starting a demo from a clean slate.
 * The parameter is stripped afterwards so a refresh does not wipe the demo again.
 * @returns {boolean}
 */
function consumeSeedParam() {
  try {
    if (typeof window === 'undefined' || !window.location) return false;
    const url = new URL(window.location.href);
    if (url.searchParams.get('seed') !== 'departure') return false;
    url.searchParams.delete('seed');
    window.history?.replaceState?.(null, '', url.toString());
    return true;
  } catch { return false; }
}

let defaultStore = null;
/** Browser singleton bound to window.localStorage (falls back to memory). */
export function getStore() {
  if (!defaultStore) {
    let storage = null;
    try { storage = typeof window !== 'undefined' ? window.localStorage : null; } catch { storage = null; }
    const fresh = consumeSeedParam();
    defaultStore = createStore({ storage, baseAccounts: true });
    if (fresh) defaultStore.reset(); else defaultStore.get();
  }
  return defaultStore;
}
