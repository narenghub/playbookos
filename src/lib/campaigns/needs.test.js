// Guards for need-based routing. The failure these exist to prevent is not a crash: it is a
// plausible-looking email whose opening sentence is not true of the person reading it.
'use strict';

const assert = require('assert');
const {
  NEED_CAMPAIGNS, needFor, renderNeed, needStepsOf, shortTopic, deptKind, formatGrantEnd,
} = require('./needs');

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
  assert.ok(/May 2029/.test(r.evidence), r.evidence);
});

// ── THE TRIAL SPLIT ──────────────────────────────────────────────────────────

t('a trial whose compound we know routes to reference standards, not API supply', () => {
  const r = needFor({ trialPhase: 'Phase 2', trialTitle: 'a breast cancer study', trialMolecule: 'olaparib' });
  assert.strictEqual(r.need, 'reference_standard');
  assert.strictEqual(r.signal, 'trial_molecule');
  assert.ok(/olaparib/.test(r.evidence) && /Phase 2/.test(r.evidence), r.evidence);
});

t('the reference-standard letter never offers to supply the trial compound itself', () => {
  // The sponsor locked API supply years before Phase II. Offering it reads as not understanding
  // how drug development works, which is the specific credibility failure this route avoids.
  const m = renderNeed('reference_standard', 1, {
    first: 'Sam', topic: 'olaparib', evidence: 'I saw you have olaparib in Phase 2.',
  });
  assert.ok(/not writing about the API/i.test(m.text), 'missing the disclaimer that makes it credible');
  assert.ok(/reference standards|impurit/i.test(m.text));
});

