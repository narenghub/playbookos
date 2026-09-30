// No retired status value may survive anywhere that writes outreach.
//
//   node --test src/lib/outreach/no-retired-statuses.test.js
//
// WHY THIS EXISTS: expanding the vocabulary to ten values left 'new', 'in_progress' and 'interested' behind
// in THREE separate live-verify scripts. Each one then failed in the least useful way available — the write
// was refused with a 400, and every assertion after it measured the absence, so one stale string produced
// six confusing mismatches and named none of them. The scripts are not in the test suite, so nothing caught
// it until each was run by hand against production.
//
// A retired value is findable. This makes it findable automatically, on the next change as well as this one.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { LEGACY_STATUS_MAP, STATUSES, CHANNELS } = require('./registry');

const ROOT = path.join(__dirname, '../../..');
// Everything retired: the values with a mapping, plus 'interested', which deliberately has none.
const RETIRED = [...Object.keys(LEGACY_STATUS_MAP), 'interested'];

// A line may legitimately name a retired value or a channel-as-status — the tests that assert those are
// REFUSED have to write one to refuse it. Such a line carries an explicit marker, so every exemption is
// visible in the diff rather than hidden behind an excluded filename. Excluding whole files instead would
// have exempted every future line in them too.
const ALLOW = 'vocabulary-guard: deliberate';
const exempt = (lines, i) => lines[i].includes(ALLOW) || (i > 0 && lines[i - 1].includes(ALLOW));

function sources() {
  const out = [];
  for (const dir of ['scripts', 'src']) {
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue; }
        if (!/\.js$/.test(e.name)) continue;
        out.push(rel);
      }
    };
    walk(dir);
  }
  return out;
}

// Only files that actually write or assert outreach status — a generic sweep for the word 'new' across the
// repo would drown in false positives and get deleted.
const OUTREACH_FILES = sources().filter(f => {
  if (/outreach\/registry\.js$|no-retired-statuses\.test\.js$|migrate-outreach-vocabulary\.js$/.test(f)) return false;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  return /setStatus|\/api\/outreach|outreach\/summary|entity_type\s*:/.test(src);
});

test('the sweep actually found the files it is supposed to police', () => {
  // A filter this narrow can quietly match nothing, at which point every assertion below passes over an
  // empty list. That is the failure mode of a guard, so it is asserted first.
  assert.ok(OUTREACH_FILES.length >= 4, `expected several outreach files, found: ${OUTREACH_FILES.join(', ')}`);
  for (const want of ['scripts/verify-outreach-live.js', 'scripts/verify-outreach-ui-live.js',
                      'scripts/verify-outreach-newlists-live.js']) {
    assert.ok(OUTREACH_FILES.includes(want), `${want} must be covered — all three carried a stale value`);
  }
});

test('no retired status is passed as a status, anywhere that writes outreach', () => {
  const bad = [];
  for (const f of OUTREACH_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment may name what was retired
      if (exempt(lines, i)) return;
      for (const dead of RETIRED) {
        // `status: 'x'`, `status='x'`, and a bare `'x'` in a setStatus/mark argument list.
        const re = new RegExp(`(status|to_status|from_status)\\s*[:=]\\s*'${dead}'|` +
                              `\\b(mark|setStatus)\\([^)]*'${dead}'`);
        if (re.test(line)) bad.push(`${f}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(bad, [], `retired status values still being written:\n${bad.join('\n')}`);
});

test("no code reads counts under a retired key, which is how a bar silently shows undefined", () => {
  // `counts.new` does not throw — it is undefined, and the check that consumes it reports a number mismatch
  // rather than a missing key. Three scripts asserted `counts.new` against a real total and failed opaquely.
  const bad = [];
  for (const f of OUTREACH_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (exempt(lines, i)) return;
      for (const dead of RETIRED) {
        if (new RegExp(`counts\\.${dead}\\b|counts\\['${dead}'\\]|by_status\\.${dead}\\b`).test(line)) {
          bad.push(`${f}:${i + 1}  ${line.trim()}`);
        }
      }
    });
  }
  assert.deepEqual(bad, [], `counts read under a retired key:\n${bad.join('\n')}`);
});

test('and no CHANNEL is being written as though it were a status', () => {
  // The two-field split only holds if nothing sets 'email' or 'phone' as a stage.
  const bad = [];
  for (const f of OUTREACH_FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (exempt(lines, i)) return;
      for (const ch of CHANNELS) {
        if (new RegExp(`(?<!_)status\\s*[:=]\\s*'${ch}'`).test(line)) bad.push(`${f}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(bad, [], `a channel used as a status:\n${bad.join('\n')}`);
});

test('the guard would catch a real regression, not just pass over clean files', () => {
  // Proving the regexes bite, rather than trusting that they do. This is the same reason the vocabulary
  // tests were mutation-checked: a guard that cannot fail is decoration.
  const lines = ["  const r = await mark(u, 'prospect', id, 'interested');",
                 "  hit('PUT','/api/outreach',{entity_type:'study',status:'in_progress'});",
                 "  check('rest', bar.body.counts.new, total - 1);",
                 "  hit('PUT','/api/outreach',{status:'email'});"];
  const hits = lines.filter(line => {
    for (const dead of [...RETIRED]) {
      if (new RegExp(`(status|to_status|from_status)\\s*[:=]\\s*'${dead}'|\\b(mark|setStatus)\\([^)]*'${dead}'`).test(line)) return true;
      if (new RegExp(`counts\\.${dead}\\b`).test(line)) return true;
    }
    for (const ch of CHANNELS) if (new RegExp(`(?<!_)status\\s*[:=]\\s*'${ch}'`).test(line)) return true;
    return false;
  });
  assert.equal(hits.length, 4, `each of these should be caught, caught ${hits.length}:\n${hits.join('\n')}`);
  // And a legitimate line must NOT trip it.
  const ok = "  const r = await mark(u, 'prospect', id, 'not_interested', null, 'email');";
  for (const dead of RETIRED) {
    assert.ok(!new RegExp(`(status|to_status|from_status)\\s*[:=]\\s*'${dead}'`).test(ok),
      `'not_interested' must not match the retired '${dead}' — substring matching would make this guard unusable`);
  }
  assert.ok(STATUSES.includes('not_interested'));
});

test('the exemption is used sparingly, and only where a refusal is being asserted', () => {
  // An escape hatch that spreads stops being an exemption and becomes the rule. Counted, so its growth is
  // visible; every current use is a test that writes a bad value in order to check it is rejected.
  const uses = [];
  for (const f of sources()) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => { if (line.includes(ALLOW)) uses.push(`${f}:${i + 1}`); });
  }
  assert.ok(uses.length <= 6, `${uses.length} exemptions is too many:\n${uses.join('\n')}`);
  for (const u of uses) assert.match(u, /\.test\.js:/, `${u} — only a test may exempt itself`);
});
