// cbBTC trend bot for make.fun's "Race a BTC trading bot live for 24 hours".
//
// Protocol: agent-fun/bars-replay/v1. The harness sends hello once, then one
// batch per minute (the 1-minute bar that just closed, the fills of the orders
// sent on the previous batch, and the account), and the bot answers every batch
// with exactly one reply echoing its seq. Orders decided on a batch fill at the
// next bar's open, with a 4 bps fee, 2 bps slippage and constant-product price
// impact against that bar's open depth, so a full-size round trip costs about
// 26 bps: a trade has to catch a move larger than that.
//
// Strategy (long only, one position, standard library only, deterministic):
// trend following on exponential moving averages of the 1-minute closes.
// It buys only when the trend is confirmed on three timeframes at once:
// the close is above the fast EMA which is above the slow EMA, the close
// clears the slow EMA by a margin, the short-term average close is rising
// against the average 60 bars earlier, and the slow EMA itself has risen
// at least 0.2% over the last 240 bars (so it stays in cash in flat or
// falling regimes instead of buying every counter-trend bounce). Once in,
// it holds at least 150 bars (a full round trip costs ~26 bps, so
// whipsaw exits lose money) and then exits only if the close falls back
// below roughly the price the window opened at, if the trailing stop is
// hit, or on the hard stop-loss — on a rising window it therefore rides
// the whole trend like buy-and-hold instead of churning. A re-entry cooldown, a no-entry tail before the window end, and an
// equity drawdown guard keep the 25% race drawdown bar out of reach.
//
// No network, no wall clock, no files outside the repository, no randomness:
// the same bars always produce the same orders.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const QUOTE_UNITS_PER_USDC = 1_000_000n;

// ---- strategy parameters (tuned on the dev window, kept generic) ----
const EMA_FAST = 30; // fast EMA length, in 1-minute bars
const EMA_SLOW = 120; // slow EMA length, in 1-minute bars
const EMA_EXIT = 100_000; // near-frozen exit EMA: it barely moves from the
// first close, so it acts as a floor at roughly the price the window opened
// at. While holding, the bot exits only if the close falls back below that
// floor (after the minimum hold), if the trailing stop is hit, or on the
// hard stop. On a rising window it therefore holds through the whole trend
// like buy-and-hold; on a falling window it gets out near where it started.
const TOTAL_BARS = 1440; // bars in the scored window (dev and race alike)
const MIN_BARS = 45; // bars of history before the first entry is allowed
const ENTRY_MARGIN_BPS = 20; // close must clear the slow EMA by this much to enter
const TRAIL_STOP_PCT = 0.02; // trailing stop: sell when close falls this far below the peak since entry
const STOP_LOSS_PCT = 0.02; // hard stop: sell when close falls this far below the entry price
const COOLDOWN_BARS = 60; // bars to wait after an exit before re-entering
const MIN_HOLD_BARS = 150; // bars a position must be held before the EMA/trailing exits may fire
const TREND_LOCKOUT_BARS = 240; // slow EMA must have risen this many bars back...
const TREND_LOCKOUT_BPS = 20; // ...by at least this much (0.2%) for an entry to be allowed
const NO_ENTRY_LAST_BARS = 60; // do not open a new position this close to the end
const MAX_DD_GUARD = 0.10; // flatten and halt if equity falls this far from its peak
const MAX_SLIPPAGE_BPS = 150; // max move from the latest close an order tolerates

/** Long-only EMA trend bot over 1-minute closes. */
class TrendBot {
  private closes: number[] = []; // closes in USDC
  private emaSlowHist: number[] = []; // slow EMA value after each bar
  private emaFast: number | null = null;
  private emaSlow: number | null = null;
  private emaExit: number | null = null;
  private entryPrice = 0;
  private entrySeq = -1;
  private peakSinceEntry = 0;
  private peakEquity = 0;
  private cooldownUntil = -1;
  private halted = false;
  private seq = -1;

  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    this.seq = state.seq;
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const closeUsd = Number(close) / 1e5; // price_scale is 5
    this.closes.push(closeUsd);
    this.updateEmas(closeUsd);

    const equityUsd = Number(state.equity) / Number(QUOTE_UNITS_PER_USDC);
    if (equityUsd > this.peakEquity) this.peakEquity = equityUsd;

    // Drawdown guard: flatten once and stop trading for the rest.
    if (!this.halted && this.peakEquity > 0) {
      if (equityUsd < this.peakEquity * (1 - MAX_DD_GUARD)) this.halted = true;
    }

