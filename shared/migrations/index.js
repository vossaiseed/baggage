import m1 from './001-foundation.js';
import m2 from './002-legacy-import.js';
import m3 from './003-normalize-statuses.js';

/** Append-only. Never edit a shipped migration — add a new one with the next `v`. */
export const MIGRATIONS = Object.freeze([m1, m2, m3]);
export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].v;

/**
 * Runs every migration newer than `state.__v`, in order.
 * @param {object} state @param {{storage?:any}} [ctx] @param {readonly {v:number,name:string,up:Function}[]} [migrations]
 * @returns {object} the same state, upgraded
 */
export function runMigrations(state, ctx = {}, migrations = MIGRATIONS) {
  state.__v = state.__v || 0;
  const applied = [];
  for (const m of [...migrations].sort((a, b) => a.v - b.v)) {
    if (m.v > state.__v) {
      m.up(state, ctx);
      state.__v = m.v;
      applied.push(m.name);
    }
  }
  state.migrations_applied = [...(state.migrations_applied || []), ...applied];
  return state;
}
