/**
 * adminService — the System Admin's own surface: integrations, the airline policy table,
 * the audit trail, and resetting the demo data. Staff accounts go through staffService.
 *
 *   integrationStatus / testIntegration   which adapter is live, and does it answer
 *   listAirlines / createAirline / updateAirlinePolicy   bags, weight and BTIC codes
 *   auditTrail                            the read model for the Audit screen
 *   resetDemoData                         rebuilds the v7 store from the seed (nothing else is deleted)
 *
 * Secrets never live here: an adapter's mode comes from shared/config.js (window.RABEL_CONFIG),
 * and the keys a real deployment would need are documented in .env.example.
 */
import { assertCan } from '../rbac.js';
import { makeAirline } from '../models.js';
import { getConfig } from '../config.js';
import { integrations } from '../integrations/index.js';
import { audit, nowIso } from './audit.js';
import { ServiceError } from './errors.js';

/** The integrations this build knows about, in the order the Admin screen lists them. */
export const INTEGRATIONS = Object.freeze([
  { id: 'nusuk', label: 'Nusuk', what: 'Traveler identity and residence' },
  { id: 'airlineFeed', label: 'Airline feed', what: 'Reservations, boarding passes and the flight manifest' },
  { id: 'sgs', label: 'SGS (Airport Authority)', what: 'Handover vouchers at the airport' },
  { id: 'sms', label: 'SMS', what: 'Traveler messages' },
]);

const row = (state, id) => (state.integrations || []).find((x) => x.id === id) || null;

/* ───────────────────────── integrations ───────────────────────── */

/**
 * One row per integration: its configured mode, whether an adapter is actually wired, what it
 * has done in this demo, and the last connection test.
 * @param {object} state @param {object} user
 */
export function integrationStatus(state, user) {
  assertCan(user, 'integration:manage');
  const modes = getConfig().integrations;
  let adapters = /** @type {any} */ ({});
  let adapterError = null;
  try { adapters = integrations(); } catch (err) { adapterError = err.message; }
  return INTEGRATIONS.map((i) => {
    const saved = row(state, i.id);
    return {
      ...i,
      mode: modes[i.id] || 'simulated',
      adapter: adapters[i.id] ? 'wired' : 'missing',
      adapterError: adapters[i.id] ? null : adapterError,
      usage: usageOf(state, i.id),
      lastCheck: saved ? { at: saved.last_check_at, ok: saved.last_check_ok, note: saved.last_check_note, by: saved.checked_by } : null,
    };
  });
}

/** What this integration has actually done against the current store. */
function usageOf(state, id) {
  if (id === 'nusuk') {
    return { label: 'travelers synced', n: (state.travelers || []).filter((t) => t.nusuk_id && !t.legacy).length };
  }
  if (id === 'airlineFeed') {
    return { label: 'tag batches imported', n: (state.tagImportBatches || []).length };
  }
  if (id === 'sgs') {
    return { label: 'vouchers issued', n: (state.sgsVouchers || []).length };
  }
  return { label: 'messages sent', n: (state.notifications || []).filter((n) => n.channel === 'sms').length };
}

/**
 * Ask the adapter for something real and record the answer. Read-only against the integration —
 * it never writes to the traveler, tag or voucher data.
 * @param {object} state @param {string} id @param {object} ctx
 */
