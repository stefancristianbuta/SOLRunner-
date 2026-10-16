"use strict";

const MIN_LIQUIDITY_USD = 20_000;
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Ranks candidates for organic momentum, not expected profit.
 * Rewards sustained activity and broad participation; penalizes one-sided flow
 * and extreme turnover that can accompany thin-liquidity pumps.
 */
function scorePair(pair, ageMin, liquidity, volume5m, buys5m, sells5m, signal = {}) {
  const total5m = Math.max(0, buys5m + sells5m);
  const buyShare5m = total5m ? buys5m / total5m : 0;
  const volumeLiquidity5m = Math.max(0, volume5m) / Math.max(liquidity, 1);
  const activity5m = clamp(Math.log10(total5m + 1) / 2, 0, 1);

  const txns1h = pair.txns?.h1 || {};
  const buys1h = n(txns1h.buys);
  const sells1h = n(txns1h.sells);
  const total1h = Math.max(0, buys1h + sells1h);
  const buyShare1h = total1h ? buys1h / total1h : 0;
  const activity1h = clamp(Math.log10(total1h + 1) / 2.7, 0, 1);

  const liquidityQuality = clamp(Math.log10(Math.max(liquidity, 0) / MIN_LIQUIDITY_USD + 1) / 1.5, 0, 1);
  const change5m = n(pair.priceChange?.m5);
  const change1h = n(pair.priceChange?.h1);
  // Prefer positive, sustained movement; do not reward a vertical 5m candle alone.
  const momentum5m = clamp((change5m + 2) / 18, 0, 1);
  const momentum1h = clamp((change1h + 3) / 25, 0, 1);
  const sustainedMomentum = momentum5m * 0.3 + momentum1h * 0.7;

  // Healthy turnover: some activity is useful; extreme turnover against liquidity is suspicious.
  const turnoverQuality = volumeLiquidity5m <= 0.6
    ? clamp(volumeLiquidity5m / 0.25, 0, 1)
    : clamp(1 - (volumeLiquidity5m - 0.6) / 1.4, 0, 1);

  // Favor buyer pressure, but penalize near-perfect one-sided flow.
  const pressureQuality = buyShare5m < 0.45
    ? clamp((buyShare5m - 0.25) / 0.2, 0, 1)
    : buyShare5m <= 0.82
      ? 1
      : clamp((0.98 - buyShare5m) / 0.16, 0, 1);

  const buyers = n(signal.buyers);
  const sellers = n(signal.sellers);
  const uniqueTotal = buyers + sellers;
  const breadth = uniqueTotal > 0 ? clamp((buyers / uniqueTotal - 0.35) / 0.45, 0, 1) : null;
  // Missing unique-wallet data is neutral, never interpreted as proof of organic demand.
  const buyerBreadth = breadth === null ? 0.45 : breadth;

  const hourBuyQuality = total1h > 0 ? clamp((buyShare1h - 0.35) / 0.45, 0, 1) : 0.35;
  const priceJumpPenalty = change5m >= 35 && total5m < 40 ? 0.35 : change5m >= 25 && total5m < 10 ? 0.5 : 0;

  const score =
    pressureQuality * 12 +
    activity5m * 12 +
    activity1h * 12 +
    liquidityQuality * 14 +
    sustainedMomentum * 20 +
    turnoverQuality * 10 +
    buyerBreadth * 12 +
    hourBuyQuality * 8 -
    priceJumpPenalty * 20;

  return Math.round(clamp(score, 0, 100));
}

module.exports = { scorePair };
