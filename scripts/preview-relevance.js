#!/usr/bin/env node
/*
 * preview-relevance.js — run the relevance engine over the live board and report what it would do.
 *
 *   node scripts/preview-relevance.js            # distribution + samples
 *   node scripts/preview-relevance.js --verdict RELEVANT --limit 30
 *
 * READ ONLY. It issues one SELECT and writes nothing, anywhere. It is meant to be run against
 * production — railway ssh 'node scripts/preview-relevance.js' — so that a change to the scoring
 * can be judged against the real board before it is wired into anything.
 *
 * Exit status: 0 when a report was produced, 1 when the board could not be read. A zero exit says
 * the report ran, never that any particular opportunity is worth bidding.
 */
'use strict';

require('dotenv').config();

const { query } = require('../src/lib/db');
const { assessRelevance, RELEVANT_AT, MARGINAL_AT } = require('../src/lib/office/opportunity-relevance');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const WANT = argOf('--verdict', null);
const LIMIT = Number(argOf('--limit', 8));

const log = (s) => process.stdout.write(`${s}\n`);
const bar = () => '─'.repeat(78);

async function main() {
  const r = await query(
    `SELECT solicitation_number, title, agency, naics_code, psc_code, description,
            response_deadline, status
       FROM federal_opportunities
      WHERE is_current
      ORDER BY response_deadline NULLS LAST`);

  const rows = r.rows;
  log(`\n${bar()}`);
  log('RELEVANCE PREVIEW — nothing is written');
  log(bar());
  log(`  board          : ${rows.length} current opportunit${rows.length === 1 ? 'y' : 'ies'}`);
  log(`  thresholds     : RELEVANT >= ${RELEVANT_AT} · MARGINAL >= ${MARGINAL_AT}\n`);

  const scored = rows.map((o) => ({ o, a: assessRelevance(o) }));
  const byVerdict = new Map();
  const byLine = new Map();
  for (const s of scored) {
    byVerdict.set(s.a.verdict, (byVerdict.get(s.a.verdict) || 0) + 1);
    for (const l of s.a.lines) byLine.set(l, (byLine.get(l) || 0) + 1);
  }

  log('  VERDICT');
  for (const [v, n] of [...byVerdict].sort((a, b) => b[1] - a[1])) {
    const pct = Math.round((n / Math.max(rows.length, 1)) * 100);
    log(`    ${String(v).padEnd(14)} ${String(n).padStart(4)}  ${String(pct).padStart(3)}%`);
  }

  log('\n  BUSINESS LINE (an opportunity can touch more than one)');
  for (const [l, n] of [...byLine].sort((a, b) => b[1] - a[1])) {
    log(`    ${String(l).padEnd(24)} ${String(n).padStart(4)}`);
  }

  const shown = scored
    .filter((s) => !WANT || s.a.verdict === WANT)
    .sort((a, b) => b.a.score - a.a.score)
    .slice(0, LIMIT);

  log(`\n  TOP ${shown.length}${WANT ? ` (${WANT} only)` : ''}, highest score first`);
  log(`  ${bar()}`);
  for (const { o, a } of shown) {
    const due = o.response_deadline
      ? new Date(o.response_deadline).toISOString().slice(0, 10) : 'no deadline';
    log(`  ${String(a.score).padStart(3)}  ${a.verdict.padEnd(13)} ${o.solicitation_number}`);
    log(`       ${String(o.title || '').slice(0, 86)}`);
    log(`       ${o.agency || 'agency not stated'} · PSC ${o.psc_code || '—'} · `
      + `NAICS ${o.naics_code || '—'} · closes ${due}`);
    log(`       lines: ${a.lines.join(', ') || '(none)'}`);
    for (const reason of a.reasons.slice(0, 4)) log(`       · ${reason}`);
    for (const v of a.vetoes) log(`       ✗ ${v}`);
    log('');
  }

  log(bar());
  log(`PREVIEW COMPLETE — ${rows.length} assessed, 0 rows written`);
  log('');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`\npreview-relevance: ${e.stack || e.message}\n\n`);
  process.exit(1);
});
