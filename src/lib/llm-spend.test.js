// ── NO MODEL CALL MAY GO UNMETERED ───────────────────────────────────────────
//
//   node --test src/lib/llm-spend.test.js
//
// Eight agents each carried their own 12-line `callClaude` that fetched api.anthropic.com
// directly. They were copies of one another, and every one of them sat outside llm.js — outside
// the `llm.call` kill switch, outside the request timeout, and invisible to any spend figure.
//
// A written rule did not stop the count reaching eight. A failing test will.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// EXACTLY ONE file may name the endpoint. llm.js is the transport; llm-spend.js is the meter that
// wraps it and does not name it, which the negative control below depends on — an exemption for a
// file that never needed one is an exemption that would silently cover a future direct call.
const TRANSPORT = new Set([path.join(ROOT, 'lib', 'llm.js')]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

// This file's own subject is the forbidden string, and so are the notes left at each converted
// call site explaining what they used to be. Scanning comments would fail on the explanation of
// the rule — which has broken five source-reading tests in this repository already.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

test('nothing outside llm.js and llm-spend.js calls the Anthropic API directly', () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    if (TRANSPORT.has(file)) continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (/api\.anthropic\.com/.test(line)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepStrictEqual(offenders, [],
    `${offenders.length} direct call(s) to the Anthropic API outside the transport. Each one is `
    + `outside the llm.call kill switch, outside the timeout, and invisible to spend. Use `
    + `meteredCall({ agent, model, prompt }) from src/lib/llm-spend.js:\n  ${offenders.join('\n  ')}`);
});

test('the scanner is actually reading source — negative control', () => {
  // A walk that returns nothing reports zero offenders and passes forever.
  const files = walk(ROOT);
  assert.ok(files.length > 50, `the walk found only ${files.length} files`);
  for (const f of TRANSPORT) {
    assert.ok(fs.existsSync(f), `${f} is missing — the transport moved and this guard is stale`);
    assert.match(stripComments(fs.readFileSync(f, 'utf8')), /api\.anthropic\.com/,
      `${path.basename(f)} no longer names the endpoint, so the exemption points at the wrong file `
      + 'and the real transport is being scanned as if it were a call site');
  }
  // And the meter must NOT be exempt: it reaches the API only through llm.js. If it ever grows its
  // own fetch, the rule above must catch it like any other file.
  assert.ok(!TRANSPORT.has(path.join(ROOT, 'lib', 'llm-spend.js')),
    'the meter is exempt from its own rule');

  // Fed a synthetic offender, the line matcher must flag exactly it.
  const sample = ['const a = 1;', "await fetch('https://api.anthropic.com/v1/messages');", 'const b = 2;'];
  const hit = sample.map((l, i) => (/api\.anthropic\.com/.test(l) ? i + 1 : 0)).filter(Boolean);
  assert.deepStrictEqual(hit, [2]);
});

test('every agent that calls the model names itself', () => {
  // `agent` is what turns a total into something actionable. meteredCall refuses without one, and
  // this checks no call site passes a placeholder that satisfies the check while saying nothing.
  const bad = [];
  for (const file of walk(ROOT)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/agent:\s*'([^']*)'/g)) {
      if (/^(unknown|todo|tbd|agent|x|test|)$/i.test(m[1])) bad.push(`${path.relative(ROOT, file)}: '${m[1]}'`);
    }
  }
  assert.deepStrictEqual(bad, [], `placeholder agent labels: ${bad.join(', ')}`);
});

// ── THE METER ITSELF ────────────────────────────────────────────────────────

const SPEND = require('./llm-spend');

function fakeQuery() {
  const rows = [];
  const fn = async (sql, params) => { rows.push({ sql, params }); return { rows: [] }; };
  fn.rows = rows;
  return fn;
}

test('an unattributed call is refused outright', async () => {
  await assert.rejects(() => SPEND.meteredCall({ model: 'claude-haiku-4-5-20251001', prompt: 'x' }),
    /requires an `agent`/);
});

test('a call with no model is refused — llm.js has no default on purpose', async () => {
  await assert.rejects(() => SPEND.meteredCall({ agent: 'a', prompt: 'x' }), /requires a `model`/);
});

