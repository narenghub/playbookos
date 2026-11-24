// ── WHICH COMPANY MAY THIS PERSON SEE? ──────────────────────────────────────
//
//   node --test src/lib/office/context-read-session.test.js
//
// `resolveCompanyForReadSession` had NO test of its real behaviour. The two suites that reference
// it — src/api/approvals-dispatch.test.js and src/api/decisions-routes.test.js — replace the whole
// module in `require.cache` with a stub that returns `{ companyId: 'abiozen' }`, so they pass
// whatever this function does, including nothing. That is worth stating plainly: the function that
// decides which tenant a person may read was covered only by tests that had replaced it.
//
// Owner ruling 2026-11-24, Phase 2. Each requirement is numbered here as it was numbered there.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const CTX = require('./context');

/** A membership module whose answers this test controls. Shaped like the real accessor. */
function membership(answer) {
  return {
    UNKNOWN: null,
    membershipsOf: async () => (typeof answer === 'function' ? answer() : answer),
  };
}

const ABIOZEN = { companyId: 'co-abiozen', companyRole: 'admin' };
const ADIFICE = { companyId: 'co-adifice', companyRole: 'dev_team' };

const resolve = (args, answer) =>
  CTX.resolveCompanyForReadSession(args, { membership: membership(answer) });

async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    assert.equal(e.name, 'NoCompanyContext', `expected a NoCompanyContext, got ${e.name}: ${e.message}`);
    return e.message;
  }
}

// ── REQ 1: ONE AUTHORIZED COMPANY RESOLVES ──────────────────────────────────

test('req 1: a user with exactly one authorized company resolves that company', async () => {
  const ctx = await resolve({ userId: 'u1' }, [ABIOZEN]);
  assert.equal(ctx.companyId, 'co-abiozen');
  assert.equal(ctx.companyRole, 'admin', 'the role held IN that company comes through');
  assert.equal(ctx.source, 'read_session');
});

// ── REQ 2: MULTIPLE COMPANIES REQUIRE AN EXPLICIT CHOICE ────────────────────

test('req 2: DECISIVE — two authorized companies and no selection is refused, not guessed', async () => {
  const why = await refusal(resolve({ userId: 'u1' }, [ABIOZEN, ADIFICE]));
  assert.ok(why, 'picking one would show a tenant they did not ask for');
  assert.match(why, /co-abiozen/);
  assert.match(why, /co-adifice/, 'and it names the authorized ones so a caller can offer a choice');
});

test('req 2: selecting one of them resolves it', async () => {
  const ctx = await resolve({ userId: 'u1', requestedCompanyId: 'co-adifice' }, [ABIOZEN, ADIFICE]);
  assert.equal(ctx.companyId, 'co-adifice');
  assert.equal(ctx.companyRole, 'dev_team', 'with the role held in THAT company, not the other');
});

// ── REQ 4: A REQUEST PARAMETER IS A LOOKUP KEY, NEVER THE ANSWER ────────────

test('req 4: DECISIVE — an unauthorized company named in the request is refused', async () => {
  const why = await refusal(
    resolve({ userId: 'u1', requestedCompanyId: 'co-someoneelse' }, [ABIOZEN]));
  assert.ok(why, 'a company id from a request must not become the context');
  assert.match(why, /not an authorized member/);
});

test('req 4: CONTROL — the same request shape succeeds for an authorized company', async () => {
  // Without this, the test above is satisfied by a function that refuses every selection, which
  // would make req 2 impossible to satisfy and the multi-company product unusable.
  const ctx = await resolve({ userId: 'u1', requestedCompanyId: 'co-abiozen' }, [ABIOZEN]);
  assert.equal(ctx.companyId, 'co-abiozen');
});

