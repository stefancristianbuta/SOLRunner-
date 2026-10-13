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
