import { createSeed } from './seed.js';

const KEY = 'rabel_ui_system-admin';

let state = null;

/** Safely read JSON from localStorage. @returns {object|null} */
function readRaw() {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/** Safely write current state to localStorage. */
function writeRaw() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {
    /* storage unavailable (private mode / quota) — app still works in-memory */
  }
}

/**
 * v2 -> v3 (Departure v7): rename Warehouse Staff -> Warehouse Manager (WH- -> WM-),
 * retire the Driver login role (Disabled, "Moved to Driver records"), add the new
 * v7 role permission presets. Nothing is deleted.
 */
function upgradeV2toV3(s) {
  const fresh = createSeed();
  s.__v = 3;
  for (const u of s.users || []) {
    if (u.roleId === 'warehouse') {
      u.roleLabel = 'Warehouse Manager';
      if (/^WH-/i.test(u.employeeId)) { u.legacyId = u.employeeId; u.employeeId = u.employeeId.replace(/^WH-/i, 'WM-'); }
    }
    if (u.roleId === 'driver') {
      u.roleLabel = 'Driver (legacy)';
      u.status = 'Disabled';
      u.disabledReason = 'Moved to Driver records';
      u.activeSessions = [];
    }
  }
  s.rolePermissions = s.rolePermissions || {};
  for (const [roleId, matrix] of Object.entries(fresh.rolePermissions)) if (!s.rolePermissions[roleId]) s.rolePermissions[roleId] = matrix;
  return s;
}

/** Load state from storage, seeding it on first run. @returns {object} */
export function loadStore() {
  if (state) return state;
  const existing = readRaw();
  if (existing && existing.__v === 3) {
    state = existing;
  } else if (existing && existing.__v === 2) {
    state = upgradeV2toV3(existing);
    writeRaw();
  } else {
    state = { __v: 3, ...createSeed() };
    writeRaw();
  }
  return state;
}

/** @returns {object} the live mutable state object */
export function getStore() {
  return loadStore();
}

/** Persist the current state to localStorage. */
export function saveStore() {
  writeRaw();
}

/** Reset all demo data back to the original seed. @returns {object} */
export function resetStore() {
  state = { __v: 2, ...createSeed() };
  writeRaw();
  return state;
}

/** @returns {boolean} whether a session token is present */
export function isAuthed() {
  return !!loadStore().session;
}

/** @param {object|null} session */
export function setSession(session) {
  loadStore().session = session;
  saveStore();
}

/** @returns {object|null} */
export function getSession() {
  return loadStore().session;
}