    const holding = state.positions.get(SYMBOL);
    const qty = holding === undefined ? 0n : holding.qty;
    const inPosition = qty > 0n;

    if (this.halted) {
      if (inPosition) return [this.sellAll(qty)];
      return [];
    }

    if (state.warmingUp) return [];

    // Track the peak since entry while long.
    if (inPosition) {
      if (closeUsd > this.peakSinceEntry) this.peakSinceEntry = closeUsd;
      if (this.shouldExit(closeUsd)) return [this.sellAll(qty)];
      return [];
    }

    // Flat: look for an entry.
    if (this.closes.length < MIN_BARS) return [];
    if (state.seq < this.cooldownUntil) return [];
    // Do not open a position so late that the end-of-window flatten
    // would eat it in fees: the last batch is warmup + TOTAL_BARS - 1.
    if (state.seq >= state.warmupBars + TOTAL_BARS - NO_ENTRY_LAST_BARS) return [];
    if (this.shouldEnter(closeUsd)) {
      const cash = state.cash;
      if (cash < QUOTE_UNITS_PER_USDC) return [];
      // Spend all cash: one position, up to 100% of equity.
      this.entryPrice = closeUsd;
      this.entrySeq = state.seq;
      this.peakSinceEntry = closeUsd;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  private updateEmas(close: number): void {
    if (this.emaFast === null || this.emaSlow === null || this.emaExit === null) {
      this.emaFast = close;
      this.emaSlow = close;
      this.emaExit = close;
      this.emaSlowHist.push(close);
      return;
    }
    const aFast = 2 / (EMA_FAST + 1);
    const aSlow = 2 / (EMA_SLOW + 1);
    const aExit = 2 / (EMA_EXIT + 1);
    this.emaFast += aFast * (close - this.emaFast);
    this.emaSlow += aSlow * (close - this.emaSlow);
    this.emaExit += aExit * (close - this.emaExit);
    this.emaSlowHist.push(this.emaSlow);
  }

  private shouldEnter(closeUsd: number): boolean {
    if (this.emaFast === null || this.emaSlow === null) return false;
    if (!(closeUsd > this.emaFast && this.emaFast > this.emaSlow)) return false;
    // The trend must be real, not a one-bar wiggle above a flat slow EMA.
    if ((closeUsd - this.emaSlow) / this.emaSlow < ENTRY_MARGIN_BPS / 10_000) return false;
    // Short-term momentum must be rising: the average close of the last
    // 31 bars beats the average close of the 30 bars 60 bars earlier.
    const n = this.closes.length;
    if (n < 91) return false;
    let recent = 0;
    for (let i = n - 31; i < n; i++) recent += this.closes[i];
    let older = 0;
    for (let i = n - 91; i < n - 61; i++) older += this.closes[i];
    if (recent / 31 <= older / 30) return false;
    // Long-term regime check, once enough slow-EMA history exists: the
    // slow EMA must have risen at least 0.2% over the last 240 bars.
    // In a flat or falling regime this keeps the bot in cash.
    if (n > TREND_LOCKOUT_BARS) {
      const slowThen = this.emaSlowHist[n - 1 - TREND_LOCKOUT_BARS];
      if ((this.emaSlow - slowThen) / slowThen < TREND_LOCKOUT_BPS / 10_000) return false;
    }
    return true;
  }

  private shouldExit(closeUsd: number): boolean {
    const held = this.seq - this.entrySeq;
    // Hard stop off the entry price: always active, even inside the hold.
    if (closeUsd < this.entryPrice * (1 - STOP_LOSS_PCT)) {
      this.cooldownUntil = this.seq + COOLDOWN_BARS;
      return true;
    }
    if (held < MIN_HOLD_BARS) return false;
    // Trend broken: the close fell back under the very slow exit EMA.
    if (this.emaExit !== null && closeUsd < this.emaExit) {
      this.cooldownUntil = this.seq + COOLDOWN_BARS;
      return true;
    }
    // Trailing stop off the peak since entry.
    if (closeUsd < this.peakSinceEntry * (1 - TRAIL_STOP_PCT)) {
      this.cooldownUntil = this.seq + COOLDOWN_BARS;
      return true;
    }
    return false;
  }

  private sellAll(qty: bigint): OrderInput {
    return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
  }
}

const bot = new TrendBot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
