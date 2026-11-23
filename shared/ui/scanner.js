/**
 * Shared scanner component — ONE implementation for every screen that scans.
 *
 * Inputs
 *  • Handheld / ring scanner (keyboard wedge + Enter) — focus is kept on the field and returned after every scan.
 *  • Phone camera via html5-qrcode — formats ITF, CODE_128, QR_CODE; wide ~300×120 box for 1D codes;
 *    BarcodeDetector used when the browser supports it (Android Chrome). A camera ITF read is only accepted after
 *    2 identical consecutive reads (see shared/scan/readFilter.js); after an accept the camera pauses briefly.
 *  • Manual entry — an exception path only; every manual value is reported as method MANUAL.
 *
 * Output (handed to onScan, which should call a service → scanService.recordScan):
 *    { value, method: 'HANDHELD'|'CAMERA'|'MANUAL', symbology: 'ITF'|'CODE128'|'QR', device_id }
 * Mode-aware hint text: setHint('Scan airline tag') / 'Scan Rabel label' / 'Scan truck QR'.
 */
import { createReadFilter, inferSymbology, symbologyFromFormat } from '../scan/readFilter.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Stable per-browser device id stored on every ScanEvent. */
export function getDeviceId() {
  try {
    let id = localStorage.getItem('rabel_device_id');
    if (!id) { id = `DEV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`; localStorage.setItem('rabel_device_id', id); }
    return id;
  } catch { return 'DEV-UNKNOWN'; }
}

function beep(low) {
  try {
    const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = low ? 220 : 880; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination); o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, low ? 260 : 120);
  } catch { /* audio blocked */ }
}
const vibrate = (ms) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };

/**
 * @param {HTMLElement} container
 * @param {{
 *   hint?: string,
 *   onScan: (scan: {value:string, method:string, symbology:string, device_id:string}) => Promise<{ok?:boolean, message?:string}|void>|{ok?:boolean, message?:string}|void,
 *   autofocus?: boolean,
 *   readFilter?: ReturnType<typeof createReadFilter>,
 * }} opts
 */
export function createScanner(container, opts) {
  const filter = opts.readFilter || createReadFilter();
  let hint = opts.hint || 'Scan';
  let manual = false;
  let cameraOn = false;
  let busy = false;
  let destroyed = false;
  let cam = null;
  const camId = `rs-cam-${Math.random().toString(36).slice(2, 7)}`;

  container.innerHTML = `
    <div class="rs-scanner" data-rs>
      <div class="rs-hint" data-rs-hint></div>
      <div class="rs-sub" data-rs-sub></div>
      <input class="rs-input" data-rs-input type="text" inputmode="none" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Scan value" />
      <div class="rs-camera" id="${camId}" data-rs-camera></div>
      <div class="rs-row">
        <button type="button" class="btn btn-secondary" data-rs-cam>Use camera</button>
        <button type="button" class="btn btn-ghost" data-rs-manual>Manual entry</button>
      </div>
      <div data-rs-result role="status" aria-live="polite"></div>
    </div>`;
  const $ = (sel) => container.querySelector(sel);
  const input = $('[data-rs-input]');

  function paint() {
    $('[data-rs-hint]').textContent = hint;
    $('[data-rs-sub]').textContent = manual ? 'Manual entry — exception path. Type the exact code and press Enter (logged as MANUAL).' : cameraOn ? 'Point the camera at the barcode.' : 'Scan with the handheld scanner, or use the camera.';
    input.classList.toggle('is-manual', manual);
    input.placeholder = manual ? 'Type the code, press Enter' : 'Waiting for scan…';
    $('[data-rs-manual]').textContent = manual ? 'Back to scanning' : 'Manual entry';
    $('[data-rs-cam]').textContent = cameraOn ? 'Stop camera' : 'Use camera';
    $('[data-rs]').setAttribute('aria-busy', String(busy));
  }
  function refocus() { if (!destroyed && !cameraOn && !document.querySelector('.overlay, .drawer-overlay')) input.focus({ preventScroll: true }); }

  function showResult(ok, message) {
    $('[data-rs-result]').innerHTML = `<div class="rs-result ${ok ? 'ok' : 'fail'}"><span aria-hidden="true">${ok ? '✓' : '✕'}</span><div><strong>${ok ? 'Accepted' : 'Not accepted'}</strong>${esc(message || '')}</div></div>`;
  }

  async function accept(value, method, symbology) {
    if (busy || destroyed) return;
    const v = String(value).trim();
    if (!v) return;
    busy = true; paint();
    try {
      /** @type {any} */
      const res = await opts.onScan({ value: v, method, symbology, device_id: getDeviceId() });
      const ok = res?.ok !== false;
      beep(!ok); vibrate(ok ? 30 : [60, 40, 60]);
      showResult(ok, res?.message || (ok ? v : 'Rejected'));
    } catch (err) {
      beep(true); vibrate([60, 40, 60]);
      showResult(false, err?.message || String(err));
    } finally {
      busy = false;
      if (!destroyed) { input.value = ''; paint(); refocus(); }
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = input.value;
    accept(v, manual ? 'MANUAL' : 'HANDHELD', inferSymbology(v));
  });
  input.addEventListener('blur', () => setTimeout(refocus, 150)); // return focus to the field (handheld wedge)
  window.addEventListener('focus', refocus);

  $('[data-rs-manual]').addEventListener('click', () => { manual = !manual; if (manual && cameraOn) stopCamera(); paint(); input.focus(); });
  $('[data-rs-cam]').addEventListener('click', () => (cameraOn ? stopCamera() : startCamera()));

  async function startCamera() {
    const w = /** @type {any} */ (window);
    const Lib = w.Html5Qrcode;
    if (!Lib) { showResult(false, 'Camera scanning is unavailable in this browser.'); return; }
    manual = false; cameraOn = true; paint();
    const box = $('[data-rs-camera]'); box.classList.add('is-on');
    const F = w.Html5QrcodeSupportedFormats || {};
    try {
      cam = new Lib(camId, {
        verbose: false,
        formatsToSupport: [F.ITF, F.CODE_128, F.QR_CODE].filter((x) => x !== undefined),
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      });
      await cam.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 300, height: 120 }, aspectRatio: 1.7778 },
        (text, result) => {
          const symbology = symbologyFromFormat(result?.result?.format?.formatName);
          const accepted = filter.feed(text, symbology);
          if (accepted) { try { cam?.pause(true); } catch { /* not running */ } accept(accepted, 'CAMERA', symbology).finally(() => setTimeout(() => { try { cam?.resume(); } catch { /* stopped */ } }, 1200)); }
        },
        () => { /* no code in this frame */ },
      );
    } catch (err) {
      cameraOn = false; box.classList.remove('is-on'); paint();
      showResult(false, `Camera unavailable: ${err?.message || err}`);
    }
  }
  async function stopCamera() {
    cameraOn = false;
    $('[data-rs-camera]')?.classList.remove('is-on');
    try { await cam?.stop(); cam?.clear?.(); } catch { /* already stopped */ }
    cam = null; filter.reset(); paint(); refocus();
  }

  paint();
  if (opts.autofocus !== false) refocus();
  return {
    setHint(text) { hint = text; paint(); },
    focus: refocus,
    clearResult() { $('[data-rs-result]').innerHTML = ''; },
    destroy() { destroyed = true; window.removeEventListener('focus', refocus); stopCamera(); },
  };
}
