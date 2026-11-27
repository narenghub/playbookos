// ── WHATSAPP: THE CHANNEL THAT NEVER GOT THE EMAIL PATH'S GATES ─────────────
//
// B3.11a, fifth directive Priority 5: *"Complete the WhatsApp boundary verification using controlled
// synthetic execution with no real message transmission."*
//
// Four defects were found in the previous version of this file, and the order they are listed in is
// the order they mattered:
//
// 1. **THE KILL SWITCH SAT BEHIND THE CREDENTIAL CHECK.** `TWILIO_*` unset returned `{skipped}` at
//    line 12 and the stop state was never read. In development the credentials are always unset —
//    so every test of this function returned before reaching the kill switch, and the kill switch
//    was a control that could not fail. It is now the FIRST thing that happens, which is also what
//    makes a synthetic exercise of it meaningful.
//
// 2. **NO RECIPIENT AUTHORIZATION.** The email path requires `assertSendAllowed`; this path took a
//    caller-supplied phone number straight to a provider. Eleven of the twelve callers already read
//    the number out of a `users` row, so the authority was available and simply not consulted. It
//    is now DERIVED from the persisted row and the caller's number is treated as an assertion to be
//    checked against it, not as the address to use. A number that no active user holds is refused.
//
// 3. **THE STOP WAS NOT COMPANY-SCOPED.** `checkStopped({capability:'whatsapp.send'})` carried no
//    company, agent or workflow, so a company-scoped STOP could not halt WhatsApp while the same
//    STOP halted email. A kill switch that covers one channel out of two is a reporting hazard.
//
// 4. **NO SEAM, SO NO WAY TO EXERCISE IT WITHOUT TRANSMITTING.** `fetch` was global and `query` was
//    a module-level import. Verifying the boundary meant either monkey-patching globals or really
//    messaging somebody. The seam is a BOOLEAN selecting a reviewed in-repo responder — never an
//    injected function, for the reason `office/synthetic-provider.js` gives at length: a
//    function-shaped seam is where a value out of a plan or a memory becomes code.
//
// The signature keeps its three positional arguments so none of the twelve callers change. `deps` is
// a fourth, optional, and is how a check supplies a cluster and selects the synthetic transport.

const crypto = require('crypto');

const SYNTHETIC_MARKER = '[SYNTHETIC-DEV-WHATSAPP]';

const REFUSAL = {
  NOT_TRUE: 'the synthetic transport flag must be the literal boolean true',
  PRODUCTION_ENV: 'the synthetic transport is refused when NODE_ENV=production',
};

/** `whatsapp:+1555…` regardless of which spelling the caller used. */
function normalize(n) {
  const s = String(n == null ? '' : n).trim();
  if (!s) return '';
  return s.startsWith('whatsapp:') ? s : `whatsapp:${s}`;
}

/**
 * The reviewed responder. It cannot reach anything: this module requires `crypto` and nothing else
 * at module scope, so "no message was transmitted" is a property of the code rather than a promise
 * about it — the same argument `office/synthetic-provider.js` makes for the model seam.
 */
function syntheticSend({ to, from, body }) {
  const digest = crypto.createHash('sha256')
    .update(`${to}\n${from}\n${body}`).digest('hex').slice(0, 16);
  return {
    transmitted: false,
    synthetic: true,
    status: 'synthetic_accepted',
    message_sid: `SMsynthetic${digest}`,
    marker: SYNTHETIC_MARKER,
    evidence: 'src/lib/whatsapp.js syntheticSend() — no transport exists in this module, so '
      + 'api.twilio.com was never reached',
  };
}

/**
 * Exactly `true`, and never in production. A truthy value is refused, and a function is refused
 * without being called.
 */
function authorizeSyntheticTransport(flag, { env = process.env } = {}) {
  if (flag !== true) {
    return {
      allowed: false,
      reason: REFUSAL.NOT_TRUE,
      detail: typeof flag === 'function'
        ? 'a function was passed as the transport flag, which is where data becomes code — the seam '
          + 'selects a reviewed responder by boolean and refuses everything else'
        : `received ${typeof flag}`,
    };
  }
  if (String((env && env.NODE_ENV) || '') === 'production') {
    return {
      allowed: false,
      reason: REFUSAL.PRODUCTION_ENV,
      detail: 'a synthetic message and a real one are indistinguishable afterwards unless the '
        + 'provenance says so, and provenance is not worth relying on in production',
    };
  }
  return { allowed: true };
}

