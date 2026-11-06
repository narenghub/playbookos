#!/usr/bin/env node
/*
 * rank-opportunities.js — rank harvested SAM.gov opportunities by practical business feasibility.
 *
 * Ruling 24 item 10: "Report back with the top 10 opportunities ranked by practical business
 * feasibility, not simply keyword similarity."
 *
 * This replaces the inline one-off commands used for earlier ranking passes, so that a ranking
 * reported to the owner can be reproduced exactly from committed inputs.
 *
 *   node scripts/rank-opportunities.js --wave 1 [--top 10] [--today YYYY-MM-DD] [--json out.json]
 *
 * Inputs are the committed harvest fixtures plus, where available, a descriptions file produced by
 * scripts/fetch-opportunity-descriptions.js. A notice with no description is ranked with its title
 * only and is reported as such — it is never upgraded by assumption.
 *
 * Exit status: 0 when a ranking was produced; non-zero on bad input or an unreadable fixture.
 * The ranking itself is diagnostics; a zero exit does not mean any opportunity is biddable.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../src/lib/office/opportunity-csv.js');
const { mapHeaders, normalizeRow } = require('../src/lib/office/opportunity-normalize.js');
const { rankAll } = require('../src/lib/office/opportunity-rank.js');
const { relevantLines } = require('../src/lib/office/opportunity-qualify.js');
const { assessFeasibility } = require('../src/lib/office/fulfillment-feasibility.js');

const WAVES = {
  1: 'fixtures/sam-opportunities-real-2026-11-06.csv',
  2: 'fixtures/sam-opportunities-wave2-2026-11-06.csv',
};

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
}

function die(msg) {
  process.stderr.write(`rank-opportunities: ${msg}\n`);
  process.exit(2);
}

const repo = path.join(__dirname, '..');
const waveArg = String(arg('wave', '1'));
const waves = waveArg === 'all' ? Object.keys(WAVES) : [waveArg];
const top = Number(arg('top', '10'));
const today = arg('today', new Date().toISOString().slice(0, 10));
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) die(`--today must be YYYY-MM-DD, got ${today}`);
if (!Number.isInteger(top) || top < 1) die(`--top must be a positive integer, got ${arg('top')}`);

// Descriptions are optional. When the file is absent we say so rather than silently ranking on
// titles alone, because a missing description is the difference between "we know what they want"
// and "we are guessing from a title".
const descPath = arg('descriptions', 'fixtures/opportunity-descriptions-2026-11-06.json');
let descriptions = {};
let descSource = 'NONE — ranked on titles only';
const descAbs = path.join(repo, descPath);
if (fs.existsSync(descAbs)) {
  descriptions = JSON.parse(fs.readFileSync(descAbs, 'utf8'));
  descSource = `${descPath} (${Object.keys(descriptions).length} notice bodies)`;
}

// SAM description bodies are HTML fragments. Strip tags for classification; the original stays in
// the descriptions file, so nothing is lost by this.
function plain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const rows = [];
const rejected = [];
const issues = [];
const unmatchedHeaders = [];
let described = 0;
for (const w of waves) {
  const rel = WAVES[w];
  if (!rel) die(`unknown wave ${w}; known waves: ${Object.keys(WAVES).join(', ')}`);
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) die(`fixture missing: ${rel}`);
  const { headers, rows: raw } = parseCsv(fs.readFileSync(abs, 'utf8'));
  // mapHeaders returns an envelope too. Unmatched headers are reported: a column we did not
  // understand is information, not noise.
  const { mapping: map, unmatched } = mapHeaders(headers);
  if (unmatched && unmatched.length) unmatchedHeaders.push({ wave: w, unmatched });
  for (const r of raw) {
    // normalizeRow returns a result envelope, not the record. A rejected row is reported, never
    // ranked — ranking a row whose own parser refused it is how a guess becomes a number.
    const res = normalizeRow(r, map);
    if (res.rejected) {
      rejected.push({ row: res.record && res.record.solicitation_number, issues: res.issues });
      continue;
    }
    const rec = res.record;
    if (res.issues && res.issues.length) issues.push({ sol: rec.solicitation_number, issues: res.issues });
    const nid = r.NoticeId || rec.notice_id;
    const body = nid && descriptions[nid] ? plain(descriptions[nid]) : '';
    if (body) described += 1;
    const withBody = { ...rec, notice_id: nid, description: body };
    // business_lines is what rank() scores technical fit from, and it comes from the qualify
    // engine's line matcher — NOT from the bid verdict. assess() returns an empty line list for a
    // sources-sought notice because there is nothing to bid on, and feeding that into rank() would
    // zero the fit score for exactly the market-entry notices that are the way in.
    const rl = relevantLines(withBody);
    rows.push({
      ...withBody,
      business_lines: rl.lines,
      _line_basis: rl.basis,
      _wave: w,
      _described: Boolean(body),
    });
  }
}

if (!rows.length) die('no rows parsed from the fixtures');

const ranked = rankAll(rows, { today });

// Tier and product-class census, so the shape of the board is visible and not inferred from the
// top of the list.
const tiers = {};
const classes = {};
for (const r of ranked) {
  tiers[r.ranking.tier] = (tiers[r.ranking.tier] || 0) + 1;
  const f = assessFeasibility(r, { today });
  r._feas = f;
  classes[f.product_class] = (classes[f.product_class] || 0) + 1;
}

const barred = ranked.filter((r) => r.ranking.bars.length);
const shortlist = ranked.filter((r) => !r.ranking.bars.length).slice(0, top);

process.stdout.write(`\nRanked ${ranked.length} opportunities · wave ${waves.join('+')} · today ${today}\n`);
// This reads the fixtures directly and does NOT dedupe across waves — 11 notices appear in both
// harvests, so the raw total here is 264 where the imported corpus is 253. The deduped view is the
// database one (scripts/prpa-tracker-demo.js); this is the reproducible fixture view.
if (waves.length > 1) process.stdout.write('  (raw fixture rows, not deduped across waves — the imported corpus is smaller)\n');
process.stdout.write(`Descriptions: ${descSource}\n`);
process.stdout.write(`Notices with a description: ${described}/${rows.length}`);
process.stdout.write(described < rows.length ? `  (${rows.length - described} ranked on title only)\n` : '\n');
if (rejected.length) process.stdout.write(`Rejected by the parser (not ranked): ${rejected.length}\n`);
if (issues.length) process.stdout.write(`Rows with parse issues (ranked, flagged): ${issues.length}\n`);
process.stdout.write(`Tiers: ${JSON.stringify(tiers)}\n`);
process.stdout.write(`Product classes: ${JSON.stringify(classes)}\n`);
process.stdout.write(`Barred: ${barred.length} (${JSON.stringify(
  barred.reduce((a, r) => { for (const b of r.ranking.bars) a[b.kind] = (a[b.kind] || 0) + 1; return a; }, {}),
)})\n\n`);

shortlist.forEach((r, i) => {
  const f = r._feas;
  process.stdout.write(
    `${String(i + 1).padStart(2)}. [${r.ranking.score}] ${r.ranking.tier}  ${r.solicitation_number || r.notice_id}\n`
    + `    ${String(r.title || '').slice(0, 96)}\n`
    + `    agency=${String(r.agency || '?').slice(0, 52)}  deadline=${r.response_deadline || '?'}\n`
    + `    set-aside=${String(r.set_aside || 'none').slice(0, 56)}\n`
    + `    class=${f.product_class}  feasibility=${f.verdict}  described=${r._described ? 'yes' : 'NO (title only)'}\n`
    + `    components=${JSON.stringify(r.ranking.components)}\n`
    + (f.unknowns && f.unknowns.length ? `    missing=${f.unknowns.map((u) => u.check || u).join(', ')}\n` : '')
    + '\n',
  );
});

const jsonOut = arg('json', null);
if (jsonOut) {
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({
    generated_at: new Date().toISOString(),
    today,
    waves,
    description_source: descSource,
    described,
    total: rows.length,
    tiers,
    product_classes: classes,
    shortlist: shortlist.map((r) => ({
      solicitation_number: r.solicitation_number,
      notice_id: r.notice_id,
      title: r.title,
      agency: r.agency,
      response_deadline: r.response_deadline,
      set_aside: r.set_aside,
      naics: r.naics_code,
      psc: r.psc_code,
      notice_type: r.notice_type,
      link: r.source_url,
      described: r._described,
      ranking: r.ranking,
      feasibility: r._feas,
    })),
  }, null, 2));
  process.stdout.write(`wrote ${jsonOut}\n`);
}
