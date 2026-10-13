const express = require("express");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_MS = 12_000;
let cache = { at: 0, payload: null };
let lastError = null;
const telemetry = {
  startedAt: new Date().toISOString(),
  lastRunAt: null,
  lastDurationMs: null,
  runs: 0,
  failures: 0,
  modules: {},
  lastPipeline: {}
};

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
async function trackedFetch(moduleName, url, optional = false) {
  const start = Date.now();
  const entry = telemetry.modules[moduleName] || { calls: 0, successes: 0, failures: 0, lastMs: null, avgMs: null, lastStatus: "never", lastError: null };
  entry.calls++;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "SOLRunner/0.2" },
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const ms = Date.now() - start;
    entry.successes++;
    entry.lastMs = ms;
    entry.avgMs = Math.round((((entry.avgMs || 0) * (entry.successes - 1)) + ms) / entry.successes);
    entry.lastStatus = "ok";
    entry.lastError = null;
    telemetry.modules[moduleName] = entry;
    return data;
  } catch (error) {
    entry.failures++;
    entry.lastMs = Date.now() - start;
    entry.lastStatus = optional ? "degraded" : "error";
    entry.lastError = String(error.message || error);
    telemetry.modules[moduleName] = entry;
    if (optional) return [];
    throw error;
  }
}

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
  return Math.round(buyPressure * 25 + (volPulse * 0.6 + activity * 0.4) * 25 + liquidityQuality * 20 + freshness * 10 + momentum * 10 + (total >= 20 ? 10 : total / 2));
}

