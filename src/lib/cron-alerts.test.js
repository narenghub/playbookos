// The alert path is the one that must never be silent, and it was.
//
// sendCronAlert ended `await sendEmail({...})` with the result discarded. sendEmail returns FALSE
// on failure and does not throw, so a refused alert left a cron failure as a console line and
// nothing else. That is the shape mailer.js was written about after 1,113 emails were lost over
// eight weeks — every layer doing the right local thing, and the aggregate being silence.
'use strict';

const assert = require('assert');
const Module = require('module');

// Swap the mailer before cron-alerts requires it, so the real Resend client is never constructed.
const realLoad = Module._load;
let sendResult = true;
const sent = [];
Module._load = function patched(request, parent, isMain) {
  if (request === './mailer' || /\/mailer$/.test(request)) {
    return {
      sendEmail: async (opts) => { sent.push(opts); return sendResult; },
    };
  }
  return realLoad(request, parent, isMain);
};
const { withAlerts, sendCronAlert } = require('./cron-alerts');
Module._load = realLoad;

// withAlerts consults the kill switch before running the body. These tests are about the ALERT
// path, so they inject a permissive switch; the switch's own behaviour is covered in
// src/lib/autonomy.test.js and scripts/check-autonomy-stop-db.js. Without this they would reach for
// a live Postgres, halt fail-closed, and "pass" by never running the body at all.
const OPEN = { autonomy: { checkStopped: async () => null, recordRefusal: () => {} } };

let pass = 0; const fails = [];
const tests = [];
const T = (n, f) => tests.push([n, f]);

const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

T('a refused alert throws instead of returning quietly', async () => {
  sendResult = false;
  await withEnv({ ALERT_EMAIL: 'naren@abiozen.com' }, async () => {
    await assert.rejects(
      () => sendCronAlert('some-job', new Error('boom')),
      /refused by the mail provider/,
      'a refused alert returned normally — the cron failure reached nobody and nothing said so');
  });
});

T('a delivered alert does not throw', async () => {
  sendResult = true;
  await withEnv({ ALERT_EMAIL: 'naren@abiozen.com' }, async () => {
    await sendCronAlert('some-job', new Error('boom'));
  });
});

T('withAlerts logs ALERT FAIL when the alert itself cannot be delivered', async () => {
  // The cron failure must still be logged, and the alert failure must be named separately. If
  // these collapse into one line, a reader cannot tell "the job failed" from "the job failed and
  // you were never told".
  sendResult = false;
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await withEnv({ ALERT_EMAIL: 'naren@abiozen.com' }, async () => {
      await withAlerts('failing-job', async () => { throw new Error('the real failure'); }, OPEN)();
    });
  } finally { console.error = realErr; }

  assert.ok(errs.some((l) => /\[ALERT FAIL\] failing-job/.test(l)),
    `no ALERT FAIL line. got:\n${errs.join('\n')}`);
  assert.ok(errs.some((l) => /\[CRON FAIL\] failing-job/.test(l) && /the real failure/.test(l)),
    `the original failure was lost. got:\n${errs.join('\n')}`);
});

T('withAlerts never lets an exception escape the cron', async () => {
  // node-cron has no error handling; a bubbled throw would be an unhandled rejection.
  sendResult = true;
  await withEnv({ ALERT_EMAIL: 'naren@abiozen.com' }, async () => {
    const realErr = console.error;
    console.error = () => {};
    try {
      await withAlerts('x', async () => { throw new Error('nope'); }, OPEN)();
    } finally { console.error = realErr; }
  });
});

T('with no alert address configured, the failure is still logged', async () => {
  sendResult = true;
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    await withEnv({ ALERT_EMAIL: '', ADMIN_EMAIL: '' }, async () => {
      await sendCronAlert('unconfigured-job', new Error('boom'));
    });
  } finally { console.error = realErr; }
  assert.ok(errs.some((l) => /no ALERT_EMAIL/.test(l)), errs.join('\n'));
});

T('an UNKNOWN kill-state halts the cron AND alerts, because nobody chose it', async () => {
  // A deliberate stop is silent by design — the operator pulled the switch. An unreadable
  // kill-state is the opposite: it halts all 37 crons and nobody asked for it, so it must not be
  // visible only in Railway logs. Without the alert, a Postgres outage becomes total silence,
  // which is the failure commit 1eba5e9 fixed being re-created by the safety control.
  sendResult = true;
  sent.length = 0;
  let ran = 0;
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    await withEnv({ ALERT_EMAIL: 'naren@abiozen.com' }, async () => {
      await withAlerts('failing-job', async () => { ran += 1; }, {
        autonomy: {
          checkStopped: async () => ({ scope_type: 'global', scope_key: '', unknown: true,
            reason: 'kill-state could not be determined (connection refused)' }),
          recordRefusal: () => {},
        },
      })();
    });
  } finally { console.warn = realWarn; }

  assert.equal(ran, 0, 'the cron body ran with the brakes in unknown condition');
  assert.ok(sent.some((m) => /HALTED — kill-state unknown/.test(m.subject)),
    `no alert was sent for an unknown kill-state. sent: ${JSON.stringify(sent.map((m) => m.subject))}`);
  assert.ok(sent.every((m) => m.capability === 'email.alert'),
    'the alert must use the email.alert capability, or a stop on outbound email would silence it');
  assert.ok(warns.some((l) => /\[STOPPED_BY_POLICY\] failing-job/.test(l)), warns.join('\n'));
});

T('a DELIBERATE stop halts the cron silently — no alert', async () => {
  sendResult = true;
  sent.length = 0;
  let ran = 0;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await withEnv({ ALERT_EMAIL: 'naren@abiozen.com' }, async () => {
      await withAlerts('failing-job', async () => { ran += 1; }, {
        autonomy: {
          checkStopped: async () => ({ scope_type: 'global', scope_key: '',
            reason: 'CEO emergency stop — unexpected outbound campaign behaviour' }),
          recordRefusal: () => {},
        },
      })();
    });
  } finally { console.warn = realWarn; }
  assert.equal(ran, 0, 'the cron body ran while autonomy was stopped');
  assert.equal(sent.length, 0, 'an operator who pulled the switch does not need 37 emails about it');
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); pass++; } catch (e) { fails.push(`${n}: ${e.message}`); }
  }
  if (fails.length) {
    console.error(`FAIL  ${fails.length} of ${pass + fails.length}`);
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`ok  cron alerts — ${pass} passed`);
})();
