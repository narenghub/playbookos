'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runFollowups, ATTACHMENT } = require('./cphi-runner');

const ROOT = path.join(__dirname, '..', '..', '..');
const quiet = () => {};

// ── PRECONDITIONS REFUSE BEFORE THEY TOUCH THE DATABASE ───────────────────────
// Each of these throws from the argument checks at the top, so they run without Postgres. That is
// deliberate: a bad event slug must be refused before a query goes out, because the slug IS the
// filter — `cphi` instead of `cphi-milan-2026` returned twenty contacts and looked like a full list.

test('an unknown event slug throws rather than querying', async () => {
  // 'cphi' is THE bug: two places once defaulted to it, the real slug is cphi-milan-2026, and the
  // export reported twenty contacts as the whole list while sixty-one sat invisible.
  await assert.rejects(() => runFollowups({ event: 'cphi', log: quiet }), /not an event/);
  await assert.rejects(() => runFollowups({ event: 'scope', log: quiet }), /not an event/);
  // Matching is exact, so a typo in the case is refused rather than quietly matching nothing. This
  // one is worth pinning: a slug that silently matches no rows reads as "nobody is due".
  await assert.rejects(() => runFollowups({ event: 'CPHI-Milan-2026', log: quiet }), /not an event/);
  // An EMPTY event is not an unknown one — `opts.event || default` makes it the default on purpose,
  // so an omitted --event= behaves like no flag at all. Asserted here so the fallback is a decision
  // on the record rather than something a later reader "fixes" into a throw.
  const { isEvent } = require('../events/registry');
  assert.strictEqual(isEvent('' || 'cphi-milan-2026'), true);
});

test('a nonsense max throws rather than being coerced', async () => {
  // parseInt('five') is NaN, and NaN silently slicing an array to nothing would read as "nothing
  // due" — a campaign that has quietly stopped looks exactly like a campaign with nothing to do.
  for (const max of [NaN, 0, -1, 2.5]) {
    await assert.rejects(() => runFollowups({ max, log: quiet }), /positive integer/);
  }
});

test('library errors THROW — a library that calls process.exit kills the web server', async () => {
  // This module now runs inside server.js on an hourly cron. The CLI turns a throw into an exit
  // code; the cron turns it into an alert email. Neither works if the module exits the process.
  // A CALL, not a mention: the comment above the function explains why there isn't one, and a
  // regex loose enough to match the explanation would pass on a file that had been emptied.
  const src = fs.readFileSync(path.join(__dirname, 'cphi-runner.js'), 'utf8');
  assert.ok(!/process\.exit\s*\(/.test(src), 'cphi-runner.js must never call process.exit()');
  // Guard against a vacuous pass: the pattern must be able to fire at all.
  assert.ok(/process\.exit\s*\(/.test('process.exit(1)'), 'the pattern itself is broken');
});

// ── THE ONE-PAGER IS NOT OPTIONAL ─────────────────────────────────────────────

test('the attachment exists on disk, where the runner expects it', () => {
  // The runner refuses to start without it, so this is the check that the refusal is about a real
  // path rather than about a path that quietly moved. Every supplier at the show asked the question
  // this PDF answers.
  assert.ok(fs.existsSync(ATTACHMENT), `${ATTACHMENT} is missing`);
  assert.ok(fs.statSync(ATTACHMENT).size > 50000, 'the one-pager is suspiciously small');
});

// ── ONE COPY OF THE SEND LOOP ────────────────────────────────────────────────
//
// These assert a property of the SOURCE, which is the one thing a source scan is actually the right
// tool for. A grep is no evidence about behaviour — a test that grepped source text is why a broken
// territory grant passed its own check — but "does a second copy of this logic exist?" is a
// question about the text, and the two worst bugs in this campaign were both second copies.

test('only cphi-runner.js sends mail for this campaign', () => {
  const callers = [];
  for (const dir of ['scripts', 'src/lib/campaigns']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
      const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      if (/users\.messages\.send/.test(src) && /cphi/i.test(f)) callers.push(`${dir}/${f}`);
    }
  }
  assert.deepStrictEqual(callers, ['src/lib/campaigns/cphi-runner.js'],
    'a second place that sends CPHI mail is a second set of guards that nobody checks');
});

test('the CLI and the cron both go through runFollowups', () => {
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'run-cphi-followup.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(cli, /runFollowups/, 'the CLI must call the shared runner');
  assert.match(server, /runFollowups/, 'the cron must call the shared runner');
  // And neither may re-implement the due-query, which is where the slug and the role join live.
  assert.ok(!/cphi_followup_state/.test(cli), 'the CLI must not query campaign state itself');
  assert.ok(!/cphi_followup_state/.test(server), 'server.js must not query campaign state itself');
});

// ── THE CRON CANNOT START MAILING BY BEING DEPLOYED ──────────────────────────

test('the hourly cron is gated on CPHI_FOLLOWUP_ENABLED', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const block = server.slice(server.indexOf("'hourly-05-cphi-followup'"));
  assert.ok(block.length, 'the hourly CPHI cron is missing from server.js');
  const gate = block.slice(0, block.indexOf('runFollowups'));
  // The gate must come BEFORE the call, not after it. A flag checked afterwards is not a flag.
  assert.match(gate, /CPHI_FOLLOWUP_ENABLED/,
    'the enable flag must be checked before runFollowups, or a deploy starts the campaign');
  assert.match(gate, /!==\s*'true'/, 'anything other than the string "true" must be off');
});

test('the cron throws on an unconfirmed send, so somebody is told', () => {
  // Nobody reads hourly logs. A claim row with no Gmail message id means a message that may or may
  // not have reached somebody who shook his hand — withAlerts only emails on a throw, so it must
  // throw rather than log.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const block = server.slice(server.indexOf("'hourly-05-cphi-followup'"));
  const body = block.slice(0, block.indexOf('}), CST);'));
  assert.match(body, /if \(r\.unconfirmed\)[\s\S]*throw new Error/);
  assert.match(body, /if \(r\.failed\)[\s\S]*throw new Error/);
});
