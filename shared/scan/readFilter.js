/**
 * Camera read acceptance. A 1D barcode (ITF) decoded once by a camera can be a misread, so an ITF value is
 * accepted only after N identical consecutive reads (default 2). Other symbologies (Code 128, QR) carry
 * their own checksum/ECC and are accepted at once. After an accept the filter "pauses" for `pauseMs`
 * so one physical scan never counts twice.
 */
export const DEFAULTS = Object.freeze({ requiredConsecutive: 2, pauseMs: 1500, consecutiveWindowMs: 1200 });

/**
 * @param {{ requiredConsecutive?: number, pauseMs?: number, consecutiveWindowMs?: number }} [opts]
 * @returns {{ feed: (value: string, symbology: string, nowMs?: number) => string|null, reset: () => void }}
 */
export function createReadFilter(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let last = null;
  let count = 0;
  let lastAt = 0;
  let pausedUntil = 0;
  return {
    feed(value, symbology, nowMs = Date.now()) {
      if (nowMs < pausedUntil) return null;
      const v = String(value ?? '').trim();
      if (!v) return null;
      const needs = symbology === 'ITF' ? cfg.requiredConsecutive : 1;
      if (v === last && nowMs - lastAt <= cfg.consecutiveWindowMs) count++; else { last = v; count = 1; }
      lastAt = nowMs;
      if (count >= needs) { pausedUntil = nowMs + cfg.pauseMs; last = null; count = 0; return v; }
      return null;
    },
    reset() { last = null; count = 0; lastAt = 0; pausedUntil = 0; },
  };
}

/** Best-effort symbology for a keyboard-wedge (handheld) read, which only gives us text. */
export function inferSymbology(value) {
  const v = String(value || '').trim();
  if (/^\d{10}$/.test(v)) return 'ITF';
  if (/^RBL-D-\d{6}$/i.test(v)) return 'CODE128';
  return 'QR';
}

/** html5-qrcode format name → our symbology enum. */
export function symbologyFromFormat(formatName) {
  const f = String(formatName || '').toUpperCase();
  if (f.includes('ITF')) return 'ITF';
  if (f.includes('CODE_128') || f.includes('CODE128')) return 'CODE128';
  return 'QR';
}
