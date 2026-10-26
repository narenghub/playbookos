#!/usr/bin/env node
// ── 37 PEOPLE ASKED TO BUY. ONE WAS QUOTED. WHY? ─────────────────────────────
//
//   railway ssh 'node scripts/triage-inquiries.js'
//   railway ssh 'node scripts/triage-inquiries.js --days=90 --all'
//
// Read-only.
//
// ── WHY THIS IS THE MOST VALUABLE REPORT IN THE REPO ─────────────────────────
//
// Generating demand is the expensive part. Trade show travel, campaigns, a marketplace, SEO — all
// of it exists to make somebody ask for a price. That happened 37 times, 14 of them in the last
// thirty days, and one quote came out of it.
//
// Chasing new leads while 36 unanswered ones sit in a table is spending money to recreate
// something already owned. So before any new outreach, this asks of each inquiry: who, what, how
// old, and — the part that decides everything — CAN WE ACTUALLY SOURCE IT?
//
// That last question is answerable right now, offline, because the supplier catalogue is already
// parsed and classified. An inquiry for a molecule sitting in supplier_products is a quote that
// could be written this morning. An inquiry for something nobody stocks is a different problem and
// deserves a different answer — usually an honest "we can't", which is still worth sending.
'use strict';

const { initDB, query } = require('../src/lib/db');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const DAYS = Math.max(1, Math.min(3650, parseInt(arg('days', '365'), 10) || 365));

const say = (s = '') => console.log(s);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function main() {
  await initDB();

  const rows = (await query(`
    SELECT i.*, (SELECT COUNT(*)::int FROM inquiry_quotes q WHERE q.inquiry_id = i.id) quotes
      FROM inquiries i
     WHERE i.created_at::text >= to_char(NOW() - ($1 || ' days')::interval, 'YYYY-MM-DD')
     ORDER BY i.created_at DESC`, [String(DAYS)])).rows;

  say(`\n── inquiry triage · last ${DAYS} days\n`);
  if (!rows.length) { say('   no inquiries in this window.\n'); process.exit(0); }

  const quoted = rows.filter((r) => r.quotes > 0);
  const unquoted = rows.filter((r) => !r.quotes);
  say(`   ${rows.length} inquiry(ies) · ${quoted.length} quoted · ${unquoted.length} NOT quoted\n`);

  // ── CAN WE SOURCE IT? ────
  // The supplier catalogue is already parsed and classified, so this is answerable offline. A
  // match here means a quote could be written today without asking anybody anything.
  const cat = (await query(`
    SELECT molecule_name, cas, supplier, use_class, review_status FROM supplier_products`)).rows;
  const byName = new Map();
  const byCas = new Map();
  for (const p of cat) {
    const k = norm(p.molecule_name);
    if (k) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p); }
    if (p.cas) { if (!byCas.has(p.cas)) byCas.set(p.cas, []); byCas.get(p.cas).push(p); }
  }

  function sourceable(r) {
    if (r.cas_number && byCas.has(String(r.cas_number).trim())) return byCas.get(String(r.cas_number).trim());
    const k = norm(r.molecule_name);
    if (k && byName.has(k)) return byName.get(k);
    // partial: the catalogue name contains the asked-for name or vice versa
    if (k && k.length >= 5) {
      for (const [ck, v] of byName) if (ck.includes(k) || k.includes(ck)) return v;
    }
    return null;
  }

  const age = (d) => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);

  // ── THE ONES WORTH ANSWERING TODAY ────
  const canQuote = [];
  const cannot = [];
  for (const r of unquoted) {
    const m = sourceable(r);
    (m ? canQuote : cannot).push({ r, m });
  }

  say('   ══ CAN BE QUOTED TODAY — the molecule is in our supplier catalogue ═══');
  if (!canQuote.length) say('      (none)');
  for (const { r, m } of canQuote) {
    const sup = [...new Set(m.map((x) => x.supplier).filter(Boolean))];
    const approved = m.some((x) => x.review_status === 'approved');
    say(`      ${pad(`${age(r.created_at)}d`, 6)}${pad(r.molecule_name || '(no molecule named)', 30)}`
      + `${pad(`${r.quantity_requested || '?'} ${r.quantity_unit || ''}`.trim(), 12)}`
      + `${pad(r.buyer_company || r.buyer_name || '(no company)', 26)}${r.status || ''}`);
    say(`             ↳ ${m.length} catalogue match(es)`
      + `${sup.length ? ` from ${sup.slice(0, 3).join(', ')}` : ''}`
      + `${approved ? ' · APPROVED for sale' : ' · not yet approved'}`);
    if (r.buyer_email) say(`             ↳ ${r.buyer_email}`);
  }

  say('\n   ══ NOT IN THE CATALOGUE — needs sourcing, or an honest no ══════════');
  if (!cannot.length) say('      (none)');
  for (const { r } of cannot.slice(0, 40)) {
    say(`      ${pad(`${age(r.created_at)}d`, 6)}${pad(r.molecule_name || '(no molecule named)', 30)}`
      + `${pad(`${r.quantity_requested || '?'} ${r.quantity_unit || ''}`.trim(), 12)}`
      + `${pad(r.buyer_company || r.buyer_name || '(no company)', 26)}${r.status || ''}`);
  }

  // ── WHO ARE THESE PEOPLE? ────
  say('\n   ══ WHERE THEY CAME FROM ════════════════════════════════════════════');
  const bySource = (await query(`
    SELECT COALESCE(NULLIF(source,''),'(unknown)') s, COUNT(*)::int n,
           COUNT(*) FILTER (WHERE id IN (SELECT inquiry_id FROM inquiry_quotes))::int quoted
      FROM inquiries GROUP BY 1 ORDER BY n DESC`)).rows;
  for (const r of bySource) say(`      ${pad(r.s, 28)} ${pad(r.n, 6)} quoted ${r.quoted}`);

  const byStatus = (await query(`
    SELECT COALESCE(NULLIF(status,''),'(none)') s, COUNT(*)::int n FROM inquiries GROUP BY 1 ORDER BY n DESC`)).rows;
  say('\n      status:');
  for (const r of byStatus) say(`      ${pad(r.s, 28)} ${r.n}`);

  // ── THE READ ────
  say('\n   ══ WHAT TO DO ══════════════════════════════════════════════════════');
  const oldest = unquoted.length ? age(unquoted[unquoted.length - 1].created_at) : 0;
  if (canQuote.length) {
    say(`      ${canQuote.length} inquiry(ies) name a molecule already in the supplier catalogue.`);
    say('      Those are quotes that can be written today with no new information.');
  }
  if (cannot.length) {
    say(`      ${cannot.length} ask for something not in the catalogue. Each deserves a reply even`);
    say('      if the reply is no — a buyer who hears "we cannot source that" comes back; one who');
    say('      hears nothing does not.');
  }
  if (oldest > 30) {
    say(`\n      ⚠ the oldest unanswered inquiry is ${oldest} days old. Past about a week these stop`);
    say('        being leads and become complaints.');
  }
  say('');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('triage-inquiries failed:', e && e.message ? e.message : e);
  process.exit(1);
});