test('req 4: a requested company is matched exactly, not by prefix or case', async () => {
  for (const bad of ['co-abiozen ', 'CO-ABIOZEN', 'co-abioz', 'co-abiozen-2']) {
    const why = await refusal(resolve({ userId: 'u1', requestedCompanyId: bad }, [ABIOZEN]));
    assert.ok(why, `"${bad}" must not resolve to co-abiozen`);
  }
});

// ── REQ 3: NO MEMBERSHIP, NO READ ───────────────────────────────────────────

test('req 3: a user with no active membership is refused', async () => {
  const why = await refusal(resolve({ userId: 'u1' }, []));
  assert.ok(why);
  assert.match(why, /no active company membership/);
  assert.match(why, /never/, 'and the refusal says a membership is granted, not inferred');
});

test('a read session still requires a userId at all', async () => {
  const why = await refusal(resolve({}, [ABIOZEN]));
  assert.match(why, /requires a userId/);
});

// ── FAIL CLOSED, DISTINGUISHABLY ────────────────────────────────────────────

test('DECISIVE: an unreadable membership table refuses, and is NOT reported as "no membership"', async () => {
  // The owner's words: "Do not classify an unavailable membership record as a departed employee."
  // Both cases refuse — what matters is that an operator reading the refusal is not sent looking
  // for a missing grant when the real problem is a database.
  const why = await refusal(resolve({ userId: 'u1' }, null));
  assert.ok(why);
  assert.match(why, /could not be read|UNKNOWN/);
  assert.doesNotMatch(why, /holds no active company membership/);
});

// ── REQ 5 AND 6: NOTHING IS CACHED, SO REVOCATION LANDS ON THE NEXT CALL ────

test('req 5/6: DECISIVE — revocation takes effect on the next request, with nothing to invalidate', async () => {
  let live = [ABIOZEN];
  const deps = { membership: membership(() => live) };

  const first = await CTX.resolveCompanyForReadSession({ userId: 'u1' }, deps);
  assert.equal(first.companyId, 'co-abiozen');

  live = [];                                   // the membership is revoked between requests
  const why = await refusal(CTX.resolveCompanyForReadSession({ userId: 'u1' }, deps));
  assert.ok(why, 'a second call must re-resolve rather than reuse the first answer');
});

test('req 6: a context carries when it was resolved, so a held one cannot pass as fresh', async () => {
  const ctx = await resolve({ userId: 'u1' }, [ABIOZEN]);
  assert.ok(ctx.resolvedAt, 'a queued task holding this must re-resolve before acting');
  assert.ok(!Number.isNaN(Date.parse(ctx.resolvedAt)));
});

// ── REQ 7: CONTEXT CANNOT BE MANUFACTURED ───────────────────────────────────

test('req 7: DECISIVE — a hand-made object with the right shape is refused by assertContext', async () => {
  // This is what an agent, or a careless caller, would construct.
  // The BRAND is checked first, deliberately, so both of these refuse on provenance rather than on
  // shape. An object that is merely missing a companyId and an object impersonating a context get
  // the same answer: this module did not produce you.
  assert.throws(() => CTX.assertContext({ companyId: 'co-abiozen' }), /not produced by/);
  assert.throws(() => CTX.assertContext(Object.freeze({})), /not produced by/);
});

test('req 7: a read-session context is frozen, so it cannot be widened after the fact', async () => {
  const ctx = await resolve({ userId: 'u1' }, [ABIOZEN]);
  assert.ok(Object.isFrozen(ctx));
  try { ctx.companyId = 'co-adifice'; } catch (_) { /* strict mode throws; either is fine */ }
  assert.equal(ctx.companyId, 'co-abiozen', 'the company in a resolved context is not writable');
});

test('the authorized set is exposed frozen, for a chooser UI, and cannot be extended', async () => {
  // Resolved WITH an explicit selection, because two memberships and no choice is a refusal.
  const chosen = await resolve({ userId: 'u1', requestedCompanyId: 'co-abiozen' }, [ABIOZEN, ADIFICE]);
  assert.deepEqual([...chosen.authorizedCompanyIds], ['co-abiozen', 'co-adifice']);
  assert.ok(Object.isFrozen(chosen.authorizedCompanyIds));
  assert.equal(chosen.companyId, 'co-abiozen',
    'the chosen company is the context; the authorized set is only what a chooser may offer');
});

