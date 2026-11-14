"use strict";

function assessMarketRisk(token = {}) {
  const flags = [];
  const change5m = Number(token.change5m) || 0;
  const volume5m = Number(token.volume5m) || 0;
  const liquidity = Number(token.liquidityUsd) || 0;
  const buys = Number(token.buys5m) || 0;
  const sells = Number(token.sells5m) || 0;
  const txns = Number(token.txns5m) || buys + sells;
  const volumeLiquidity = liquidity > 0 ? volume5m / liquidity : 0;
  const buyShare = txns > 0 ? buys / txns : 0;
  const hasUniqueBuyerData = token.uniqueBuyers5m !== null && token.uniqueBuyers5m !== undefined && token.uniqueBuyers5m !== "";
  const uniqueBuyers = hasUniqueBuyerData ? Number(token.uniqueBuyers5m) : NaN;
  const uniqueBuyerRatio = Number.isFinite(uniqueBuyers) && buys > 0 ? uniqueBuyers / buys : null;

  if (change5m >= 35 && txns < 40) flags.push("Extreme 5m price spike on limited trades");
  if (change5m >= 25 && txns < 10) flags.push("Sharp price move with very few transactions");
  if (txns >= 20 && (sells === 0 || buyShare >= 0.97)) flags.push("Near one-sided buy flow with no meaningful sell-side activity");
  else if (txns >= 20 && buyShare >= 0.93) flags.push("Highly one-sided buy flow");
  if (volumeLiquidity >= 2) flags.push("5m volume exceeds 2x pool liquidity");
  else if (volumeLiquidity >= 1.5) flags.push("5m turnover exceeds 1.5x pool liquidity");
  else if (change5m >= 20 && volumeLiquidity >= 0.75) flags.push("5m volume unusually high versus liquidity");
  if (txns >= 20 && uniqueBuyerRatio !== null && uniqueBuyerRatio < 0.15) {
    flags.push("Buy activity may be concentrated in very few wallets");
  } else if (txns >= 20 && uniqueBuyerRatio !== null && uniqueBuyerRatio < 0.25) {
    flags.push("Buyer breadth is weak relative to transaction count");
  }

  const severe = flags.some(flag => flag === "Extreme 5m price spike on limited trades" ||
    flag === "5m volume exceeds 2x pool liquidity");
  return {
    flags,
    suspectedArtificialPump: flags.length >= 2 || (severe && flags.length >= 1),
    volumeLiquidityRatio: Number(volumeLiquidity.toFixed(3)),
    uniqueBuyerRatio: uniqueBuyerRatio === null ? null : Number(uniqueBuyerRatio.toFixed(3))
  };
}

module.exports = { assessMarketRisk };
