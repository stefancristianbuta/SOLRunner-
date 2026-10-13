const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_MS = 12_000;
let cache = { at: 0, payload: null };
let lastError = null;

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "accept": "application/json", "user-agent": "SOLRunner/0.1" },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error("Market data provider returned HTTP " + response.status);
  return response.json();
}
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function scorePair(pair, ageMin, liquidity, volume, buys, sells) {
  const total = buys + sells;
  const buyShare = total ? buys / total : 0;
  const volumeLiquidity = volume / Math.max(liquidity, 1);
  const activity = clamp(Math.log10(total + 1) / 2.4, 0, 1);
  const liquidityQuality = clamp(Math.log10(liquidity / 20000 + 1) / 1.2, 0, 1);
  const momentum = clamp((n(pair.priceChange?.m5) + 10) / 40, 0, 1);
  const freshness = clamp(1 - ageMin / 30, 0, 1);
  const buyPressure = clamp((buyShare - 0.35) / 0.5, 0, 1);
  const volPulse = clamp(volumeLiquidity / 2, 0, 1);
  return Math.round(
    buyPressure * 25 +
    (volPulse * 0.6 + activity * 0.4) * 25 +
    liquidityQuality * 20 +
    freshness * 10 +
    momentum * 10 +
    (total >= 20 ? 10 : total / 2)
  );
}
async function loadCandidates() {
  const [profiles, boosts] = await Promise.all([
    fetchJson("https://api.dexscreener.com/token-profiles/latest/v1"),
    fetchJson("https://api.dexscreener.com/token-boosts/latest/v1").catch(() => [])
  ]);
  const solanaProfiles = (Array.isArray(profiles) ? profiles : [])
    .filter(x => x.chainId === "solana" && x.tokenAddress);
  const solanaBoosts = (Array.isArray(boosts) ? boosts : [])
    .filter(x => x.chainId === "solana" && x.tokenAddress);
  const addresses = [...new Set([...solanaProfiles, ...solanaBoosts].map(x => x.tokenAddress))].slice(0, 30);
  if (!addresses.length) return [];
  const pairSets = await Promise.all(
    Array.from({ length: Math.ceil(addresses.length / 30) }, (_, i) =>
      fetchJson("https://api.dexscreener.com/tokens/v1/solana/" + addresses.slice(i * 30, (i + 1) * 30).join(","))
        .catch(() => [])
    )
  );
  const now = Date.now();
  const best = new Map();
  for (const pair of pairSets.flat()) {
    if (!pair?.baseToken?.address || !pair?.pairAddress || !pair?.pairCreatedAt) continue;
    const ageMin = (now - n(pair.pairCreatedAt)) / 60000;
    const liquidity = n(pair.liquidity?.usd);
    const volume5m = n(pair.volume?.m5);
    const buys = n(pair.txns?.m5?.buys);
    const sells = n(pair.txns?.m5?.sells);
    if (ageMin < 0 || ageMin > 30 || liquidity < 20000) continue;
    const mint = pair.baseToken.address;
    const candidate = {
      symbol: String(pair.baseToken.symbol || "UNKNOWN").slice(0, 20),
      name: String(pair.baseToken.name || pair.baseToken.symbol || "Unknown token").slice(0, 50),
      mint,
      pairAddress: pair.pairAddress,
      dexId: pair.dexId || "unknown",
      url: pair.url || "https://dexscreener.com/solana/" + pair.pairAddress,
      ageMin: Math.round(ageMin * 10) / 10,
      priceUsd: n(pair.priceUsd),
      change5m: n(pair.priceChange?.m5),
      change1h: n(pair.priceChange?.h1),
      volume5m,
      volume1h: n(pair.volume?.h1),
      liquidityUsd: liquidity,
      buys5m: buys,
      sells5m: sells,
      buySellRatio: Number(((buys + 1) / (sells + 1)).toFixed(2)),
      txns5m: buys + sells,
      score: scorePair(pair, ageMin, liquidity, volume5m, buys, sells),
      riskStatus: "UNVERIFIED",
      smartMoney: "NOT VERIFIED",
      holderCount: null,
      reasons: [
        "Live DEX market activity",
        buys > sells ? "More buys than sells in the last 5 minutes" : "Buy pressure is not confirmed",
        "Token security and wallet attribution have not been audited"
      ]
    };
    const old = best.get(mint);
    if (!old || candidate.liquidityUsd > old.liquidityUsd) best.set(mint, candidate);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "SOLRunner", dataProvider: "DexScreener", cached: Boolean(cache.payload), lastUpdated: cache.at || null }));
app.get("/api/tokens", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (cache.payload && Date.now() - cache.at < CACHE_MS) {
    return res.json({ ...cache.payload, cached: true });
  }
  try {
    const tokens = await loadCandidates();
    cache = { at: Date.now(), payload: { ok: true, source: "DexScreener public API", updatedAt: new Date().toISOString(), count: tokens.length, filters: { chain: "solana", maxAgeMinutes: 30, minLiquidityUsd: 20000 }, tokens } };
    lastError = null;
    return res.json({ ...cache.payload, cached: false });
  } catch (error) {
    lastError = String(error.message || error);
    if (cache.payload) return res.status(200).json({ ...cache.payload, stale: true, warning: "Live refresh failed; showing last successful snapshot." });
    return res.status(502).json({ ok: false, error: "Live market feed unavailable", detail: lastError, tokens: [], count: 0 });
  }
});
app.get("/api/status", (_req, res) => res.json({ ok: true, lastUpdated: cache.at ? new Date(cache.at).toISOString() : null, lastError, hasSnapshot: Boolean(cache.payload) }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, "0.0.0.0", () => console.log("SOLRunner listening on port " + PORT));