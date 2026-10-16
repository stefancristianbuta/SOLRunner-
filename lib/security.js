"use strict";

function classifySecurityReport(report) {
  if (!report || typeof report !== "object") return { status: "UNAVAILABLE", score: null, flags: [], reasons: [] };
  const rawScore = report.score_normalised;
  const score = rawScore !== null && rawScore !== undefined && rawScore !== "" && Number.isFinite(Number(rawScore)) ? Number(rawScore) : null;
  const risks = Array.isArray(report.risks) ? report.risks.filter(r => r && typeof r === "object") : [];
  const flags = risks.map(r => String(r.name || "RugCheck risk"));
  const highLevel = risks.some(r => /\b(danger|critical|high)\b/i.test(String(r.level || "")));
  const riskText = risks.map(r => [r.name, r.description, r.value].filter(Boolean).join(" ")).join(" ").toLowerCase();
  const directThreat = /\b(rugged|honeypot|scam|malicious|blacklist enabled|cannot sell|unsellable)\b/i.test(riskText);
  const activeAuthority = /\b(mint|freeze) authority\b.{0,45}\b(enabled|active|not revoked|not disabled|mutable)\b/i.test(riskText) ||
    /\b(enabled|active|not revoked|not disabled|mutable)\b.{0,45}\b(mint|freeze) authority\b/i.test(riskText);
  const highRisk = report.rugged === true || highLevel || directThreat || activeAuthority || (score !== null && score >= 70);
  const caution = risks.length > 0 || (score !== null && score >= 35);
  return { status: highRisk ? "HIGH_RISK" : caution ? "CAUTION" : "NO_MAJOR_FLAGS", score, flags,
    reasons: [...flags, ...(report.rugged === true ? ["RugCheck marks this token as rugged"] : [])] };
}

module.exports = { classifySecurityReport };
