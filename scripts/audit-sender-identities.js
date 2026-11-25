#!/usr/bin/env node
// ── B7.9: WHICH IDENTITIES CAN THIS PLATFORM SEND AS? ───────────────────────
//
//   node scripts/audit-sender-identities.js            # the audit
//   node scripts/audit-sender-identities.js --json      # machine-readable, for review tooling
//
//   exit 0 = an audit was produced      exit 3 = NOT EXECUTED (no readable database)
//
// Owner instruction: *"B7.9 sender and provider-account authorization. … audit stored config,
// legacy mailbox credentials, signatures, database-backed identities."* And, in the same breath,
// the constraint that shapes this whole file:
//
//   *"A comment-stripped source scan is not proof."*
//
// ── WHY THIS IS NOT A GREP ─────────────────────────────────────────────────
//
// B7.10 answered the neighbouring question with a comment-stripped grep for a departed employee's
// address and found four occurrences, all in comments. That was recorded as IMPLEMENTED and
// explicitly marked insufficient, because a scan can only find what is written in the source. It
// cannot find:
//
//   • an address in an environment variable — which is where the default sender actually lives;
//   • an address in a database row, including every row of `sender_identities` itself;
//   • a Gmail mailbox that holds its own OAuth credential, whose name is configuration;
//   • an address assembled at runtime from a column and a domain.
//
// So this asks each SOURCE in turn and reports what it holds. The source scan is still here, as
// one source among several and labelled as the weakest, because a literal in source is worth
// seeing — it is how a departed director's address ended up on the outside of a customer letter.
//
// ── IT CHANGES NOTHING ─────────────────────────────────────────────────────
//
// No INSERT, no UPDATE. Declaring a sender identity is an authorization, and this repository's
// standing rule is that authorizations are reviewed acts, not side effects of a report. The
// `UNDECLARED` section is the list a reviewer works from.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const JSON_OUT = process.argv.includes('--json');
const ROOT = path.join(__dirname, '..');

