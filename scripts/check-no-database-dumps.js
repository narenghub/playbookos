// ── NO DATABASE DUMP MAY SIT IN THIS WORKING TREE ──────────────────────────────────────────────────
//
//   node scripts/check-no-database-dumps.js ; echo $?
//
// On 2026-11-06 `git status` in the CEO's checkout showed this:
//
//     ?? prod-20261105.dump
//     ?? prod-20261105-1755.dump
//     ?? prod-20261106-1226.dump
//
// Three full production dumps inside the working tree of `narenghub/playbookos`, which is PUBLIC,
// with no `*.dump` pattern in .gitignore. One `git add -A && git commit && git push` would have
// published the users table and its password hashes, 4,756 prospects, buyer contacts and the
// `integrations` table — which the handoff document says holds API keys.
//
// Nothing had been committed, so it stayed a near miss. It was not caught by care: it was caught
// because `git status --porcelain` happened to be run for an unrelated reason. Meanwhile I had been
// running `git add -A` in my own checkout all evening — had those files been there, I would have
// committed them.
//
// WHY A CHECK AND NOT JUST .gitignore. .gitignore stops the accident from `git add -A` and nothing
// else: it is bypassed by `git add -f`, and it has no effect at all on a file that is already staged
// or tracked. A check runs before every push and cannot be forgotten. Both exist; this is the half
// that holds when someone is in a hurry.
//
// It deliberately looks at the WHOLE tree, not just tracked files. An untracked dump is the dangerous
// state — tracked means it has already happened.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fail = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };

// Extensions that are a dump and nothing else. `.sql` is NOT here: docs/deploy/prod-roles.sql is a
// legitimate tracked file of GRANT statements, and a checker that flags it is a checker that gets
// switched off. A `.sql` file is caught below by its CONTENT instead.
const DUMP_EXT = /\.(dump|sql\.gz|sql\.bz2|sql\.zst|pgdump|bak)$/i;

// pg_dump --format=custom and --format=tar archives both begin with this.
const PGDMP = 'PGDMP';

// A plain-SQL dump announces itself in its first few hundred bytes. prod-roles.sql does not.
const PLAIN_DUMP_MARKERS = [
  'PostgreSQL database dump',
  'pg_dump version',
  'SET statement_timeout = 0;',
];

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function looksLikeDump(abs) {
  if (DUMP_EXT.test(abs)) return `its extension (${path.extname(abs)}) is a database dump`;
  let head = '';
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n).toString('latin1');
  } catch { return null; }
  if (head.startsWith(PGDMP)) return 'it begins with the PGDMP magic string (pg_dump custom/tar archive)';
  for (const m of PLAIN_DUMP_MARKERS) {
    if (head.includes(m)) return `its header contains ${JSON.stringify(m)}`;
  }
  return null;
}

console.log(`\n${'─'.repeat(78)}\nDATABASE DUMPS IN THE WORKING TREE\n${'─'.repeat(78)}`);

const found = [];
for (const abs of walk(ROOT)) {
  const why = looksLikeDump(abs);
  if (why) found.push({ rel: path.relative(ROOT, abs), why, bytes: fs.statSync(abs).size });
}

if (found.length) {
  for (const f of found) {
    bad(`${f.rel} (${f.bytes.toLocaleString()} bytes) — ${f.why}`);
  }
  console.log('\n  A database dump in this tree is one `git add -A` away from a PUBLIC repository.');
  console.log('  Move it out — it does not belong next to the code that reads it:\n');
  console.log('      mkdir -p ~/db-backups && mv <file> ~/db-backups/\n');
  console.log('  If this file is genuinely not a dump, give it a different extension or header;');
  console.log('  do not add it to the allow-list, because the next real one will be added too.\n');
} else {
  ok('no database dump anywhere in the tree (tracked or untracked)');
}

// The .gitignore half. Weaker than the check above — `git add -f` ignores it, and it does nothing for
// an already-tracked file — but it stops the common accident, so its absence is worth failing on.
const gi = fs.existsSync(path.join(ROOT, '.gitignore'))
  ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
if (/^\*\.dump$/m.test(gi)) ok('.gitignore carries a *.dump pattern');
else bad('.gitignore has no *.dump pattern', 'the accident this check exists for would not even be flagged by git');

// And nothing dump-shaped may ever have been committed. If one ever was, .gitignore and the sweep
// above are both irrelevant: it is in the history of a public repository and the remedy is rotation,
// not deletion.
try {
  const ever = execFileSync('git', ['-C', ROOT, 'log', '--all', '--diff-filter=A', '--name-only',
    '--pretty=format:', '--', '*.dump', '*.sql.gz', '*.pgdump', '*.bak'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!ever) ok('no dump-shaped file appears anywhere in git history');
  else {
    bad('a dump-shaped file WAS committed at some point', `${ever.split('\n').filter(Boolean).join(', ')}`
      + ' — this is in the history of a public repository; the remedy is credential rotation, not deletion');
  }
} catch {
  console.log('  ----  could not read git history (not a checkout?) — this part did NOT run');
}

console.log(`\n${'─'.repeat(78)}`);
if (fail) {
  console.log(`FAIL  ${fail} finding(s). Do not push.\n`);
  process.exit(1);
}
console.log('PASS  no database dump in the tree, the ignore pattern is present, and none was ever committed.\n');
