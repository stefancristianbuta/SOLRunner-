const test = require("node:test");
const assert = require("node:assert/strict");
const { scorePair } = require("../lib/score");

const basePair = { priceChange: { m5: 0, h1: 0 } };

test("score is a bounded integer from 0 to 100", () => {
  for (const score of [
    scorePair(basePair, 0, 20_000, 0, 0, 0),
    scorePair({ priceChange: { m5: 500, h1: 500 } }, 500, 1e12, 1e12, 1e6, 0, { buyers: 1000, sellers: 0 })
  ]) {
    assert.ok(Number.isInteger(score));
    assert.ok(score >= 0 && score <= 100);
  }
});

test("higher buy pressure and activity should not lower score", () => {
  const weak = scorePair(basePair, 10, 50_000, 100, 2, 8, { buyers: 2, sellers: 8 });
  const strong = scorePair({ priceChange: { m5: 8, h1: 12 } }, 10, 50_000, 50_000, 25, 3, { buyers: 25, sellers: 3 });
  assert.ok(strong > weak, `expected strong ${strong} > weak ${weak}`);
});

test("missing unique-wallet data remains neutral and produces finite score", () => {
  const score = scorePair(basePair, 30, 25_000, 100, 5, 5, {});
  assert.ok(Number.isFinite(score));
  assert.ok(score >= 0 && score <= 100);
});

test("minimum-liquidity baseline remains finite", () => {
  assert.ok(Number.isFinite(scorePair(basePair, 9999, 20_000, 0, 0, 0)));
});
