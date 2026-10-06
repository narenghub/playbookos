// ── THE CPHI PAGE ACTUALLY RUNS, NOT JUST PARSES ──────────────────────────────
//
// On 7 October the page rendered nothing at the show, with "Cannot access 'halls' before
// initialization" in the console. A `const` read above its own declaration line is legal syntax and
// throws only when the line executes, so scripts/check-spa-parse.js — which parses — could not see it,
// and neither could any test in this repo. The failure surfaced on a phone in Milan.
//
// This EXECUTES the page function in a sandbox with stubbed globals and a fabricated server response.
// It asserts almost nothing about the markup; its whole job is that the function reaches the end
// without throwing, for every role and market combination the UI can put it in. A temporal-dead-zone
// read, a typo'd identifier, a null dereference on a field the server does not always send — all of
// those are now a failing test rather than a blank screen at a booth.
//
// IT IS NOT A BROWSER. There is no layout, no CSS, no event dispatch; `document` is a stub that
// records the HTML it was handed. That is the trade: it catches the class of bug that actually shipped,
// cheaply, with no new dependency.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/** Pull one `pages['x'] = async function(...) { ... }` out of the SPA by counting braces. */
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
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
    } else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) break; }
    prev = prev === '\\' ? '' : ch;
  }
  assert.ok(depth === 0, 'braces never balanced — extraction is wrong, not the page');
  return HTML.slice(HTML.indexOf('(', start), i + 1);
}

/** A response shaped like the real one, for one role. */
function fakeResponse(role, opts = {}) {
  const row = (id, over) => Object.assign({
    id: String(id), holder: 'Firm ' + id, exhibitor_name: 'Firm ' + id + ' SpA',
    exhibiting: true, booth: '10' + id, hall: '10', match_tier: 'exact',
    review_status: 'auto_confirmed', entity_note: null, molecules_covered: 5,
    checked_at: '2026-10-01T00:00:00Z', role, role_note: 'ITA · 4 operations',
    market: role === 'supplier' ? null : 'eu',
    met_in_person: false, linkedin_connected: false,
  }, over);
  return {
    event: 'cphi-milan-2026', role,
    roles: [{ role: 'supplier', on_floor: 12, checked: 40 },
            { role: 'platform_partner', on_floor: 3, checked: 10 },
            { role: 'qc_lab', on_floor: 2, checked: 9 },
            { role: 'buyer', on_floor: 7, checked: 30 }],
    market: opts.market || 'all',
    markets: opts.markets === undefined
      ? [{ market: 'eu', on_floor: 3, checked: 10 }, { market: 'us', on_floor: 4, checked: 20 }]
      : opts.markets,
    items: opts.items === undefined
      ? [row(1), row(2, { hall: '7', booth: '7A' }),
         // A token-tier row, which the table drops and the unverified panel shows.
         row(3, { match_tier: 'token', review_status: 'unreviewed' }),
         // The shapes that have broken this page before: no booth, no hall, zero molecules.
         row(4, { booth: null, hall: null, molecules_covered: 0, exhibiting: false })]
      : opts.items,
    summary: { exhibiting: 3, checked: 40, booths: 3, molecule_links: 10, entity_review: 1, unverified: 1 },
    dmf_source: { source_file: 'dmf.xlsx', ingested_at: '2026-08-01T00:00:00Z', rows: 9000 },
  };
}

/** Run the page function once against a given state and response. Returns the HTML it wrote. */
async function render(state, res) {
  const written = [];
  const el = () => ({
    set innerHTML(v) { written.push(String(v)); },
    get innerHTML() { return written[written.length - 1] || ''; },
    scrollIntoView() {}, value: '', style: {}, focus() {},
    addEventListener() {}, querySelector: () => null,
  });
  const sandbox = {
    document: { getElementById: el, querySelector: () => null, createElement: el },
    window: {}, console,
    // The page's own helpers, stubbed to the shape the page uses rather than their real behaviour.
    API: async () => ({ items: [] }),
    orLoad: async () => {}, orCell: () => '', orBar: () => '',
    cmEsc: (s) => String(s == null ? '' : s),
    cmTierBadge: (t) => String(t || ''),
    cmFileAge: () => '10 weeks old',
    cmDrawer: () => '', cmComposeForm: () => '',
    URLSearchParams, Promise, Math, Number, String, Object, Array, JSON, Set, Date, parseInt,
    alert: () => {},
  };
  sandbox.window._cmState = state;
  sandbox.pages = {};
  vm.createContext(sandbox);
  // The thin-supply call and the exhibitor call both go through API; reuse=true skips both, so the
  // response is injected as state.data the way the page's own refetch does.
  state.data = res;
  state.thin = { items: [{ molecule: 'Amlodipine', studies: 12, ph3: 3, holder_count: 1,
                           // Deliberately NOT one of the table's firms: the thin-supply panel renders
                           // holder names too, so sharing a name would make a table assertion pass on
                           // a row from the wrong panel.
                           holders: [{ holder: 'Sole Holder Ltd', exhibiting: true, booth: '101' }] }] };
  const src = extractPage('cphi-milan');
  vm.runInContext(`pages['cphi-milan'] = async function ${src};`, sandbox);
  await sandbox.pages['cphi-milan'](true);
  return written.join('\n');
}

