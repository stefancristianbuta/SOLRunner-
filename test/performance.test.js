const test = require("node:test");
const assert = require("node:assert/strict");
const { createPerformanceTracker } = require("../lib/performance");

test("records first-observation price follow-through at 5m and 15m", () => {
  const tracker = createPerformanceTracker();
  tracker.observe([{ mint: "A", priceUsd: 2, score: 90 }], 1_000);
  tracker.observe([{ mint: "A", priceUsd: 2.2, score: 95 }], 301_001);
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.fiveMinutes.samples, 1);
  assert.equal(snapshot.fiveMinutes.winRatePct, 100);
  assert.equal(snapshot.fiveMinutes.averageReturnPct, 10);
  assert.equal(snapshot.fifteenMinutes.samples, 0);
  tracker.observe([{ mint: "A", priceUsd: 1.8, score: 90 }], 901_001);
  snapshot = tracker.snapshot();
  assert.equal(snapshot.fifteenMinutes.samples, 1);
  assert.equal(snapshot.fifteenMinutes.winRatePct, 0);
});

test("does not track zero or missing prices", () => {
  const tracker = createPerformanceTracker();
  tracker.observe([{ mint: "A", priceUsd: 0, score: 90 }, { mint: "B", score: 80 }], 1_000);
  tracker.observe([{ mint: "A", priceUsd: 1, score: 90 }], 1_000_000);
  assert.equal(tracker.snapshot().fiveMinutes.samples, 0);
});

test("high-score cohort is reported separately", () => {
  const tracker = createPerformanceTracker();
  tracker.observe([{ mint: "A", priceUsd: 1, score: 90 }, { mint: "B", priceUsd: 1, score: 70 }], 0);
  tracker.observe([{ mint: "A", priceUsd: 1.1, score: 90 }, { mint: "B", priceUsd: 0.9, score: 70 }], 301_000);
  const result = tracker.snapshot().fiveMinutes;
  assert.equal(result.samples, 2);
  assert.equal(result.highScoreSamples, 1);
  assert.equal(result.highScoreWinRatePct, 100);
});


test("reports score buckets, positive/negative/neutral counts, median and observation delay", () => {
  const tracker = createPerformanceTracker();
  const start = 1_000_000;
  tracker.observe([
    { mint: "low", priceUsd: 1, score: 40 },
    { mint: "watch", priceUsd: 2, score: 65 },
    { mint: "strong", priceUsd: 4, score: 78 },
    { mint: "high", priceUsd: 8, score: 90 }
  ], start);
  tracker.observe([
    { mint: "low", priceUsd: 1.1, score: 99 },
    { mint: "watch", priceUsd: 1.8, score: 99 },
    { mint: "strong", priceUsd: 4, score: 99 },
    { mint: "high", priceUsd: 8.8, score: 99 }
  ], start + 5 * 60_000 + 15_000);
  const five = tracker.snapshot().fiveMinutes;
  assert.equal(five.samples, 4);
  assert.equal(five.positive, 2);
  assert.equal(five.negative, 1);
  assert.equal(five.neutral, 1);
  assert.equal(five.medianObservationDelaySeconds, 15);
  assert.equal(five.scoreBuckets.under58.samples, 1);
  assert.equal(five.scoreBuckets.watch.negative, 1);
  assert.equal(five.scoreBuckets.strong.neutral, 1);
  assert.equal(five.scoreBuckets.high.positive, 1);
  assert.equal(five.scoreBuckets.high.winRatePct, 100);
});

test("reports median separately from average when returns contain an outlier", () => {
  const tracker = createPerformanceTracker();
  const start = 2_000_000;
  tracker.observe([
    { mint: "a", priceUsd: 1, score: 60 },
    { mint: "b", priceUsd: 1, score: 60 },
    { mint: "c", priceUsd: 1, score: 60 }
  ], start);
  tracker.observe([
    { mint: "a", priceUsd: 1.01, score: 60 },
    { mint: "b", priceUsd: 1.02, score: 60 },
    { mint: "c", priceUsd: 2, score: 60 }
  ], start + 5 * 60_000);
  const five = tracker.snapshot().fiveMinutes;
  assert.equal(five.medianReturnPct, 2);
  assert.ok(five.averageReturnPct > five.medianReturnPct);
});


test("excludes stale observations and reports skipped horizons", () => {
  const tracker = createPerformanceTracker();
  const start = 10_000;
  tracker.observe([{ mint: "late", priceUsd: 1, score: 90 }], start);
  tracker.observe([{ mint: "late", priceUsd: 1.5, score: 90 }], start + 11 * 60_000);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.fiveMinutes.samples, 0);
  assert.equal(snapshot.fiveMinutes.lateSkipped, 1);
  assert.equal(snapshot.fiveMinutes.maxAllowedDelaySeconds, 300);
  assert.equal(snapshot.pendingMints, 1);
});

test("keeps a timely 5-minute sample but excludes a very late 15-minute sample", () => {
  const tracker = createPerformanceTracker();
  const start = 20_000;
  tracker.observe([{ mint: "timely", priceUsd: 1, score: 86 }], start);
  tracker.observe([{ mint: "timely", priceUsd: 1.1, score: 86 }], start + 6 * 60_000);
  tracker.observe([{ mint: "timely", priceUsd: 1.2, score: 86 }], start + 26 * 60_000);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.fiveMinutes.samples, 1);
  assert.equal(snapshot.fifteenMinutes.samples, 0);
  assert.equal(snapshot.fifteenMinutes.lateSkipped, 1);
});
