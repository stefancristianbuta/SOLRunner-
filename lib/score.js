"use strict";

const MIN_LIQUIDITY_USD = 20_000;
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(1, v));

function scorePair(pair, ageMin, liquidity, volume5m, buys5m, sells5m, signal = {}) {
  const total5m = Math.max(0, buys5m + sells5m);
  const buyShare5m = total5m ? buys5m / total5m : 0;
  const volumeLiquidity5m = Math.max(0, volume5m) / Math.max(liquidity, 1);
  const txns1h = pair.txns?.h1 || {};
  const buys1h = n(txns1h.buys), sells1h = n(txns1h.sells);
  const total1h = Math.max(0, buys1h + sells1h);
  const buyShare1h = total1h ? buys1h / total1h : 0;
  const change5m = n(pair.priceChange?.m5), change1h = n(pair.priceChange?.h1);
  const momentum5m = clamp((change5m + 2) / 18, 0, 1);
  const momentum1h = clamp((change1h + 3) / 25, 0, 1);
  const sustainedMomentum = momentum5m * 0.3 + momentum1h * 0.7;
  const activity5m = clamp(Math.log10(total5m + 1) / 2, 0, 1);
  const activity1h = clamp(Math.log10(total1h + 1) / 2.7, 0, 1);
  const liquidityQuality = clamp(Math.log10(Math.max(liquidity, 0) / MIN_LIQUIDITY_USD + 1) / 1.5, 0, 1);
  const turnoverQuality = volumeLiquidity5m <= 0.6
    ? clamp(volumeLiquidity5m / 0.25, 0, 1)
    : clamp(1 - (volumeLiquidity5m - 0.6) / 1.4, 0, 1);
  const pressureQuality = buyShare5m < 0.45
    ? clamp((buyShare5m - 0.25) / 0.2, 0, 1)
    : buyShare5m <= 0.82 ? 1 : clamp((0.98 - buyShare5m) / 0.16, 0, 1);

  const buyers = n(signal.buyers), sellers = n(signal.sellers);
  const uniqueTotal = buyers + sellers;
  const buyerShare = uniqueTotal > 0 ? buyers / uniqueTotal : null;
  const buyerBreadth = buyerShare === null ? 0.35 : clamp((buyerShare - 0.35) / 0.45, 0, 1);
  const buyerDiversity = uniqueTotal > 0 ? clamp(Math.log10(uniqueTotal + 1) / 1.7, 0, 1) : 0.25;
  const uniqueBuyerRatio = buyers > 0 ? Math.min(1, buyers / buys5m) : null;
  const diversityPenalty = uniqueBuyerRatio === null ? 3 :
    uniqueBuyerRatio < 0.08 ? 12 : uniqueBuyerRatio < 0.15 ? 8 :
    uniqueBuyerRatio < 0.25 ? 4 : 0;
  const hourBuyQuality = total1h > 0 ? clamp((buyShare1h - 0.35) / 0.45, 0, 1) : 0.25;

  const priceJumpPenalty = change5m >= 35 && total5m < 40 ? 8 : change5m >= 25 && total5m < 10 ? 10 : 0;
  const turnoverPenalty = volumeLiquidity5m >= 2 ? 14 : volumeLiquidity5m >= 1.5 ? 10 :
    volumeLiquidity5m >= 1 ? 6 : volumeLiquidity5m >= 0.75 ? 3 : 0;
  const oneSidedPenalty = total5m >= 20 && (sells5m === 0 || buyShare5m >= 0.97) ? 10 :
    total5m >= 20 && buyShare5m >= 0.93 ? 6 : 0;
  const dataPenalty = (total5m === 0 ? 5 : 0) + (total1h === 0 ? 5 : 0) +
    (buyerShare === null ? 4 : 0) + (change1h === 0 ? 2 : 0);

  const score =
    sustainedMomentum * 25 +
    (buyerBreadth * 0.65 + buyerDiversity * 0.35) * 20 +
    (activity5m * 0.45 + activity1h * 0.35 + turnoverQuality * 0.20) * 20 +
    (pressureQuality * 0.65 + hourBuyQuality * 0.35) * 15 +
    (liquidityQuality * 0.7 + turnoverQuality * 0.3) * 10 +
    (momentum5m * 0.35 + momentum1h * 0.65) * 10 -
    priceJumpPenalty - turnoverPenalty - oneSidedPenalty - diversityPenalty - dataPenalty;
  return Math.round(Math.max(0, Math.min(100, score)));
}

module.exports = { scorePair };
