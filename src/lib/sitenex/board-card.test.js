// REACHABILITY: can a person actually GET to the deal form?
//
//   node --test src/lib/sitenex/board-card.test.js
//
// THE BUG THIS EXISTS FOR. snEditDeal — the client details, the payment schedule, the Generate contract
// button, the Email to client button — shipped complete, correct, on window, with 50 passing route tests
// behind it, AND NOTHING CALLED IT. The Kanban board drew its cards with no click handler, so the entire
// contract flow was unreachable from the UI.
//
// Every server-side test passed, because every server-side thing worked. THE COMPLETENESS OF THE BACKEND IS
// WHAT HID IT: a route test proves a route answers, and says nothing about whether a human can get there.
// Nor can inline-handlers.test.js, which asks the opposite question — "is every handler NAMED by the HTML
// reachable" — and is perfectly happy when a handler is named by nothing at all.
//
// So this file asks: for each thing that must be reachable, does some rendered element carry a handler that
// leads to it? It is a small question and it was the whole gap.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const SHELL = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'public/sitenex-phase3.js'), 'utf8');
const ALL = SHELL + '\n' + UI;

// Handlers named by any rendered on* attribute, across both files. Interpolations are stripped: a
// `'+esc(x)+'` inside an attribute runs when the HTML is BUILT, not when it is clicked.
function handlersNamed(src) {
  const out = new Set();
  for (const m of src.matchAll(/\son(?:click|change|input|submit|keydown|dblclick)="([^"]*)"/g)) {
    const attr = m[1].replace(/'\s*\+\s*[^+]+\+\s*'/g, "''").replace(/\$\{[^}]*\}/g, "''");
    for (const f of attr.matchAll(/(?<![.$\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) out.add(f[1]);
  }
  return out;
}
const NAMED = handlersNamed(ALL);

// Does `from` reach `target`, following named function calls? One hop is enough in practice (a card calls a
// guard which calls the form) but following the graph means a future indirection does not silently break it.
function reaches(from, target, depth = 0) {
  if (from === target) return true;
  if (depth > 4) return false;
  // The body of `from`, wherever it is declared.
  const pat = new RegExp(`(?:window\\.${from}\\s*=\\s*(?:async\\s*)?function|(?:async\\s+)?function\\s+${from})\\b`);
  const m = pat.exec(ALL);
  if (!m) return false;
  const body = ALL.slice(m.index, m.index + 2600);
  if (new RegExp(`(?<![.$\\w])${target}\\s*\\(`).test(body)) return true;
  for (const call of body.matchAll(/(?<![.$\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    if (call[1] !== from && reaches(call[1], target, depth + 1)) return true;
  }
  return false;
}

test('GUARD: the scanner finds handlers at all', () => {
  // A reachability test whose scanner has stopped working reports everything as reachable.
  assert.ok(NAMED.size > 20, `only ${NAMED.size} handlers found across both files — the scanner is broken`);
  assert.ok(NAMED.has('apOpenDeal'), 'the board card handler must be found');
});

test('a deal board CARD has a handler that reaches snEditDeal', () => {
  // THE EXACT REGRESSION. The board renders one card per deal; if that card carries no handler, the form
  // behind it cannot be opened by anybody.
  const card = SHELL.slice(SHELL.indexOf('  const card = (d) =>'), SHELL.indexOf("  const board = '<div class=\"card\""));
  assert.ok(card.length > 100, 'could not find the card renderer — find it before asserting about it');
  const on = [...card.matchAll(/\son(?:click|dblclick)="([^"]*)"/g)].map(m => m[1]);
  assert.ok(on.length > 0,
    'the deal board card has NO click handler, so snEditDeal — and with it the client details, the payment '
    + 'schedule and the contract — is unreachable from the UI. This is exactly the bug this file exists for.');
  const names = [...new Set(on.flatMap(a => [...a.matchAll(/(?<![.$\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map(x => x[1])))];
  assert.ok(names.some(n => reaches(n, 'snEditDeal')),
    `the card's handler(s) [${names.join(', ')}] do not reach snEditDeal`);
  // And it must LOOK clickable, or it is reachable only by accident.
  assert.match(card, /cursor:pointer/, 'a clickable card must say so');
});

test('the card handler does NOT swallow clicks on anything interactive inside it', () => {
  // A whole-card handler that captured its own children would make a future button, link or select on a
  // card unusable: the click would open the deal instead of doing what the control says.
  const fn = SHELL.slice(SHELL.indexOf('function apOpenDeal('), SHELL.indexOf("pages['sitenex-deals'] = async function"));
  assert.ok(fn.length > 100, 'apOpenDeal must be findable');
  assert.match(fn, /closest/, 'it must inspect the click target, not just act on it');
  for (const tag of ['a', 'button', 'select', 'input', 'textarea', 'label']) {
    assert.ok(new RegExp(`[,'"(]\\s*${tag}\\b`).test(fn), `${tag} must be treated as interactive`);
  }
  assert.match(fn, /return/, 'and it must bail out rather than continuing');
  // Walked up from the target, so a <span> inside a <button> still counts as the button.
  assert.ok(/target/.test(fn), 'it reads the event target');
});

test('and it fails LOUDLY if the form script has not loaded', () => {
  // A card that silently ignores a click is the bug this whole file is about, so the degenerate case must
  // not reproduce it in miniature.
  const fn = SHELL.slice(SHELL.indexOf('function apOpenDeal('), SHELL.indexOf("pages['sitenex-deals'] = async function"));
  assert.match(fn, /typeof snEditDeal !== 'function'/, 'it must check the form exists');
  assert.match(fn, /alert\(/, 'and say something, rather than returning quietly');
});

test('a deal can be CREATED from the UI, and the flow lands in the form', () => {
  // The second half of the same gap: the form was unreachable, and there was also no way to make a deal to
  // open it with. A create button that leaves the user on the board is barely better — they then have to
  // find the new card.
  assert.ok(NAMED.has('apNewDeal'), 'there must be a New deal button');
  assert.match(SHELL, /New deal/, 'and it must say so');
  const flow = SHELL.slice(SHELL.indexOf('window.apNewDeal'), SHELL.indexOf('function apOpenDeal('));
  assert.ok(flow.length > 400, 'the new-deal flow must be findable');
  assert.match(flow, /\/sitenex\/prospects\?/, 'it picks a prospect from the existing list');
  assert.match(flow, /status=qualified/, 'qualified only — a rejected row must not become a deal by accident');
  assert.match(flow, /&q=|q=' \+ encodeURIComponent/, 'and it is searchable by name');
  assert.match(flow, /method: 'POST'/, 'it creates the deal');
  assert.match(flow, /prospect_id: prospectId/, 'with the chosen prospect');
  assert.ok(reaches('apCreateDeal', 'snEditDeal'),
    'after creating, the flow must open the form — otherwise the user has to go and find the new card');
});

test('the New deal button is shown on the SERVER\'s word, not the client\'s guess', () => {
  // The board is visible to super_admin, admin and partner; only the first two may POST a deal. A second
  // copy of that rule in the SPA is a copy that can disagree with the gate, and the user has asked before
  // that the client not compute boundary decisions.
  assert.match(SHELL, /res\.can_create/, 'the button must be gated on what the server reported');
  const routes = fs.readFileSync(path.join(ROOT, 'src/api/sitenex-phase3.routes.js'), 'utf8');
  assert.match(routes, /can_create:/, 'and the server must report it');
  // The gate itself stays on the route — a hidden button is not a permission.
  assert.match(routes, /router\.post\('\/sitenex\/deals', authMiddleware, adminOnly/,
    'hiding the button must not be what protects the write');
});

test('every control the deal form draws reaches a handler that exists', () => {
  // The general form of the same question, over the form itself: a button drawn by snEditDeal whose handler
  // is not defined anywhere is the same silent nothing as a card with no handler.
  const onWindow = new Set([...UI.matchAll(/window\.([A-Za-z0-9_$]+)\s*=/g)].map(m => m[1]));
  for (const m of SHELL.matchAll(/window\.([A-Za-z0-9_$]+)\s*=/g)) onWindow.add(m[1]);
  const topLevel = new Set();
  for (const src of [SHELL, UI]) {
    for (const m of src.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)/gm)) topLevel.add(m[1]);
    for (const m of src.matchAll(/^(?:const|let|var) ([A-Za-z0-9_$]+)/gm)) topLevel.add(m[1]);
    for (const line of src.split('\n')) {
      const m = /^[ \t]+function ([A-Za-z0-9_$]+)[ \t]*\(/.exec(line);
      if (m) topLevel.add(m[1]);
    }
  }
  const HOST = new Set(['alert', 'confirm', 'prompt', 'parseInt', 'parseFloat', 'Number', 'String', 'JSON',
    'Math', 'Date', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout', 'fetch',
    'console', 'event', 'this', 'return', 'if', 'typeof', 'pages', 'Boolean', 'Array', 'Object', 'isNaN',
    'requestAnimationFrame', 'Promise']);
  const missing = [...handlersNamed(UI)].filter(n => !onWindow.has(n) && !topLevel.has(n) && !HOST.has(n));
  assert.deepEqual(missing, [], `drawn by the deal form but defined nowhere: ${missing.join(', ')}`);
});

test('the reachability check would CATCH the regression it was written for', () => {
  // Proving it bites, by asking the same question of a card with no handler.
  const withHandler = `const card = (d) => '<div onclick="apOpenDeal(event,'+d.id+')" style="cursor:pointer">x</div>';`;
  const without = `const card = (d) => '<div style="border:1px solid #ccc">x</div>';`;
  const hasOn = (src) => [...src.matchAll(/\son(?:click|dblclick)="([^"]*)"/g)].length > 0;
  assert.equal(hasOn(withHandler), true);
  assert.equal(hasOn(without), false, 'a card with no handler must be detected as having none');
  // And the graph walk must not claim a path that does not exist.
  assert.equal(reaches('apOpenDeal', 'snEditDeal'), true);
  assert.equal(reaches('snToast', 'snEditDeal'), false, 'reaches() must be able to say no');
});

// ── RUNNING the click guard, not just reading it ──────────────────────────────
//
// Every assertion above is textual. This one extracts apOpenDeal and executes it against a stubbed target,
// because "the source mentions closest()" and "a click on a button does not open the deal" are different
// claims and only the second is the one that matters.

function loadOpenDeal() {
  const vm = require('node:vm');
  const from = SHELL.indexOf('function apOpenDeal(');
  const to = SHELL.indexOf("pages['sitenex-deals'] = async function");
  assert.ok(from !== -1 && to > from, 'apOpenDeal must be findable');
  const calls = [];
  const sandbox = {
    snEditDeal: (id) => calls.push(id),
    alert: (m) => calls.push({ alert: m }),
    console,
  };
  vm.runInNewContext(SHELL.slice(from, to) + '\nglobalThis.__open = apOpenDeal;', sandbox);
  return { open: sandbox.__open, calls, sandbox };
}

// A target whose closest() answers for a given selector, the way a real element's would.
const targetMatching = (tag) => ({
  closest: (sel) => (tag && sel.split(',').some(s => s.trim().split(':')[0].trim() === tag)) ? { tag } : null,
});

test('clicking the card BODY opens the deal', () => {
  const { open, calls } = loadOpenDeal();
  open({ target: targetMatching(null) }, 101);
  assert.deepEqual(calls, [101], 'a click on the card itself must open it');
});

test('clicking a BUTTON, link, select or input inside the card does NOT open the deal', () => {
  // The property that matters: a future control on a card keeps working. Asserted by execution, because a
  // guard that reads correctly and returns the wrong answer looks identical in the source.
  for (const tag of ['a', 'button', 'select', 'input', 'textarea', 'label']) {
    const { open, calls } = loadOpenDeal();
    open({ target: targetMatching(tag) }, 101);
    assert.deepEqual(calls, [], `a click on <${tag}> inside the card must not open the deal`);
  }
});

test('and it does not fall over on a click with no usable target', () => {
  // A synthetic or cross-browser event may have no target, or one without closest(). Opening the deal is
  // the right default there — the click was on the card, which is what the handler is attached to.
  for (const ev of [undefined, null, {}, { target: null }, { target: {} }]) {
    const { open, calls } = loadOpenDeal();
    open(ev, 7);
    assert.deepEqual(calls, [7], `a click with target ${JSON.stringify(ev)} should still open the deal`);
  }
});

test('with the form script absent it ALERTS rather than doing nothing', () => {
  const vm = require('node:vm');
  const from = SHELL.indexOf('function apOpenDeal(');
  const to = SHELL.indexOf("pages['sitenex-deals'] = async function");
  const alerts = [];
  const sandbox = { alert: (m) => alerts.push(m), console };   // no snEditDeal at all
  vm.runInNewContext(SHELL.slice(from, to) + '\nglobalThis.__open = apOpenDeal;', sandbox);
  sandbox.__open({ target: targetMatching(null) }, 101);
  assert.equal(alerts.length, 1, 'it must say something — a silent click is the original bug in miniature');
  assert.match(alerts[0], /not loaded/i);
});

// ── WHAT THE CARD SAYS, and in what order ─────────────────────────────────────
//
// Executed, not read. The complaint was about READING ORDER — "no package" sat where the money goes, so the
// second thing read on every unfinished deal was an absence — and reading order is a property of the
// rendered string, which only running the function can show.

function renderCard(deal) {
  const vm = require('node:vm');
  const from = SHELL.indexOf('  const apDays = (d) =>');
  const to = SHELL.indexOf("  const board = '<div class=\"card\"");
  assert.ok(from !== -1 && to > from, 'the card renderer must be findable');
  const sandbox = { apEsc: (x) => String(x == null ? '' : x) };
  vm.runInNewContext(SHELL.slice(from, to) + '\nglobalThis.__card = card;', sandbox);
  return sandbox.__card(deal);
}
// The visible text, in order, one entry per rendered line.
const linesOf = (html) => html
  .replace(/<[^>]+>/g, '\n').split('\n').map(x => x.trim()).filter(Boolean);

const FULL = { id: 41, company_name: 'Bolt & Co', contact_name: 'Jo Smith',
  package_label: 'P2 · Renew (rebuild, 3 weeks)', value_usd: 4500, monthly_usd: 99,
  partner_name: 'ACBM Partners', days_in_stage: 1, contract_ready: true, missing: [] };

test('the card reads: company · contact, then package + value, then partner, then stage age', () => {
  const l = linesOf(renderCard(FULL));
  assert.equal(l[0], 'Bolt & Co', 'the company leads');
  assert.equal(l[1], '· Jo Smith', 'the contact sits with it');
  assert.match(l[2], /^P2 · Renew \(rebuild, 3 weeks\) · \$4,500 \+ \$99\/mo$/,
    'package and value share the SECOND line — this is where the money goes');
  assert.equal(l[3], 'via ACBM Partners');
  assert.equal(l[4], '1 day in this stage');
  assert.equal(l.length, 5, `nothing else: ${JSON.stringify(l)}`);
});

test('a deal with no partner says "direct", not nothing', () => {
  const { partner_name, ...direct } = FULL;
  assert.ok(linesOf(renderCard(direct)).includes('direct'),
    'an unattributed deal is a fact about it, not an absence to hide');
});

test('ABSENCES GROUP INTO ONE QUIET LINE AT THE BOTTOM — never the second thing read', () => {
  // THE EXACT COMPLAINT. "no package" used to occupy the line where the value goes, so a board of new deals
  // read as a list of problems.
  const bare = { id: 38, prospect_name: 'Hopkins Machine', days_in_stage: 0,
                 contract_ready: false, missing: ['Client company', 'Total value'] };
  const l = linesOf(renderCard(bare));
  assert.equal(l[0], 'Hopkins Machine', 'it still leads with a name');
  assert.ok(!/needs|no package|missing/i.test(l[1] || ''),
    `the SECOND line must not be an absence, got: ${JSON.stringify(l[1])}`);
  // Exactly one line carries everything missing, and it is last.
  const needs = l.filter(x => /^needs /.test(x));
  assert.equal(needs.length, 1, `one absence line, got ${JSON.stringify(needs)}`);
  assert.equal(l[l.length - 1], needs[0], 'and it is at the bottom');
  assert.equal(needs[0], 'needs a package, a price and the client name', 'read as a sentence, not a list of fields');
});

test('the money line is simply ABSENT when there is no money — not "no package"', () => {
  const l = linesOf(renderCard({ id: 39, company_name: 'X Ltd', days_in_stage: 2, contract_ready: false, missing: [] }));
  assert.ok(!l.some(x => /no package|\$|unpriced|—/.test(x)),
    `an empty row should say nothing at all, got ${JSON.stringify(l)}`);
  // Which is the standing rule for SiteNex prices: never print a figure for an unpriced thing.
  assert.ok(!/\$0/.test(renderCard({ id: 39, company_name: 'X', days_in_stage: 1 })), 'and never $0');
});

test('the absence line names only what is actually absent', () => {
  const l = (d) => linesOf(renderCard(d)).find(x => /^needs /.test(x));
  assert.equal(l({ id: 1, company_name: 'A', package_label: 'P2', days_in_stage: 1 }), 'needs a price');
  assert.equal(l({ id: 1, company_name: 'A', value_usd: 100, days_in_stage: 1 }), 'needs a package');
  assert.equal(l({ id: 1, package_label: 'P2', value_usd: 100, days_in_stage: 1, prospect_name: 'P' }),
               'needs the client name');
  assert.equal(l(FULL), undefined, 'a complete deal gets no absence line at all');
});

test('days in stage: 0 reads as "moved today", and NULL says it is not recorded', () => {
  const l = (v) => linesOf(renderCard({ ...FULL, days_in_stage: v }));
  assert.ok(l(0).includes('moved today'), '0 must not read as "0 days", which looks like a missing value');
  assert.ok(l(1).includes('1 day in this stage'), 'singular');
  assert.ok(l(12).includes('12 days in this stage'), 'plural');
  // NULL is "we do not know", and saying so beats showing 0 — which would read as "moved today".
  assert.ok(l(null).includes('stage age not recorded'));
  assert.ok(!l(null).some(x => /\bday/.test(x)), 'and it must not claim a number');
});

test('the BLOCKED marker appears only when the basics are there but a contract still cannot be made', () => {
  // Otherwise it duplicates the absence line: a deal with no price is not "blocked", it is empty.
  const blocked = linesOf(renderCard({ id: 42, company_name: 'Rivet Inc', package_label: 'P1 · Launch',
    value_usd: 3000, days_in_stage: 12, contract_ready: false, missing: ['Client address'] }));
  assert.ok(blocked.some(x => /contract blocked/.test(x)), 'it must be marked');
  assert.ok(!blocked.some(x => /^needs /.test(x)), 'and not alongside an absence line');

  const empty = linesOf(renderCard({ id: 38, prospect_name: 'H', days_in_stage: 0,
    contract_ready: false, missing: ['Client company'] }));
  assert.ok(!empty.some(x => /contract blocked/.test(x)),
    'a brand-new deal is empty, not blocked — the absence line already says what it needs');

  const ready = linesOf(renderCard(FULL));
  assert.ok(!ready.some(x => /blocked/.test(x)), 'a ready deal is not marked');
});

test('the blocked marker carries the SERVER\'s own list in its tooltip', () => {
  const html = renderCard({ id: 42, company_name: 'R', package_label: 'P1', value_usd: 3000,
    days_in_stage: 1, contract_ready: false, missing: ['Client address', 'Client email'] });
  assert.match(html, /title="Client address, Client email"/, 'the reason comes from the server, not a guess');
  // And a blocked deal with no list still explains itself rather than showing a bare glyph.
  const vague = renderCard({ id: 42, company_name: 'R', package_label: 'P1', value_usd: 3000,
    days_in_stage: 1, contract_ready: false, missing: [] });
  assert.match(vague, /title="open the deal to see what is needed"/);
});

test('contract_ready is read from the SERVER — the card computes no part of it', () => {
  // The board and the form must not be able to disagree about whether a contract can be made.
  const src = SHELL.slice(SHELL.indexOf('  const apDays = (d) =>'), SHELL.indexOf("  const board = '<div class=\"card\""));
  assert.match(src, /d\.contract_ready === false/, 'the marker is driven by the server flag');
  for (const own of ['checkRenderable', 'client_email', 'duration_weeks', 'amount_cents']) {
    assert.ok(!src.includes(own), `the card must not reimplement readiness (found ${own})`);
  }
});

test('XSS: every field the card prints goes through apEsc', () => {
  // These are a client company name and a contact name typed by a person.
  const src = SHELL.slice(SHELL.indexOf('  const card = (d) => {'), SHELL.indexOf("  const board = '<div class=\"card\""));
  for (const f of ['company_name', 'prospect_name', 'contact_name', 'partner_label', 'partner_name']) {
    const uses = [...src.matchAll(new RegExp(`d\\.${f}`, 'g'))];
    if (!uses.length) continue;
    // Every print site (as opposed to a truthiness test) must be wrapped.
    const printed = new RegExp(`apEsc\\(d\\.${f}`).test(src) || new RegExp(`apEsc\\([^)]*d\\.${f}`).test(src);
    assert.ok(printed, `d.${f} is printed without apEsc`);
  }
  // And the numbers are formatted, not concatenated from the body.
  assert.match(src, /toLocaleString\(\)/);
});
