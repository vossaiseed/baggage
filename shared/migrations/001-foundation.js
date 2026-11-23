import { COLLECTIONS } from '../models.js';

/** Creates every v7 collection, counters and config on a fresh state. Idempotent. */
export default {
  v: 1,
  name: 'v7-foundation',
  up(state) {
    for (const c of COLLECTIONS) if (!Array.isArray(state[c])) state[c] = [];
    state.counters = { internalTag: 0, audit: 0, ...(state.counters || {}) };
    state.legacy = state.legacy || {};
    state.config = {
      slotHours: 2, collectionHours: 8, warehouseHours: 2, driveHours: 2, supervisorPin: '9999',
      ...(state.config || {}),
    };
    state.session = state.session ?? null;
  },
};