const baseState = (over) => Object.assign({
  exhibiting: 'true', tier: '', showUnverified: false, data: null, thin: null,
  hall: '', role: 'supplier', market: 'all',
  openId: 0, openTab: 'molecules', open: null, openLoading: false,
  composeFor: 0, composeSubject: '', composeBody: '', composeAttach: true,
}, over);

// ── THE FOUR ROLES ───────────────────────────────────────────────────────────

for (const role of ['supplier', 'platform_partner', 'qc_lab', 'buyer']) {
  test(`the page renders for role=${role}`, async () => {
    const html = await render(baseState({ role }), fakeResponse(role));
    assert.ok(html.length > 500, 'the page produced almost no markup');
    assert.match(html, /CPHI MILAN 2026/);
    // Every role tab is present whichever one is open, so the other conversations stay reachable.
    assert.match(html, /cmSetRole\('platform_partner'\)/);
    assert.match(html, /cmSetRole\('qc_lab'\)/);
    assert.match(html, /cmSetRole\('buyer'\)/);
  });
}

// ── THE FILTERS, INCLUDING THE COMBINATION THAT BROKE IT ─────────────────────

test('a hall filter renders, and narrows the table', async () => {
  const all = await render(baseState({ role: 'supplier' }), fakeResponse('supplier'));
  const one = await render(baseState({ role: 'supplier', hall: '7' }), fakeResponse('supplier'));
  assert.match(all, /hall: all/);
  // Row 2 is the only hall-7 row that survives the token filter.
  assert.ok(one.includes('Firm 2'), 'the hall-7 row is missing');
  assert.ok(!one.includes('Firm 1<'), 'a hall-10 row survived the hall-7 filter');
});

test('the market filter appears only where the role has markets', async () => {
  const withMarkets = await render(baseState({ role: 'buyer' }), fakeResponse('buyer'));
  assert.match(withMarkets, /cmSet\('market'/);
  // Suppliers carry no market, so the server returns none and the dropdown must not be drawn —
  // offering a filter that can only ever empty the table is worse than offering none.
  const none = await render(baseState({ role: 'supplier' }), fakeResponse('supplier', { markets: [] }));
  assert.ok(!/cmSet\('market'/.test(none), 'a market dropdown was drawn with no markets behind it');
});

test('an EU market view says what the EU list actually is', async () => {
  // The underlying register is the US one, so "EU" means EU firms with US-facing business. Reading
  // this list as full EU coverage is the mistake that would be made at a booth, so the page says it.
  const html = await render(baseState({ role: 'buyer', market: 'eu' }), fakeResponse('buyer', { market: 'eu' }));
  assert.match(html, /US register/);
  assert.match(html, /not every EU firm/);
});

// ── THE EMPTY AND MISSING CASES ──────────────────────────────────────────────

test('a role with no rows yet renders an empty table, not an error', async () => {
  // Every non-supplier role starts empty, before its lookup has ever been run. That state is the
  // FIRST thing seen after a deploy, so it must read as "not run yet".
  const html = await render(baseState({ role: 'qc_lab' }),
    fakeResponse('qc_lab', { items: [], markets: [] }));
  assert.match(html, /Nothing matches this filter|Nothing is here until a lookup/);
});

test('the page survives a response missing the fields the server does not always send', async () => {
  // `markets` and `roles` were added after the page shipped; an older container answering a newer
  // page omits them. The page must degrade, not throw.
  const res = fakeResponse('buyer');
  delete res.markets; delete res.roles; delete res.dmf_source;
  const html = await render(baseState({ role: 'buyer' }), res);
  assert.ok(html.length > 500);
});
