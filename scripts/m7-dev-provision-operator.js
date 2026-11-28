#!/usr/bin/env node
// ── PROVISION THE ONE DEVELOPMENT OPERATOR ──────────────────────────────────
//
//   PLAYNEXA_DEV_OPERATOR_CREDENTIAL=<>=32 chars> \
//   M7_5_DEV_CONFIRM=yes \
//   node scripts/m7-dev-provision-operator.js --label <name> [--capabilities a,b] [--note "…"]
//
//   exit 0 = provisioned · 1 = refused · 2 = refused before touching anything
//
// Owner directive 2026-11-27, Option A: *"Explicitly provision one owner-approved development
// operator."*
//
// ── THE CREDENTIAL IS NEVER AN ARGUMENT ─────────────────────────────────────
//
// It arrives in the environment. An argv lands in the shell history and is visible in every `ps`
// listing on the machine for as long as the process runs — the same class of exposure that
// `enroll-worker-no-transcript.js` exists to correct, and it would be absurd to reintroduce it in
// the script that creates the credential's record.
//
// Nothing here prints the credential. It prints the operator id, which is configuration, and a
// 12-hex fingerprint of a SHA-256 of the credential, which identifies it for comparison and
// reconstructs none of it.
//
// ── IT REFUSES ANYTHING THAT IS NOT AN ISOLATED DEVELOPMENT DATABASE ────────
//
// Twice over, and the two checks answer different questions. `scripts/lib/db-identity.js` asks the
// database what it CONTAINS — it detects production's three STOP rows and populated business
// tables, which is the only thing that catches a development database restored from a production
// dump. `src/lib/worker/dev-operators.js` then asks the positive question — is every table here one
// a declared development schema module creates — before it will write a row.
//
// A hostname check is deliberately not among them. `db-identity.js` records at length why that was
// the wrong question, and that the workaround it invited was to give the development database a
// public internet address.

'use strict';

const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const die = (msg, code = 2) => { process.stderr.write(`REFUSED  ${msg}\n`); process.exit(code); };

const label = arg('label');
const note = arg('note', null);
const capabilities = (arg('capabilities', 'worker.execute') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!label) {
  die('usage: --label <name> [--capabilities worker.execute] [--note "…"]\n'
    + '         the credential is read from PLAYNEXA_DEV_OPERATOR_CREDENTIAL, never from an\n'
    + '         argument, and is never printed');
}

const credential = process.env.PLAYNEXA_DEV_OPERATOR_CREDENTIAL;
if (!credential) die('PLAYNEXA_DEV_OPERATOR_CREDENTIAL is not set');

// The same explicit confirmation the rest of the M7 development path requires, so that provisioning
// an authority is never something a stray invocation can do.
if (String(process.env.M7_5_DEV_CONFIRM) !== 'yes') {
  die("M7_5_DEV_CONFIRM must be 'yes'. Provisioning creates an authority that can mint worker "
    + 'credentials');
}
if (String(process.env.NODE_ENV) === 'production') {
  die('NODE_ENV=production. This provisions a DEVELOPMENT operator and nothing else');
}
if (!process.env.DATABASE_URL) die('DATABASE_URL is not set');

(async () => {
  const { query } = require('../src/lib/db');

  // ── CONTENT-BASED IDENTIFICATION FIRST ────────────────────────────────────
  const DBID = require('./lib/db-identity');
  const verdict = await DBID.identifyDatabase(query);
  if (verdict.verdict !== 'development') {
    die(`the database is ${verdict.verdict}, not development: ${verdict.detail}`
      + `${verdict.findings && verdict.findings.length ? `\n         findings: ${verdict.findings.join('; ')}` : ''}`);
  }
  console.log(`  ok    database identified as DEVELOPMENT — ${verdict.detail}`);

  const DEVOPS = require('../src/lib/worker/dev-operators');
  const r = await DEVOPS.provisionOperator({ label, credential, allowedCapabilities: capabilities, note });

  if (!r.ok) {
    process.stderr.write(`REFUSED  provisioning failed (${r.code})`
      + `${r.detail ? `: ${r.detail}` : ''}\n`);
    process.exit(1);
  }

  const fingerprint = crypto.createHash('sha256').update(credential).digest('hex').slice(0, 12);

  console.log('');
  console.log('  PROVISIONED. The credential was NOT printed and is NOT in this transcript.');
  console.log('');
  console.log(`    operator id             ${r.operatorId}`);
  console.log(`    label                   ${r.label}`);
  console.log(`    scope                   ${r.allowedCapabilities.join(', ') || '(none)'}`);
  console.log(`    synthetic-only          enforced by a CHECK constraint, not by this script`);
  console.log(`    credential fingerprint  sha256:${fingerprint}…  (12 hex of a hash — not a secret)`);
  console.log('');
  console.log('  To enrol a worker with it, set the same credential in');
  console.log('  PLAYNEXA_DEV_OPERATOR_CREDENTIAL and run scripts/enroll-worker-no-transcript.js.');
  process.exit(0);
})().catch((e) => {
  process.stderr.write(`REFUSED  ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
