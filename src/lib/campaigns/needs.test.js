// Guards for need-based routing. The failure these exist to prevent is not a crash: it is a
// plausible-looking email whose opening sentence is not true of the person reading it.
'use strict';

const assert = require('assert');
const { NEED_CAMPAIGNS, needFor, renderNeed, needStepsOf } = require('./needs');

let pass = 0; const fails = [];
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fails.push(`${name}: ${e.message}`); } };

// ── FAIL CLOSED ──────────────────────────────────────────────────────────────
// Each of these is a contact we know something about but not enough. The right output is null.

t('no signals at all sends nothing', () => {
  assert.strictEqual(needFor({}), null);
  assert.strictEqual(needFor(), null);
});

t('an Apollo segment on its own never routes anybody', () => {
  for (const seg of ['Compounding Pharmacy', 'Generic Manufacturer', 'University/Research', 'Research Lab/Biotech']) {
    assert.strictEqual(needFor({ apolloSegment: seg }), null, `${seg} routed with no evidence`);
  }
});

t('a molecule we have not checked against the catalogue routes nowhere', () => {
  // inCatalogue undefined. Guessing picks between "we can source it" and "nobody carries it" —
  // opposite emails, one of them wrong.
  assert.strictEqual(needFor({ moleculeNamed: 'Yttrium oxide' }), null);
});

t('a phase with no study title sends nothing', () => {
  assert.strictEqual(needFor({ trialPhase: 'Phase 2' }), null);
});

t('a chemistry department with no topic or grant sends nothing', () => {
  assert.strictEqual(needFor({ deptType: 'CHEMISTRY' }), null);
  assert.strictEqual(needFor({ deptType: 'CHEMISTRY', researchTopic: 'C–H activation' }), null);
  assert.strictEqual(needFor({ deptType: 'CHEMISTRY', grantNumber: 'R35GM134809' }), null);
});

t('a non-chemistry department does not get the discovery letter', () => {
  // A pharmacology or clinical department may want API, not a structure search. No rule fires.
  assert.strictEqual(needFor({
    deptType: 'PHARMACOLOGY', researchTopic: 'opioid receptor signalling', grantNumber: 'R01DA000000',
  }), null);
});

// ── THE FOUR ROUTES ──────────────────────────────────────────────────────────

t('a phase II trial routes to clinical API', () => {
  const r = needFor({ trialPhase: 'Phase 2', trialTitle: 'olaparib in BRCA-mutated breast cancer' });
  assert.strictEqual(r.need, 'clinical_api');
  assert.strictEqual(r.signal, 'trial_phase');
  assert.ok(/Phase 2/.test(r.evidence) && /olaparib/.test(r.evidence), r.evidence);
});

t('phase I, II, III and roman numerals all route', () => {
  for (const ph of ['Phase 1', 'Phase 2', 'Phase 3', 'Phase I', 'Phase II', 'Phase III']) {
    const r = needFor({ trialPhase: ph, trialTitle: 'a study' });
    assert.ok(r && r.need === 'clinical_api', `${ph} did not route`);
  }
});

t('a molecule we stock routes to catalogue, one we do not routes to custom synthesis', () => {
  const have = needFor({ moleculeNamed: 'Metformin Hydrochloride', inCatalogue: true });
  assert.strictEqual(have.need, 'catalogue_api');
  const havent = needFor({ moleculeNamed: '4-Aminopyridine', inCatalogue: false });
  assert.strictEqual(havent.need, 'custom_synthesis');
  // And the two must never produce the same letter — they are opposite claims.
  assert.notStrictEqual(have.need, havent.need);
});

t('a funded chemistry lab routes to discovery with its grant in the evidence', () => {
  const r = needFor({
    deptType: 'CHEMISTRY', researchTopic: 'catalytic C–H functionalisation',
    grantNumber: 'R35GM134809', grantEndsOn: '2029-05-31',
  });
  assert.strictEqual(r.need, 'discovery');
  assert.ok(/R35GM134809/.test(r.evidence), r.evidence);
  assert.ok(/2029-05/.test(r.evidence), r.evidence);
});

t('a trial beats a molecule when both are present', () => {
  // A sponsor who also named a compound needs the clinical letter: the phase is the stronger fact.
  const r = needFor({
    trialPhase: 'Phase 3', trialTitle: 'a cardiology study',
    moleculeNamed: 'Metformin Hydrochloride', inCatalogue: true,
  });
  assert.strictEqual(r.need, 'clinical_api');
});

