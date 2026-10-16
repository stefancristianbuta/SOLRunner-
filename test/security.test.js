const test = require("node:test");
const assert = require("node:assert/strict");
const { classifySecurityReport } = require("../lib/security");

test("missing RugCheck report stays unverified", () => assert.equal(classifySecurityReport(null).status, "UNAVAILABLE"));
test("normalized high risk score is classified high risk", () => assert.equal(classifySecurityReport({ score_normalised: 70, risks: [] }).status, "HIGH_RISK"));
test("authority mention alone does not create a false high-risk classification", () => {
  const result = classifySecurityReport({ score_normalised: 12, risks: [{ name: "Mint Authority", level: "warn", description: "Mint authority is disabled and revoked" }] });
  assert.equal(result.status, "CAUTION");
});
test("explicitly enabled mint authority is high risk", () => {
  const result = classifySecurityReport({ score_normalised: 12, risks: [{ name: "Mint Authority Enabled", level: "warn", description: "Mint authority is still enabled" }] });
  assert.equal(result.status, "HIGH_RISK");
});
test("danger or critical risk levels are high risk", () => {
  assert.equal(classifySecurityReport({ score_normalised: 10, risks: [{ name: "Holder concentration", level: "danger" }] }).status, "HIGH_RISK");
  assert.equal(classifySecurityReport({ score_normalised: 10, risks: [{ name: "Holder concentration", level: "critical" }] }).status, "HIGH_RISK");
});
test("a low score and no risk items is not reported as a major flag", () => assert.equal(classifySecurityReport({ score_normalised: 10, risks: [] }).status, "NO_MAJOR_FLAGS"));
test("rugged flag always takes precedence", () => assert.equal(classifySecurityReport({ rugged: true, score_normalised: 5, risks: [] }).status, "HIGH_RISK"));