/**
 * Resolve the recipient from PERSISTED state, and check the caller's number against it.
 *
 * Returns `{ ok: true, number, userId }`, or `{ ok: false, reason }`. A database that cannot be read
 * is a refusal, not a pass: the alternative is that an unreachable database widens who can be
 * messaged, which is the inversion every gate in this repository is written against.
 */
async function resolveRecipient({ to, userId, company }, { query }) {
  const asserted = normalize(to);
  if (!asserted) return { ok: false, reason: 'no recipient number provided' };

  let row;
  try {
    if (userId) {
      const r = await query(
        'SELECT id, whatsapp_number, is_active FROM users WHERE id = $1', [String(userId)]);
      row = r.rows[0];
      if (!row) return { ok: false, reason: `user ${userId} does not exist` };
    } else {
      // No user_id: the number must still belong to somebody. This is the `routes.js` welcome-message
      // path, where the number arrives on a request — so it is checked against the row that request
      // created rather than trusted because it arrived.
      // `excludeExternalSql` is not decoration: without it a PARTNER's number resolves here and a
      // partner would be messaged as though they were an employee. `external-roles.test.js` swept
      // src/lib and caught this query the moment it was written, which is the sweep working.
      const { excludeExternalSql } = require('./roles');
      const r = await query(
        `SELECT id, whatsapp_number, is_active FROM users
          WHERE whatsapp_number IS NOT NULL
            AND regexp_replace(whatsapp_number, '[^0-9]', '', 'g')
                = regexp_replace($1, '[^0-9]', '', 'g')
            ${excludeExternalSql('users')}`,
        [asserted]);
      if (r.rows.length === 0) {
        return { ok: false,
          reason: 'the recipient number belongs to no user, so there is no persisted authority to '
            + 'send to it' };
      }
      if (r.rows.length > 1) {
        return { ok: false,
          reason: `the recipient number is held by ${r.rows.length} users, so the recipient is `
            + 'ambiguous and the message is refused rather than sent to a guess' };
      }
      row = r.rows[0];
    }
  } catch (e) {
    return { ok: false,
      reason: `the recipient could not be established (${e.message}), so authority to message them `
        + 'is unknown — refusing rather than assuming it' };
  }

  if (!row.is_active) {
    return { ok: false, reason: `user ${row.id} is deactivated and must not be messaged` };
  }
  const persisted = normalize(row.whatsapp_number);
  if (!persisted) {
    return { ok: false, reason: `user ${row.id} holds no WhatsApp number` };
  }
  // The caller's number is an assertion. Disagreement is refused rather than resolved in either
  // direction: a caller passing a different number is either forging a recipient or working from a
  // stale read, and both of those are reasons not to send.
  const digits = (s) => s.replace(/[^0-9]/g, '');
  if (digits(persisted) !== digits(asserted)) {
    return { ok: false,
      reason: `the number supplied for user ${row.id} does not match the number on their record` };
  }

  if (company) {
    try {
      const MBR = require('./identity/company-membership');
      const active = await MBR.isActiveMember(
        { userId: row.id, companyId: company }, { query });
      if (active === MBR.UNKNOWN) {
        return { ok: false,
          reason: `membership of ${company} could not be read for user ${row.id}` };
      }
      if (!active) {
        return { ok: false,
          reason: `user ${row.id} is not an active member of ${company}` };
      }
    } catch (e) {
      return { ok: false, reason: `company scope could not be established (${e.message})` };
    }
  }

  return { ok: true, number: persisted, userId: row.id };
}

