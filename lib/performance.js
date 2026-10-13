const HORIZONS_MS = { fiveMinutes: 5 * 60_000, fifteenMinutes: 15 * 60_000 };
const MAX_TRACKED_MINTS = 2000;

function createPerformanceTracker() {
  const samples = new Map();
  const completed = { fiveMinutes: [], fifteenMinutes: [] };

  function observe(tokens, now = Date.now()) {
    for (const token of tokens) {
      const mint = token.mint;
      const price = Number(token.priceUsd);
      if (!mint || !Number.isFinite(price) || price <= 0) continue;
      let sample = samples.get(mint);
      if (!sample) {
        sample = { mint, score: Number(token.score) || 0, price, observedAt: now, due: {} };
        for (const [horizon, duration] of Object.entries(HORIZONS_MS)) sample.due[horizon] = now + duration;
        samples.set(mint, sample);
      }
      for (const [horizon, duration] of Object.entries(HORIZONS_MS)) {
        if (sample.due[horizon] && now >= sample.due[horizon]) {
          const changePct = ((price - sample.price) / sample.price) * 100;
          completed[horizon].push({ score: sample.score, changePct, observedAt: now });
          if (completed[horizon].length > 5000) completed[horizon].shift();
          sample.due[horizon] = 0;
        }
      }
    }
    if (samples.size > MAX_TRACKED_MINTS) {
      const oldest = [...samples.values()].sort((a, b) => a.observedAt - b.observedAt);
      for (const sample of oldest.slice(0, samples.size - MAX_TRACKED_MINTS)) samples.delete(sample.mint);
    }
  }

  function summarize(items) {
    if (!items.length) return { samples: 0, winRatePct: null, averageReturnPct: null, highScoreSamples: 0, highScoreWinRatePct: null };
    const avg = list => list.reduce((sum, item) => sum + item.changePct, 0) / list.length;
    const winners = list => list.filter(item => item.changePct > 0).length;
    const high = items.filter(item => item.score >= 85);
    return {
      samples: items.length,
      winRatePct: Math.round((winners(items) / items.length) * 100),
      averageReturnPct: Number(avg(items).toFixed(2)),
      highScoreSamples: high.length,
      highScoreWinRatePct: high.length ? Math.round((winners(high) / high.length) * 100) : null
    };
  }

  return { observe, snapshot: () => ({ methodology: "First observed USD price versus later observed price; not trade returns, excludes tokens without positive USD price", fiveMinutes: summarize(completed.fiveMinutes), fifteenMinutes: summarize(completed.fifteenMinutes) }) };
}

module.exports = { createPerformanceTracker };