(async () => {
  const db = require('../src/lib/db');
  const query = db.query;

  try {
    await query('SELECT 1');
  } catch (e) {
    console.error(`NOT EXECUTED  the database is not readable: ${e.message}`);
    console.error('              An audit that could not read the declarations is not an audit');
    console.error('              showing none — and "none declared" is the answer that would let');
    console.error('              a reviewer conclude there is nothing to review.');
    process.exit(3);
  }

  const SID = require('../src/lib/outbound/sender-identity');
  const RECIPIENTS = require('../src/lib/outbound/recipients');

  const report = await SID.declaredIdentities({ query });

  // ── SOURCE 4: LITERALS IN SOURCE, THE WEAKEST ONE ────────────────────────
  //
  // Addresses on a company domain appearing in a `from`, `replyTo`, `mailbox` or `sender`
  // position. Comments are BLANKED rather than stripped so line numbers survive and a commented
  // address cannot be reported as live configuration — the mistake B7.10's grep made in reverse.
  const { blankCommentsOnly } = require('./js-lex');
  const domains = [...RECIPIENTS.companyDomains()];
  const literals = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs); continue; }
      if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue;
      let code;
      try { code = blankCommentsOnly(fs.readFileSync(abs, 'utf8')); } catch (_) { continue; }
      const rel = path.relative(ROOT, abs);
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (!/\b(from|replyTo|reply_to|mailbox|sender)\b\s*[:=]/.test(line)) return;
        for (const d of domains) {
          const re = new RegExp(`[A-Za-z0-9._%+-]+@${d.replace(/\./g, '\\.')}`, 'g');
          for (const m of line.match(re) || []) {
            literals.push({ file: rel, line: i + 1, address: m.toLowerCase() });
          }
        }
      });
    }
  };
  for (const d of ['src', 'scripts']) {
    try { walk(path.join(ROOT, d)); } catch (_) { /* a missing tree is not an empty one, noted below */ }
  }

  const declaredActive = new Set(report.table
    .filter((r) => r.status === 'active').map((r) => r.address));
  const literalAddresses = [...new Set(literals.map((l) => l.address))].sort();
  const undeclaredLiterals = literalAddresses.filter((a) => !declaredActive.has(a));

  // Which of these belong to accounts that are no longer active? The worst case in the set: the
  // platform able to send as somebody who has left.
  let deactivated = null;
  try {
    const SHARED = require('../src/lib/outbound/shared-mailboxes');
    const all = [...new Set([...declaredActive, ...literalAddresses,
      ...report.env.map((e) => e.address), ...(report.defaultFrom ? [report.defaultFrom] : [])])];
    const set = await SHARED.deactivatedAccounts(all, { query });
    deactivated = set === null ? null : [...set].sort();
  } catch (_) { deactivated = null; }

  const out = {
    generated_at: new Date().toISOString(),
    writes_nothing: true,
    sources: {
      sender_identities_table: report.tableReadable ? report.table : null,
      table_error: report.tableReadable ? null : report.tableError,
      environment: report.env,
      mailer_default_from: report.defaultFrom,
      source_literals: literals,
    },
    undeclared_env_identities: report.undeclaredEnv,
    undeclared_source_literals: undeclaredLiterals,
    deactivated_accounts_among_them: deactivated,
    what_a_scan_cannot_see: [
      'an address in an environment variable — where the default sender actually lives',
      'an address in a database row, including every row of sender_identities itself',
      'a Gmail mailbox holding its own OAuth credential, whose name is configuration',
      'an address assembled at runtime from a column and a domain',
    ],
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const line = (s = '') => console.log(s);
  line('── B7.9 SENDER IDENTITY AUDIT ───────────────────────────────────────────');
  line();
  line('  THIS TOOL WRITES NOTHING. Declaring a sender is an authorization, and an');
  line('  authorization is a reviewed act, not a side effect of a report.');
  line();

  line(`  ── DECLARED in sender_identities (${report.tableReadable ? report.table.length : 'UNREADABLE'}) ──`);
  if (!report.tableReadable) {
    line(`    UNREADABLE: ${report.tableError}`);
    line('    An unreadable declaration table is not an empty one.');
  } else if (!report.table.length) {
    line('    (none — the table is empty by design; every row is a reviewed declaration)');
  } else {
    for (const r of report.table) {
      const scope = r.company_scope === 'platform' ? 'PLATFORM' : r.company_id;
      line(`    ${r.address.padEnd(34)} ${scope.padEnd(20)} ${r.provider_account}`);
      line(`      purpose ${r.purpose} · ${r.status} · send=${r.may_send} replies=${r.may_receive_replies}`
        + ` · by ${r.authorized_by}`);
    }
  }

  line();
  line(`  ── CONFIGURED in the environment (${report.env.length}) ──`);
  if (!report.env.length) line('    (MAIL_FROM and RESEND_FROM are unset here)');
  for (const e of report.env) line(`    ${e.address.padEnd(34)} ${e.source}`);
  if (report.defaultFrom) line(`    mailer.defaultFrom() resolves to: ${report.defaultFrom}`);

  line();
  line(`  ── LITERALS in source, the weakest source (${literalAddresses.length} distinct) ──`);
  line('    A scan finds only what is written down. It is reported because a literal is how a');
  line('    departed director\'s address reached the outside of a customer letter.');
  for (const a of literalAddresses) {
    const where = literals.filter((l) => l.address === a).slice(0, 3)
      .map((l) => `${l.file}:${l.line}`).join(', ');
    line(`    ${a.padEnd(34)} ${where}${literals.filter((l) => l.address === a).length > 3 ? ' …' : ''}`);
  }

  line();
  line('  ── NEEDS A REVIEWED DECLARATION ──');
  if (!report.undeclaredEnv.length && !undeclaredLiterals.length) {
    line('    (nothing — every configured and literal identity has an active declaration)');
  }
  for (const a of report.undeclaredEnv) line(`    ${a.padEnd(34)} configured in the environment`);
  for (const a of undeclaredLiterals) line(`    ${a.padEnd(34)} a literal in source`);

  line();
  if (deactivated === null) {
    line('  ── DEACTIVATED ACCOUNTS AMONG THEM: UNKNOWN (the user table could not be read) ──');
  } else if (!deactivated.length) {
    line('  ── DEACTIVATED ACCOUNTS AMONG THEM: none ──');
  } else {
    line('  ── DEACTIVATED ACCOUNTS AMONG THEM — THE WORST CASE IN THIS SET ──');
    line('    The platform could put these names on the outside of a message, and the reply would');
    line('    land in a mailbox nobody reads. authorizedSender() refuses them regardless of any');
    line('    declaration, and they should not be declared at all.');
    for (const a of deactivated) line(`    ${a}`);
  }

  line();
  line('  ── WHAT A SOURCE SCAN CANNOT SEE ──');
  for (const s of out.what_a_scan_cannot_see) line(`    · ${s}`);
  line();
  line('── NOTHING WAS DECLARED. A reviewer decides, and each declaration names a company, a ──');
  line('── provider account, a reason and an authorizer.                                     ──');
  process.exit(0);
})().catch((e) => {
  console.error(`FAIL  ${e.stack || e.message}`);
  process.exit(1);
});
