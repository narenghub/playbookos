#!/usr/bin/env node
// ── Does the SPA parse? THE VERDICT IS THE EXIT CODE. ─────────────────────────
//
// Exit 0 = every inline script parses. Exit 1 = at least one does not, and the app renders NOTHING.
//
// READ THE EXIT CODE, NOT THE OUTPUT. This script already printed the right answer on 2026-09-30 and
// production still went down for hours, because it was run as `node spa-check.js | tail -1`: block 1 said
// "Unexpected identifier 'outreachPage'", block 6 said OK, and tail showed the OK. A per-block report piped
// through tail is not a verdict. The verdict lives here, in the exit status, where truncation cannot reach
// it.
//
//   node scripts/check-spa-parse.js [file]     # default: public/index.html
//   node scripts/check-spa-parse.js --url https://app.playnexa.ai/
//
// The same logic is also a unit test (src/lib/spa-parses.test.js) so it runs on every commit. This script
// exists for the deployed case, which a test cannot reach.

const fs = require('fs');
const path = require('path');

// The app's entry points. A file can parse perfectly and still be the wrong file — an empty page, an error
// page, a CDN interstitial — so "it parsed" is not enough on its own.
const ENTRY_POINTS = [
  { re: /const API = \(path, opts=\{\}\) =>/, what: 'the API helper' },
  { re: /window\.addEventListener\('load'/, what: 'the boot listener' },
  { re: /async function checkAuth\(\)/, what: 'checkAuth (the auth gate)' },
  { re: /async function buildNav\(\)/, what: 'buildNav' },
  { re: /const pages = \{/, what: 'the pages object' },
];

function inlineBlocks(src) {
  return [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => ({
    code: m[1], line: src.slice(0, m.index).split('\n').length, chars: m[1].length,
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  let src, label;
  if (urlIdx !== -1) {
    const url = args[urlIdx + 1];
    if (!url) { console.error('--url needs a URL'); process.exit(2); }
    const r = await fetch(url).catch(e => ({ ok: false, status: 0, statusText: e.message }));
    if (!r.ok) { console.error(`FAIL  could not fetch ${url}: ${r.status} ${r.statusText || ''}`); process.exit(1); }
    src = await r.text();
    label = url;
  } else {
    const file = args[0] || path.join(__dirname, '..', 'public', 'index.html');
    if (!fs.existsSync(file)) { console.error(`FAIL  no such file: ${file}`); process.exit(2); }
    src = fs.readFileSync(file, 'utf8');
    label = path.relative(process.cwd(), file);
  }

  const blocks = inlineBlocks(src);
  console.log(`${label} — ${src.length} bytes, ${blocks.length} inline script block(s)`);
  const failures = [];
  if (blocks.length < 5) failures.push(`only ${blocks.length} inline blocks — this does not look like the SPA`);
  for (const b of blocks) {
    try { new Function(b.code); console.log(`  ok    line ${String(b.line).padStart(5)}  ${b.chars} chars`); }
    catch (e) {
      console.log(`  FAIL  line ${String(b.line).padStart(5)}  ${b.chars} chars  — ${e.message}`);
      failures.push(`index.html:${b.line} — ${e.message}`);
    }
  }
  for (const ep of ENTRY_POINTS) {
    if (ep.re.test(src)) console.log(`  ok    entry point: ${ep.what}`);
    else { console.log(`  FAIL  MISSING entry point: ${ep.what}`); failures.push(`missing ${ep.what}`); }
  }

  if (failures.length) {
    console.error(`\nFAIL — ${failures.length} problem(s). The application will not render.`);
    failures.forEach(f => console.error(`  ${f}`));
    process.exit(1);
  }
  console.log('\nPASS — every inline block parses and every entry point is present');
  process.exit(0);
}
main().catch(e => { console.error('FAIL  ' + (e && e.message)); process.exit(1); });
