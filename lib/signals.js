"use strict";

function classifyCandidateSignals(token = {}) {
  const score = Number(token.score) || 0;
  const coverage = Number(token.organicDataCoverage) || 0;
  const txns5m = Number(token.txns5m) || 0;
  const txns1h = Number(token.txns1h) || 0;
  const marketFlagged = Boolean(token.suspectedArtificialPump);
  let organicStatus = "INSUFFICIENT DATA";

  if (marketFlagged) organicStatus = "FLAGGED";
  else if (score >= 72 && coverage >= 4 && txns5m >= 12 && txns1h >= 40) organicStatus = "STRONG SIGNAL";
  else if (score >= 58 && coverage >= 3) organicStatus = "WATCH";

  const securityStatus = token.securityStatus || "UNAVAILABLE";
  const shortlistEligible = organicStatus === "STRONG SIGNAL" &&
    securityStatus === "NO_MAJOR_FLAGS" && !marketFlagged;
  let shortlistStatus = organicStatus;
  if (organicStatus === "STRONG SIGNAL" && !shortlistEligible) {
    shortlistStatus = securityStatus === "HIGH_RISK" ? "EXCLUDED · SECURITY HIGH RISK" :
      securityStatus === "CAUTION" ? "REVIEW · SECURITY CAUTION" :
      "REVIEW · SECURITY UNVERIFIED";
  }
  return { organicStatus, shortlistEligible, shortlistStatus };
}

module.exports = { classifyCandidateSignals };