export function testIntegration(state, id, ctx) {
  assertCan(ctx.user, 'integration:manage');
  const spec = INTEGRATIONS.find((i) => i.id === id);
  if (!spec) throw new ServiceError('NOT_FOUND', `Unknown integration "${id}".`);
  let ok = false;
  let note = '';
  try {
    const api = integrations()[id];
    if (id === 'nusuk') { const n = api.fetchAll().length; ok = n > 0; note = `${n} traveler record(s) available.`; }
    else if (id === 'airlineFeed') { const n = api.fetchReservations().length; ok = n > 0; note = `${n} reservation(s) available.`; }
    else if (id === 'sgs') { ok = typeof api.submitHandover === 'function'; note = ok ? 'Handover endpoint answers.' : 'Adapter has no handover endpoint.'; }
    else { ok = typeof api.send === 'function'; note = ok ? 'Message endpoint answers.' : 'Adapter has no send endpoint.'; }
  } catch (err) {
    ok = false;
    note = err.message;
  }
  const at = nowIso(ctx);
  state.integrations = state.integrations || [];
  const existing = row(state, id);
  const next = { id, mode: getConfig().integrations[id] || 'simulated', last_check_at: at, last_check_ok: ok, last_check_note: note, checked_by: ctx.user?.id ?? null };
  if (existing) Object.assign(existing, next); else state.integrations.push(next);
  audit(state, ctx, { action: 'integration.test', entity: 'Integration', entityId: id, after: { ok, note } });
  return { id, ok, note, at };
}

/* ───────────────────────── airline policy ───────────────────────── */

/** @param {object} state @param {object} user */
export function listAirlines(state, user) {
  assertCan(user, 'airline_policy:manage');
  return [...(state.airlines || [])]
    .map((a) => ({
      airline: a,
      flights: (state.flights || []).filter((f) => f.airline_code === a.code).length,
      travelers: (state.travelers || []).filter((t) => !t.legacy && (state.flights || []).some((f) => f.id === t.flight_id && f.airline_code === a.code)).length,
    }))
    .sort((x, y) => String(x.airline.code).localeCompare(String(y.airline.code)));
}

function validatePolicy(patch) {
  const out = {};
  if (patch.bags_allowed !== undefined) {
    const n = Number(patch.bags_allowed);
    if (!Number.isInteger(n) || n < 0 || n > 9) throw new ServiceError('INVALID', 'Bags allowed must be a whole number from 0 to 9.');
    out.bags_allowed = n;
  }
  if (patch.extra_bags_max !== undefined) {
    const n = Number(patch.extra_bags_max);
    if (!Number.isInteger(n) || n < 0 || n > 9) throw new ServiceError('INVALID', 'Extra bags must be a whole number from 0 to 9.');
    out.extra_bags_max = n;
  }
  if (patch.max_bag_weight_kg !== undefined) {
    const n = Number(patch.max_bag_weight_kg);
    if (!Number.isFinite(n) || n < 1 || n > 50) throw new ServiceError('INVALID', 'Maximum bag weight must be between 1 and 50 kg.');
    out.max_bag_weight_kg = n;
  }
  if (patch.btic_codes !== undefined) {
    const codes = (Array.isArray(patch.btic_codes) ? patch.btic_codes : String(patch.btic_codes).split(/[,\s]+/))
      .map((c) => String(c).trim()).filter(Boolean);
    if (!codes.every((c) => /^\d{3}$/.test(c))) throw new ServiceError('INVALID', 'Every BTIC issuer code is exactly 3 digits (the first 3 digits of the airline tag).');
    out.btic_codes = [...new Set(codes)];
  }
  if (patch.data_feed_status !== undefined) {
    if (!['Connected', 'Not connected'].includes(patch.data_feed_status)) throw new ServiceError('INVALID', 'The data feed is either Connected or Not connected.');
    out.data_feed_status = patch.data_feed_status;
  }
  if (patch.name !== undefined) out.name = String(patch.name).trim() || undefined;
  return out;
}

/**
 * @param {object} state
 * @param {{ code: string, name?: string, bags_allowed?: number, extra_bags_max?: number, max_bag_weight_kg?: number, btic_codes?: string[]|string }} input
 * @param {object} ctx
 */
export function createAirline(state, input, ctx) {
  assertCan(ctx.user, 'airline_policy:manage');
  const code = String(input?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(code)) throw new ServiceError('INVALID', 'An airline code is 2 letters or digits, e.g. SV.');
  if ((state.airlines || []).some((a) => a.code === code)) throw new ServiceError('DUPLICATE', `${code} already exists.`);
  // makeAirline fills the AIRLINE_DEFAULTS for anything the form left blank.
  const airline = makeAirline({ code, name: String(input?.name || '').trim() || code, ...validatePolicy(input || {}) });
  state.airlines.push(airline);
  audit(state, ctx, { action: 'airline.create', entity: 'Airline', entityId: code, after: { ...airline } });
  return airline;
}

