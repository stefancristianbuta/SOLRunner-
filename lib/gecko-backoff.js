"use strict";

const LOGO_BACKOFF_BASE_MS = 5 * 60_000;
const LOGO_BACKOFF_MAX_MS = 60 * 60_000;

function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now) || null;
}

function logoBackoffMs(streak) {
  const attempts = Math.max(1, Math.floor(Number(streak) || 1));
  return Math.min(LOGO_BACKOFF_MAX_MS, LOGO_BACKOFF_BASE_MS * (2 ** Math.min(attempts - 1, 10)));
}

module.exports = { parseRetryAfter, logoBackoffMs, LOGO_BACKOFF_BASE_MS, LOGO_BACKOFF_MAX_MS };
