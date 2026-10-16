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
