'use strict';
// ── EXECUTE THE SCOPE PAGE, DO NOT JUST PARSE IT. ─────────────────────────────
//
// scripts/check-spa-parse.js proves the page PARSES. It cannot catch a TDZ read, a handler that is
// not reachable from an inline onclick, or a render that throws on a shape the API actually returns
// — and a page that throws renders nothing at all, with an empty container and no server trace.
// That is the outage this whole class of test exists because of.
//
// Same vm approach as src/lib/cphi/page-renders.test.js, including its brace-counting extractor's
// line-comment skip: an apostrophe in a prose comment otherwise opens a string that never closes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../../..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function extractPage(name) {
  const needle = `pages['${name}'] = async function`;
  const start = HTML.indexOf(needle);
  assert.ok(start >= 0, `${needle} not found — did the page get renamed?`);
  const open = HTML.indexOf('{', HTML.indexOf(')', start));
  let depth = 0, i = open, inStr = null, prev = '';
  for (; i < HTML.length; i++) {
    const ch = HTML[i];
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
    } else if (ch === '/' && HTML[i + 1] === '/') {
      const nl = HTML.indexOf('\n', i);
      if (nl < 0) break;
      i = nl; prev = ''; continue;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
    } else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) break; }
    prev = prev === '\\' ? '' : ch;
  }
  assert.ok(depth === 0, 'braces never balanced — extraction is wrong, not the page');
  return HTML.slice(HTML.indexOf('(', start), i + 1);
}

// Shaped like the real /sponsors response: ranked, with molecules.
function rankedResponse(over = {}) {
  return Object.assign({
    event: { slug: 'scope-europe-2026', name: 'SCOPE Europe 2026', city: 'Barcelona',
             starts: '2026-10-13', ends: '2026-10-14' },
    role: 'abiozen', role_label: 'Abiozen',
    role_note: 'Runs clinical trials, so it buys molecules and the QC testing around them.',
    basis: 'demand', ranked: true, count: 2, on_floor: 1, exhibitor_list_loaded: true,
    items: [
      { sponsor: 'Takeda Development Center Americas, Inc.', studies: 2, ph3: 1, ph2: 1,
        recruiting: 2, patients: 520, score: '28.04', molecules: 2, sourceable: 2, unsourced: 0,
        molecule_list: [{ molecule: 'Cabazitaxel', sourceable: true, has_dmf: false, has_price: true },
                        { molecule: 'Leuprolide Acetate', sourceable: true, has_dmf: true, has_price: false }],
        exhibiting: true, booth: 'P14', hall: 'Exhibit Hall', exhibitor_name: 'Takeda',
        match_tier: 'prefix', review_status: 'entity_review' },
      { sponsor: 'Novo Nordisk A/S', studies: 3, ph3: 2, ph2: 0, recruiting: 2, patients: 1740,
        score: '22.48', molecules: 2, sourceable: 0, unsourced: 2,
        molecule_list: [{ molecule: 'Semaglutide', sourceable: false, has_dmf: false, has_price: false }],
        exhibiting: false, booth: null, hall: null, exhibitor_name: null,
        match_tier: null, review_status: null },
    ],
  }, over);
}

// Shaped like the real /exhibitors response: worked, alphabetical, no ranking.
function workedResponse(over = {}) {
  return Object.assign({
    event: { slug: 'scope-europe-2026', name: 'SCOPE Europe 2026', city: 'Barcelona',
             starts: '2026-10-13', ends: '2026-10-14' },
    role: 'aros', role_label: 'AROS',
    role_note: 'Mostly AROS COMPETITORS, not prospects — no ranking signal, so the list is alphabetical.',
    basis: 'none', ranked: false, count: 2, on_floor: 2,
    items: [
      { id: '1', holder: 'Medidata', exhibitor_name: 'Medidata', exhibiting: true, booth: null,
        hall: 'Exhibit Hall', match_tier: 'exact', review_status: 'entity_review',
        role: 'aros', role_note: 'premier sponsor · COMPETITOR. The incumbent EDC/clinical cloud.' },
      { id: '2', holder: 'Suvoda', exhibitor_name: 'Suvoda', exhibiting: true, booth: null,
        hall: 'Exhibit Hall', match_tier: 'exact', review_status: 'entity_review',
        role: 'aros', role_note: 'corporate sponsor · COMPETITOR. IRT/RTSM and eConsent.' },
    ],
  }, over);
}

async function render(res, stateOver = {}) {
  const written = [];
  const el = () => ({
    set innerHTML(v) { written.push(v); },
    get innerHTML() { return written[written.length - 1] || ''; },
    scrollIntoView() {}, value: '', style: {}, focus() {},
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
    slug: 'scope-europe-2026', role: res.role || 'abiozen', data: null, loading: false, openId: 0,
  }, stateOver);
  sandbox.window._seState = state;
  sandbox.pages = {};
  vm.createContext(sandbox);
  // seEsc delegates to cmEsc, which is defined far earlier in the file. Provide it the same way.
  vm.runInContext(`function seEsc(v){ return cmEsc(v); }
    function seGate(row){
      if (!row || row.review_status === 'confirmed') return '';
      const t = row.match_tier;
      if (t && t !== 'exact') return '<span>' + seEsc(t) + ' match — confirm the entity</span>';
      return '<span>category unreviewed</span>';
    }`, sandbox);
  const src = extractPage('scope-europe');
  vm.runInContext(`pages['scope-europe'] = async function ${src};`, sandbox);
  await sandbox.pages['scope-europe']();
  return written.join('\n');
}

