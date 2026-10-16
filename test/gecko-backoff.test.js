const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRetryAfter, logoBackoffMs, LOGO_BACKOFF_BASE_MS, LOGO_BACKOFF_MAX_MS } = require("../lib/gecko-backoff");

test("parses Retry-After seconds", () => assert.equal(parseRetryAfter("12", 0), 12_000));
test("parses Retry-After HTTP date", () => assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:12 GMT", 0), 12_000));
test("ignores invalid Retry-After", () => assert.equal(parseRetryAfter("not-a-date", 0), null));
test("logo cooldown grows exponentially", () => {
  assert.equal(logoBackoffMs(1), LOGO_BACKOFF_BASE_MS);
  assert.equal(logoBackoffMs(2), LOGO_BACKOFF_BASE_MS * 2);
  assert.equal(logoBackoffMs(3), LOGO_BACKOFF_BASE_MS * 4);
});
test("logo cooldown is capped at one hour", () => assert.equal(logoBackoffMs(100), LOGO_BACKOFF_MAX_MS));