/**
 * Change an airline's policy. It applies to what happens next (bookings, weight checks); bags
 * already weighed keep the verdict they were given at the residence.
 * @param {object} state @param {string} code @param {object} patch @param {object} ctx
 */
export function updateAirlinePolicy(state, code, patch, ctx) {
  assertCan(ctx.user, 'airline_policy:manage');
  const airline = (state.airlines || []).find((a) => a.code === code);
  if (!airline) throw new ServiceError('NOT_FOUND', `Airline ${code} not found.`);
  const next = validatePolicy(patch || {});
  if (!Object.keys(next).length) throw new ServiceError('INVALID', 'Nothing to change.');
  const before = { bags_allowed: airline.bags_allowed, extra_bags_max: airline.extra_bags_max, max_bag_weight_kg: airline.max_bag_weight_kg, btic_codes: [...(airline.btic_codes || [])], data_feed_status: airline.data_feed_status };
  Object.assign(airline, next);
  audit(state, ctx, { action: 'airline.policy', entity: 'Airline', entityId: airline.code, before, after: next });
  return airline;
}

/* ───────────────────────── audit ───────────────────────── */

/**
 * The audit trail, newest first.
 * @param {object} state @param {object} user
 * @param {{ q?: string, action?: string, entity?: string, userId?: string, since?: string|number|Date, limit?: number }} [filters]
 */
export function auditTrail(state, user, filters = {}) {
  assertCan(user, 'audit:read');
  const q = String(filters.q || '').trim().toLowerCase();
  const since = filters.since != null ? new Date(filters.since).getTime() : 0;
  const rows = (state.auditLog || [])
    .filter((a) => new Date(a.at).getTime() >= since)
    .filter((a) => (filters.action ? a.action === filters.action : true))
    .filter((a) => (filters.entity ? a.entity === filters.entity : true))
    .filter((a) => (filters.userId ? a.user_id === filters.userId : true))
    .filter((a) => (q ? [a.id, a.action, a.entity, a.entity_id, a.user_id, a.note].some((v) => String(v || '').toLowerCase().includes(q)) : true))
    .map((a) => ({ entry: a, by: (state.users || []).find((u) => u.id === a.user_id) || null }))
    // Entries made in the same millisecond (a seed run, a bulk action) are ordered by their
    // id, which is sequential — otherwise "newest first" leaves them in insertion order.
    .sort((x, y) => String(y.entry.at).localeCompare(String(x.entry.at)) || String(y.entry.id).localeCompare(String(x.entry.id)));
  return filters.limit ? rows.slice(0, filters.limit) : rows;
}

/** Distinct actions/entities in the log, for the Audit screen's filters. */
export function auditFacets(state, user) {
  assertCan(user, 'audit:read');
  const actions = [...new Set((state.auditLog || []).map((a) => a.action))].sort();
  const entities = [...new Set((state.auditLog || []).map((a) => a.entity))].sort();
  return { actions, entities };
}

/* ───────────────────────── demo data ───────────────────────── */

/**
 * Rebuild the v7 store from scratch: migrations (which re-import the old `rabel_ui_*` keys,
 * read-only as always) then the departure seed. Takes the store, not the state, because the
 * whole state object is replaced.
 * @param {{ reset: () => object, save: () => void }} store @param {{ user?: object, now?: any }} ctx
 */
export function resetDemoData(store, ctx) {
  assertCan(ctx.user, 'demo:reset');
  const next = store.reset();
  audit(next, ctx, {
    action: 'demo.reset', entity: 'Store', entityId: 'rabel_v7',
    after: { flights: next.flights.length, travelers: next.travelers.length, bags: next.bags.length, users: next.users.length },
  });
  store.save();
  return next;
}
