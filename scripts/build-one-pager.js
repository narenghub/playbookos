#!/usr/bin/env node
// ── BUILD assets/abiozen-model.pdf FROM ITS HTML SOURCE ───────────────────────
//
//   node scripts/build-one-pager.js            → rebuilds the PDF, reports the result
//   node scripts/build-one-pager.js --check     → fails if the PDF was not built from THIS source
//
// --check used to compare mtimes, and that was wrong in both directions. Git does not preserve
// mtimes, so after a clone or a pull the relative order of two files depends on checkout order, not
// on content: the same commit went GREEN in CI and RED on a developer's Mac on 2026-11-06. The
// dangerous direction is the other one — touching the PDF, or a checkout that happens to write it
// last, makes the check PASS while the PDF is genuinely stale. A release gate whose verdict depends
// on filesystem timestamps is not a release gate.
//
// So the build records the sha256 of the SOURCE it rendered, in a committed sidecar, and --check
// compares that recording against the source as it stands. Content, not clocks. A missing or
// unreadable sidecar is a FAILURE, not a pass: "I cannot tell" must never read as "it matches".
//
// The one-pager is attached to step 1 of all three sequences, so it is read by every contact who
// shook Naren's hand at CPHI. It was first produced by hand, with no recorded command — which meant
// the HTML and the PDF could disagree and nothing would say so. On 12 Oct the title in the
// signature changed from "Chief Executive Officer" to "Director" to match his business card, and
// an un-rebuilt PDF would have contradicted the email it was attached to.
//
// A4, no margins (the source lays out its own), background graphics on, one page.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'assets', 'abiozen-model.src.html');
const OUT = path.join(__dirname, '..', 'assets', 'abiozen-model.pdf');
const STAMP = OUT + '.built-from.json';
const CHECK = process.argv.includes('--check');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function main() {
  if (!fs.existsSync(SRC)) { console.log(`✗ no source at ${SRC}`); process.exit(1); }

  if (CHECK) {
    if (!fs.existsSync(OUT)) { console.log('✗ the PDF does not exist — run without --check'); process.exit(1); }
    if (!fs.existsSync(STAMP)) {
      console.log(`✗ no build record at ${path.basename(STAMP)}`);
      console.log('  Without it there is no way to tell whether the PDF matches this source, and');
      console.log('  "cannot tell" is not "matches".');
      console.log('  Rebuild:  node scripts/build-one-pager.js');
      process.exit(1);
    }
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    } catch (e) {
      console.log(`✗ the build record is unreadable: ${e.message}`);
      process.exit(1);
    }
    if (typeof rec.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rec.source_sha256)) {
      console.log('✗ the build record carries no usable source_sha256');
      process.exit(1);
    }
    const now = sha256(SRC);
    if (now !== rec.source_sha256) {
      console.log('✗ abiozen-model.pdf was not built from the current source');
      console.log(`    source now   ${now.slice(0, 16)}…`);
      console.log(`    PDF built from ${rec.source_sha256.slice(0, 16)}…  (${rec.built_at || 'no date'})`);
      console.log('  The attachment every contact receives would not match its own source.');
      console.log('  Rebuild:  node scripts/build-one-pager.js');
      process.exit(1);
    }
    // The PDF's own hash is recorded too, so a corrupted or truncated PDF is caught as well as a
    // stale one. A matching source with a mangled attachment is still a bad attachment.
    if (typeof rec.pdf_sha256 === 'string' && /^[0-9a-f]{64}$/.test(rec.pdf_sha256)) {
      const pdfNow = sha256(OUT);
      if (pdfNow !== rec.pdf_sha256) {
        console.log('✗ abiozen-model.pdf has changed since it was built from this source');
        console.log(`    PDF now ${pdfNow.slice(0, 16)}…  recorded ${rec.pdf_sha256.slice(0, 16)}…`);
        console.log('  Rebuild:  node scripts/build-one-pager.js');
        process.exit(1);
      }
    }
    console.log('  ok    the one-pager PDF was built from this exact source');
    return;
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('file://' + SRC, { waitUntil: 'load' });
    await page.pdf({
      path: OUT, format: 'A4', printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await browser.close();
  }

  const size = fs.statSync(OUT).size;
  // A blank or half-rendered page is small. The real document has been ~127 kB; anything far under
  // that means the render failed quietly, which is the failure mode worth catching here.
  if (size < 40000) {
    console.log(`✗ ${OUT} is only ${size} bytes — the render probably failed.`);
    process.exit(1);
  }
  // Only now, AFTER the render has been validated. A stamp written beside a failed render would
  // make the next --check pass over a broken attachment, which is the whole failure this guards.
  const srcHash = sha256(SRC);
  const pdfHash = sha256(OUT);
  fs.writeFileSync(STAMP, `${JSON.stringify({
    source: path.basename(SRC),
    source_sha256: srcHash,
    pdf_sha256: pdfHash,
    pdf_bytes: size,
    built_at: new Date().toISOString(),
    note: 'Written by scripts/build-one-pager.js. --check compares source_sha256 against the '
        + 'source as it stands. Do not edit by hand; rebuild instead.',
  }, null, 2)}\n`);

  const text = fs.readFileSync(SRC, 'utf8');
  const role = (text.match(/<span class="role">([^<]+)</) || [])[1] || '(none)';
  console.log(`✅ abiozen-model.pdf rebuilt — ${size.toLocaleString()} bytes`);
  console.log(`   signature role: ${role}`);
  console.log(`   source sha256:  ${srcHash.slice(0, 16)}…  recorded in ${path.basename(STAMP)}`);
}

main().catch((e) => { console.error('build-one-pager failed:', e && e.message ? e.message : e); process.exit(1); });
