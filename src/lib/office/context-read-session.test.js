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

// ── CONTEXT SUBSTITUTION: EXPLICIT CLOSURE EVIDENCE ─────────────────────────
//
// Owner, 2026-11-24: "The previous context substitution vulnerability remains open unless you
// provide explicit evidence that copied or modified contexts and direct brand fabrication are
// refused. Do not infer its closure from 19 passing context tests."
//
// Correct to insist. The brand alone did NOT close it, and the earlier version of this file said
// so: Symbols survive object spread, so `Object.freeze({ ...real, companyId: 'other' })` carried
// the brand, was frozen, and passed. That is the realistic attack — it needs no key, only a
// context the caller already legitimately holds.
//
// Trust is now OBJECT IDENTITY: a WeakSet of the objects this module minted, on globalThis so it
// survives the require.cache clearing the harnesses do. "Does it bear a mark" is a question a copy
// answers; "is it the object we created" is not.
//
// Each case below is an attack, named, with the real API.

test('CLOSURE: a spread copy with a CHANGED company is refused', async () => {
  const real = await resolve({ userId: 'u1' }, [ABIOZEN]);
  const substituted = Object.freeze({ ...real, companyId: 'co-someone-elses-company' });
  assert.equal(CTX.isTrustedContext(substituted), false);
  assert.throws(() => CTX.assertContext(substituted), /not produced by|neither is a COPY/);
});

test('CLOSURE: a spread copy that changes NOTHING is also refused', async () => {
  // Load-bearing. If only the changed copy were caught, an attacker would launder a context by
  // copying it first and mutating later, and the check would be testing the mutation rather than
  // the copying.
  const real = await resolve({ userId: 'u1' }, [ABIOZEN]);
  assert.equal(CTX.isTrustedContext(Object.freeze({ ...real })), false);
});

test('CLOSURE: direct brand fabrication with the PUBLISHED key is refused', async () => {
  // The brand key is in the source and in a scanner's allowlist, so it is not secret. Anyone can
  // write Symbol.for('playnexa.office.companyContext.v1'). It buys nothing.
  const fabricated = Object.freeze({
    companyId: 'co-someone-elses-company',
    [Symbol.for('playnexa.office.companyContext.v1')]: true,
  });
  assert.equal(CTX.isTrustedContext(fabricated), false);
  assert.throws(() => CTX.assertContext(fabricated), /not produced by/);
});

test('CLOSURE: prototype inheritance from a real context is refused', async () => {
  // Object.create(real) inherits companyId AND the Symbol through the prototype chain, so every
  // property check passes while the object itself is new.
  const real = await resolve({ userId: 'u1' }, [ABIOZEN]);
  const inherited = Object.freeze(Object.create(real));
  assert.equal(inherited.companyId, real.companyId, 'it really does read as the same company');
  assert.equal(CTX.isTrustedContext(inherited), false, 'and it is still not the resolved object');
});

test('CLOSURE: a JSON round-trip of a real context is refused', async () => {
  const real = await resolve({ userId: 'u1' }, [ABIOZEN]);
  const revived = Object.freeze(JSON.parse(JSON.stringify(real)));
  assert.equal(revived.companyId, real.companyId);
  assert.equal(CTX.isTrustedContext(revived), false,
    'this is the shape an agent could actually emit — JSON cannot carry a Symbol OR an identity');
});

test('CLOSURE: a derived context is trusted, and still cannot change company', async () => {
  // deriveContext is the sanctioned path, so it must keep working — otherwise office/run.js breaks
  // and the closure is achieved by making the system unusable.
  const real = await resolve({ userId: 'u1' }, [ABIOZEN]);
  const derived = CTX.deriveContext(real, { runId: 'run-1' });
  assert.equal(CTX.isTrustedContext(derived), true, 'a sanctioned derivation is a new MINTED object');
  assert.equal(derived.companyId, real.companyId);
  assert.throws(() => CTX.deriveContext(real, { companyId: 'co-other' }), /cannot change the company/);
});

test('CLOSURE: substitution is refused at the GATE, not only by the predicate', async () => {
  // The predicate being right matters only if the thing that authorizes sends consults it. This
  // asserts the refusal where it has consequences.
  const real = await resolve({ userId: 'u1' }, [ABIOZEN]);
  const substituted = Object.freeze({ ...real, companyId: 'co-someone-elses-company' });
  const GATE = require('../email-gate');
  const g = await GATE.assertSendAllowed(
    { capability: 'email.send', to: 'naren@abiozen.com', companyContext: substituted },
    { env: { COMPANY_EMAIL_DOMAINS: 'abiozen.com' },
      autonomy: { checkStopped: async () => null, recordRefusal: () => {} },
      query: async () => ({ rows: [] }) });
  assert.strictEqual(g.allowed, false,
    'a substituted context must not make anybody internal at the gate');
});

