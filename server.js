const express = require("express");
const path = require("path");
const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_MS = 60_000;
const GECKO_MIN_INTERVAL_MS = 1_500;
let lastGeckoRequestAt = 0;
const MIN_LIQUIDITY_USD = 20_000;
const MAX_ADDRESSES = 240;
const SECURITY_CACHE_MS = 10 * 60_000;
const SECURITY_SCAN_LIMIT = 8;
const securityCache = new Map();
let cache = { at: 0, payload: null };
let refreshInFlight = null;
let lastError = null;
const telemetry = { lastRunAt: null, lastDurationMs: null, runs: 0, failures: 0, modules: {}, lastPipeline: {} };

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true, setHeaders(res, filePath) { if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate"); } }));
const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const addressFromGeckoId = id => String(id || "").startsWith("solana_") ? String(id).slice(7) : "";

async function trackedFetch(moduleName, url, optional = false) {
  // GeckoTerminal public API: spread requests out instead of firing a burst of four at once.
  if (url.startsWith("https://api.geckoterminal.com/")) {
    const waitMs = Math.max(0, lastGeckoRequestAt + GECKO_MIN_INTERVAL_MS - Date.now());
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastGeckoRequestAt = Date.now();
  }
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

const { scorePair } = require("./lib/score");
const { createPerformanceTracker } = require("./lib/performance");
const { assessMarketRisk } = require("./lib/risk");
const performanceTracker = createPerformanceTracker();

async function applySecurityChecks(tokens) {
  const selected = tokens.slice(0, SECURITY_SCAN_LIMIT);
  for (let offset = 0; offset < selected.length; offset += 8) {
    const batch = selected.slice(offset, offset + 8);
    await Promise.all(batch.map(async token => {
      let cached = securityCache.get(token.mint);
      if (!cached || Date.now() - cached.at >= SECURITY_CACHE_MS) {
        const report = await trackedFetch("rugcheck_radar", "https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(token.mint) + "/report/summary", true);
        cached = { at: Date.now(), report };
        securityCache.set(token.mint, cached);
      }
      const report = cached.report;
      token.securityCheckedAt = report ? new Date(cached.at).toISOString() : null;
      token.securityStatus = report ? "CLEAR" : "UNAVAILABLE";
      token.securityScore = Number.isFinite(Number(report?.score_normalised)) ? Number(report.score_normalised) : null;
      const risks = Array.isArray(report?.risks) ? report.risks : [];
      const flags = risks.map(r => String(r.name || "RugCheck risk")).filter(Boolean);
      const critical = Boolean(report?.rugged) ||
        risks.some(r => /danger|critical|high/i.test(String(r.level || ""))) ||
        risks.some(r => /rugged|honeypot|mint authority|freeze authority/i.test(String(r.name || ""))) ||
        (token.securityScore !== null && token.securityScore >= 70);
      if (report) token.securityStatus = critical ? "HIGH_RISK" : (risks.length || (token.securityScore !== null && token.securityScore >= 35) ? "CAUTION" : "CLEAR");
      token.securityFlags = flags;
      token.riskFlags = [...new Set([...(token.riskFlags || []), ...flags])];
      if (critical) {
        token.suspectedArtificialPump = true;
        token.riskStatus = "HIGH_RISK";
        token.reasons = [...(token.reasons || []), "RugCheck reported high-risk security signals"];
      }
    }));
  }
  return tokens;
}

async function loadCandidates() {
  const runStart = Date.now();
  telemetry.lastRunAt = new Date().toISOString();

  // Multi-signal discovery: new pools plus pools trending over 5m/1h and high-activity pools.
  // GeckoTerminal's public API is rate-limited, so keep discovery to four calls per refresh.
  const geckoResults = await Promise.all([
    trackedFetch("geckoterminal_new_pools", "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1&include=base_token", true),
    trackedFetch("geckoterminal_trending_5m", "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=5m&include=base_token", true),
    trackedFetch("geckoterminal_trending_1h", "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h&include=base_token", true),
    trackedFetch("geckoterminal_active_pools", "https://api.geckoterminal.com/api/v2/networks/solana/pools?sort=h24_tx_count_desc&page=1&include=base_token", true)
  ]);
  const geckoPools = geckoResults.flatMap((result, index) => Array.isArray(result?.data) ? result.data.map(pool => ({ ...pool, __included: Array.isArray(result.included) ? result.included : [], __solrunnerSource: ["geckoterminal_new_pool", "geckoterminal_trending_5m", "geckoterminal_trending_1h", "geckoterminal_active_pool"][index] })) : []);
  const geckoByAddress = new Map();
  for (const pool of geckoPools) {
    const attrs = pool.attributes || {};
    const rel = pool.relationships || {};
    const baseId = rel.base_token?.data?.id;
    const quoteId = rel.quote_token?.data?.id;
    const mint = addressFromGeckoId(baseId);
    const includedBaseToken = (pool.__included || []).find(item => item?.id === baseId && item?.type === "token");
    const geckoIcon = includedBaseToken?.attributes?.image_url || includedBaseToken?.attributes?.imageUrl || null;
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
        imageUrl: geckoIcon, volume5m: n(attrs.volume_usd?.m5), volume1h: n(attrs.volume_usd?.h1),
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
  if (geckoResults.every(result => result === null) && [profilesRaw, latestRaw, topRaw, searchSolUsdc, searchSolUsdt, searchSol].every(result => result === null)) {
    throw new Error("All discovery providers are unavailable");
  }
  const profiles = (Array.isArray(profilesRaw) ? profilesRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const latest = (Array.isArray(latestRaw) ? latestRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const top = (Array.isArray(topRaw) ? topRaw : []).filter(x => x.chainId === "solana" && x.tokenAddress);
  const tokenMetadata = new Map();
  // Seed logo metadata from GeckoTerminal first; DexScreener fills only missing logos.
  for (const [mint, pool] of geckoByAddress) {
    if (pool.imageUrl) tokenMetadata.set(mint, { icon: pool.imageUrl, header: null });
  }
  for (const item of [...profiles, ...latest, ...top]) {
    if (!item?.tokenAddress) continue;
    const old = tokenMetadata.get(item.tokenAddress) || {};
    tokenMetadata.set(item.tokenAddress, { icon: old.icon || item.icon || null, header: old.header || item.header || null });
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
    const marketRisk = assessMarketRisk({ change5m: n(changes.m5), volume5m: n(volume.m5), liquidityUsd: liquidity, buys5m: buys5, sells5m: sells5, txns5m: buys5 + sells5, uniqueBuyers5m: n(geckoM5.buyers) || null });
    const candidate = {
      symbol: String(pair.baseToken.symbol || "UNKNOWN").slice(0, 24),
      name: String(pair.baseToken.name || pair.baseToken.symbol || "Unknown token").slice(0, 80),
      mint, pairAddress: pair.pairAddress, dexId: pair.dexId || "unknown", chainId: pair.chainId || "solana",
      url: pair.url || "https://dexscreener.com/solana/" + pair.pairAddress,
      imageUrl: tokenMetadata.get(mint)?.icon || info.imageUrl || null, header: tokenMetadata.get(mint)?.header || info.header || null, openGraph: info.openGraph || null,
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
      organicDataCoverage: (n(changes.m5) !== 0 ? 1 : 0) + (n(changes.h1) !== 0 ? 1 : 0) + ((buys5 + sells5) > 0 ? 1 : 0) + (n(volume.m5) > 0 ? 1 : 0) + (n(txns.h1?.buys) + n(txns.h1?.sells) > 0 ? 1 : 0) + (n(geckoM5.buyers) > 0 ? 1 : 0),
      organicStatus: "ASSESSING",
      riskStatus: marketRisk.suspectedArtificialPump ? "SUSPECTED_PUMP" : "UNVERIFIED", riskFlags: marketRisk.flags, suspectedArtificialPump: marketRisk.suspectedArtificialPump, volumeLiquidityRatio: marketRisk.volumeLiquidityRatio, smartMoney: "NOT VERIFIED", holderCount: null,
      reasons: ["Discovered from live pool/token feeds", buys5 > sells5 ? "More buys than sells in the last 5 minutes" : "Buy pressure is not confirmed", ...marketRisk.flags, "On-chain security report is not part of the radar feed"]
    };
    candidate.organicStatus = candidate.suspectedArtificialPump ? "FLAGGED" :
      candidate.score >= 72 && candidate.organicDataCoverage >= 4 && candidate.txns5m >= 12 && candidate.txns1h >= 40 ? "STRONG SIGNAL" :
      candidate.score >= 58 && candidate.organicDataCoverage >= 3 ? "WATCH" : "INSUFFICIENT DATA";
    candidate.reasons.push(candidate.organicStatus === "STRONG SIGNAL" ? "Sustained momentum and activity meet the radar's organic-signal heuristic" :
      candidate.organicStatus === "INSUFFICIENT DATA" ? "Insufficient market data/activity for a stronger organic-momentum signal" :
      candidate.organicStatus === "WATCH" ? "Some momentum signals present; organic demand not yet strongly supported" : "Risk pattern or insufficient evidence prevents a strong organic label");
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
    const marketRisk = assessMarketRisk({ change5m: g.change5m, volume5m: g.volume5m, liquidityUsd: g.liquidityUsd, buys5m: buys5, sells5m: sells5, txns5m: buys5 + sells5, uniqueBuyers5m: tx.m5?.buyers });
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
      riskStatus: marketRisk.suspectedArtificialPump ? "SUSPECTED_PUMP" : "UNVERIFIED", riskFlags: marketRisk.flags, suspectedArtificialPump: marketRisk.suspectedArtificialPump, volumeLiquidityRatio: marketRisk.volumeLiquidityRatio, smartMoney: "NOT VERIFIED", holderCount: null,
      reasons: ["Fresh pool discovered by GeckoTerminal", "DexScreener pair metadata not indexed yet; price fields may be incomplete", ...marketRisk.flags, "Security and sellability not verified"]
    });
    counts.fallbackGeckoTokens++;
  }

  const tokens = [...best.values()].sort((a, b) => b.score - a.score);
  // Keep radar refresh independent of the optional RugCheck API. Token scans call RugCheck on demand.
  counts.securityScanned = 0;
  counts.securityHighRisk = 0;
  counts.suspectedPumpPatterns = tokens.filter(token => token.suspectedArtificialPump).length;
  counts.uniqueEligibleTokens = tokens.length;
  performanceTracker.observe(tokens);
  counts.tokensWithLogo = tokens.filter(token => Boolean(token.imageUrl)).length;
  counts.tokensWithoutLogo = tokens.length - counts.tokensWithLogo;
  counts.logoCoveragePct = tokens.length ? Math.round((counts.tokensWithLogo / tokens.length) * 100) : 0;
  telemetry.lastDurationMs = Date.now() - runStart;
  telemetry.runs++;
  telemetry.lastPipeline = counts;
  return tokens;
}

app.get("/api/scan", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const mint = String(req.query.mint || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ ok: false, error: "Enter a valid Solana mint address (base58, 32–44 characters)." });
  }
  const [rugReport, pairData] = await Promise.all([
    trackedFetch("rugcheck_scan", "https://api.rugcheck.xyz/v1/tokens/" + encodeURIComponent(mint) + "/report/summary", true),
    trackedFetch("dexscreener_scan", "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(mint), true)
  ]);
  const pairs = Array.isArray(pairData?.pairs) ? pairData.pairs.filter(pair => pair.chainId === "solana" && pair.baseToken?.address === mint) : [];
  pairs.sort((a, b) => n(b.liquidity?.usd) - n(a.liquidity?.usd));
  const pair = pairs[0] || null;
  const marketRisk = pair ? assessMarketRisk({
    change5m: pair.priceChange?.m5, volume5m: pair.volume?.m5, liquidityUsd: pair.liquidity?.usd,
    buys5m: pair.txns?.m5?.buys, sells5m: pair.txns?.m5?.sells,
    txns5m: n(pair.txns?.m5?.buys) + n(pair.txns?.m5?.sells)
  }) : { flags: [], suspectedArtificialPump: false, volumeLiquidityRatio: null };
  const risks = Array.isArray(rugReport?.risks) ? rugReport.risks.map(r => ({
    name: String(r.name || "Risk flag"), level: String(r.level || "unknown"),
    description: String(r.description || ""), value: String(r.value || "")
  })) : [];
  const normalizedScore = Number.isFinite(Number(rugReport?.score_normalised)) ? Number(rugReport.score_normalised) : null;
  const critical = risks.some(r => /danger|critical|high/i.test(r.level)) ||
    risks.some(r => /rugged|honeypot|mint authority|freeze authority/i.test(r.name));
  const rugStatus = rugReport ? (rugReport.rugged || critical || (normalizedScore !== null && normalizedScore >= 70) ? "HIGH RISK" : (normalizedScore !== null && normalizedScore >= 35 || risks.length ? "CAUTION" : "NO MAJOR FLAGS REPORTED")) : "UNAVAILABLE";
  return res.json({
    ok: true, mint, scannedAt: new Date().toISOString(),
    token: pair ? {
      name: pair.baseToken?.name || "Unknown token", symbol: pair.baseToken?.symbol || "UNKNOWN",
      priceUsd: n(pair.priceUsd), change5m: n(pair.priceChange?.m5), change1h: n(pair.priceChange?.h1),
      liquidityUsd: n(pair.liquidity?.usd), volume5m: n(pair.volume?.m5), volume24h: n(pair.volume?.h24),
      buys5m: n(pair.txns?.m5?.buys), sells5m: n(pair.txns?.m5?.sells), url: pair.url || "https://dexscreener.com/solana/" + (pair.pairAddress || mint)
    } : null,
    marketRisk,
    security: {
      status: rugStatus, available: Boolean(rugReport), normalizedScore,
      rawScore: Number.isFinite(Number(rugReport?.score)) ? Number(rugReport.score) : null,
      rugged: typeof rugReport?.rugged === "boolean" ? rugReport.rugged : null,
      risks, liquidityLockedPct: Number.isFinite(Number(rugReport?.lpLockedPct)) ? Number(rugReport.lpLockedPct) : null,
      note: rugReport ? "RugCheck summary; a clean report does not guarantee safety." : "RugCheck report unavailable; do not treat this token as verified safe."
    },
    sources: { rugcheck: "https://rugcheck.xyz/tokens/" + mint, dexscreener: "https://dexscreener.com/solana/" + mint }
  });
});
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "SOLRunner", dataProvider: "GeckoTerminal discovery + DexScreener search/market APIs", cached: Boolean(cache.payload), lastUpdated: cache.at || null }));
app.get("/api/tokens", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  if (cache.payload && Date.now() - cache.at < CACHE_MS) return res.json({ ...cache.payload, cached: true });
  try {
    if (!refreshInFlight) {
      refreshInFlight = loadCandidates().then(tokens => {
        cache = { at: Date.now(), payload: { ok: true, source: "GeckoTerminal new/trending/active pools + DexScreener search and market APIs", updatedAt: new Date().toISOString(), count: tokens.length, filters: { chain: "solana", minLiquidityUsd: MIN_LIQUIDITY_USD }, tokens } };
        lastError = null;
        return cache.payload;
      }).finally(() => { refreshInFlight = null; });
    }
    const payload = await refreshInFlight;
    return res.json({ ...payload, cached: true });
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
  modules: telemetry.modules, pipeline: telemetry.lastPipeline, performance: performanceTracker.snapshot()
}));
app.get("/api/status", (_req, res) => res.json({ ok: true, lastUpdated: cache.at ? new Date(cache.at).toISOString() : null, lastError, hasSnapshot: Boolean(cache.payload) }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, "0.0.0.0", () => console.log("SOLRunner listening on port " + PORT));