t('a trial with no named compound still falls back to clinical API', () => {
  const r = needFor({ trialPhase: 'Phase 3', trialTitle: 'a cardiology outcomes study' });
  assert.strictEqual(r.need, 'clinical_api');
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
    needFor({ trialPhase: 'Phase 2', trialTitle: 'x', trialMolecule: 'olaparib' }),
    needFor({ moleculeNamed: 'm', inCatalogue: true }),
    needFor({ moleculeNamed: 'm', inCatalogue: false }),
    needFor({ deptType: 'CHEMISTRY', researchTopic: 'total synthesis', grantNumber: 'R01GM000000' }),
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

// ── THE GRANT TITLE BECOMES SOMETHING A PERSON WOULD SAY ─────────────────────
// research_labs.focus is the NIH project title verbatim. These are real ones from the 26 October
// ingest, and the failure is not a crash: it is an email opening "your work on catalytic methods
// for the selective", which tells the reader nobody looked at it.

const REAL_TITLES = [
  'CAREER: Catalytic Methods for the Selective Functionalization of Complex Molecular Scaffolds',
  'Chemical Synthesis of Complex Natural Products',
  'MIRA: New Reactions for Medicinal Chemistry',
  'Catalyst-Controlled Site-Selective Reactions of Polyfunctional Molecules',
  'Development of DNA-Encoded Library Technology for Drug Discovery',
  'C-H Activation Approaches to Alkaloid Synthesis',
  'Total Synthesis of Terpenoid Natural Products and Analogues Thereof',
  'Mechanistic Studies of Transition Metal Catalyzed Cross-Coupling Reactions in Complex Settings',
];

// ── WHY THIS IS A GOLDEN TABLE AND NOT A PROPERTY CHECK ──────────────────────
//
// The first version of this test asserted only that the result does not END on a stopword. It
// passed with the phrase-boundary logic disabled, because the bad output was "catalytic methods
// for the selective" and "selective" is not a stopword — the test was checking a property the
// defect did not violate, which is the same failure as reading `tail -1` of a checker.
//
// There is no cheap property that distinguishes "catalytic methods for the selective" from
// "development of DNA-encoded library technology". A human can see it instantly and a regex
// cannot. So the expected strings are written out: each one was read and judged as the sentence
// the recipient sees, and any change to the shortening has to come back here and be judged again.
t('real grant titles shorten to exactly these phrases', () => {
  const want = new Map([
    ['CAREER: Catalytic Methods for the Selective Functionalization of Complex Molecular Scaffolds',
      'catalytic methods for the selective functionalization'],
    ['Chemical Synthesis of Complex Natural Products',
      'chemical synthesis of complex natural products'],
    ['MIRA: New Reactions for Medicinal Chemistry',
      'new reactions for medicinal chemistry'],
    ['Catalyst-Controlled Site-Selective Reactions of Polyfunctional Molecules',
      'catalyst-controlled site-selective reactions'],
    ['Development of DNA-Encoded Library Technology for Drug Discovery',
      'development of DNA-encoded library technology'],
    ['C-H Activation Approaches to Alkaloid Synthesis',
      'C-H activation approaches to alkaloid synthesis'],
    ['Total Synthesis of Terpenoid Natural Products and Analogues Thereof',
      'total synthesis of terpenoid natural products'],
    ['Mechanistic Studies of Transition Metal Catalyzed Cross-Coupling Reactions in Complex Settings',
      'mechanistic studies'],
    // The cap is 58 rather than 52 because of this one: at 52 it cut to "proton-coupled electron",
    // and a chemist reads that as someone who does not know the term is "electron transfer".
    ['Catalyzed Multi-Site Proton-Coupled Electron Transfer',
      'catalyzed multi-site proton-coupled electron transfer'],
  ]);
  for (const [raw, expected] of want) {
    assert.strictEqual(shortTopic(raw), expected,
      `\n  title:    ${raw}\n  expected: "${expected}"\n  got:      "${shortTopic(raw)}"`);
  }
});

t('no shortened title ends on a dangling article, preposition or conjunction', () => {
  // Weaker than the table above and kept for titles nobody has written out yet.
  for (const title of REAL_TITLES) {
    const s = shortTopic(title);
    assert.ok(!/\b(a|an|the|of|for|in|on|to|and|or|with|by|from|at|via|using|toward|towards|new|novel)\s*$/i.test(s),
      `"${title}" -> "${s}" ends mid-phrase`);
  }
});

t('a shortened title fits a subject line', () => {
  for (const title of REAL_TITLES) {
    assert.ok(shortTopic(title).length <= 58, `"${shortTopic(title)}" is too long for a subject`);
  }
});

t('acronyms and hyphenated technical terms keep their case', () => {
  // "dna-encoded" and "c-h activation" are wrong, and a chemist notices in the first two words.
  assert.ok(/DNA-encoded/.test(shortTopic('Development of DNA-Encoded Library Technology for Drug Discovery')));
  assert.ok(/C-H/.test(shortTopic('C-H Activation Approaches to Alkaloid Synthesis')));
});

t('funding mechanism prefixes are dropped', () => {
  for (const [raw, gone] of [['CAREER: Catalytic Methods for Synthesis', /career/i],
    ['MIRA: New Reactions for Medicinal Chemistry', /mira/i]]) {
    assert.ok(!gone.test(shortTopic(raw)), `prefix survived in "${shortTopic(raw)}"`);
  }
});

t('a title with no real subject is declined rather than shortened into nonsense', () => {
  // "Studies of" reduces to one word, and needFor refuses a one-word topic.
  assert.strictEqual(needFor({
    deptType: 'CHEMISTRY', researchTopic: 'Studies of', grantNumber: 'R01GM000000',
  }), null);
  assert.strictEqual(needFor({
    deptType: 'CHEMISTRY', researchTopic: '   ', grantNumber: 'R01GM000000',
  }), null);
});

t('every real title produces a readable opening sentence', () => {
  for (const title of REAL_TITLES) {
    const r = needFor({
      deptType: 'CHEMISTRY', researchTopic: title, grantNumber: 'R35GM134809', grantEndsOn: '2029-05-31',
    });
    assert.ok(r, `"${title}" was declined`);
    assert.ok(/^I came across your work on \S+ \S+/.test(r.evidence), r.evidence);
    assert.ok(!/\s{2,}|\bundefined\b/.test(r.evidence), r.evidence);
  }
});

// ── THE TWO DEFECTS THE FIRST DRY RUN FOUND ──────────────────────────────────
// Both produced plausible output and no error, which is why they reached a printed letter.

t('a Date object from Postgres formats as a month and year, not "Sun Mar"', () => {
  // node-postgres returns DATE as a JS Date. String(date).slice(0,7) took the first seven
  // characters of "Sun Mar 31 2030 00:00:00 GMT…" and printed it to three professors.
  assert.strictEqual(formatGrantEnd(new Date('2030-03-31T00:00:00Z')), 'March 2030');
  assert.strictEqual(formatGrantEnd('2029-05-31'), 'May 2029');
  assert.strictEqual(formatGrantEnd('2031-12-01T00:00:00.000Z'), 'December 2031');
});

t('an unparseable or nonsense date yields no clause at all', () => {
  for (const v of [null, undefined, '', 'not a date', '0001-01-01', {}]) {
    assert.strictEqual(formatGrantEnd(v), '', `${JSON.stringify(v)} produced a clause`);
  }
});

t('the grant clause never reaches an email malformed', () => {
  const r = needFor({
    deptType: 'Department of Chemistry', researchTopic: 'catalytic redox reactions',
    grantNumber: '2R35GM134929-06', grantEndsOn: new Date('2030-06-30T00:00:00Z'),
  });
  assert.ok(/running to June 2030/.test(r.evidence), r.evidence);
  assert.ok(!/Sun|Mon|Tue|Wed|Thu|Fri|Sat|GMT|\d{2}:\d{2}/.test(r.evidence), r.evidence);
});

t('RePORTER department strings are recognised, not just bare keywords', () => {
  // The first dry run declined 22 of 25 labs — Miller, Stahl, Denmark, Weix — because the check
  // was startsWith('CHEMISTRY') and RePORTER files "Department of Chemistry". Nothing errored;
  // the report said "not routed", which reads as a data problem rather than a matching bug.
  for (const d of ['CHEMISTRY', 'Chemistry', 'Department of Chemistry', 'Dept of Chemistry',
    'The Department of Chemistry', 'Department of Medicinal Chemistry', 'School of Chemistry']) {
    assert.strictEqual(deptKind(d), 'CHEMISTRY', `"${d}" -> ${deptKind(d)}`);
  }
  for (const d of ['BIOCHEMISTRY', 'Department of Biochemistry', 'Division of Biochemistry']) {
    assert.strictEqual(deptKind(d), 'BIOCHEMISTRY', `"${d}" -> ${deptKind(d)}`);
  }
  assert.strictEqual(deptKind('Department of Pharmacology'), 'PHARMACOLOGY');
  assert.strictEqual(deptKind(''), '');
});

t('the real declined labs now route', () => {
  // Exactly the rows the dry run skipped, with their filed department strings.
  for (const [who, dept] of [['Scott J Miller', 'Department of Chemistry'],
    ['Shannon S Stahl', 'Department of Chemistry'],
    ['Tian Qin', 'Department of Biochemistry'],
    ['Margaret A. Phillips', 'Department of Biochemistry']]) {
    const r = needFor({
      deptType: dept, researchTopic: 'catalytic methods for synthesis',
      grantNumber: 'R35GM134809', grantEndsOn: '2029-05-31',
    });
    assert.ok(r && r.need === 'discovery', `${who} (${dept}) still declined`);
  }
  // And pharmacology still does not get the discovery letter — that was deliberate, not a bug.
  assert.strictEqual(needFor({
    deptType: 'Department of Pharmacology', researchTopic: 'receptor signalling', grantNumber: 'R01',
  }), null);
});

t('a date string with no year is refused rather than filled in as 2001', () => {
  // "Sun Mar 31" parses happily and V8 supplies 2001, so three professors were about to be told
  // their 2030 grant runs to March 2001 — confidently wrong, which is worse than visibly broken.
  for (const v of ['Sun Mar 31', 'Mar 31', 'March', 'Fri Jun 30']) {
    assert.strictEqual(formatGrantEnd(v), '', `"${v}" produced a clause`);
  }
  // A Date object straight from Postgres still works, which is what the caller now passes.
  assert.strictEqual(formatGrantEnd(new Date('2030-03-31T00:00:00Z')), 'March 2030');
});

t('a year outside the plausible grant window produces no clause', () => {
  assert.strictEqual(formatGrantEnd('2001-03-31'), '');
  assert.strictEqual(formatGrantEnd('1999-01-01'), '');
  assert.strictEqual(formatGrantEnd('2099-01-01'), '');
});

t('a topic made only of grant boilerplate is declined', () => {
  // Real shortenings from the second dry run. Each is true and tells the professor nothing, which
  // is what a mail merge sounds like.
  // Note these are titles whose SHORTENING collapses to filler — "Broadened Access to Chemical
  // Tools for Biology" survives intact and routes correctly, because "chemical tools for biology"
  // does say something. The defect is the truncated remainder, not the original.
  for (const title of ['Broadened Access and Improved Methods for the Preparation of Heterocycles',
    'Fundamental Studies and Novel Approaches in Synthetic Transformations',
    'New Methods and Strategies']) {
    const r = needFor({
      deptType: 'Department of Chemistry', researchTopic: title, grantNumber: 'R01GM000000',
    });
    assert.strictEqual(r, null, `"${title}" -> "${shortTopic(title)}" was sent anyway`);
  }
});

t('a specific topic still routes even when padded with boilerplate', () => {
  for (const title of ['New Methods and Strategies for the Synthesis of Complex Molecules',
    'Catalytic Redox Reactions',
    'Expanding the Chemical Probe Development Paradigm',
    'Site-Selective Catalysis']) {
    const r = needFor({
      deptType: 'Department of Chemistry', researchTopic: title, grantNumber: 'R01GM000000',
    });
    assert.ok(r, `"${title}" -> "${shortTopic(title)}" was wrongly declined`);
  }
});

t('a subject never starts with a lowercase letter', () => {
  // Topics are de-title-cased to sit inside a sentence, which left "catalytic redox reactions —
  // structure search" in an inbox list, reading as machine output.
  const r = needFor({
    deptType: 'Department of Chemistry', researchTopic: 'Catalytic Redox Reactions in Synthesis',
    grantNumber: 'R35GM134929',
  });
  const m = renderNeed('discovery', 1, { first: 'Shannon', topic: r.topic, evidence: r.evidence });
  assert.ok(/^[A-Z]/.test(m.subject), `subject starts lowercase: ${m.subject}`);
  // …and the sentence still reads with a lowercase topic inside it.
  assert.ok(/your work on catalytic redox/.test(r.evidence), r.evidence);
});

if (fails.length) {
  console.error(`FAIL  ${fails.length} of ${pass + fails.length}`);
  for (const f of fails) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`ok  needs routing — ${pass} passed`);
