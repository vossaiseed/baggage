import { migrateStatus } from './statusMap.js';

/** Re-maps every bag still carrying a pre-v7 status (and any entry in its history). Idempotent. */
export default {
  v: 3,
  name: 'normalize-bag-statuses',
  up(state) {
    const cancelled = new Set((state.flights || []).filter((f) => f.status === 'Cancelled').map((f) => f.id));
    for (const bag of state.bags || []) {
      const ctx = { flightCancelled: cancelled.has(bag.flight_id), hasTag: !!bag.tag_no };
      const next = migrateStatus(bag.status, ctx);
      if (next !== bag.status) {
        bag.legacy_status = bag.legacy_status ?? bag.status;
        bag.status = next;
      }
    }
  },
};