// ── EVERY ROUTE HAS COPY, AND EVERY CAMPAIGN IS REACHABLE ────────────────────

t('every need a route can return has a campaign defined', () => {
  const routes = [
    needFor({ trialPhase: 'Phase 2', trialTitle: 'x' }),
    needFor({ moleculeNamed: 'm', inCatalogue: true }),
    needFor({ moleculeNamed: 'm', inCatalogue: false }),
    needFor({ deptType: 'CHEMISTRY', researchTopic: 't', grantNumber: 'g' }),
  ];
  for (const r of routes) {
    assert.ok(NEED_CAMPAIGNS[r.need], `route returned "${r.need}" with no campaign`);
    assert.ok(needStepsOf(r.need).length >= 2, `${r.need} has fewer than 2 steps`);
  }
  // And nothing is defined that no route can reach — dead copy drifts out of date unnoticed.
  const reachable = new Set(routes.map((r) => r.need));
  for (const k of Object.keys(NEED_CAMPAIGNS)) {
    assert.ok(reachable.has(k), `campaign "${k}" is unreachable from needFor()`);
  }
});

// ── RENDERING REFUSES RATHER THAN DEGRADES ───────────────────────────────────

t('step 1 without evidence throws instead of sending a generic letter', () => {
  for (const k of Object.keys(NEED_CAMPAIGNS)) {
    assert.throws(() => renderNeed(k, 1, { first: 'Sam', topic: 'x' }), /evidence/,
      `${k} rendered step 1 with no evidence`);
  }
});

t('a missing first name throws', () => {
  assert.throws(() => renderNeed('discovery', 1, { evidence: 'e', topic: 't' }), /first name/);
});

t('no rendered subject or body carries an uninterpolated placeholder', () => {
  const vars = { first: 'Sam', topic: 'C–H activation', evidence: 'I came across your work.' };
  for (const k of Object.keys(NEED_CAMPAIGNS)) {
    for (const n of needStepsOf(k)) {
      const m = renderNeed(k, n, vars);
      for (const part of [m.subject, m.text, m.html]) {
        if (part === null) continue;
        assert.ok(!/\{\{|\$\{|undefined|\[object/.test(String(part)),
          `${k} step ${n} rendered a placeholder: ${String(part).slice(0, 120)}`);
      }
    }
  }
});

t('follow-up steps reply in thread rather than opening a new subject', () => {
  for (const k of Object.keys(NEED_CAMPAIGNS)) {
    const steps = needStepsOf(k);
    const last = renderNeed(k, steps[steps.length - 1], { first: 'Sam', topic: 't', evidence: 'e' });
    assert.strictEqual(last.isFollowUp, true, `${k}'s last step opens a new thread`);
  }
});

// ── CLAIMS WE MUST NOT MAKE ──────────────────────────────────────────────────

t('no sequence promises a volume, a throughput or a purity figure', () => {
  // Same guard as the CPHI campaigns. A number in cold copy is a claim we have to honour, and
  // "99.5% purity" on a molecule we have not sourced is one we cannot.
  const bad = /\b\d+\s*(kg|tonnes?|metric tons?)\b|\b99\.\d+\s*%|\b\d{3,}\s*(suppliers?|products?|customers?|clients?)\b/i;
  for (const k of Object.keys(NEED_CAMPAIGNS)) {
    for (const n of needStepsOf(k)) {
      const m = renderNeed(k, n, { first: 'Sam', topic: 't', evidence: 'e' });
      assert.ok(!bad.test(m.text), `${k} step ${n} promises a figure: ${m.text.match(bad)}`);
    }
  }
});

t('every sequence offers a way out or an honest no', () => {
  // The thing that makes these different from the campaigns that failed: each one says what
  // happens when the answer is no, so a reply costs the reader nothing.
  const out = /no obligation|straight no|whether or not|I will (leave it|stop)|not the right|decline|tell you we cannot|including when the answer is no|will not chase|keep the thread/i;
  for (const k of Object.keys(NEED_CAMPAIGNS)) {
    const all = needStepsOf(k).map((n) => renderNeed(k, n, { first: 'Sam', topic: 't', evidence: 'e' }).text).join('\n');
    assert.ok(out.test(all), `${k} never offers an easy no`);
  }
});

if (fails.length) {
  console.error(`FAIL  ${fails.length} of ${pass + fails.length}`);
  for (const f of fails) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`ok  needs routing — ${pass} passed`);
