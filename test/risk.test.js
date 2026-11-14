const test = require("node:test");
const assert = require("node:assert/strict");
const { assessMarketRisk } = require("../lib/risk");

test("normal activity is not flagged", () => {
  const result = assessMarketRisk({ change5m: 3, volume5m: 5000, liquidityUsd: 50000, buys5m: 20, sells5m: 12, txns5m: 32 });
  assert.equal(result.suspectedArtificialPump, false);
  assert.deepEqual(result.flags, []);
});

test("extreme price spike with few trades is flagged", () => {
  const result = assessMarketRisk({ change5m: 45, volume5m: 40000, liquidityUsd: 25000, buys5m: 8, sells5m: 1, txns5m: 9 });
  assert.equal(result.suspectedArtificialPump, true);
  assert.ok(result.flags.length >= 2);
});

test("one-sided trading plus high turnover is flagged", () => {
  const result = assessMarketRisk({ change5m: 22, volume5m: 50000, liquidityUsd: 50000, buys5m: 30, sells5m: 1, txns5m: 31 });
  assert.equal(result.suspectedArtificialPump, true);
});

test("missing metrics do not throw or automatically flag", () => {
  const result = assessMarketRisk({});
  assert.equal(result.suspectedArtificialPump, false);
  assert.deepEqual(result.flags, []);
});

test("extreme turnover is flagged even without a sharp price move", () => {
  const result = assessMarketRisk({ change5m: 2, volume5m: 80000, liquidityUsd: 30000, buys5m: 35, sells5m: 18, txns5m: 53 });
  assert.ok(result.flags.some(flag => flag.includes("2x pool liquidity")));
  assert.equal(result.suspectedArtificialPump, true);
});

test("missing unique buyer data is not treated as zero wallet diversity", () => {
  const result = assessMarketRisk({ change5m: 2, volume5m: 5000, liquidityUsd: 50000, buys5m: 30, sells5m: 12, txns5m: 42, uniqueBuyers5m: null });
  assert.equal(result.uniqueBuyerRatio, null);
  assert.equal(result.flags.some(flag => flag.includes("concentrated") || flag.includes("Buyer breadth")), false);
});

test("low unique buyer count relative to buys is flagged", () => {
  const result = assessMarketRisk({ change5m: 3, volume5m: 5000, liquidityUsd: 50000, buys5m: 40, sells5m: 10, txns5m: 50, uniqueBuyers5m: 4 });
  assert.ok(result.flags.some(flag => flag.includes("concentrated")));
});
