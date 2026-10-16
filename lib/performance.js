const HORIZONS_MS = { fiveMinutes: 5 * 60_000, fifteenMinutes: 15 * 60_000 };
const MAX_TRACKED_MINTS = 2000;
const MAX_COMPLETED_PER_HORIZON = 5000;
const MAX_OBSERVATION_DELAY_MS = { fiveMinutes: 5 * 60_000, fifteenMinutes: 10 * 60_000 };
const SCORE_BUCKETS = [
  { key: "under58", label: "<58", min: 0, max: 58 },
  { key: "watch", label: "58–71", min: 58, max: 72 },
  { key: "strong", label: "72–84", min: 72, max: 85 },
  { key: "high", label: "85–100", min: 85, max: 101 }
];

function createPerformanceTracker() {
  const samples = new Map();
  const completed = { fiveMinutes: [], fifteenMinutes: [] };
  const lateSkipped = { fiveMinutes: 0, fifteenMinutes: 0 };

  function observe(tokens, now = Date.now()) {
    for (const token of tokens) {
      const mint = token.mint;
      const price = Number(token.priceUsd);
      if (!mint || !Number.isFinite(price) || price <= 0) continue;
      let sample = samples.get(mint);
      if (!sample) {
        sample = { mint, score: Math.max(0, Math.min(100, Number(token.score) || 0)), price, observedAt: now, due: {} };
        for (const [horizon, duration] of Object.entries(HORIZONS_MS)) sample.due[horizon] = now + duration;
        samples.set(mint, sample);
      }
      for (const [horizon, duration] of Object.entries(HORIZONS_MS)) {
        const dueAt = sample.due[horizon];
        if (dueAt && now >= dueAt) {
          const delayMs = now - dueAt;
          if (delayMs <= MAX_OBSERVATION_DELAY_MS[horizon]) {
            const changePct = ((price - sample.price) / sample.price) * 100;
            completed[horizon].push({
              score: sample.score,
              changePct,
              observedAt: now,
              observedAfterSeconds: Math.max(0, Math.round(delayMs / 1000))
            });
            if (completed[horizon].length > MAX_COMPLETED_PER_HORIZON) completed[horizon].shift();
          } else {
            lateSkipped[horizon]++;
          }
          // Each mint contributes at most one observation per horizon, whether valid or too late.
          sample.due[horizon] = 0;
        }
      }
    }
    if (samples.size > MAX_TRACKED_MINTS) {
      const oldest = [...samples.values()].sort((a, b) => a.observedAt - b.observedAt);
      for (const sample of oldest.slice(0, samples.size - MAX_TRACKED_MINTS)) samples.delete(sample.mint);
    }
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return Number((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
  }

  function summarize(items) {
    const winners = list => list.filter(item => item.changePct > 0).length;
    const losers = list => list.filter(item => item.changePct < 0).length;
    const flats = list => list.filter(item => item.changePct === 0).length;
    const avg = list => list.length ? list.reduce((sum, item) => sum + item.changePct, 0) / list.length : null;
    const summarizeGroup = list => ({
      samples: list.length,
      positive: winners(list),
      negative: losers(list),
      neutral: flats(list),
      winRatePct: list.length ? Math.round((winners(list) / list.length) * 100) : null,
      averageReturnPct: avg(list) === null ? null : Number(avg(list).toFixed(2)),
      medianReturnPct: median(list.map(item => item.changePct)),
      medianObservationDelaySeconds: median(list.map(item => item.observedAfterSeconds))
    });
    const buckets = {};
    for (const bucket of SCORE_BUCKETS) {
      buckets[bucket.key] = { label: bucket.label, ...summarizeGroup(items.filter(item => item.score >= bucket.min && item.score < bucket.max)) };
    }
    return { ...summarizeGroup(items), highScoreSamples: buckets.high.samples, highScoreWinRatePct: buckets.high.winRatePct, scoreBuckets: buckets };
  }

  return {
    observe,
    snapshot: () => ({
      methodology: "First observed positive USD price versus a follow-up price sampled within 5 minutes after the 5-minute target or within 10 minutes after the 15-minute target. Late samples are excluded; each mint contributes at most once per horizon. Score buckets use the initial score. These are price observations, not trade returns.",
      pendingMints: [...samples.values()].filter(sample => sample.due.fiveMinutes || sample.due.fifteenMinutes).length,
      fiveMinutes: { ...summarize(completed.fiveMinutes), lateSkipped: lateSkipped.fiveMinutes, maxAllowedDelaySeconds: MAX_OBSERVATION_DELAY_MS.fiveMinutes / 1000 },
      fifteenMinutes: { ...summarize(completed.fifteenMinutes), lateSkipped: lateSkipped.fifteenMinutes, maxAllowedDelaySeconds: MAX_OBSERVATION_DELAY_MS.fifteenMinutes / 1000 }
    })
  };
}

module.exports = { createPerformanceTracker, SCORE_BUCKETS };
