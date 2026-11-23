/**
 * SGS (Airport Authority) adapter — the handover counterpart of the airline feed:
 *   submitHandover(state, handover, flight) -> { voucher_no, counted_tags, issued_at }
 *   fetchVoucher(state, voucherNo)          -> { voucher_no, counted_tags } | null
 *
 * Simulated: SGS counts exactly the airline tags Rabel handed over, minus any tag listed in
 * `state.simulated.voucherDrops[flightId]` — the switch that demos an "SGS Voucher Mismatch"
 * (the same shape as `manifestDrops` in the airline feed). Voucher numbers are deterministic
 * per handover so re-fetching one never invents a new number.
 */

const pad = (n) => String(n).padStart(6, '0');

export const simulatedSgs = {
  mode: 'simulated',

  /**
   * @param {any} state
   * @param {{ id: string, flight_id: string, tags: string[] }} handover the manifest as handed over
   * @returns {{ voucher_no: string, counted_tags: string[], issued_at: string|null }}
   */
  submitHandover(state, handover) {
    const drops = new Set(state.simulated?.voucherDrops?.[handover.flight_id] || []);
    const counted = (handover.tags || []).filter((t) => !drops.has(t));
    return { voucher_no: `SGS-${pad(Number(String(handover.id).replace(/\D/g, '')) || 1)}`, counted_tags: counted, issued_at: null };
  },

  /** Re-read a voucher SGS has already issued (the demo keeps them on the store). */
  fetchVoucher(state, voucherNo) {
    return (state.sgsVouchers || []).find((v) => v.voucher_no === voucherNo) || null;
  },
};