async function loadCandidates() {
  const runStart = Date.now();
  telemetry.lastRunAt = new Date().toISOString();
  const [profilesRaw, latestRaw, topRaw] = await Promise.all([
    trackedFetch("token_profiles_latest", "https://api.dexscreener.com/token-profiles/latest/v1"),
    trackedFetch("boosts_latest", "https://api.dexscreener.com/token-boosts/latest/v1", true),
    trackedFetch("boosts_top", "https://api.dexscreener.com/token-boosts/top/v1", true)
  ]);
  const profiles = (Array.isArray(profilesRaw) ? profilesRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const latest = (Array.isArray(latestRaw) ? latestRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const top = (Array.isArray(topRaw) ? topRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const addressSources = new Map();
  for (const [source, list] of [["profile", profiles], ["boost_latest", latest], ["boost_top", top]]) {
    for (const item of list) {
      const address = item.tokenAddress;
      if (!addressSources.has(address)) addressSources.set(address, new Set());
      addressSources.get(address).add(source);
    }
  }
  // Pull a wider set than the original 30-address cap. DexScreener's token endpoint accepts batches of up to 30.
  const addresses = [...addressSources.keys()].slice(0, 180);
  const pairBatches = await Promise.all(
    Array.from({ length: Math.ceil(addresses.length / 30) }, (_, i) =>
      trackedFetch("pair_batch_" + (i + 1), "https://api.dexscreener.com/tokens/v1/solana/" + addresses.slice(i * 30, (i + 1) * 30).join(","), true)
    )
  );
  const pairs = pairBatches.flat().filter(Boolean);
  const now = Date.now();
  const best = new Map();
  const counts = { profileTokens: profiles.length, latestBoostTokens: latest.length, topBoostTokens: top.length, uniqueAddresses: addressSources.size, addressesRequested: addresses.length, pairsReceived: pairs.length, rejectedMissingFields: 0, rejectedTooOld: 0, rejectedFuture: 0, rejectedLowLiquidity: 0, eligiblePairs: 0, uniqueEligibleTokens: 0 };
  for (const pair of pairs) {
    if (!pair?.baseToken?.address || !pair?.pairAddress || !pair?.pairCreatedAt) {
      counts.rejectedMissingFields++;
      continue;
    }
    const ageMin = (now - n(pair.pairCreatedAt)) / 60000;
    const liquidity = n(pair.liquidity?.usd);
    if (ageMin < 0) { counts.rejectedFuture++; continue; }
    if (ageMin > 30) { counts.rejectedTooOld++; continue; }
    if (liquidity < 20000) { counts.rejectedLowLiquidity++; continue; }
    counts.eligiblePairs++;
    const mint = pair.baseToken.address;
    const volume = pair.volume || {};
    const txns = pair.txns || {};
    const changes = pair.priceChange || {};
    const buys5 = n(txns.m5?.buys), sells5 = n(txns.m5?.sells);
    const info = pair.info || {};
    const socials = Array.isArray(info.socials) ? info.socials : [];
    const websites = Array.isArray(info.websites) ? info.websites : [];
    const sources = [...(addressSources.get(mint) || [])];
    const candidate = {
      symbol: String(pair.baseToken.symbol || "UNKNOWN").slice(0, 24),
      name: String(pair.baseToken.name || pair.baseToken.symbol || "Unknown token").slice(0, 80),
      mint,
      pairAddress: pair.pairAddress,
      dexId: pair.dexId || "unknown",
      chainId: pair.chainId || "solana",
      url: pair.url || "https://dexscreener.com/solana/" + pair.pairAddress,
      imageUrl: info.imageUrl || null,
      header: info.header || null,
      openGraph: info.openGraph || null,
      websites: websites.slice(0, 8),
      socials: socials.slice(0, 10),
      sources,
      ageMin: Math.round(ageMin * 10) / 10,
      pairCreatedAt: n(pair.pairCreatedAt),
      priceUsd: n(pair.priceUsd),
      priceNative: pair.priceNative || null,
      marketCapUsd: n(pair.marketCap),
      fdvUsd: n(pair.fdv),
      change5m: n(changes.m5), change1h: n(changes.h1), change6h: n(changes.h6), change24h: n(changes.h24),
      volume5m: n(volume.m5), volume1h: n(volume.h1), volume6h: n(volume.h6), volume24h: n(volume.h24),
      liquidityUsd: liquidity,
      buys5m: buys5, sells5m: sells5, txns5m: buys5 + sells5,
      buys1h: n(txns.h1?.buys), sells1h: n(txns.h1?.sells), txns1h: n(txns.h1?.buys) + n(txns.h1?.sells),
      buys6h: n(txns.h6?.buys), sells6h: n(txns.h6?.sells), txns6h: n(txns.h6?.buys) + n(txns.h6?.sells),
      buys24h: n(txns.h24?.buys), sells24h: n(txns.h24?.sells), txns24h: n(txns.h24?.buys) + n(txns.h24?.sells),
      buySellRatio: Number(((buys5 + 1) / (sells5 + 1)).toFixed(2)),
      score: scorePair(pair, ageMin, liquidity, n(volume.m5), buys5, sells5),
      riskStatus: "UNVERIFIED",
      smartMoney: "NOT VERIFIED",
      holderCount: null,
      reasons: ["Live DEX market activity", buys5 > sells5 ? "More buys than sells in the last 5 minutes" : "Buy pressure is not confirmed", "Security and wallet attribution are not audited by this feed"]
    };
    const old = best.get(mint);
    if (!old || candidate.liquidityUsd > old.liquidityUsd) best.set(mint, candidate);
  }
  const tokens = [...best.values()].sort((a, b) => b.score - a.score);
  counts.uniqueEligibleTokens = tokens.length;
  telemetry.lastDurationMs = Date.now() - runStart;
  telemetry.runs++;
  telemetry.lastPipeline = counts;
  return tokens;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "SOLRunner", dataProvider: "DexScreener", cached: Boolean(cache.payload), lastUpdated: cache.at || null }));
app.get("/api/tokens", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (cache.payload && Date.now() - cache.at < CACHE_MS) return res.json({ ...cache.payload, cached: true });
  try {
    const tokens = await loadCandidates();
    cache = { at: Date.now(), payload: { ok: true, source: "DexScreener public API", updatedAt: new Date().toISOString(), count: tokens.length, filters: { chain: "solana", maxAgeMinutes: 30, minLiquidityUsd: 20000 }, tokens } };
    lastError = null;
    return res.json({ ...cache.payload, cached: false });
  } catch (error) {
    lastError = String(error.message || error);
    telemetry.failures++;
    if (cache.payload) return res.status(200).json({ ...cache.payload, stale: true, warning: "Live refresh failed; showing last successful snapshot." });
    return res.status(502).json({ ok: false, error: "Live market feed unavailable", detail: lastError, tokens: [], count: 0 });
  }
});
app.get("/api/telemetry", (_req, res) => res.json({
  ok: true, generatedAt: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()),
  cache: { ageSeconds: cache.at ? Math.round((Date.now() - cache.at) / 1000) : null, hasSnapshot: Boolean(cache.payload), tokenCount: cache.payload?.count || 0 },
  refresh: { runs: telemetry.runs, failures: telemetry.failures, lastRunAt: telemetry.lastRunAt, lastDurationMs: telemetry.lastDurationMs, lastError },
  modules: telemetry.modules, pipeline: telemetry.lastPipeline
}));
app.get("/api/status", (_req, res) => res.json({ ok: true, lastUpdated: cache.at ? new Date(cache.at).toISOString() : null, lastError, hasSnapshot: Boolean(cache.payload) }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, "0.0.0.0", () => console.log("SOLRunner listening on port " + PORT));
