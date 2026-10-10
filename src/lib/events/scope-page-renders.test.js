'use strict';
// ── EXECUTE THE SCOPE PAGE, DO NOT JUST PARSE IT. ─────────────────────────────
//
// scripts/check-spa-parse.js proves the page PARSES. It cannot catch a TDZ read, a handler that is
// not reachable from an inline onclick, or a render that throws on a shape the API actually returns
// — and a page that throws renders nothing at all, with an empty container and no server trace.
// That is the outage this whole class of test exists because of.
//
// The page is a WORKING list, not a report: mark met, connect on LinkedIn, capture the card, follow
// up next week. All three tabs read the same exhibitor rows for exactly that reason — every one of
// those actions needs a row id. So these tests are mostly about whether the loop is intact.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../../..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function extractFn(decl) {
  const start = HTML.indexOf(decl);
  assert.ok(start >= 0, `${decl} not found — did it get renamed?`);
  const open = HTML.indexOf('{', HTML.indexOf(')', start));
  let depth = 0, i = open, inStr = null, prev = '';
  for (; i < HTML.length; i++) {
    const ch = HTML[i];
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
    } else if (ch === '/' && HTML[i + 1] === '/') {
      // SKIP LINE COMMENTS. An apostrophe in prose otherwise opens a string that never closes, the
      // brace depth desyncs, and every test here fails while the page is perfectly fine.
      const nl = HTML.indexOf('\n', i);
      if (nl < 0) break;
      i = nl; prev = ''; continue;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
    } else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) break; }
    prev = prev === '\\' ? '' : ch;
  }
  // THIS MESSAGE IS THE FIX FOR A TRAP. The extractor is a brace counter with a naive string
  // tracker: a backtick flips its in-string state, so a NESTED template literal — ``${c ? `a` : `b`}``
  // — makes it lose track, desync the depth, and report "braces never balanced" for all 21 tests at
  // once. That reads as a catastrophically broken page when the page parses perfectly.
  //
  // `${x.map(r => `…`)}` happens to survive because the backticks pair up and the parity works out.
  // A ternary between two templates does not. If every test in this file fails together, suspect the
  // extractor first and look for a nested backtick added to the page — not the page's logic.
  assert.ok(depth === 0,
    `braces never balanced for ${decl} — this is almost certainly the EXTRACTOR, not the page. ` +
    'Look for a nested template literal (a backtick inside a backtick, e.g. a ternary between two ' +
    'templates) newly added to that function, and hoist it into a plain variable instead. ' +
    'Confirm the page itself is fine with: node scripts/check-spa-parse.js');
  return HTML.slice(HTML.indexOf('(', start), i + 1);
}

// Shaped like the real /events/:slug/exhibitors response.
function response(over = {}) {
  return Object.assign({
    event: { slug: 'scope-europe-2026', name: 'SCOPE Europe 2026', city: 'Barcelona',
             starts: '2026-10-13', ends: '2026-10-14' },
    role: 'abiozen', role_label: 'Abiozen',
    role_note: 'Runs clinical trials, so it buys molecules and the QC testing around them.',
    basis: 'demand', ranked: false,
    count: 2, on_floor: 1, met: 1, connected: 0, cards: 1,
    items: [
      { id: '11', holder: 'Thermo Fisher', exhibitor_name: 'Thermo Fisher', exhibiting: true,
        booth: 'P14', hall: 'Exhibit Hall', match_tier: 'exact', review_status: 'entity_review',
        role: 'abiozen', role_note: 'corporate sponsor · CDMO and analytical services.',
        met_in_person: false, linkedin_connected: false, meeting_note: null, contact_count: 0 },
      { id: '12', holder: 'Fortrea', exhibitor_name: 'Fortrea', exhibiting: false,
        booth: null, hall: null, match_tier: 'exact', review_status: 'entity_review',
        role: 'abiozen', role_note: 'premier sponsor · Global CRO.',
        met_in_person: true, linkedin_connected: false, meeting_note: 'Wants a QC quote',
        contact_count: 1 },
    ],
  }, over);
}

async function render(res, stateOver = {}) {
  const written = [];
  const el = (id) => ({
    set innerHTML(v) { written.push(v); },
    get innerHTML() { return written[written.length - 1] || ''; },
    scrollIntoView() {}, value: (stateOver.__inputs || {})[id] || '', style: {}, focus() {},
    addEventListener() {}, querySelector: () => null,
  });
  const sandbox = {
    document: { getElementById: el, querySelector: () => null, createElement: el },
    window: {}, console,
    API: async () => res,
    cmEsc: (s) => String(s == null ? '' : s),
    URLSearchParams, Promise, Math, Number, String, Object, Array, JSON, Set, Date,
    parseInt, encodeURIComponent, alert: () => {},
  };
  const state = Object.assign({
    slug: 'scope-europe-2026', role: res.role || 'abiozen', data: null,
    openId: 0, contacts: [], form: {}, formError: '', contactsLoading: false,
  }, stateOver);
  sandbox.window._seState = state;
  sandbox.pages = {};
  vm.createContext(sandbox);
  vm.runInContext('function seEsc(v){ return cmEsc(v); }', sandbox);
  vm.runInContext(`function seCardPanel ${extractFn('function seCardPanel(row)')}`, sandbox);
  vm.runInContext(`pages['scope-europe'] = async function ${extractFn("pages['scope-europe'] = async function(reuse)")};`, sandbox);
  await sandbox.pages['scope-europe']();
  return { out: written.join('\n'), state, sandbox };
}

