'use strict';
// Tests for the SAM.gov adapter (ruling 7 item 1).
//
// WHAT THESE PROVE, AND WHAT THEY CANNOT. The field names in sam-gov.js come from documentation,
// not from a live response, because no api_key exists and obtaining one is the authorization this
// ruling withholds. So these tests prove the connector's BEHAVIOUR — the activation gate, quota
// refusal before the call, amendment detection, error classification, credential redaction, date
// and limit validation — against fixtures shaped like the documented payload.
//
// They do NOT prove the field names are right. No test here can. That is what
// VERIFY_ON_FIRST_CALL is for, and `assertResponseShape` exists so a renamed field fails loudly
// instead of filling a table with nulls.

const assert = require('assert');
const sam = require('./sam-gov');

let pass = 0; let fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use ta() for async tests');
    pass += 1;
  } catch (e) { fail += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
const pending = [];
function ta(name, fn) { pending.push([name, fn]); }

// ── THE ACTIVATION GATE ────────────────────────────────────────────────────

ta('REFUSES to fetch without authorized:true, even with a key', async () => {
  let called = false;
  await assert.rejects(
    () => sam.fetchSearch(
      { postedFrom: '01/01/2026', postedTo: '02/01/2026' },
      { apiKey: 'k', fetchImpl: () => { called = true; } },
    ),
    /REFUSED — authenticated ingestion is not activated/,
  );
  assert.strictEqual(called, false, 'NO REQUEST may be made — the refusal happens before the call');
});

ta('NEGATIVE CONTROL: with authorized:true the same call proceeds', async () => {
  // Without this, the gate test above would pass on a connector that never works at all.
  let called = false;
  const res = await sam.fetchSearch(
    { postedFrom: '01/01/2026', postedTo: '02/01/2026' },
    {
      apiKey: 'k',
      authorized: true,
      fetchImpl: async () => {
        called = true;
        return { status: 200, json: async () => ({ totalRecords: 0, opportunitiesData: [] }) };
      },
    },
  );
  assert.strictEqual(called, true);
  assert.deepStrictEqual(res.notices, []);
});

t('the key is never read from the environment', () => {
  process.env.SAM_API_KEY = 'leaked-from-env';
  try {
    assert.throws(() => sam.buildSearchRequest({ postedFrom: '01/01/2026', postedTo: '02/01/2026' }, {}),
      /must be passed explicitly; it is never read from the environment/);
  } finally { delete process.env.SAM_API_KEY; }
});

// ── CREDENTIAL REDACTION ───────────────────────────────────────────────────

t('redactUrl removes the key', () => {
  const u = 'https://api.sam.gov/opportunities/v2/search?api_key=SUPERSECRET&limit=10';
  const r = sam.redactUrl(u);
  assert.ok(!r.includes('SUPERSECRET'), `the key survived redaction: ${r}`);
  assert.ok(r.includes('api_key=REDACTED'));
  assert.ok(r.includes('limit=10'), 'the rest of the URL must survive, or the log is useless');
});

t('buildSearchRequest exposes a redacted form alongside the real url', () => {
  const r = sam.buildSearchRequest({ postedFrom: '01/01/2026', postedTo: '03/01/2026' }, { apiKey: 'SECRET' });
  assert.ok(r.url.includes('SECRET'), 'the real request must carry the key');
  assert.ok(!r.redacted.includes('SECRET'), 'the loggable form must not');
});

ta('NEGATIVE CONTROL: a failing request reports the REDACTED url', async () => {
  // The natural thing to do with a failing request is print its URL. On this API that pastes a
  // live credential into the logs.
  await assert.rejects(
    () => sam.fetchSearch(
      { postedFrom: '01/01/2026', postedTo: '02/01/2026' },
      {
        apiKey: 'SUPERSECRET',
        authorized: true,
        fetchImpl: async () => ({ status: 403, json: async () => ({ error: 'An invalid api_key was supplied' }) }),
      },
    ),
    (e) => {
      assert.ok(!e.message.includes('SUPERSECRET'), `the error leaked the key: ${e.message}`);
      assert.ok(e.message.includes('REDACTED'));
      return true;
    },
  );
});

// ── QUOTA ──────────────────────────────────────────────────────────────────

t('a known budget refuses the call that would exceed it', () => {
  const q = sam.makeQuotaLedger(2);
  q.charge(); q.charge();
  assert.strictEqual(q.remaining, 0);
  assert.throws(() => q.charge(), sam.QuotaExhausted);
});

t('an UNKNOWN budget permits calls and reports its ignorance rather than guessing', () => {
  // The documentation gives no numeric limit for ANY role, so a made-up number would be a
  // fabricated constraint — and the honest value is UNKNOWN, not Infinity and not 1000.
  const q = sam.makeQuotaLedger(null);
  assert.strictEqual(q.known, false);
  assert.strictEqual(q.budget, 'UNKNOWN');
  assert.strictEqual(q.remaining, 'UNKNOWN');
  q.charge();
  assert.strictEqual(q.used, 1);
  assert.strictEqual(q.remaining, 'UNKNOWN');
});

ta('quota is charged BEFORE the request, so an exhausted budget never reaches the network', async () => {
  // Rule 7's shape: never perform the call you predict will be refused. On an API whose real limit
  // is unknown, the call that discovers the limit may trip a lockout rather than a tidy 429.
  let called = false;
  const q = sam.makeQuotaLedger(1);
  q.charge();
  await assert.rejects(
    () => sam.fetchSearch(
      { postedFrom: '01/01/2026', postedTo: '02/01/2026' },
      { apiKey: 'k', authorized: true, quota: q, fetchImpl: async () => { called = true; return { status: 200, json: async () => ({ opportunitiesData: [] }) }; } },
    ),
    sam.QuotaExhausted,
  );
  assert.strictEqual(called, false, 'the network must not be touched once the budget is spent');
});

// ── REQUEST VALIDATION (each saves a quota call) ───────────────────────────

t('postedFrom/postedTo are mandatory and must be MM/DD/YYYY', () => {
  const k = { apiKey: 'k' };
  assert.throws(() => sam.buildSearchRequest({}, k), /mandatory/);
  assert.throws(() => sam.buildSearchRequest({ postedFrom: '2026-01-01', postedTo: '2026-02-01' }, k), /MM\/DD\/YYYY/);
});

t('a range over one year is refused locally rather than by the API', () => {
  const k = { apiKey: 'k' };
  assert.throws(() => sam.buildSearchRequest({ postedFrom: '01/01/2025', postedTo: '06/01/2026' }, k), /1 year/);
  assert.doesNotThrow(() => sam.buildSearchRequest({ postedFrom: '01/01/2026', postedTo: '12/01/2026' }, k));
});

t('limit is ALWAYS set explicitly, because the API default is 1', () => {
  // Omitting limit returns a single record, which reads exactly like a query with one result.
  const r = sam.buildSearchRequest({ postedFrom: '01/01/2026', postedTo: '02/01/2026' }, { apiKey: 'k' });
  assert.ok(/[?&]limit=\d+/.test(r.url), 'no limit in the query string');
  assert.ok(!/[?&]limit=1(&|$)/.test(r.url), 'the default of 1 must never be what ships');
});

t('limit outside 1..1000 is refused', () => {
  const k = { apiKey: 'k' };
  for (const limit of [0, -1, 1001, 1.5, '100']) {
    assert.throws(() => sam.buildSearchRequest({ postedFrom: '01/01/2026', postedTo: '02/01/2026', limit }, k),
      /limit must be an integer/, `limit ${JSON.stringify(limit)} should be refused`);
  }
});

// ── ERROR CLASSIFICATION ───────────────────────────────────────────────────

t('documented error strings classify correctly', () => {
  assert.strictEqual(sam.classifyError(403, { error: 'An invalid api_key was supplied' }), sam.ERROR_KINDS.AUTH);
  assert.strictEqual(sam.classifyError(403, { error: 'No api_key was supplied' }), sam.ERROR_KINDS.AUTH);
  assert.strictEqual(sam.classifyError(400, { error: 'PostedFrom and PostedTo are mandatory' }), sam.ERROR_KINDS.REQUEST);
  assert.strictEqual(sam.classifyError(400, { error: 'Date range must be 1 year(s) apart' }), sam.ERROR_KINDS.REQUEST);
  assert.strictEqual(sam.classifyError(429, {}), sam.ERROR_KINDS.QUOTA);
  assert.strictEqual(sam.classifyError(500, {}), sam.ERROR_KINDS.SERVER);
});

t('an auth error is NEVER retryable', () => {
  // Retrying an auth failure in a loop is how a key gets blocked.
  assert.strictEqual(sam.isRetryable(sam.ERROR_KINDS.AUTH), false);
  assert.strictEqual(sam.isRetryable(sam.ERROR_KINDS.REQUEST), false);
  assert.strictEqual(sam.isRetryable(sam.ERROR_KINDS.QUOTA), false);
  assert.strictEqual(sam.isRetryable(sam.ERROR_KINDS.SERVER), true);
});

// ── RESPONSE SHAPE ─────────────────────────────────────────────────────────

t('a missing opportunitiesData array fails LOUDLY, naming the keys it did get', () => {
  // The likeliest first-call failure is a renamed key. Silently, that is a table of notices whose
  // every field is null — which looks like sparse data, not a broken connector.
  assert.throws(() => sam.assertResponseShape({ totalRecords: 5, results: [] }),
    /no opportunitiesData array/);
  try { sam.assertResponseShape({ totalRecords: 5, results: [] }); } catch (e) {
    assert.ok(/totalRecords, results/.test(e.message), `the error must name the keys present: ${e.message}`);
  }
});

t('normalizeNotice preserves UNKNOWN as null, never as empty string or zero', () => {
  const n = sam.normalizeNotice({ noticeId: 'n1', title: '', responseDeadLine: null });
  assert.strictEqual(n.title, null);
  assert.strictEqual(n.responseDeadline, null);
  assert.notStrictEqual(n.title, '');
  assert.notStrictEqual(n.responseDeadline, 0);
});

t('NEGATIVE CONTROL: pointOfContact and description are NOT collected', () => {
  // Phase 1 has no use for federal staff contact details, the global email HOLD stands, and
  // assembling a contactable list before anything may contact them builds an outreach capability
  // nobody asked for.
  const n = sam.normalizeNotice({
    noticeId: 'n1',
    pointOfContact: [{ fullName: 'A Person', email: 'person@agency.gov', phone: '555' }],
    description: 'https://api.sam.gov/...?api_key=',
  });
  const blob = JSON.stringify(n);
  assert.ok(!/person@agency\.gov/.test(blob), 'a contact email was collected');
  assert.ok(!/pointOfContact/i.test(blob), 'the contact block was collected');
  assert.ok(!/description/i.test(blob), 'the description link was collected');
});

t('both the current and the original notice type are kept', () => {
  const n = sam.normalizeNotice({ noticeId: 'n', type: 'Solicitation', baseType: 'Sources Sought' });
  assert.strictEqual(n.noticeType, 'Solicitation');
  assert.strictEqual(n.baseNoticeType, 'Sources Sought');
});

// ── AMENDMENT TRACKING ─────────────────────────────────────────────────────

t('a first sighting is isNew, not an amendment', () => {
  const r = sam.detectAmendment(null, sam.normalizeNotice({ noticeId: 'n', title: 'T' }));
  assert.strictEqual(r.isNew, true);
  assert.strictEqual(r.amended, false);
});

t('an unchanged notice reports no amendment', () => {
  const a = sam.normalizeNotice({ noticeId: 'n', title: 'T', type: 'Solicitation', responseDeadLine: '2026-12-01' });
  const b = sam.normalizeNotice({ noticeId: 'n', title: 'T', type: 'Solicitation', responseDeadLine: '2026-12-01' });
  const r = sam.detectAmendment(a, b);
  assert.strictEqual(r.amended, false);
  assert.strictEqual(r.significance, 'none');
});

t('A1: a moved deadline is singled out, not buried in a diff list', () => {
  const a = sam.normalizeNotice({ noticeId: 'n', title: 'T', responseDeadLine: '2026-12-01' });
  const b = sam.normalizeNotice({ noticeId: 'n', title: 'T', responseDeadLine: '2026-11-10' });
  const r = sam.detectAmendment(a, b);
  assert.strictEqual(r.amended, true);
  assert.strictEqual(r.significance, 'deadline_moved');
  assert.deepStrictEqual(r.changes, [{ field: 'responseDeadline', from: '2026-12-01', to: '2026-11-10' }]);
});

t('A2: a notice type change is reported as a biddability transition', () => {
  const a = sam.normalizeNotice({ noticeId: 'n', type: 'Sources Sought' });
  const b = sam.normalizeNotice({ noticeId: 'n', type: 'Solicitation' });
  const r = sam.detectAmendment(a, b);
  assert.strictEqual(r.significance, 'type_changed');
});

t('a withdrawal outranks every other change', () => {
  const a = sam.normalizeNotice({ noticeId: 'n', active: 'Yes', responseDeadLine: '2026-12-01' });
  const b = sam.normalizeNotice({ noticeId: 'n', active: 'No', responseDeadLine: '2026-11-01' });
  const r = sam.detectAmendment(a, b);
  assert.strictEqual(r.significance, 'withdrawn',
    'a withdrawn notice whose deadline also moved is withdrawn, not rescheduled');
});

t('a cosmetic change is material but NOT ranked with a deadline move', () => {
  const a = sam.normalizeNotice({ noticeId: 'n', title: 'Widget supply' });
  const b = sam.normalizeNotice({ noticeId: 'n', title: 'Widget supply,' });
  const r = sam.detectAmendment(a, b);
  assert.strictEqual(r.amended, true);
  assert.strictEqual(r.significance, 'material');
});

t('NEGATIVE CONTROL: an untracked field changing is not an amendment', () => {
  const a = sam.normalizeNotice({ noticeId: 'n', title: 'T', uiLink: 'https://a' });
  const b = sam.normalizeNotice({ noticeId: 'n', title: 'T', uiLink: 'https://b' });
  assert.strictEqual(sam.detectAmendment(a, b).amended, false,
    'a changed UI link is not an amendment, and treating it as one trains people to ignore the list');
});

t('typeDiverged works on a FIRST sighting, with nothing stored to diff against', () => {
  const n = sam.normalizeNotice({ noticeId: 'n', type: 'Solicitation', baseType: 'Sources Sought' });
  const d = sam.typeDiverged(n);
  assert.strictEqual(d.diverged, true);
  assert.strictEqual(d.determinable, true);
});

t('typeDiverged says UNKNOWN rather than false when a type is missing', () => {
  const d = sam.typeDiverged(sam.normalizeNotice({ noticeId: 'n', type: 'Solicitation' }));
  assert.strictEqual(d.determinable, false);
  assert.strictEqual(d.diverged, false);
  assert.ok(/UNKNOWN/.test(d.reason), 'an undeterminable answer must not read as a negative one');
});

// ── the first-call checklist is real content, not a stub ───────────────────

t('VERIFY_ON_FIRST_CALL names the offset ambiguity and the unknown quota', () => {
  const all = sam.VERIFY_ON_FIRST_CALL.join(' ');
  assert.ok(sam.VERIFY_ON_FIRST_CALL.length >= 5);
  assert.ok(/offset/i.test(all), 'the offset semantics must be on the checklist');
  assert.ok(/quota/i.test(all), 'the unknown quota must be on the checklist');
});

(async () => {
  for (const [name, fn] of pending) {
    try { await fn(); pass += 1; } catch (e) { fail += 1; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  console.log(`\nsam-gov: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