// ── IT RENDERS AT ALL ────

test('the ranked tab renders without throwing', async () => {
  const out = await render(rankedResponse());
  assert.ok(out.length > 200, 'rendered almost nothing');
  assert.ok(out.includes('SCOPE Europe 2026'));
  assert.ok(out.includes('Barcelona'));
});

test('the worked tab renders without throwing', async () => {
  const out = await render(workedResponse(), { role: 'aros' });
  assert.ok(out.includes('Medidata'));
  assert.ok(out.includes('Suvoda'));
});

test('an API error renders a message, not a blank page', async () => {
  // API() resolves with {error} rather than throwing. A page that only try/catches shows nothing.
  const out = await render({ error: 'tier required' });
  assert.ok(out.includes('tier required'), 'the error text must reach the page');
  assert.ok(out.includes('SCOPE Europe'), 'and the page must still identify itself');
});

test('an empty list says why it is empty', async () => {
  const ranked = await render(rankedResponse({ items: [], count: 0, on_floor: 0 }));
  assert.ok(/statement about our data/i.test(ranked),
    'an empty ranked tab must distinguish "our data is thin" from "the floor is empty"');
  const worked = await render(workedResponse({ items: [], count: 0 }), { role: 'aros' });
  assert.ok(/worked from the exhibitor list|fills when the list is seeded/i.test(worked));
});

// ── THE THINGS THE PAGE MUST NOT OVERSTATE ────

test('a sponsor we can supply shows WHICH molecules, not just a score', async () => {
  const out = await render(rankedResponse());
  assert.ok(out.includes('Leuprolide Acetate'), 'the molecule is the sentence said at the booth');
  assert.ok(out.includes('Cabazitaxel'));
  assert.ok(/We can quote 2 of 2/.test(out), 'quotable count must be explicit');
});

test('a sponsor we cannot supply says so instead of showing a bare score', async () => {
  const out = await render(rankedResponse());
  assert.ok(/None of its .* molecule/i.test(out),
    'Novo Nordisk has nothing quotable and the page must say that, not just rank it lower');
});

test('a prefix match is shown as needing entity confirmation', async () => {
  // "Takeda Development Center Americas, Inc." matched a stand reading "Takeda". Right stand,
  // possibly wrong legal entity — fine for a conversation, not for a contract.
  const out = await render(rankedResponse());
  assert.ok(/prefix match/.test(out), 'the match tier must be visible on the row');
  assert.ok(/confirm the entity/i.test(out));
});

test('a sponsor absent from the exhibitor list is marked absent, not omitted', async () => {
  const out = await render(rankedResponse());
  assert.ok(out.includes('Novo Nordisk A/S'), 'a high-ranking non-exhibitor must still appear');
  assert.ok(/not on the exhibitor list/.test(out));
});

test('the competitor note reaches the page', async () => {
  const out = await render(workedResponse(), { role: 'aros' });
  assert.ok(/COMPETITOR/.test(out),
    'the AROS tab is a competitor map and must not read as a prospect list');
});

test('a missing exhibitor list is stated, so an empty floor column is not read as an empty floor', async () => {
  const out = await render(rankedResponse({ exhibitor_list_loaded: false, on_floor: 0 }));
  assert.ok(/missing data, not an empty floor/i.test(out));
});

// ── HANDLERS MUST BE REACHABLE FROM AN INLINE onclick ────

test('every onclick the page emits names a function assigned to window', async () => {
  const out = await render(rankedResponse());
  const names = [...out.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]);
  assert.ok(names.length, 'the page emitted no handlers at all');
  for (const n of new Set(names)) {
    // Annex B hoists a plain `function` out of a block but NOT an `async function`, so these are
    // assigned as window.<name> = ... . A block-scoped one throws ReferenceError on click and does
    // nothing visible, which is indistinguishable from a dead button.
    const assigned = new RegExp('window\\.' + n + '\\s*=').test(HTML);
    assert.ok(assigned, `onclick calls ${n}() but nothing assigns window.${n}`);
  }
});

test('the three role tabs are all present and switchable', async () => {
  const out = await render(rankedResponse());
  for (const label of ['Abiozen', 'AROS', 'LinkAble']) {
    assert.ok(out.includes(label), `the ${label} tab is missing`);
  }
  for (const key of ['abiozen', 'aros', 'linkable']) {
    assert.ok(out.includes(`seSetRole('${key}')`), `no switch handler for ${key}`);
  }
});

// ── THE COUNTDOWN IS COMPUTED, NOT WRITTEN DOWN ────

test('the days-until figure comes from the event dates, not a literal', async () => {
  // A hardcoded "in 4 days" is wrong tomorrow. Render with dates far in the future and assert the
  // page does not claim the real event's distance.
  const far = rankedResponse({
    event: { slug: 'x', name: 'SCOPE Europe 2026', city: 'Barcelona',
             starts: '2099-01-10', ends: '2099-01-11' },
  });
  const out = await render(far);
  assert.ok(/in \d+ days/.test(out), 'no countdown rendered');
  const n = Number(/in (\d+) days/.exec(out)[1]);
  assert.ok(n > 10000, `countdown reads ${n} days for a 2099 event — it is not computed from the dates`);
});

test('a finished event says finished rather than a negative number', async () => {
  const past = rankedResponse({
    event: { slug: 'x', name: 'CPHI Milan 2026', city: 'Milan',
             starts: '2026-10-06', ends: '2026-10-08' },
  });
  const out = await render(past);
  assert.ok(!/in -\d+ days/.test(out), 'a past event must not render "in -3 days"');
});
