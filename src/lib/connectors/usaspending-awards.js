// ── AWARD BENCHMARKS FROM USASPENDING ────────────────────────────────────────
//
// Read-only. Pure except for an injectable fetch.
//
// Answers one question per product service code: what has the government actually paid for this
// kind of work? The board needs it because of a measured fact — of 149 live solicitations, ZERO
// carried an estimated value.
//
// ── WHY NOT FPDS, THE OBVIOUS SOURCE ─────────────────────────────────────────
//
// Measured 2026-11-09, FPDS Atom feed, PSC Q301, 2024-2026: of ten entries, ONE was a base award
// and NINE were modifications, SIX of them carrying negative obligations — money handed back. An
// average over that feed lands near zero and looks entirely reasonable on a dashboard.
// USAspending's award search returns base award values, which is what a comparable actually is.
//
// ── WHY THREE REQUESTS AND NOT A DOWNLOAD ────────────────────────────────────
//
// PSC Q301 alone has 9,824 contracts over three years. Fetching them to compute a median is
// absurd, and fetching a bounded SAMPLE of a sorted list is worse — it is biased by construction,
// and quietly, because the result still looks like a distribution.
//
// So: ask the count endpoint how many there are, then ask for the single page containing each
// percentile position in the ASCENDING sort. Three requests, exact figures, no estimation. For
// Q301 that returns p25 $14,016 · median $50,000 · p75 $203,642 — measured 2026-11-09.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
// It does not compute a mean. Q301 covers both an $821M pandemic pharmacy contract and a $10,000
// lab order; the mean of that population describes no contract that has ever existed.
'use strict';

const COUNT_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award_count/';
const SEARCH_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';

// A, B, C, D are the contract award types: definitive contracts, purchase orders and delivery
// orders. Grants, loans and direct payments are excluded — they are not work anybody bid for.
const CONTRACT_TYPES = Object.freeze(['A', 'B', 'C', 'D']);

const PAGE_LIMIT = 100;
const DEFAULT_WINDOW_YEARS = 3;

// Below this there is no point asking for percentiles: award-comparables.js refuses to produce a
// bid from fewer than five, so three extra HTTP requests would buy nothing.
const MIN_AWARDS = 5;

function windowDates(years, now) {
  const end = now instanceof Date ? now : new Date();
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start_date: iso(start), end_date: iso(end) };
}

function buildFilters({ psc, naics, years, now }) {
  const filters = {
    time_period: [windowDates(years, now)],
    award_type_codes: [...CONTRACT_TYPES],
  };
  if (psc) filters.psc_codes = [String(psc).trim().toUpperCase()];
  if (naics) filters.naics_codes = [String(naics).trim()];
  return filters;
}

async function post(url, body, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`usaspending ${r.status} for ${url}: ${text.slice(0, 180)}`);
    }
    try { return JSON.parse(text); } catch {
      throw new Error(`usaspending returned non-JSON for ${url}: ${text.slice(0, 120)}`);
    }
  } finally { clearTimeout(timer); }
}

/**
 * The award at a given position in the ascending-by-amount ordering.
 *
 * Positions are zero-based over the whole result set. Page numbers are one-based, which is the
 * kind of off-by-one that silently returns the wrong percentile rather than an error, so it is
 * computed in exactly one place.
 */
async function awardAtPosition(filters, index, opts) {
  const page = Math.floor(index / PAGE_LIMIT) + 1;
  const offset = index % PAGE_LIMIT;
  const j = await post(SEARCH_URL, {
    filters,
    fields: ['Award ID', 'Award Amount'],
    page,
    limit: PAGE_LIMIT,
    sort: 'Award Amount',
    order: 'asc',
    subawards: false,
  }, opts);
  const rows = (j && j.results) || [];
  const row = rows[offset];
  if (!row) return null;
  const v = row['Award Amount'];
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Build one benchmark.
 *
 * @returns {{psc, naics, windowYears, n, p25, median, p75, computedAt, sufficient}}
 */
async function fetchBenchmark({
  psc,
  naics = null,
  years = DEFAULT_WINDOW_YEARS,
  now = new Date(),
  ...opts
} = {}) {
  if (!psc && !naics) throw new Error('fetchBenchmark: a psc or a naics is required');

  const filters = buildFilters({ psc, naics, years, now });

  const countJson = await post(COUNT_URL, { filters, subawards: false }, opts);
  const n = Number((countJson && countJson.results && countJson.results.contracts) || 0);

  const base = {
    psc: psc || null,
    naics: naics || null,
    windowYears: years,
    n,
    p25: null,
    median: null,
    p75: null,
    computedAt: (now instanceof Date ? now : new Date()).toISOString(),
    sufficient: false,
  };

  if (!Number.isFinite(n) || n < MIN_AWARDS) return base;

  // Positions, zero-based. Math.floor keeps every index inside [0, n-1].
  const [p25, median, p75] = await Promise.all([
    awardAtPosition(filters, Math.floor(n * 0.25), opts),
    awardAtPosition(filters, Math.floor(n * 0.50), opts),
    awardAtPosition(filters, Math.floor(n * 0.75), opts),
  ]);

  // A transposed or non-ascending result means the sort did not hold — which would invert the bid
  // ladder. Refuse the benchmark rather than store figures the database would reject anyway.
  const ordered = [p25, median, p75].every((v) => v === null || Number.isFinite(v))
    && (p25 == null || median == null || p25 <= median)
    && (median == null || p75 == null || median <= p75);

  if (!ordered) {
    return { ...base, error: 'percentiles did not ascend — the ordering cannot be trusted' };
  }

  return { ...base, p25, median, p75, sufficient: median != null };
}

module.exports = {
  fetchBenchmark,
  buildFilters,
  awardAtPosition,
  windowDates,
  COUNT_URL,
  SEARCH_URL,
  CONTRACT_TYPES,
  PAGE_LIMIT,
  MIN_AWARDS,
  DEFAULT_WINDOW_YEARS,
};
