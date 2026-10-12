#!/usr/bin/env node
// ── BUILD assets/abiozen-model.pdf FROM ITS HTML SOURCE ───────────────────────
//
//   node scripts/build-one-pager.js            → rebuilds the PDF, reports the result
//   node scripts/build-one-pager.js --check     → fails if the PDF is older than the source
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

const SRC = path.join(__dirname, '..', 'assets', 'abiozen-model.src.html');
const OUT = path.join(__dirname, '..', 'assets', 'abiozen-model.pdf');
const CHECK = process.argv.includes('--check');

async function main() {
  if (!fs.existsSync(SRC)) { console.log(`✗ no source at ${SRC}`); process.exit(1); }

  if (CHECK) {
    if (!fs.existsSync(OUT)) { console.log('✗ the PDF does not exist — run without --check'); process.exit(1); }
    const srcT = fs.statSync(SRC).mtimeMs;
    const outT = fs.statSync(OUT).mtimeMs;
    if (srcT > outT) {
      console.log('✗ abiozen-model.src.html is NEWER than abiozen-model.pdf');
      console.log('  The attachment every contact receives would not match its own source.');
      console.log('  Rebuild:  node scripts/build-one-pager.js');
      process.exit(1);
    }
    console.log('  ok    the one-pager PDF is current with its source');
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
  const text = fs.readFileSync(SRC, 'utf8');
  const role = (text.match(/<span class="role">([^<]+)</) || [])[1] || '(none)';
  console.log(`✅ abiozen-model.pdf rebuilt — ${size.toLocaleString()} bytes`);
  console.log(`   signature role: ${role}`);
}

main().catch((e) => { console.error('build-one-pager failed:', e && e.message ? e.message : e); process.exit(1); });
