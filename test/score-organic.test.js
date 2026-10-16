const test = require("node:test");
const assert = require("node:assert/strict");
const { scorePair } = require("../lib/score");

test("sustained activity ranks above a thin vertical spike", () => {
  const organic = scorePair({
    priceChange: { m5: 8, h1: 18 },
    txns: { h1: { buys: 180, sells: 90 } }
  }, 60, 80000, 12000, 28, 14, { buyers: 40, sellers: 18 });
  const pump = scorePair({
    priceChange: { m5: 48, h1: 2 },
    txns: { h1: { buys: 18, sells: 1 } }
  }, 4, 25000, 42000, 8, 1, { buyers: 2, sellers: 0 });
  assert.ok(organic > pump, `organic ${organic} should beat pump ${pump}`);
});

test("missing unique wallet data is handled safely", () => {
  const score = scorePair({ priceChange: { m5: 4, h1: 7 }, txns: { h1: { buys: 30, sells: 20 } } },
    20, 30000, 5000, 15, 10, {});
  assert.ok(Number.isInteger(score));
  assert.ok(score >= 0 && score <= 100);
});

test("near-perfect one-sided flow ranks below healthier buy pressure", () => {
  const balanced = scorePair({ priceChange: { m5: 5, h1: 12 }, txns: { h1: { buys: 60, sells: 30 } } },
    30, 50000, 7000, 24, 10, { buyers: 20, sellers: 10 });
  const oneSided = scorePair({ priceChange: { m5: 5, h1: 12 }, txns: { h1: { buys: 60, sells: 1 } } },
    30, 50000, 7000, 33, 1, { buyers: 20, sellers: 1 });
  assert.ok(balanced > oneSided);
});

test("token age does not reduce the score when market signals are identical", () => {
  const pair = { priceChange: { m5: 6, h1: 14 }, txns: { h1: { buys: 90, sells: 45 } } };
  const signal = { buyers: 24, sellers: 12 };
  const recent = scorePair(pair, 10, 60000, 8000, 24, 12, signal);
  const older = scorePair(pair, 1440, 60000, 8000, 24, 12, signal);
  assert.equal(recent, older);
});

test("missing market evidence lowers confidence compared with sustained observed activity", () => {
  const active = scorePair({
    priceChange: { m5: 6, h1: 14 },
    txns: { h1: { buys: 90, sells: 45 } }
  }, 60, 60000, 8000, 24, 12, { buyers: 24, sellers: 12 });
  const missing = scorePair({ priceChange: { m5: 0, h1: 0 }, txns: {} },
    60, 60000, 0, 0, 0, {});
  assert.ok(active > missing, `active ${active} should exceed incomplete ${missing}`);
});
