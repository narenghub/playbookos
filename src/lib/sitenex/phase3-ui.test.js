// The Phase 3 UI file — its structure, and the two things that would silently not work.
//
//   node --test src/lib/sitenex/phase3-ui.test.js
//
// Source-level, like the other index.html tests, because there is no DOM here. What is being protected:
//
//   • THE FILE EXISTS AND IS LOADED. A <script src> pointing at nothing leaves every handler undefined
//     and every button dead, with no error anywhere a server can see.
//   • IT PARSES. A separate script that throws a SyntaxError cannot take the app down the way the 30 Sep
//     outage did — which is the whole reason it is a separate file — but its own page would be dead.
//   • THE DOWNLOAD FETCHES WITH THE HEADER. A bare href or an <a download> sends no Authorization, and
//     the contract routes are gated, so the user would get a 401 page instead of a document.
//   • NOTHING IS ADDED TO THE pages LITERAL. The hazard that caused the outage.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const SHELL = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const FILE = path.join(ROOT, 'public/sitenex-phase3.js');

test('index.html loads it, and the file is there', () => {
  assert.match(SHELL, /<script src="\/sitenex-phase3\.js"><\/script>/,
    'the shell must load the Phase 3 UI with one script tag');
  assert.ok(fs.existsSync(FILE), 'public/sitenex-phase3.js must exist');
});

const SRC = fs.readFileSync(FILE, 'utf8');

// Comments blanked, newlines kept. Needed for any check that asks "does this FILE do X", because a comment
// explaining why it must NOT do X contains the very text being searched for: the first version of the two
// checks below failed on this file's own prose about `const pages = { ... }` and about not calling a
// derived total revenue.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
                .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

// Every slice goes through this. A hand-written slice(indexOf(a), indexOf(b)) returns '' when b appears
// BEFORE a, and every assertion over the result then passes or fails for a reason unrelated to the code —
// which it did here: snTotalsCard is defined after the function being sliced, so "it asks the server"
// failed while the request was plainly on the line below. Same fix as ui-wiring.test.js.
function between(hay, startNeedle, endNeedle) {
  const a = hay.indexOf(startNeedle);
  assert.notEqual(a, -1, `not found: ${startNeedle}`);
  const b = endNeedle ? hay.indexOf(endNeedle, a + startNeedle.length) : hay.length;
  assert.notEqual(b, -1, `not found after ${startNeedle}: ${endNeedle}`);
  const out = hay.slice(a, b);
  assert.ok(out.length > 0, `empty slice between ${startNeedle} and ${endNeedle}`);
  return out;
}

test('it parses — a dead page is better than a dead app, but neither is acceptable', () => {
  // Checked the same way scripts/check-spa-parse.js checks the inline blocks.
  new (require('vm').Script)(SRC, { filename: 'sitenex-phase3.js' });
});

test('it is loaded AFTER the inline script, so `pages` exists when it runs', () => {
  // `pages` is a top-level const in the inline script. A script tag placed before it would run first and
  // throw a ReferenceError on the attach line.
  const inlineEnd = SHELL.lastIndexOf('</script>\n\n<!-- SiteNex Phase 3 UI');
  const tag = SHELL.indexOf('<script src="/sitenex-phase3.js">');
  assert.notEqual(tag, -1);
  assert.ok(inlineEnd !== -1 && inlineEnd < tag,
    'the external script must come after the inline script that declares `pages`');
});

// ── the download ──────────────────────────────────────────────────────────────