test('an unmeasured call is filed as UNKNOWN, never as zero', async () => {
  // The whole reason the table has cost_known. A call that was attempted but returned no usage
  // block may have spent tokens; filing it as 0 is a claim that it did not, and a report that
  // sums its way past it under-reports by exactly the amount it could not see.
  const q = fakeQuery();
  await SPEND.recordSpend({ agent: 'a', model: 'm', costUsd: null, costKnown: false }, { query: q });
  const p = q.rows[0].params;
  assert.strictEqual(p[6], null, 'an unknown cost was written as a number');
  assert.strictEqual(p[7], false, 'an unknown cost was marked known');
});

test('a known cost is written with its value, and a missing one defaults to a real zero', async () => {
  // Negative control for the test above: if costKnown were always false, nothing would ever be
  // counted and the previous assertion would still pass.
  const q = fakeQuery();
  await SPEND.recordSpend({ agent: 'a', model: 'm', costUsd: 0.0042, costKnown: true }, { query: q });
  assert.strictEqual(q.rows[0].params[6], 0.0042);
  assert.strictEqual(q.rows[0].params[7], true);

  await SPEND.recordSpend({ agent: 'a', model: 'm', costKnown: true }, { query: q });
  assert.strictEqual(q.rows[1].params[6], 0,
    'a known cost with no value must be a real 0, not null — the CHECK refuses the pair');
});

test('an unwritable ledger does not take down the agent, but is not silent either', async () => {
  // Losing the measurement is bad. Losing the briefing the agent was in the middle of is worse.
  const boom = async () => { throw new Error('relation "llm_spend_log" does not exist'); };
  const logged = [];
  const realError = console.error;
  console.error = (m) => logged.push(String(m));
  try {
    const okFlag = await SPEND.recordSpend({ agent: 'ceo-agent', model: 'm', costKnown: true, costUsd: 0 },
      { query: boom });
    assert.strictEqual(okFlag, false, 'a failed write reported success');
  } finally { console.error = realError; }

  assert.strictEqual(logged.length, 1, 'a failed spend write was swallowed silently');
  assert.match(logged[0], /SPEND UNRECORDED/);
  assert.match(logged[0], /ceo-agent/, 'the log line does not name the agent, so nobody can fix it');
  assert.match(logged[0], /does not exist/, 'the log line does not carry the reason');
});

test('meteredCall returns the transport result untouched', async () => {
  // Every caller is a cron mid-run and llm.callClaude never throws. Wrapping must not change the
  // envelope, or eight agents start handling a shape they were not written for.
  const llm = require('./llm');
  const real = llm.callClaude;
  llm.callClaude = async () => ({ text: 'hello', usage: { input_tokens: 10, output_tokens: 3 },
    costUsd: 0.001, costKnown: true });
  try {
    const q = fakeQuery();
    const r = await SPEND.meteredCall({ agent: 'a', model: 'claude-haiku-4-5-20251001', prompt: 'x' },
      { query: q });
    assert.strictEqual(r.text, 'hello');
    assert.strictEqual(r.costUsd, 0.001);
    assert.strictEqual(q.rows.length, 1, 'the call was not recorded');
    assert.strictEqual(q.rows[0].params[0], 'a');
    assert.strictEqual(q.rows[0].params[4], 10, 'input tokens were not recorded');
    assert.strictEqual(q.rows[0].params[5], 3, 'output tokens were not recorded');
  } finally { llm.callClaude = real; }
});

test('a call refused by the kill switch is still recorded', async () => {
  // Otherwise "spend went to zero" and "the agents stopped running" look identical in this table,
  // and the one number that would tell them apart is the one that is missing.
  const llm = require('./llm');
  const real = llm.callClaude;
  llm.callClaude = async () => ({ error: 'STOPPED_BY_POLICY: global', stopped: true,
    costUsd: 0, costKnown: true });
  try {
    const q = fakeQuery();
    await SPEND.meteredCall({ agent: 'sales-agent', model: 'claude-haiku-4-5-20251001', prompt: 'x' },
      { query: q });
    assert.strictEqual(q.rows.length, 1, 'a refused call left no trace');
    assert.strictEqual(q.rows[0].params[8], false, 'a refused call was recorded as ok');
    assert.match(String(q.rows[0].params[9]), /STOPPED_BY_POLICY/);
    assert.strictEqual(q.rows[0].params[6], 0, 'a refusal spent nothing — that is a known zero');
  } finally { llm.callClaude = real; }
});