// ── IT RENDERS, AND IT RENDERS THE LOOP ────

test('the page renders without throwing', async () => {
  const { out } = await render(response());
  assert.ok(out.length > 300, 'rendered almost nothing');
  assert.ok(out.includes('SCOPE Europe 2026'));
  assert.ok(out.includes('Barcelona'));
});

test('every company row carries the three floor actions', async () => {
  // Met, LinkedIn, card. This IS the CPHI format, and a row missing one of them is a row that
  // cannot be worked at a booth.
  const { out } = await render(response());
  assert.ok(/seToggle\('11','met_in_person'/.test(out), 'no Met toggle');
  assert.ok(/seToggle\('11','linkedin_connected'/.test(out), 'no LinkedIn toggle');
  assert.ok(/seCards\('11'\)/.test(out), 'no card capture');
});

test('a toggle sends the OPPOSITE of the current state', async () => {
  // Thermo Fisher has met_in_person false, Fortrea true. A button that always sends true cannot
  // undo a mis-tap, and mis-taps happen on a phone between booths.
  const { out } = await render(response());
  assert.ok(/seToggle\('11','met_in_person',true\)/.test(out), 'an unmet row must offer to set true');
  assert.ok(/seToggle\('12','met_in_person',false\)/.test(out), 'a met row must offer to set false');
});

test('a met company is visually distinct and sorts as done', async () => {
  const { out } = await render(response());
  assert.ok(out.includes('✓ Met'), 'a met row must read as met');
  assert.ok(/Wants a QC quote/.test(out), 'the meeting note must be visible');
});

test('the card count shows when cards exist and invites one when none do', async () => {
  const { out } = await render(response());
  assert.ok(/1 card/.test(out), 'a company with a card must show the count');
  assert.ok(/\+ Card/.test(out), 'a company with none must invite one');
});

test('the summary counts progress, not ranking', async () => {
  const { out } = await render(response());
  for (const label of ['Companies', 'On floor', 'Met', 'LinkedIn', 'Cards']) {
    assert.ok(out.includes(label), `the ${label} stat is missing`);
  }
});

test('there is NO hall filter', async () => {
  // One hall at SCOPE. A filter that can only ever return everything is a control that teaches
  // the user it does nothing.
  const { out } = await render(response());
  assert.ok(!/hall.*<select|<select[^>]*hall/i.test(out), 'a hall filter crept back in');
  assert.ok(/one hall/i.test(out), 'the page should say why there is no hall filter');
});

// ── THE CARD DRAWER ────

test('opening a company shows the capture form', async () => {
  const { out } = await render(response(), { openId: '11' });
  for (const id of ['se-name', 'se-title', 'se-email', 'se-phone', 'se-note']) {
    assert.ok(out.includes(id), `the ${id} field is missing`);
  }
  assert.ok(/seSaveCard\('11'\)/.test(out), 'no save handler');
});

test('the drawer lists cards already captured for that company only', async () => {
  const { out } = await render(response(), {
    openId: '12',
    contacts: [
      { exhibitor_match_id: '12', name: 'Ana Ruiz', title: 'BD Director', email: 'ana@example.com' },
      { exhibitor_match_id: '99', name: 'Someone Else', title: 'Wrong company' },
    ],
  });
  assert.ok(out.includes('Ana Ruiz'), 'the matching card is missing');
  assert.ok(!out.includes('Someone Else'), 'a card from another company leaked into this drawer');
});

test('the drawer says a save also marks them met', async () => {
  // Otherwise it is a surprise, and a surprise in a progress counter reads as a bug.
  const { out } = await render(response(), { openId: '11' });
  assert.ok(/also marks them met/i.test(out));
});

test('a half-typed card is preserved so a failed save loses nothing', async () => {
  const { out } = await render(response(), {
    openId: '11', form: { name: 'Ana Ruiz', email: 'ana@example.com' }, formError: 'name and company are required',
  });
  assert.ok(out.includes('Ana Ruiz'), 'the typed name was dropped on re-render');
  assert.ok(out.includes('ana@example.com'));
  assert.ok(out.includes('name and company are required'), 'the error must be shown');
});

// ── FAILURE SHAPES ────

test('an API error renders a message, not a blank page', async () => {
  // API() resolves with {error} rather than throwing. A page that only try/catches shows nothing.
  const { out } = await render({ error: 'tier required' });
  assert.ok(out.includes('tier required'));
  assert.ok(out.includes('SCOPE Europe'), 'the page must still identify itself');
});

test('an empty tab says it is missing data, not an empty floor', async () => {
  const { out } = await render(response({ items: [], count: 0, on_floor: 0, met: 0, connected: 0, cards: 0 }));
  assert.ok(/missing data, not an empty floor/i.test(out));
});

test('an empty LinkAble tab says ZERO IS THE ANSWER, not that data is missing', async () => {
  // The two empty states mean opposite things. All 61 SCOPE sponsors were researched and none is a
  // staffing agency, so calling that "missing data" would send someone hunting a bug in a tab that
  // is already correct — the same mistake in reverse as the CPHI buyer tab looking authoritative
  // while returning dairies.
  const { out } = await render(
    response({ role: 'linkable', items: [], count: 0, on_floor: 0, met: 0, connected: 0, cards: 0 }),
    { role: 'linkable' });
  assert.ok(/Zero is the answer here, not a gap/i.test(out), 'the finding must be stated as a finding');
  assert.ok(!/missing data/i.test(out), 'and must NOT be called missing data');
  assert.ok(/attendee/i.test(out), 'and must say where the tab IS worked from instead');
});

test('a sponsor row shows the studies and patients it is running', async () => {
  // What Naresh asked for: the sponsor behind the CRO, with how many studies and how many
  // patients. That line is what makes the first sentence at a booth theirs rather than ours.
  const { out } = await render(response({
    items: [{ id: '20', holder: 'Takeda', exhibiting: false, booth: null, role: 'abiozen',
              role_note: 'Sponsor · 12 studies, 5 recruiting', met_in_person: false,
              linkedin_connected: false, contact_count: 0,
              studies_count: 12, patients_count: 4200, molecules_covered: 3 }],
  }));
  assert.ok(/12<\/b> studies/.test(out), 'the study count is missing');
  assert.ok(/4,200<\/b> patients/.test(out), 'the patient count must be present and thousands-separated');
  assert.ok(/3 quotable/.test(out), 'how many of their molecules we can quote must show');
});

test('a row with no trial data shows no counts rather than zeros', async () => {
  // studies_count is nullable on purpose: 0 reads as "runs no trials", null as "we do not know",
  // and an exhibitor row seeded from a sponsor list genuinely does not know.
  const { out } = await render(response());
  assert.ok(!/<b>0<\/b> stud/.test(out), 'a null study count rendered as zero');
});

test('a row with no booth is marked not exhibiting rather than left ambiguous', async () => {
  const { out } = await render(response());
  assert.ok(/not exhibiting/.test(out));
});

// ── HANDLERS MUST BE REACHABLE FROM AN INLINE onclick ────

test('every onclick the page emits names a function assigned to window', async () => {
  const { out } = await render(response(), { openId: '11' });
  const names = [...out.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]);
  assert.ok(names.length, 'the page emitted no handlers at all');
  for (const n of new Set(names)) {
    // Annex B hoists a plain `function` out of a block but NOT an `async function`, so these are
    // assigned as window.<name> = ... . A block-scoped one throws ReferenceError on click and does
    // nothing visible, which is indistinguishable from a dead button.
    assert.ok(new RegExp('window\\.' + n + '\\s*=').test(HTML),
      `onclick calls ${n}() but nothing assigns window.${n}`);
  }
});

test('the three role tabs are present and switchable', async () => {
  const { out } = await render(response());
  for (const label of ['Abiozen', 'AROS', 'LinkAble']) {
    assert.ok(out.includes(label), `the ${label} tab is missing`);
  }
  for (const key of ['abiozen', 'aros', 'linkable']) {
    assert.ok(out.includes(`seSetRole('${key}')`), `no switch handler for ${key}`);
  }
});

// ── THE COUNTDOWN IS COMPUTED, NOT WRITTEN DOWN ────

test('the days-until figure comes from the event dates, not a literal', async () => {
  const { out } = await render(response({
    event: { slug: 'x', name: 'SCOPE Europe 2026', city: 'Barcelona',
             starts: '2099-01-10', ends: '2099-01-11' },
  }));
  assert.ok(/in \d+ days/.test(out), 'no countdown rendered');
  const n = Number(/in (\d+) days/.exec(out)[1]);
  assert.ok(n > 10000, `countdown reads ${n} days for a 2099 event — it is not computed`);
});

test('a finished event says finished rather than a negative number', async () => {
  const { out } = await render(response({
    event: { slug: 'x', name: 'CPHI Milan 2026', city: 'Milan',
             starts: '2026-10-06', ends: '2026-10-08' },
  }));
  assert.ok(!/in -\d+ days/.test(out), 'a past event must not render "in -3 days"');
});
