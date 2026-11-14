// ── SEALING A WORKER SECRET AT REST ──────────────────────────────────────────
//
// M7.1. HMAC is symmetric, so the server must hold the same bytes the worker holds. That is a real
// cost and this module is the mitigation, not a cure: the secret is encrypted with a key that lives
// only in the environment, so a database dump alone — a backup file, a read-only replica, a
// support export — does not yield a usable worker credential.
//
// What it does NOT protect against: an attacker who has both the database and the environment of a
// running application. Against that, nothing symmetric helps, and the answer is an asymmetric
// scheme where the database holds a public key and no credential at all. identity-schema.js keeps
// a `scheme` column so that remains a second branch rather than a migration. This is written down
// because a reader who assumes "encrypted at rest" means "the database cannot impersonate a
// worker" would be wrong, and would be wrong in a way that only shows up after an incident.
//
// ── FAIL CLOSED, LOUDLY ──────────────────────────────────────────────────────
//
// With no sealing key there is no safe fallback. Storing the secret in the clear "for now" is how
// a development shortcut becomes the production shape, so seal() throws instead. A deployment that
// has not set the key cannot enrol a worker and cannot authenticate one — it is inert rather than
// insecure, and the error says which variable is missing.
//
// GCM is chosen over CBC because it authenticates: open() on a tampered ciphertext throws rather
// than returning plausible bytes. A verifier handed quietly-corrupted key material would compute a
// wrong signature and report "bad signature", sending the next person to look at the worker.

'use strict';

const crypto = require('crypto');

const ENV_VAR = 'WORKER_SECRET_SEAL_KEY';
const VERSION = 'v1';
const IV_BYTES = 12;          // GCM's standard nonce length
const SECRET_BYTES = 32;

/** 32 bytes as 64 hex characters. Anything else is a misconfiguration, not a shorter key. */
function sealingKey(env = process.env) {
  const raw = env[ENV_VAR];
  if (!raw) {
    throw new Error(`${ENV_VAR} is not set — worker identity cannot be sealed or opened. `
      + 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${ENV_VAR} must be exactly 64 hex characters (32 bytes); got ${raw.length} character(s)`);
  }
  return Buffer.from(raw, 'hex');
}

function seal(plaintext, env = process.env) {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', sealingKey(env), iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return [VERSION, iv.toString('hex'), c.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}

function open(sealed, env = process.env) {
  const parts = String(sealed == null ? '' : sealed).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('sealed worker secret is malformed or of an unknown version');
  }
  const [, ivHex, tagHex, ctHex] = parts;
  const d = crypto.createDecipheriv('aes-256-gcm', sealingKey(env), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  // Throws on a tampered ciphertext or a wrong key. Deliberately not caught here.
  return Buffer.concat([d.update(Buffer.from(ctHex, 'hex')), d.final()]).toString('utf8');
}

/** A fresh worker secret. 32 bytes of CSPRNG, hex, never derived from anything guessable. */
const newSecret = () => crypto.randomBytes(SECRET_BYTES).toString('hex');

/** An enrollment token, and the digest that is all the database ever sees of it. */
const newEnrollmentToken = () => `wet_${crypto.randomBytes(SECRET_BYTES).toString('hex')}`;
const digestOfToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

module.exports = {
  ENV_VAR, seal, open, newSecret, newEnrollmentToken, digestOfToken, sealingKey,
};
