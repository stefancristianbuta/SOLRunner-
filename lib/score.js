const MIN_LIQUIDITY_USD = 20_000;
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function scorePair(pair, ageMin, liquidity, volume, buys, sells, signal = {}) {
  const total = buys + sells;
  const buyShare = total ? buys / total : 0;
  const volumeLiquidity = volume / Math.max(liquidity, 1);
  const activity = clamp(Math.log10(total + 1) / 2.4, 0, 1);
  const liquidityQuality = clamp(Math.log10(liquidity / MIN_LIQUIDITY_USD + 1) / 1.2, 0, 1);
  const momentum5m = clamp((n(pair.priceChange?.m5) + 5) / 25, 0, 1);
  const momentum1h = clamp((n(pair.priceChange?.h1) + 5) / 35, 0, 1);
  const buyPressure = clamp((buyShare - 0.35) / 0.5, 0, 1);
  const volPulse = clamp(volumeLiquidity / 1.5, 0, 1);
  const buyers = n(signal.buyers), sellers = n(signal.sellers);
  const uniqueBuyerSignal = buyers + sellers > 0 ? clamp((buyers / Math.max(buyers + sellers, 1) - 0.35) / 0.5, 0, 1) : null;
  // Organic-momentum heuristic: favor sustained activity, rising volume and broad buyer participation.
  // Missing unique-wallet data is neutral, not proof of organic demand.
  const organic = uniqueBuyerSignal === null ? 0.5 : uniqueBuyerSignal;
  const score = buyPressure * 20 + (volPulse * 0.55 + activity * 0.45) * 20 +
    liquidityQuality * 15 + (momentum5m * 0.65 + momentum1h * 0.35) * 20 +
    organic * 15 + clamp(total / 30, 0, 1) * 10;
  return Math.round(clamp(score, 0, 100));
}


module.exports = { scorePair };
