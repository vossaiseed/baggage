import { describe, it, expect } from 'vitest';
import { validateLpn } from '../../shared/tags/validateLpn.js';
import { parseCsv } from '../../shared/tags/csv.js';

const sv = { code: 'SV', btic_codes: ['065'] };

describe('validateLpn — import mode', () => {
  const base = { mode: 'import', airline: sv, tags: [], flightIds: ['F1'], flightId: 'F1' };
  it('accepts 10 digits with a valid issuer and KEEPS the leading zero as text', () => {
    const r = validateLpn('0650012345', base);
    expect(r).toMatchObject({ ok: true, lpn: '0650012345', issuer_code: '065', serial: '001234' });
    expect(typeof r.lpn).toBe('string');
  });
  it('rejects bad formats', () => {
    for (const bad of ['12345', '065001234', '06500123456', '065001234A', '', ' ', '065 0012345']) {
      expect(validateLpn(bad, base)).toMatchObject({ ok: false, code: 'INVALID_FORMAT', exception_type: 'Invalid Tag Format' });
    }
  });
  it('rejects a numeric value (leading zero would already be lost)', () => {
    expect(validateLpn(650012345, base).code).toBe('INVALID_FORMAT');
  });
  it('rejects an issuer outside the airline BTIC allow-list', () => {
    expect(validateLpn('1260012345', base)).toMatchObject({ ok: false, code: 'WRONG_ISSUER' });
    expect(validateLpn('0650012345', { ...base, airline: { code: 'SV', btic_codes: [] } }).code).toBe('WRONG_ISSUER');
  });
  it('rejects duplicates and unknown flights', () => {
    expect(validateLpn('0650012345', { ...base, tags: [{ lpn: '0650012345' }] })).toMatchObject({ ok: false, code: 'DUPLICATE', exception_type: 'Duplicate Tag' });
    expect(validateLpn('0650012345', { ...base, flightId: 'NOPE' }).code).toBe('FLIGHT_NOT_FOUND');
  });
});

describe('validateLpn — scan mode (released / flight / traveler / step)', () => {
  const tag = (over = {}) => ({ lpn: '0650012345', status: 'Released', flight_id: 'F1', traveler_id: 'T1', ...over });
  const ctx = (t, over = {}) => ({ mode: 'scan', airline: sv, tags: [t], flightId: 'F1', travelerId: 'T1', ...over });
  it('OK when Released for this flight + traveler', () => expect(validateLpn('0650012345', ctx(tag())).ok).toBe(true));
  it('UNKNOWN when not in the imported list', () => expect(validateLpn('0650099999', ctx(tag()))).toMatchObject({ ok: false, result: 'UNKNOWN' }));
  it('WRONG_FLIGHT', () => expect(validateLpn('0650012345', ctx(tag({ flight_id: 'F2' })))).toMatchObject({ ok: false, result: 'WRONG_FLIGHT', exception_type: 'Wrong Flight Tag' }));
  it('another traveler\'s tag is refused', () => expect(validateLpn('0650012345', ctx(tag({ traveler_id: 'T2' }))).ok).toBe(false));
  it('NOT released → WRONG_STEP / Tag Not Released', () => {
    for (const status of ['Imported', 'Assigned']) expect(validateLpn('0650012345', ctx(tag({ status })))).toMatchObject({ ok: false, result: 'WRONG_STEP', exception_type: 'Tag Not Released' });
  });
  it('already attached/scanned → DUPLICATE; void → Damaged Tag', () => {
    expect(validateLpn('0650012345', ctx(tag({ status: 'Attached' }))).result).toBe('DUPLICATE');
    expect(validateLpn('0650012345', ctx(tag({ status: 'Void' })))).toMatchObject({ result: 'WRONG_STEP', exception_type: 'Damaged Tag' });
  });
  it('bad format and bad issuer are caught first', () => {
    expect(validateLpn('abc', ctx(tag())).result).toBe('INVALID_FORMAT');
    expect(validateLpn('9990012345', ctx(tag())).code).toBe('WRONG_ISSUER');
  });
});

describe('parseCsv', () => {
  it('keeps every cell as a string (leading zeros), trims, handles quotes/CRLF/BOM and blank lines', () => {
    const { header, rows } = parseCsv('﻿Booking Ref,Flight,LPN\r\nA1,"SV 1821",0650012345\r\n\r\n"B,2",SV 1821, 0650012346 \r\n');
    expect(header).toEqual(['booking_ref', 'flight', 'lpn']);
    expect(rows.map((r) => r.cells)).toEqual([
      { booking_ref: 'A1', flight: 'SV 1821', lpn: '0650012345' }, { booking_ref: 'B,2', flight: 'SV 1821', lpn: '0650012346' },
    ]);
    expect(rows[0].line).toBe(2);
  });
  it('empty input', () => expect(parseCsv('')).toEqual({ header: [], rows: [] }));
});
