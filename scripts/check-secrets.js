#!/usr/bin/env node
// ── REFUSE TO SHIP A COMMITTED CREDENTIAL ────────────────────────────────────
//
//   scripts/check-secrets.js        → exit 0 = nothing that looks live is committed
//
// Part of preflight. Never prints a secret value — only the file, the line, and enough of the
// prefix to find it.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// The 27 October audit found the repository itself clean of live third-party keys, which is a
// genuine credit to whoever has been maintaining it. It found two things anyway:
//
//   · scripts/init-db.js hard-coded the live admin password as a fallback
//   · the project's own handoff document carried a working GitHub PAT, the Postgres password, the
//     admin password and three webhook secrets in cleartext
//
// The second is outside this repository and cannot be fixed from here. The first was one line.
// What neither had was anything that would have CAUGHT them — the repo's discipline is unusually
// strong about verification exit codes and silent failures, and had no check for this at all.
//
// So: a check that fails the build. A convention nobody enforces is a convention that holds until
// the week somebody is busy.
//
// ── WHY IT IS DELIBERATELY NARROW ────────────────────────────────────────────
//
// A scanner that fires on anything high-entropy produces a wall of false positives, gets muted,
// and then misses the real one — the same alarm-fatigue failure that let a broken cron email 168
// false alerts a week unnoticed. So this matches only credential formats that are unambiguous:
// vendor-prefixed tokens, and a DSN carrying a password. Everything else is left alone.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// Each rule matches a format that is a credential and essentially nothing else.
const RULES = [
  { name: 'GitHub PAT (classic)', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'GitHub PAT (fine-grained)', re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: 'GitHub OAuth token', re: /\bgho_[A-Za-z0-9]{36}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI key', re: /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: 'Resend key', re: /\bre_[A-Za-z0-9]{24,}\b/ },
  { name: 'Stripe live key', re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'Twilio account SID', re: /\bAC[0-9a-f]{32}\b/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  // A DSN is only a finding when it carries a password. localhost with no password is how every
  // check-*-sql.js connects to its throwaway cluster, and flagging those would mute the rule.
  {
    name: 'database URL with password',
    re: /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]{6,}@/,
  },
];

// A fallback secret is the shape that put the live admin password in this repo: the value sits in
// the open and is used whenever the environment is not set.
//
// URL is deliberately NOT in the name list. `process.env.APP_URL || 'https://…'` is the most
// common line in this codebase and it is not a secret — including it produced 14 false positives
// on the first run, which is how a scanner gets muted and then misses the real one.
const FALLBACK = /process\.env\.[A-Z_0-9]*(PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|_KEY|CREDENTIAL)[A-Z_0-9]*\s*\|\|\s*['"`]([^'"`]{6,})['"`]/;

// Values that are obviously not real, so templates stay usable. The DSN words matter: every
// .env.example DSN reads `user:password@` or `USER:PASSWORD@`, and flagging those would mean
// every run fails for a file whose whole purpose is to carry fake values.
const PLACEHOLDER = /REPLACE|YOUR_|EXAMPLE|PLACEHOLDER|CHANGEME|CHANGE_ME|xxx+|\.\.\.|<[^>]+>|\bTODO\b|dummy|sample|test[-_]?key|\buser:password\b|USER:PASSWORD|:password@|:PASSWORD@|localhost|127\.0\.0\.1/i;

// A fallback value that is plainly not a credential: a URL, a path, a flag, a number, an enum.
const NOT_A_SECRET = /^(https?:\/\/|\/|\.\/|\.\.\/|true$|false$|\d+$|[a-z_]+$)/i;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'test-fixtures']);
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.sh', '.html', '.sql',
  '.yml', '.yaml', '.env', '.example', '.txt']);

function files() {
  // Tracked files only. An untracked local scratch file is the developer's business; what matters
  // is what is committed and therefore shared.
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (_) {
    const out = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name)); continue; }
        out.push(path.relative(ROOT, path.join(d, e.name)));
      }
    }(ROOT));
    return out;
  }
}

const findings = [];
const SELF = path.relative(ROOT, __filename);

for (const rel of files()) {
  if (rel === SELF) continue;                       // this file contains the patterns by necessity
  const ext = path.extname(rel);
  if (ext && !SCAN_EXT.has(ext)) continue;
  if ([...SKIP_DIRS].some((d) => rel.startsWith(`${d}/`))) continue;

  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { continue; }
  if (text.length > 4 * 1024 * 1024) continue;

  text.split('\n').forEach((line, i) => {
    if (PLACEHOLDER.test(line)) return;
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) findings.push({ rel, line: i + 1, rule: rule.name, hint: `${m[0].slice(0, 6)}…` });
    }
    // Test files legitimately carry fake credentials — that is what a fixture is. Scanning them
    // produces noise that buries the one finding that matters.
    if (/\.test\.js$/.test(rel)) return;

    const f = line.match(FALLBACK);
    if (f && !PLACEHOLDER.test(f[2]) && !NOT_A_SECRET.test(f[2]) && f[2].length >= 6) {
      findings.push({
        rel, line: i + 1, rule: 'hard-coded fallback secret', hint: `${f[2].slice(0, 2)}…`,
      });
    }
  });
}

if (findings.length) {
  console.error(`FAIL  ${findings.length} committed credential(s):\n`);
  for (const f of findings) {
    console.error(`  ${f.rel}:${f.line}`);
    console.error(`     ${f.rule} — starts "${f.hint}"`);
  }
  console.error('\n  If one of these is real: ROTATE IT FIRST, then remove it. Removing it from');
  console.error('  the working tree does not remove it from git history, and the value has');
  console.error('  already been shared by everyone who cloned.');
  console.error('  If it is a placeholder, make that obvious (REPLACE_ME, <token>, YOUR_KEY).\n');
  process.exit(1);
}

console.log(`PASS  no committed credentials (scanned ${files().length} tracked files)`);

// ── HISTORY ──────────────────────────────────────────────────────────────────
//
//   scripts/check-secrets.js --history
//
// The scan above reads `git ls-files` — the working tree. That is the right default and it is also
// a blind spot: a credential committed and then deleted leaves this check GREEN forever while the
// value stays in history. On 2026-11-06 that blind spot was measured, not hypothesised. The live
// admin password was committed on 27 Oct in scripts/init-db.js and AUTONOMY_SECURITY_REVIEW.md,
// removed from the tip the same day, and remained readable in the history of a PUBLIC repository.
// Every check was green throughout, correctly, because none of them looked.
//
// So this mode scans every patch in every reachable commit. It is cheap — one `git log --all -p`
// pass, well under a second on this repo.
//
// ── THE BASELINE, AND WHY IT HOLDS ONLY RETIRED VALUES ───────────────────────
//
// History cannot be cleaned without a rewrite, so a check that fails forever on a known finding is
// a check that gets muted — the alarm-fatigue failure this file's header already warns about. The
// baseline at docs/security/history-findings.json therefore records each known finding with a
// STATUS, and the gate is the status, not the finding:
//
//   rotate-required → FAIL. The credential is exposed and still valid. Rotate it, then set
//                     'retired'. This is a real gate with a real, reachable green state.
//   retired         → pass, and the value is additionally WATCHED: if it ever reappears in the
//                     tree or in a new commit, that fails.
//   placeholder     → pass. Triaged as never having been a credential.
//
// The baseline stores a TRUNCATED SHA-256, never a value, because the baseline itself lives in the
// public repository.
//
// ── NEVER ADD A LIVE SECRET'S HASH HERE ──────────────────────────────────────
//
// A hash of a weak secret in a public file is a brute-force target, so only values that are
// already compromised AND rotated out of use may be watched. The hash of a retired password
// protects nothing that still matters; the hash of a live one is a liability. This is a policy,
// not a mechanism, and it is the reason the mechanism is safe.
if (process.argv.includes('--history')) {
  const BASELINE = path.join(ROOT, 'docs', 'security', 'history-findings.json');
  const h12 = (v) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 12);

  let base = { findings: [] };
  try { base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) {
    console.error(`FAIL  cannot read ${path.relative(ROOT, BASELINE)}: ${e.message}`);
    console.error('      A missing baseline is not an empty baseline. "I cannot tell" is not "clean".');
    process.exit(1);
  }
  const known = new Map(base.findings.map((f) => [f.id, f]));
  // Only RETIRED values are watched, and only when the baseline carries an explicit watch hash.
  // A finding can therefore be recorded and gated without storing any hash of a value that might
  // still be live — which is the case for a password that is exposed but not yet rotated.
  const watched = new Set(base.findings
    .filter((f) => f.status === 'retired' && typeof f.watch_sha12 === 'string')
    .map((f) => f.watch_sha12));

  let patches = '';
  try {
    patches = execFileSync('git', ['log', '--all', '-p', '--no-color', '--unified=0'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    console.error(`FAIL  could not read git history: ${e.message}`);
    process.exit(1);
  }

  const seen = new Map();   // id → {rule, sample}
  const reappeared = [];
  for (const line of patches.split('\n')) {
    if (PLACEHOLDER.test(line)) continue;
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) { const id = h12(m[0]); if (!seen.has(id)) seen.set(id, { rule: rule.name, hint: `${m[0].slice(0, 6)}…` }); }
    }
    // Watched retired values: tokenise and hash. Only retired values are watched, so this can
    // never be a search for something that is still a secret.
    if (watched.size) {
      for (const tok of line.split(/[\s"'`,;(){}\[\]<>]+/)) {
        if (tok.length < 8) continue;
        if (watched.has(h12(tok))) reappeared.push(h12(tok));
      }
    }
  }

  const unknown = [...seen.entries()].filter(([id]) => !known.has(id));
  // A rotate-required finding is time-boxed. Within its window it is reported loudly and passes;
  // past the window it FAILS. Neither extreme works: failing from day one deadlocks the branch on
  // an action only the credential's owner can take, and never failing is a warning nobody reads.
  // The date is the thing that cannot be forgotten.
  const today = new Date().toISOString().slice(0, 10);
  const pending = base.findings.filter((f) => f.status === 'rotate-required');
  const outstanding = pending.filter((f) => !f.accepted_until || f.accepted_until < today);
  const accepted = pending.filter((f) => f.accepted_until && f.accepted_until >= today);
  const commits = execFileSync('git', ['rev-list', '--all', '--count'], { cwd: ROOT, encoding: 'utf8' }).trim();

  let bad = 0;
  if (unknown.length) {
    bad += unknown.length;
    console.error(`\nFAIL  ${unknown.length} credential(s) in history that the baseline does not know:`);
    for (const [id, v] of unknown) console.error(`  id ${id}  ${v.rule} — starts "${v.hint}"`);
    console.error('  Triage each one, ROTATE if real, and record it in docs/security/history-findings.json.');
  }
  if (outstanding.length) {
    bad += outstanding.length;
    console.error(`\nFAIL  ${outstanding.length} exposed credential(s) past their rotation deadline:`);
    for (const f of outstanding) {
      console.error(`  ${f.what}`);
      console.error(`     ${f.where}`);
      console.error(`     deadline ${f.accepted_until || '(none set)'} — today ${today}`);
    }
    console.error('  Rotate it, then set status to "retired" in docs/security/history-findings.json.');
  }
  for (const f of accepted) {
    console.log(`  NOTE  ${f.what} is exposed and unrotated — this check FAILS after ${f.accepted_until}`);
    console.log(`        ${f.where}`);
  }
  if (reappeared.length) {
    bad += reappeared.length;
    console.error(`\nFAIL  ${reappeared.length} RETIRED credential(s) have reappeared:`);
    const byWatch = new Map(base.findings.filter((f) => f.watch_sha12).map((f) => [f.watch_sha12, f]));
    for (const id of [...new Set(reappeared)]) console.error(`  ${(byWatch.get(id) || {}).what || `watch ${id}`}`);
    console.error('  A value that was compromised once must never come back.');
  }
  if (bad) process.exit(1);
  console.log(`PASS  history clean: ${commits} commits scanned, ${seen.size} known finding(s), `
    + `${watched.size} retired value(s) watched, 0 outstanding`);
}
