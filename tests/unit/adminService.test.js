import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../shared/store.js';
import { seedDeparture } from '../../shared/seed/departure.js';
import * as adm from '../../shared/services/adminService.js';
import * as staff from '../../shared/services/staffService.js';
import { validateLpn } from '../../shared/tags/validateLpn.js';
import { PermissionError } from '../../shared/rbac.js';

const NOW = new Date('2026-06-01T06:00:00Z').getTime();

let s; let ADM; let OPS; let WM;
const ctx = (user, now = NOW) => ({ user, now });

beforeEach(() => {
  s = createStore({ storage: null, baseAccounts: false }).get();
  seedDeparture(s, { now: NOW });
  ADM = s.users.find((u) => u.id === 'ADM-001');
  OPS = s.users.find((u) => u.id === 'OPS-001');
  WM = s.users.find((u) => u.id === 'WM-001');
});

describe('integrations', () => {
  it('reports the configured mode, the wired adapter and what each one has done', () => {
    const rows = adm.integrationStatus(s, ADM);
    expect(rows.map((r) => r.id)).toEqual(['nusuk', 'airlineFeed', 'sgs', 'sms']);
    expect(rows.every((r) => r.mode === 'simulated' && r.adapter === 'wired')).toBe(true);
    expect(rows.find((r) => r.id === 'nusuk').usage.n).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === 'nusuk').lastCheck).toBeNull();
  });

  it('a connection test asks the adapter for something real and keeps the answer', () => {
    const res = adm.testIntegration(s, 'nusuk', ctx(ADM));
    expect(res.ok).toBe(true);
    expect(res.note).toMatch(/traveler record/);
    const row = adm.integrationStatus(s, ADM).find((r) => r.id === 'nusuk');
    expect(row.lastCheck).toMatchObject({ ok: true, by: 'ADM-001' });
    expect(s.auditLog.some((a) => a.action === 'integration.test' && a.entity_id === 'nusuk')).toBe(true);
    expect(() => adm.testIntegration(s, 'nope', ctx(ADM))).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => adm.testIntegration(s, 'nusuk', ctx(OPS))).toThrow(PermissionError);
  });
});

describe('airline policy', () => {
  it('lists each airline with the flights and travelers behind it', () => {
    const rows = adm.listAirlines(s, ADM);
    expect(rows.map((r) => r.airline.code)).toEqual(['GA', 'PK', 'SV']);
    expect(rows.find((r) => r.airline.code === 'SV').flights).toBe(2);
    expect(rows.find((r) => r.airline.code === 'SV').travelers).toBeGreaterThan(0);
  });

  it('validates every field before it changes the rules travelers are held to', () => {
    expect(() => adm.updateAirlinePolicy(s, 'SV', { bags_allowed: 2.5 }, ctx(ADM))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => adm.updateAirlinePolicy(s, 'SV', { max_bag_weight_kg: 0 }, ctx(ADM))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => adm.updateAirlinePolicy(s, 'SV', { btic_codes: '65' }, ctx(ADM))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => adm.updateAirlinePolicy(s, 'SV', { data_feed_status: 'Maybe' }, ctx(ADM))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => adm.updateAirlinePolicy(s, 'ZZ', { bags_allowed: 1 }, ctx(ADM))).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => adm.updateAirlinePolicy(s, 'SV', {}, ctx(ADM))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
    expect(() => adm.updateAirlinePolicy(s, 'SV', { bags_allowed: 1 }, ctx(WM))).toThrow(PermissionError);
  });

  it('a new BTIC code is what the tag validator accepts from then on', () => {
    const lpn = '9990012345';
    expect(validateLpn(lpn, { airline: s.airlines.find((a) => a.code === 'SV'), mode: 'import' }).ok).toBe(false);
    adm.updateAirlinePolicy(s, 'SV', { btic_codes: '065, 999' }, ctx(ADM));
    expect(s.airlines.find((a) => a.code === 'SV').btic_codes).toEqual(['065', '999']);
    expect(validateLpn(lpn, { airline: s.airlines.find((a) => a.code === 'SV'), mode: 'import' }).ok).toBe(true);
    expect(s.auditLog.some((a) => a.action === 'airline.policy' && a.entity_id === 'SV')).toBe(true);
  });

  it('creates an airline on the v7 defaults, and refuses a bad or duplicate code', () => {
    const a = adm.createAirline(s, { code: 'ek', name: 'Emirates', btic_codes: ['176'] }, ctx(ADM));
    expect(a.code).toBe('EK');
    expect(a.bags_allowed).toBe(2);
    expect(a.max_bag_weight_kg).toBe(23);
    expect(a.data_feed_status).toBe('Not connected');
    expect(() => adm.createAirline(s, { code: 'EK' }, ctx(ADM))).toThrowError(expect.objectContaining({ code: 'DUPLICATE' }));
    expect(() => adm.createAirline(s, { code: 'TOOLONG' }, ctx(ADM))).toThrowError(expect.objectContaining({ code: 'INVALID' }));
  });
});

describe('audit trail', () => {
  it('is newest first, filterable, and names who did it', () => {
    adm.testIntegration(s, 'sms', ctx(ADM));
    staff.resetPin(s, 'OPS-001', '4321', ctx(ADM));
    const rows = adm.auditTrail(s, ADM, {});
    expect(rows[0].entry.action).toBe('staff.reset_pin');
    expect(rows[0].by.id).toBe('ADM-001');
    expect(adm.auditTrail(s, ADM, { action: 'integration.test' })).toHaveLength(1);
    expect(adm.auditTrail(s, ADM, { q: 'ops-001' }).length).toBeGreaterThan(0);
    expect(adm.auditTrail(s, ADM, { limit: 2 })).toHaveLength(2);
    const facets = adm.auditFacets(s, ADM);
    expect(facets.actions).toContain('integration.test');
    expect(facets.entities).toContain('User');
    expect(() => adm.auditTrail(s, WM, {})).toThrow(PermissionError);
  });

  it('never records a PIN', () => {
    staff.resetPin(s, 'OPS-001', '4321', ctx(ADM));
    const entry = s.auditLog.find((a) => a.action === 'staff.reset_pin');
    expect(JSON.stringify(entry)).not.toContain('4321');
  });
});

describe('reset demo data', () => {
  it('rebuilds the store from the seed and logs who did it', () => {
    const store = createStore({ storage: null, baseAccounts: true });
    const before = store.get();
    before.flights.find((f) => f.id === 'FLT-SV-1821').status = 'Cancelled';
    before.bags.length = 0;
    const admin = before.users.find((u) => u.id === 'ADM-001');

    const next = adm.resetDemoData(store, { user: admin, now: NOW });
    expect(next.flights.find((f) => f.id === 'FLT-SV-1821').status).toBe('Scheduled');
    expect(next.bags.length).toBeGreaterThan(0);
    expect(next.auditLog.some((a) => a.action === 'demo.reset' && a.user_id === 'ADM-001')).toBe(true);
  });

  it('only a role with demo:reset may do it', () => {
    const store = createStore({ storage: null, baseAccounts: true });
    const wm = store.get().users.find((u) => u.id === 'WM-001');
    expect(() => adm.resetDemoData(store, { user: wm, now: NOW })).toThrow(PermissionError);
  });
});