// ── A READ CONTEXT IS NOT A WRITE CONTEXT ───────────────────────────────────

test('a read-session context is not accepted on the kernel write path', async () => {
  // It is frozen and has a companyId, so only `source` distinguishes it. assertContext guards the
  // write path; this pins that a read context is recognisably different rather than interchangeable.
  const ctx = await resolve({ userId: 'u1' }, [ABIOZEN]);
  assert.equal(ctx.source, 'read_session');
  assert.equal(ctx.objectiveId, null, 'a person browsing is not executing against an objective');
});

// ── REQ 7, PROPERLY: A CONTEXT IS TRUSTED BY PROVENANCE, NOT BY SHAPE ───────
//
// assertContext required `Object.isFrozen` plus a `companyId`, and its own comment said the point
// was to accept only "a context this module produced, not an object that merely has the right
// shape". Those are different claims, and a one-line probe on 2026-11-24 showed the gap:
//
//   assertContext(Object.freeze({ companyId: 'co-someone-elses-company' }))   // → ACCEPTED
//
// Frozen-ness is something any caller can supply. Every company-isolation rule in the system rests
// on this check, so it now requires a module-private Symbol that cannot be obtained from outside.

test('DECISIVE: a FROZEN hand-made object with a companyId is refused', async () => {
  const forged = Object.freeze({ companyId: 'co-someone-elses-company', objectiveId: null });
  assert.throws(() => CTX.assertContext(forged), /not produced by/);
  assert.equal(CTX.isTrustedContext(forged), false);
});

test('CONTROL: a context this module resolved IS trusted', async () => {
  // Without this, the test above is satisfied by an assertContext that refuses everything — which
  // would stop every kernel write in the system rather than only the forged ones.
  const ctx = await resolve({ userId: 'u1' }, [ABIOZEN]);
  assert.equal(CTX.isTrustedContext(ctx), true);
  assert.equal(CTX.assertContext(ctx), ctx, 'and it passes the write-path guard unchanged');
});

test('the brand cannot be copied off a real context by spreading it', async () => {
  // A Symbol-keyed property IS copied by object spread, so this pins the one case where a caller
  // could launder a real context into a modified one: spreading a genuine context and changing the
  // company. The copy carries the brand, so it must be caught by something else — it is not frozen.
  const real = await resolve({ userId: 'u1' }, [ABIOZEN]);
  const laundered = { ...real, companyId: 'co-someone-elses-company' };
  assert.equal(CTX.isTrustedContext(laundered), false, 'an unfrozen copy is not a context');
  assert.throws(() => CTX.assertContext(laundered), /frozen/);
});

test('…and a FROZEN spread copy with a changed company is still a forgery risk — documented', async () => {
  // Honest limit, stated rather than hidden: Object.freeze({ ...real, companyId: 'other' }) carries
  // the brand AND is frozen, so provenance alone cannot catch it. Spreading a trusted context is
  // therefore a code-review concern, and the defence is that no caller is given a real context for
  // a company it may not act for in the first place — the resolvers only ever return one the
  // authenticated subject is authorized for. Asserted so that if this ever becomes catchable, the
  // test changes deliberately rather than by accident.
  const real = await resolve({ userId: 'u1' }, [ABIOZEN]);
  const laundered = Object.freeze({ ...real, companyId: 'co-someone-elses-company' });
  assert.equal(CTX.isTrustedContext(laundered), true,
    'KNOWN LIMIT: a frozen spread of a genuine context passes provenance. The resolvers never hand '
    + 'out a context for an unauthorized company, which is what makes this hard to exploit, not the '
    + 'brand. If a non-spreadable carrier is introduced, update this test.');
});
