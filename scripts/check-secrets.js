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
