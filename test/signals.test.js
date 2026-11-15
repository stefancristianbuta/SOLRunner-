const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyCandidateSignals } = require("../lib/signals");

const strong = {
  score: 82, organicDataCoverage: 5, txns5m: 30, txns1h: 120,
  suspectedArtificialPump: false
};

test("organic momentum status is independent of RugCheck status", () => {
  const highRisk = classifyCandidateSignals({ ...strong, securityStatus: "HIGH_RISK" });
  assert.equal(highRisk.organicStatus, "STRONG SIGNAL");
  assert.equal(highRisk.shortlistEligible, false);
  assert.match(highRisk.shortlistStatus, /SECURITY HIGH RISK/);
});

test("only strong organic signals with a clean RugCheck report enter shortlist", () => {
  const clean = classifyCandidateSignals({ ...strong, securityStatus: "NO_MAJOR_FLAGS" });
  assert.equal(clean.organicStatus, "STRONG SIGNAL");
  assert.equal(clean.shortlistEligible, true);
  assert.equal(classifyCandidateSignals({ ...strong, securityStatus: "UNAVAILABLE" }).shortlistEligible, false);
  assert.equal(classifyCandidateSignals({ ...strong, securityStatus: "CAUTION" }).shortlistEligible, false);
});

test("market manipulation flags independently block strong organic status", () => {
  const result = classifyCandidateSignals({ ...strong, securityStatus: "NO_MAJOR_FLAGS", suspectedArtificialPump: true });
  assert.equal(result.organicStatus, "FLAGGED");
  assert.equal(result.shortlistEligible, false);
});

test("any individual market risk flag blocks strong status and shortlist", () => {
  const result = classifyCandidateSignals({
    ...strong, securityStatus: "NO_MAJOR_FLAGS",
    suspectedArtificialPump: false,
    riskFlags: ["Highly one-sided buy flow"]
  });
  assert.equal(result.organicStatus, "FLAGGED");
  assert.equal(result.shortlistEligible, false);
});

test("marketRiskFlags also block shortlist when riskFlags are absent", () => {
  const result = classifyCandidateSignals({
    ...strong, securityStatus: "NO_MAJOR_FLAGS",
    marketRiskFlags: ["Weak buyer breadth"]
  });
  assert.equal(result.organicStatus, "FLAGGED");
  assert.equal(result.shortlistEligible, false);
});

test("watch and insufficient data remain separate categories", () => {
  assert.equal(classifyCandidateSignals({ score: 65, organicDataCoverage: 3, securityStatus: "NO_MAJOR_FLAGS" }).organicStatus, "WATCH");
  assert.equal(classifyCandidateSignals({ score: 50, organicDataCoverage: 2 }).organicStatus, "INSUFFICIENT DATA");
});
