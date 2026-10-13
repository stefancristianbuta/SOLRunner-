const express = require("express");
const path = require("path");
const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_MS = 30_000;
const MIN_LIQUIDITY_USD = 20_000;
const MAX_ADDRESSES = 240;
let cache = { at: 0, payload: null };
let lastError = null;
const telemetry = { lastRunAt: null, lastDurationMs: null, runs: 0, failures: 0, modules: {}, lastPipeline: {} };

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true, setHeaders(res, filePath) { if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate"); } }));
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const addressFromGeckoId = id => String(id || "").startsWith("solana_") ? String(id).slice(7) : "";

async function trackedFetch(moduleName, url, optional = false) {
  const start = Date.now();
  const entry = telemetry.modules[moduleName] || { calls: 0, successes: 0, failures: 0, lastMs: null, avgMs: null, lastStatus: "never", lastError: null };
  entry.calls++;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "SOLRunner/0.4" },
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
    if (optional) return null;
    throw error;
  }
}

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

async function loadCandidates() {
  const runStart = Date.now();
  telemetry.lastRunAt = new Date().toISOString();

  // Multi-signal discovery: new pools plus pools trending over 5m/1h and high-activity pools.
  // GeckoTerminal's public API is rate-limited, so keep discovery to four calls per refresh.
  const geckoResults = await Promise.all([
    trackedFetch("geckoterminal_new_pools", "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1", true),
    trackedFetch("geckoterminal_trending_5m", "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=5m", true),
    trackedFetch("geckoterminal_trending_1h", "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h", true),
    trackedFetch("geckoterminal_active_pools", "https://api.geckoterminal.com/api/v2/networks/solana/pools?sort=h24_tx_count_desc&page=1", true)
  ]);
  const geckoPools = geckoResults.flatMap((result, index) => Array.isArray(result?.data) ? result.data.map(pool => ({ ...pool, __solrunnerSource: ["geckoterminal_new_pool", "geckoterminal_trending_5m", "geckoterminal_trending_1h", "geckoterminal_active_pool"][index] })) : []);
  const geckoByAddress = new Map();
  for (const pool of geckoPools) {
    const attrs = pool.attributes || {};
    const rel = pool.relationships || {};
    const baseId = rel.base_token?.data?.id;
    const quoteId = rel.quote_token?.data?.id;
    const mint = addressFromGeckoId(baseId);
    if (!mint) continue;
    const createdAt = Date.parse(attrs.pool_created_at || "");
    const ageMin = Number.isFinite(createdAt) ? (Date.now() - createdAt) / 60000 : null;
    const reserveUsd = n(attrs.reserve_in_usd);
    if (ageMin !== null && ageMin >= 0 && reserveUsd >= MIN_LIQUIDITY_USD) {
      const source = pool.__solrunnerSource || "geckoterminal_pool";
      const old = geckoByAddress.get(mint);
      if (!old || reserveUsd > old.liquidityUsd) geckoByAddress.set(mint, {
        mint, pairAddress: attrs.address || String(pool.id || "").replace(/^solana_/, ""),
        ageMin, liquidityUsd: reserveUsd, name: attrs.name || "", dexId: rel.dex?.data?.id || "geckoterminal",
        volume5m: n(attrs.volume_usd?.m5), volume1h: n(attrs.volume_usd?.h1),
        volume6h: n(attrs.volume_usd?.h6), volume24h: n(attrs.volume_usd?.h24),
        change5m: n(attrs.price_change_percentage?.m5), change1h: n(attrs.price_change_percentage?.h1),
        change6h: n(attrs.price_change_percentage?.h6), change24h: n(attrs.price_change_percentage?.h24),
        txns: attrs.transactions || {}, poolCreatedAt: createdAt, source
      });
    }
  }

  const [profilesRaw, latestRaw, topRaw, searchSolUsdc, searchSolUsdt, searchSol] = await Promise.all([
    trackedFetch("token_profiles_latest", "https://api.dexscreener.com/token-profiles/latest/v1", true),
    trackedFetch("boosts_latest", "https://api.dexscreener.com/token-boosts/latest/v1", true),
    trackedFetch("boosts_top", "https://api.dexscreener.com/token-boosts/top/v1", true),
    trackedFetch("dex_search_sol_usdc", "https://api.dexscreener.com/latest/dex/search?q=SOL/USDC", true),
    trackedFetch("dex_search_sol_usdt", "https://api.dexscreener.com/latest/dex/search?q=SOL/USDT", true),
    trackedFetch("dex_search_sol", "https://api.dexscreener.com/latest/dex/search?q=SOL", true)
  ]);
  const profiles = (Array.isArray(profilesRaw) ? profilesRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const latest = (Array.isArray(latestRaw) ? latestRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const top = (Array.isArray(topRaw) ? topRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const tokenMetadata = new Map();
  for (const item of [...profiles, ...latest, ...top]) {
    if (!item?.tokenAddress) continue;
    const old = tokenMetadata.get(item.tokenAddress) || {};
    tokenMetadata.set(item.tokenAddress, { icon: item.icon || old.icon || null, header: item.header || old.header || null });
  }
  const sourceMap = new Map();
  const addSource = (address, source) => {
    if (!sourceMap.has(address)) sourceMap.set(address, new Set());
    sourceMap.get(address).add(source);
  };
  for (const [source, list] of [["profile", profiles], ["boost_latest", latest], ["boost_top", top]]) {
    for (const item of list) addSource(item.tokenAddress, source);
  }
  for (const address of geckoByAddress.keys()) addSource(address, "geckoterminal_pool");

  // Search-based fallback helps keep the feed populated when new/trending endpoints are sparse.
  // Search results are not trusted by themselves: all candidates still pass chain, pair, and liquidity checks.
  const searchPairs = [searchSolUsdc, searchSolUsdt, searchSol]
    .flatMap(result => Array.isArray(result?.pairs) ? result.pairs : [])
    .filter(pair => pair.chainId === "solana" && pair.baseToken?.address && pair.pairAddress);
  for (const pair of searchPairs) {
    addSource(pair.baseToken.address, "dexscreener_search");
    if (pair.quoteToken?.address) addSource(pair.quoteToken.address, "dexscreener_search");
  }

  // Prioritize tokens from newly created pools, then fill remaining capacity with DexScreener discovery.
  const geckoAddresses = [...geckoByAddress.keys()];
  const otherAddresses = [...sourceMap.keys()].filter(address => !geckoByAddress.has(address));
  const addresses = [...geckoAddresses, ...otherAddresses].slice(0, MAX_ADDRESSES);
  const pairBatches = await Promise.all(Array.from({ length: Math.ceil(addresses.length / 30) }, (_, i) =>
    trackedFetch("dexscreener_pairs_batch_" + (i + 1),
      "https://api.dexscreener.com/tokens/v1/solana/" + addresses.slice(i * 30, (i + 1) * 30).join(","), true)
  ));
  const enrichedPairs = pairBatches.flatMap(result => Array.isArray(result) ? result : []);
  // Merge direct search results as a fallback; de-duplicate by pair address.
  const pairMap = new Map();
  for (const pair of [...searchPairs, ...enrichedPairs]) {
    if (!pair?.pairAddress) continue;
    const old = pairMap.get(pair.pairAddress);
    if (!old || n(pair.liquidity?.usd) > n(old.liquidity?.usd)) pairMap.set(pair.pairAddress, pair);
  }
  const pairs = [...pairMap.values()];
  const now = Date.now();
  const best = new Map();
  const counts = {
    geckoPoolsReceived: geckoPools.length, geckoNewPoolsEligible: geckoByAddress.size, dexSearchPairs: searchPairs.length,
    profileTokens: profiles.length, latestBoostTokens: latest.length, topBoostTokens: top.length,
    uniqueAddresses: sourceMap.size, addressesRequested: addresses.length, pairsReceived: pairs.length,
    rejectedMissingFields: 0, rejectedFuture: 0, rejectedLowLiquidity: 0,
    eligiblePairs: 0, uniqueEligibleTokens: 0, fallbackGeckoTokens: 0
  };

  for (const pair of pairs) {
    if (!pair?.baseToken?.address || !pair?.pairAddress || !pair?.pairCreatedAt) { counts.rejectedMissingFields++; continue; }
    const ageMin = (now - n(pair.pairCreatedAt)) / 60000;
    const liquidity = n(pair.liquidity?.usd);
    if (ageMin < 0) { counts.rejectedFuture++; continue; }
    
    if (liquidity < MIN_LIQUIDITY_USD) { counts.rejectedLowLiquidity++; continue; }
    counts.eligiblePairs++;
    const mint = pair.baseToken.address, volume = pair.volume || {}, txns = pair.txns || {}, changes = pair.priceChange || {}, info = pair.info || {};
    const buys5 = n(txns.m5?.buys), sells5 = n(txns.m5?.sells);
    const geckoSignal = geckoByAddress.get(mint) || {};
    const geckoM5 = geckoSignal.txns?.m5 || {};
    const geckoH1 = geckoSignal.txns?.h1 || {};
    const candidate = {
      symbol: String(pair.baseToken.symbol || "UNKNOWN").slice(0, 24),
      name: String(pair.baseToken.name || pair.baseToken.symbol || "Unknown token").slice(0, 80),
      mint, pairAddress: pair.pairAddress, dexId: pair.dexId || "unknown", chainId: pair.chainId || "solana",
      url: pair.url || "https://dexscreener.com/solana/" + pair.pairAddress,
      imageUrl: info.imageUrl || tokenMetadata.get(mint)?.icon || null, header: info.header || tokenMetadata.get(mint)?.header || null, openGraph: info.openGraph || null,
      websites: (Array.isArray(info.websites) ? info.websites : []).slice(0, 8),
      socials: (Array.isArray(info.socials) ? info.socials : []).slice(0, 10),
      sources: [...(sourceMap.get(mint) || [])],
      ageMin: Math.round(ageMin * 10) / 10, pairCreatedAt: n(pair.pairCreatedAt),
      priceUsd: n(pair.priceUsd), priceNative: pair.priceNative || null, marketCapUsd: n(pair.marketCap), fdvUsd: n(pair.fdv),
      change5m: n(changes.m5), change1h: n(changes.h1), change6h: n(changes.h6), change24h: n(changes.h24),
      volume5m: n(volume.m5), volume1h: n(volume.h1), volume6h: n(volume.h6), volume24h: n(volume.h24),
      liquidityUsd: liquidity, buys5m: buys5, sells5m: sells5, txns5m: buys5 + sells5,
      uniqueBuyers5m: n(geckoM5.buyers) || null, uniqueSellers5m: n(geckoM5.sellers) || null,
      uniqueBuyers1h: n(geckoH1.buyers) || null, uniqueSellers1h: n(geckoH1.sellers) || null,
      buys1h: n(txns.h1?.buys), sells1h: n(txns.h1?.sells), txns1h: n(txns.h1?.buys) + n(txns.h1?.sells),
      buys6h: n(txns.h6?.buys), sells6h: n(txns.h6?.sells), txns6h: n(txns.h6?.buys) + n(txns.h6?.sells),
      buys24h: n(txns.h24?.buys), sells24h: n(txns.h24?.sells), txns24h: n(txns.h24?.buys) + n(txns.h24?.sells),
      buySellRatio: Number(((buys5 + 1) / (sells5 + 1)).toFixed(2)),
      score: scorePair(pair, ageMin, liquidity, n(volume.m5), buys5, sells5, { buyers: geckoM5.buyers, sellers: geckoM5.sellers }),
      riskStatus: "UNVERIFIED", smartMoney: "NOT VERIFIED", holderCount: null,
      reasons: ["Discovered from live pool/token feeds", buys5 > sells5 ? "More buys than sells in the last 5 minutes" : "Buy pressure is not confirmed", "Security and wallet attribution are not audited by this feed"]
    };
    const old = best.get(mint);
    if (!old || candidate.liquidityUsd > old.liquidityUsd) best.set(mint, candidate);
  }

  // If DexScreener has not indexed a freshly-created pool yet, preserve its GeckoTerminal data.
  for (const [mint, g] of geckoByAddress) {
    if (best.has(mint)) continue;
    const tx = g.txns || {};
    const buys5 = n(tx.m5?.buys), sells5 = n(tx.m5?.sells);
    const pairLike = { priceChange: { m5: g.change5m } };
    const score = scorePair(pairLike, g.ageMin, g.liquidityUsd, g.volume5m, buys5, sells5, { buyers: tx.m5?.buyers, sellers: tx.m5?.sellers });
    best.set(mint, {
      symbol: "NEW", name: g.name.split(" / ")[0] || "New Solana token", mint,
      pairAddress: g.pairAddress, dexId: g.dexId, chainId: "solana",
      url: "https://www.geckoterminal.com/solana/pools/" + g.pairAddress,
      imageUrl: tokenMetadata.get(mint)?.icon || null, header: tokenMetadata.get(mint)?.header || null, websites: [], socials: [], sources: ["geckoterminal_new_pool"],
      ageMin: Math.round(g.ageMin * 10) / 10, pairCreatedAt: g.poolCreatedAt,
      priceUsd: 0, priceNative: null, marketCapUsd: 0, fdvUsd: 0,
      change5m: g.change5m, change1h: g.change1h, change6h: g.change6h, change24h: g.change24h,
      volume5m: g.volume5m, volume1h: g.volume1h, volume6h: g.volume6h, volume24h: g.volume24h,
      liquidityUsd: g.liquidityUsd, buys5m: buys5, sells5m: sells5, txns5m: buys5 + sells5,
      uniqueBuyers5m: n(tx.m5?.buyers) || null, uniqueSellers5m: n(tx.m5?.sellers) || null,
      uniqueBuyers1h: n(tx.h1?.buyers) || null, uniqueSellers1h: n(tx.h1?.sellers) || null,
      buys1h: n(tx.h1?.buys), sells1h: n(tx.h1?.sells), txns1h: n(tx.h1?.buys) + n(tx.h1?.sells),
      buys6h: n(tx.h6?.buys), sells6h: n(tx.h6?.sells), txns6h: n(tx.h6?.buys) + n(tx.h6?.sells),
      buys24h: n(tx.h24?.buys), sells24h: n(tx.h24?.sells), txns24h: n(tx.h24?.buys) + n(tx.h24?.sells),
      buySellRatio: Number(((buys5 + 1) / (sells5 + 1)).toFixed(2)), score,
      riskStatus: "UNVERIFIED", smartMoney: "NOT VERIFIED", holderCount: null,
      reasons: ["Fresh pool discovered by GeckoTerminal", "DexScreener pair metadata not indexed yet; price fields may be incomplete", "Security and sellability not verified"]
    });
    counts.fallbackGeckoTokens++;
  }

  const tokens = [...best.values()].sort((a, b) => b.score - a.score);
  counts.uniqueEligibleTokens = tokens.length;
  telemetry.lastDurationMs = Date.now() - runStart;
  telemetry.runs++;
  telemetry.lastPipeline = counts;
  return tokens;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "SOLRunner", dataProvider: "GeckoTerminal discovery + DexScreener search/market APIs", cached: Boolean(cache.payload), lastUpdated: cache.at || null }));
app.get("/api/tokens", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (cache.payload && Date.now() - cache.at < CACHE_MS) return res.json({ ...cache.payload, cached: true });
  try {
    const tokens = await loadCandidates();
    cache = { at: Date.now(), payload: { ok: true, source: "GeckoTerminal new/trending/active pools + DexScreener search and market APIs", updatedAt: new Date().toISOString(), count: tokens.length, filters: { chain: "solana", minLiquidityUsd: MIN_LIQUIDITY_USD }, tokens } };
    lastError = null;
    return res.json({ ...cache.payload, cached: false });
  } catch (error) {
    lastError = String(error.message || error); telemetry.failures++;
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
