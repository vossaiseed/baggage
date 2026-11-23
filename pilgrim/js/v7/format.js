import { fmtTime, fmtDate, esc } from '../ui.js';

/** "Tue 3 Jun, 14:00–16:00" */
export function slotLabel(slot) {
  if (!slot) return '—';
  return `${fmtDate(slot.start)}, ${fmtTime(slot.start)}–${fmtTime(slot.end)}`;
}

export const maskPassport = (p) => (p ? `${'•'.repeat(Math.max(0, p.length - 3))}${p.slice(-3)}` : '—');

export function residenceHtml(res) {
  if (!res) return '<span class="muted">No residence on file</span>';
  return `<strong>${esc(res.building)}</strong>, flat ${esc(res.flat_no)}<br><span class="muted fs-sm">${esc(res.street)} · ${esc(res.district)}${res.landmark ? ` · ${esc(res.landmark)}` : ''}</span>`;
}

export function bannersHtml(banners) {
  const color = { cancelled: 'amber', rebooked: 'blue', absent: 'amber' };
  return banners.map((b) => `<div class="banner-alert ${color[b.kind] || 'blue'}" role="status"><span class="icon">⚠</span><div><strong>${esc(b.text)}</strong></div></div>`).join('');
}