test('the download FETCHES with the Authorization header and clicks a blob anchor', () => {
  const fn = between(SRC, 'window.snDownloadContract', '/* ── emailing a contract');
  assert.ok(fn.length > 200, 'snDownloadContract must be findable');
  assert.match(fn, /Authorization.*Bearer/s, 'without the header the request is a 401');
  assert.match(fn, /URL\.createObjectURL/, 'the bytes become a blob');
  assert.match(fn, /\.click\(\)/, 'and a synthetic anchor is clicked');
  assert.match(fn, /revokeObjectURL/, 'and the object URL is released');
  // The failure mode this replaces: a plain link. The browser sends no Authorization on a navigation.
  assert.ok(!/href\s*=\s*['"]\/api\/sitenex\/contracts/.test(SRC),
    'a bare href to the file route would 401 — it must go through fetch');
});

test('every write goes through one helper that carries the header', () => {
  // Rather than a fetch() per handler, each of which could forget it.
  const fetches = [...SRC.matchAll(/fetch\(/g)];
  assert.equal(fetches.length, 2,
    `expected exactly two fetch() calls — snSend and the download — found ${fetches.length}. ` +
    'Every other write must go through snSend so the header cannot be forgotten.');
  const send = between(SRC, 'async function snSend', 'function snToast');
  assert.match(send, /Authorization.*Bearer/s);
  assert.match(send, /'Content-Type': 'application\/json'/);
});

// ── the structural rules ──────────────────────────────────────────────────────

test('every handler named by an onclick/onchange in this file is on window', () => {
  const called = new Set();
  for (const m of SRC.matchAll(/\son(?:click|change|input|submit)="([^"]*)"/g)) {
    // Interpolations are render-time, not click-time: `onclick="f('+esc(x)+')"` calls esc while the HTML
    // is built and only f on click.
    const attr = m[1].replace(/'\s*\+\s*[^+]+\+\s*'/g, "''");
    for (const f of attr.matchAll(/(?<![.$\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) called.add(f[1]);
  }
  assert.ok(called.size >= 6, `only ${called.size} handler calls found — the scanner has stopped working`);
  const onWindow = new Set([...SRC.matchAll(/window\.([A-Za-z0-9_$]+)\s*=/g)].map(m => m[1]));
  const topLevel = new Set([...SRC.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)/gm)].map(m => m[1]));
  for (const m of SRC.matchAll(/^(?:const|let|var) ([A-Za-z0-9_$]+)/gm)) topLevel.add(m[1]);
  // `pages[...]` and host functions are not ours.
  const HOST = new Set(['pages', 'alert', 'confirm', 'parseInt', 'Number', 'String', 'JSON', 'encodeURIComponent']);
  const missing = [...called].filter(n => !onWindow.has(n) && !topLevel.has(n) && !HOST.has(n));
  assert.deepEqual(missing, [],
    `named by a handler in this file but not reachable globally, so clicking throws:\n  ${missing.join('\n  ')}`);
});

test('no async function is declared INDENTED — Annex B does not hoist those', () => {
  // The mcTrigger bug. [ \t]+ and not \s+: \s matches a newline, which made an earlier version of this
  // check report 50 false positives.
  const bad = SRC.split('\n')
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /^[ \t]+async function [A-Za-z0-9_$]+[ \t]*\(/.test(l));
  assert.deepEqual(bad.map(b => `${b.n}: ${b.l.trim()}`), [],
    'an indented async function declaration is block-scoped and unreachable from an inline handler');
});

test('the page is attached with pages[...] = , never inside an object literal', () => {
  // THE 30 SEPTEMBER HAZARD. An `async function` inside `const pages = { ... }` is a syntax error that
  // killed the entire inline script. This file cannot do that — there is no literal here — and this test
  // fails if one ever appears.
  assert.match(SRC, /pages\['sitenex-contracts'\]\s*=/, 'the page must be attached by assignment');
  assert.ok(!/^const\s+pages\s*=\s*\{/m.test(CODE), 'this file must never declare a pages literal');
});

test('the page is wrapped so a render failure is VISIBLE, not a blank screen', () => {
  // apGuard replaces the content with an error card. Without it an exception after the "Loading…" paint
  // leaves "Loading…" on screen for ever, which is how sitenex-prospects once shipped broken.
  assert.match(SRC, /apGuard\('sitenex-contracts'/, 'the page must be wrapped in apGuard');
});

// ── the content it renders ────────────────────────────────────────────────────

test('the register prints the placeholder warning on the PAGE, not only in the document', () => {
  // A notice that lives only inside the .docx is a notice nobody reads before sending it.
  assert.match(SRC, /has not been reviewed by an attorney/i);
});

test('the annualised figure is labelled as derived, never as revenue', () => {
  assert.match(SRC, /one-time \+ 12 × monthly/, 'the arithmetic must be stated beside the number');
  // SCOPED TO THE TOTALS CARD, which is what this protects. The first version banned the word across the
  // whole file and then failed on the Partners page saying "the revenue tiers are identical for everyone" —
  // a true sentence about the commercial model, not a label on a computed figure. A prohibition reaching
  // beyond the thing it protects generates noise, and noise is how a prohibition gets deleted.
  const card = between(CODE, 'function snTotalsCard', 'function snContractRow');
  assert.ok(!/\brevenue\b/i.test(card), 'a derived total must not be called revenue');
  assert.ok(!/\bbooked\b|\bearned\b/i.test(card), 'nor booked, nor earned — it is arithmetic, not money received');
});

test("the call script shows the exclusions as a section, not a footnote", () => {
  assert.match(SRC, /What this is NOT/, 'the exclusions need their own heading');
  assert.match(SRC, /what_this_is_not/, 'and they come from the server, not a local list');
});

test('the email panel says there is no send button, because somebody will look for one', () => {
  assert.match(SRC, /no send button/i);
  assert.match(SRC, /your own address/i);
});

test('a blank money field clears the value rather than becoming $0', () => {
  const save = between(SRC, 'window.snSaveDeal', 'function snParseSchedule');
  assert.match(save, /raw === ''\s*\?\s*null/, "'' must mean clear, not zero");
});

test('the schedule parser rejects a bad line instead of guessing', () => {
  // Loaded in isolation: the parser is pure, so it can be exercised without a DOM.
  const vm = require('vm');
  const sandbox = { window: {}, document: undefined, token: null, apEsc: (x) => String(x), apGet: () => {},
                    pages: {}, apGuard: null, URL: {}, navigator: {}, console, setTimeout, fetch: () => {} };
  sandbox.globalThis = sandbox;
  // Only the parser is needed, so it is extracted rather than running the whole file (which attaches a page).
  const fn = SRC.slice(SRC.indexOf('function snParseSchedule'), SRC.indexOf('window.snSaveSchedule'));
  vm.runInNewContext(fn + '\nglobalThis.__p = snParseSchedule;', sandbox);
  const p = sandbox.__p;
  assert.deepEqual(p('Deposit | 2250 | on_signature').rows,
                   [{ label: 'Deposit', amount_cents: 225000, due_trigger: 'on_signature' }]);
  assert.equal(p('Deposit | 2250.50').rows[0].amount_cents, 225050, 'dollars become cents');
  assert.deepEqual(p('Balance | 1000 | 2026-12-01').rows[0],
                   { label: 'Balance', amount_cents: 100000, due_trigger: 'date', due_date: '2026-12-01' },
                   'a date in the trigger column sets due_trigger=date, which the server requires');
  assert.equal(p('').rows.length, 0, 'empty clears the schedule');
  assert.match(p('Deposit').bad[0], /needs at least/);
  assert.match(p('Deposit | nope').bad[0], /not a positive amount/);
  assert.match(p('Deposit | -5').bad[0], /not a positive amount/);
  assert.equal(p('Deposit | 0').bad.length, 1, 'zero is not an installment');
  // A bad line does not silently drop: it is reported, and the caller refuses to save.
  const mixed = p('Good | 100\nBad');
  assert.equal(mixed.rows.length, 1);
  assert.equal(mixed.bad.length, 1);
});

// ── THE EMAIL BUTTON ──────────────────────────────────────────────────────────
//
// The one irreversible control in these screens, so what is asserted is the three properties that make it
// safe: it is a SEPARATE button, the address is on screen BEFORE the click, and the confirmation NAMES the
// address.

test('Email to client is a SEPARATE button from Generate, and never automatic', () => {
  assert.match(CODE, /Email to client/, 'the button must exist');
  assert.match(CODE, /onclick="snEmailContract\(/, 'with its own handler');
  // The generate handler must not send. Two buttons, two routes, two decisions.
  const gen = between(CODE, 'window.snGenerateContract', 'const SN_DEAL_FIELDS');
  assert.ok(!/snEmailContract|contracts\/.*\/send/.test(gen), 'generating must not trigger a send');
  // And nothing calls the send handler on load.
  assert.ok(!/snEmailContract\(\s*\)/.test(CODE), 'the send handler is never invoked without an id');
});

test('the RECIPIENT is rendered beside the button, before anything is clicked', () => {
  // A tooltip would not count: nobody hovers before pressing a button they already meant to press.
  assert.match(CODE, /function snSendLine/, 'there must be a line that states the recipient');
  const line = between(CODE, 'function snSendLine', 'window.snEmailContract');
  assert.match(line, /Will email/, 'it says what will happen, in words');
  assert.match(line, /pv\.to/, 'and names the address');
  assert.match(line, /pv\.cc/, 'and the cc');
  assert.match(line, /pv\.price/, 'and the price the note will state — a wrong price cannot be unsent either');
  // It is actually placed in the DOM for each row, on both screens.
  assert.ok((CODE.match(/id="sn-to-'/g) || []).length >= 2, 'a slot per row, on the register and the deal page');
  assert.match(CODE, /snFillRecipients/, 'and something fills them');
});

test('the preview is read from the SERVER, not assembled in the browser', () => {
  // What is displayed must be what will be sent. A client-side guess at the recipient could disagree with
  // the snapshot the server will actually use, and then the address shown is not the address used.
  const fill = between(CODE, 'async function snFillRecipients', 'window.snSetContractStatus');
  assert.match(fill, /\/sitenex\/contracts\/.*\/send/, 'it asks the server');
  // A failed preview says so rather than leaving a blank, which would read as "no recipient needed".
  assert.match(fill, /could not read the recipient/);
});

test('the confirmation NAMES the address, the price and the attachment', () => {
  const fn = between(CODE, 'window.snEmailContract', 'function snTotalsCard');
  assert.match(fn, /confirm\(/, 'it must block on a confirmation');
  assert.match(fn, /d\.to/, 'the address goes in the prompt');
  assert.match(fn, /d\.from/);
  assert.match(fn, /d\.price/);
  assert.match(fn, /d\.file_name/);
  assert.match(fn, /cannot be unsent/, 'and it says what is at stake');
  // A repeat send is a different decision from a first one.
  assert.match(fn, /ALREADY been emailed/);
  // The server is still asked to confirm independently — the dialog is a courtesy, not the safeguard.
  assert.match(fn, /confirm_to: d\.to/);
});

test('"sent but not recorded" must NOT read as a failure', () => {
  // If it did, somebody would press the button again and a second copy would reach the client.
  const fn = between(CODE, 'window.snEmailContract', 'function snTotalsCard');
  assert.match(fn, /sent_but_not_recorded/, 'the case must be handled explicitly');
  const branch = fn.slice(fn.indexOf('sent_but_not_recorded'));
  assert.match(branch.slice(0, 400), /return/, 'and it must stop, not fall through to a generic error');
});

test('a superseded contract offers no Email button', () => {
  // A client receiving a superseded document has no way to know it is not the agreement.
  const row = between(CODE, 'function snContractRow', 'async function snContractsPage');
  assert.match(row, /dead \? ''/, 'the button is omitted for a dead contract');
  assert.match(row, /const dead = c\.status === 'superseded' \|\| c\.status === 'void'/);
});

test('the sender is the AUTHORIZED domain, and it is not hardcoded in the UI', () => {
  // abiozen.com 403s on this Resend key. The address belongs server-side, where the one place that knows
  // which domain works can own it — a copy in the UI would be a second thing to change.
  assert.ok(!/adificetechnologies|abiozen/.test(CODE),
    'the UI must not name a sender domain; it displays what the server reports');
});

// ── THE PARTNERS PAGE: territories and the approval queue ─────────────────────
//
// Built at the same time as the routes, because "staff approve or reject with a stated reason" describes a
// person doing something and a person needs a screen. The deal form shipped complete and unreachable once;
// board-card.test.js exists because of it, and these assertions exist so this page does not repeat it.

test('the Partners page is reachable: a nav item, a page function and a title', () => {
  assert.match(SHELL, /id:'sitenex-partners'/, 'a nav item');
  assert.match(SRC, /pages\['sitenex-partners'\]\s*=/, 'a page function, attached by assignment');
  assert.match(SHELL, /'sitenex-partners':'SiteNex Partners'/, 'and a title');
  assert.match(SHELL, /"sitenex-partners":\[\["intelligence"\]\]/,
    'gated on a tier the partner role does not hold — the page GRANTS territory and shows every partner\'s');
  assert.match(SHELL, /pages:\['sitenex-prospects','sitenex-deals','sitenex-packages','sitenex-contracts','sitenex-partners'\]/,
    'and listed in the product tab, or it is unreachable in the default shell');
});

test('PENDING APPROVALS come first — they are the only thing with a clock on it', () => {
  const page = between(CODE, 'async function snPartnersPage', 'window.snGrantTerritory');
  const queueAt = page.indexOf('Out-of-territory approvals');
  const grantsAt = page.indexOf('Territories');
  assert.ok(queueAt !== -1 && grantsAt !== -1);
  assert.ok(queueAt < grantsAt, 'the queue must be rendered above the territory list');
  // And the empty state says the queue being empty is NORMAL, not a failure to load.
  assert.match(page, /Nothing waiting/);
  assert.match(page, /backstop, not the path/);
});

test('the reason box sits WITH the reject button, and is checked before the click', () => {
  // Discovering "a reason is required" from a 400 after clicking Reject is a worse way to learn it.
  const page = between(CODE, 'async function snPartnersPage', 'window.snGrantTerritory');
  assert.match(page, /Why — required to reject/, 'the box says what it is for');
  assert.ok(page.indexOf('sn-why-') < page.indexOf("snDecideLead(' + r.id + ',\\'rejected\\'"),
    'the input must be rendered before the button that needs it');
  const decide = between(CODE, 'window.snDecideLead', 'pages[\'sitenex-partners\']');
  assert.match(decide, /status === 'rejected' && why\.length < 3/, 'checked client-side too');
  assert.match(decide, /owed the sentence/);
  assert.match(decide, /box\.focus\(\)/, 'and it puts the cursor where the answer goes');
  // An APPROVAL needs no reason — the test for whether the client copy matches the server rule.
  assert.ok(!/status === 'confirmed' && why/.test(decide), 'an approval must not demand one');
});

test('revoking a territory confirms, naming the patch', () => {
  // Revoking the last one silently blinds a partner. The server says so afterwards, but afterwards is late.
  const fn = between(CODE, 'window.snRevokeTerritory', 'window.snDecideLead');
  assert.match(fn, /confirm\(/);
  assert.match(fn, /\+ label \+/, 'the patch is named in the prompt');
  assert.match(fn, /no prospects at all/, 'and the consequence is stated');
});

test('the grant form says the exclusivity rule BEFORE a 409 teaches it', () => {
  const page = between(CODE, 'async function snPartnersPage', 'window.snGrantTerritory');
  assert.match(page, /held by one partner only/);
  assert.match(page, /database refuses the second grant/, 'and that it is the database, not the form');
  // Matched in halves: the sentence is split across a string concatenation, so a single regex over the
  // source cannot see it as one phrase even though a browser renders it as one.
  assert.match(page, /Uncheck /);
  assert.match(page, /exclusive if two partners are meant to share it/);
  // exclusive is CHECKED by default, matching the column default.
  assert.match(page, /id="sn-t-excl" checked/);
});

test('the page states the model it could most easily drift from', () => {
  const page = between(CODE, 'async function snPartnersPage', 'window.snGrantTerritory');
  assert.match(page, /One product, many partners/);
  assert.match(page, /identical for everyone/);
  // And the fail-closed consequence, said on the screen where somebody might otherwise call it a bug.
  assert.match(page, /no territory sees no prospects/);
});

test('dimensions come from the SERVER, with a local label map only for display', () => {
  const page = between(CODE, 'async function snPartnersPage', 'window.snGrantTerritory');
  assert.match(page, /terr\.data && terr\.data\.dimensions/, 'the list is the server\'s');
  // A hardcoded fallback is fine; a hardcoded ONLY list is a second copy that can drift.
  const labels = between(CODE, 'const SN_DIMENSION_LABEL', 'async function snPartnersPage');
  assert.match(labels, /region/);
  assert.match(labels, /subtype/);
  assert.match(labels, /state/);
});

// ── the outreach control a partner cannot use ─────────────────────────────────

test('the prospects screen omits the outreach control when the server says so', () => {
  // A partner holds the prospect list now but /api/outreach is staffOnly, because an outreach note is OUR
  // record of what we did. Drawing the control anyway would give them two dropdowns that 403 on use, which
  // is worse than not offering them.
  const shellCode = SHELL.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  assert.match(shellCode, /window\._apState\.canTrackOutreach\s*\n?\s*\?\s*'<td[^']*'\+orCell\('prospect'/,
    'the cell is conditional');
  assert.match(shellCode, /canTrackOutreach \? '<th style="padding:8px">Outreach<\/th>' : ''/,
    'and so is its column header, or the table misaligns');
  assert.match(shellCode, /canTrackOutreach \? orBar\('prospect'\) : ''/, 'and the summary bar');
  // The flag comes FROM THE RESPONSE, and only an ABSENT key defaults permissive.
  assert.match(shellCode, /st\.canTrackOutreach = res\.can_track_outreach !== false/);
  // orLoad is not even CALLED when it cannot be used — otherwise every partner page load logs a 403.
  assert.match(shellCode, /if \(st\.canTrackOutreach\) await orLoad\('prospect'/);
});

test('the colspan of the empty row follows the column count', () => {
  // Dropping a column without dropping it from the colspan leaves the "no prospects" message misaligned,
  // which looks like a rendering bug on the screen a partner is most likely to see empty.
  const shellCode = SHELL.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  assert.match(shellCode, /\(apOneSubtype\?9:10\) - \(window\._apState\.canTrackOutreach\?0:1\)/);
});

test('an empty prospects screen EXPLAINS itself', () => {
  // A partner with no granted territory sees nothing, which is correct and fail-closed — and
  // indistinguishable from broken unless it says so. The wording is the server's, because the server scoped it.
  const shellCode = SHELL.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  assert.match(shellCode, /st\.scopeNote = res\.scope_note \|\| null/);
  assert.match(shellCode, /window\._apState\.scopeNote/);
  assert.ok(!/no territory yet/.test(shellCode),
    'the sentence must come from the server, not be a second copy in the SPA');
});