async function sendWhatsApp(to, message, opts = {}, deps = {}) {
  const { user_id: userId = null, message_type: messageType = 'reminder',
    company = null, workflow = null, agent = null } = opts || {};
  const env = deps.env || process.env;
  const query = deps.query || require('./db').query;
  const autonomy = deps.autonomy || require('./autonomy');

  const logAttempt = async (status) => {
    try {
      await query(
        `INSERT INTO whatsapp_log (id, user_id, to_number, message_type, message, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [crypto.randomUUID(), userId, to, messageType, message, String(status).slice(0, 200)]);
    } catch (_) { /* logging must never become the reason a refusal fails to return */ }
  };

  // ── 1. THE KILL SWITCH, BEFORE ANYTHING ELSE ──────────────────────────────
  // Ahead of the credential check on purpose. Behind it, this branch was unreachable in every
  // environment that has no Twilio credentials — which is every development environment.
  try {
    const blocked = await autonomy.checkStopped({
      capability: 'whatsapp.send',
      ...(company ? { company } : {}),
      ...(workflow ? { workflow } : {}),
      ...(agent ? { agent } : {}),
    }, { consequential: true, deps: { query } });
    if (blocked) {
      const reason = `${blocked.scope_type}${blocked.scope_key ? `:${blocked.scope_key}` : ''}`
        + ` — ${blocked.reason}`;
      console.warn(`[STOPPED_BY_POLICY] whatsapp to ${to}: ${reason}`);
      try {
        autonomy.recordRefusal({ stop: blocked, what: 'whatsapp.send',
          detail: { to, message_type: messageType, company } });
      } catch (_) { /* the refusal is already the return value */ }
      await logAttempt(`stopped_by_policy: ${reason}`);
      return { stopped_by_policy: true, reason };
    }
  } catch (e) {
    // An unreadable kill switch is a halt. It was already a halt here, and that was the one thing
    // this function got right.
    const reason = `kill-switch check failed (${e.message})`;
    console.error(`[STOPPED_BY_POLICY] whatsapp to ${to}: ${reason}`);
    return { stopped_by_policy: true, reason };
  }

  // ── 2. THE RECIPIENT, DERIVED RATHER THAN ACCEPTED ────────────────────────
  const rcpt = await resolveRecipient({ to, userId, company }, { query });
  if (!rcpt.ok) {
    await logAttempt(`refused_unauthorized_recipient: ${rcpt.reason}`);
    return { refused: true, reason: rcpt.reason };
  }

  // ── 3. THE TRANSPORT ──────────────────────────────────────────────────────
  // The synthetic seam is decided here, BEFORE the credential check, so a synthetic exercise does
  // not need credentials present and a credentialed environment cannot be synthetic by accident.
  if ('syntheticTransport' in deps) {
    const verdict = authorizeSyntheticTransport(deps.syntheticTransport, { env });
    if (!verdict.allowed) {
      await logAttempt(`synthetic_transport_refused: ${verdict.reason}`);
      return { refused: true, synthetic: true, reason: verdict.reason, detail: verdict.detail };
    }
    const r = syntheticSend({
      to: rcpt.number, from: normalize(env.TWILIO_WHATSAPP_FROM || 'whatsapp:+10000000000'),
      body: `${SYNTHETIC_MARKER} ${message}`,
    });
    await logAttempt(`${r.status} ${SYNTHETIC_MARKER}`);
    return { success: true, transmitted: false, synthetic: true, status: r.status,
      message_sid: r.message_sid, evidence: r.evidence };
  }

  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) {
    return { skipped: true,
      reason: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM must all be set' };
  }

  const params = new URLSearchParams({
    From: normalize(from), To: rcpt.number, Body: message });
  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;

  let status = 'pending';
  let messageSid = null;
  let errorMsg = null;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      status = 'error';
      errorMsg = data.message || `Twilio ${res.status}`;
    } else {
      status = data.status || 'queued';
      messageSid = data.sid;
    }
  } catch (e) {
    status = 'error';
    errorMsg = e.message;
  }

  await logAttempt(status + (errorMsg ? `: ${errorMsg.slice(0, 180)}` : ''));

  if (errorMsg) return { error: errorMsg, status };
  return { success: true, transmitted: true, status, message_sid: messageSid };
}

module.exports = {
  sendWhatsApp,
  authorizeSyntheticTransport,
  syntheticSend,
  resolveRecipient,
  normalize,
  SYNTHETIC_MARKER,
  REFUSAL,
};
