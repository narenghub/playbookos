// What the CPHI contact capture must never do.
//
//   node --test src/lib/cphi/contacts-guards.test.js
//
// Read as source text rather than exercised against a database, for the same reason the LabConnect
// seed guards are: each failure below produces a run that inserts rows, reports success, and is
// only noticed when a card is missing from the list weeks after the show, with the paper long gone.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'scripts/migrate-cphi-contacts.js'), 'utf8');
const SEED = fs.readFileSync(path.join(ROOT, 'scripts/seed-cphi-contacts.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(ROOT, 'src/api/routes.js'), 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/--[^\n]*/g, '');

test('a card with no DMF match is still imported', () => {
  // THE FAILURE THIS EXISTS FOR. Five of the fifteen cards from Milan are firms that hold no US
  // drug master file at all — a CDMO, a Taiwanese intermediate maker, a Chinese supplier. If
  // exhibitor_match_id were NOT NULL, every one of them would be rejected at insert and the only
  // record of that conversation would be a piece of card in a coat pocket.
  const sql = strip(MIGRATION);
  const col = sql.slice(sql.indexOf('exhibitor_match_id'), sql.indexOf('company '));
  assert.ok(!/NOT NULL/.test(col), 'exhibitor_match_id must stay nullable — see the migration header');
  assert.match(sql, /company\s+TEXT NOT NULL/, 'the company name is what makes an unmatched card usable');
  assert.match(sql, /ON DELETE SET NULL/,
    'deleting an exhibitor row must orphan the contact, never delete the person you met');
});

test('a re-import refreshes rather than duplicating', () => {
  assert.match(strip(MIGRATION), /CREATE UNIQUE INDEX[^;]*idx_cec_unique[^;]*event_slug, company_normalized, lower\(name\)/s,
    'without this key a second run doubles every contact');
  assert.match(SEED, /ON CONFLICT \(event_slug, company_normalized, lower\(name\)\) DO UPDATE/);
});

test('the seed does not invent a booth match by hand', () => {
  // A hand-written company → booth mapping is correct the day it is written and silently wrong
  // after the next quarterly re-run renames a holder. The seed has to use the same fold the
  // exhibitor matcher uses, so the two cannot drift.
  assert.match(SEED, /require\('\.\.\/src\/lib\/cphi\/match-company'\)/);
  assert.match(SEED, /normalizeCompany/);
  assert.match(SEED, /companyCore/);
});

test('it is a DRY RUN unless asked otherwise, and it SHOWS what matched', () => {
  assert.match(SEED, /const WRITE = process\.argv\.includes\('--write'\)/);
  assert.ok(SEED.indexOf("if (!WRITE)") < SEED.indexOf('INSERT INTO cphi_exhibitor_contacts'),
    'the write happens before the dry-run guard, so a report run would mutate the database');
  // The lesson from the exclusion_flag and region bugs, applied a third time: when a step decides
  // something, print what it decided before it acts on it.
  assert.match(SEED, /MATCHED HOLDER/, 'the dry run must print the match per card, not just a count');
  assert.match(SEED, /no DMF-holder match/, 'and must name the ones it could not tie to a booth');
});

test('the molecules endpoint only returns CONFIRMED molecule-to-DMF links', () => {
  // A molecule read aloud at a booth is a claim. molecule_dmf_matches carries unconfirmed links,
  // and quoting one to a supplier is the kind of error that costs the relationship on first
  // contact — the same reasoning that gates the LabConnect outreach generator.
  const route = ROUTES.slice(ROUTES.indexOf("'/events/cphi/exhibitors/:id/molecules'"),
                             ROUTES.indexOf("'/events/cphi/contacts'"));
  assert.ok(route.length > 100, 'could not find the molecules route — these guards need rewriting');
  assert.match(route, /md\.review_status = 'auto_confirmed'/,
    'unconfirmed molecule links must be excluded');
});

test('the send route refuses to compose on anybody\'s behalf', () => {
  // The platform rule: nothing outbound leaves without a human releasing it. A person typing the
  // body IS that release. An endpoint that accepted an empty body and filled it in would not be.
  const route = ROUTES.slice(ROUTES.indexOf("'/events/cphi/contacts/:id/email'"),
                             ROUTES.indexOf('OUTREACH STATUS'));
  assert.ok(route.length > 100, 'could not find the send route');
  assert.match(route, /if \(!subject \|\| !html\)/, 'subject and body must both be required');
  assert.match(route, /adminOnly/, 'sending from the company domain is not an ordinary read tier');
  assert.match(route, /sanitizeHtml\(html\)/, 'the body is user input and goes out as HTML');
  assert.match(route, /last_emailed_at = NOW\(\)/, 'a send must be recorded against the contact');
});

test('every seeded card carries a company and a name', () => {
  // The two NOT NULL columns. A card missing either cannot be inserted, and the run would fail
  // halfway with some rows written — worse than refusing up front.
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    const src = require('fs').readFileSync(${JSON.stringify(path.join(ROOT, 'scripts/seed-cphi-contacts.js'))}, 'utf8');
    const body = src.slice(src.indexOf('const CARDS = ['), src.indexOf('];', src.indexOf('const CARDS = [')) + 2);
    const CARDS = eval(body.replace('const CARDS =', ''));
    const bad = CARDS.filter(c => !c.company || !c.name);
    const emails = CARDS.filter(c => c.email && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(c.email));
    console.log(JSON.stringify({ n: CARDS.length, bad: bad.length, badEmails: emails.map(e => e.email) }));
  `], { encoding: 'utf8' });
  const r = JSON.parse(out.trim());
  assert.ok(r.n >= 15, `expected the Milan cards, found ${r.n}`);
  assert.equal(r.bad, 0, 'a card is missing company or name');
  assert.deepEqual(r.badEmails, [], 'an email address does not parse');
});

test('the ambiguous cards keep their warning', () => {
  // Two cards from day 1 contradict themselves: Hetero's prints one name and mails from another,
  // and Sintaho's email domain is a different company entirely. Both are fine for a conversation
  // and wrong for a contract — exactly what the exhibitor matcher flags as entity_review. The note
  // is the only thing standing between that and a purchase order to the wrong legal entity.
  assert.match(SEED, /CONFIRM NAME/, "Hetero's name mismatch must stay flagged");
  assert.match(SEED, /CONFIRM ENTITY/, "Sintaho's domain mismatch must stay flagged");
});

test('the overview attachment is read from disk, and a missing file refuses the send', () => {
  // THE FAILURE THIS EXISTS FOR. An email that says "overview attached" and arrives without one is
  // seen by the supplier; an error on our screen is seen by nobody but us. So a missing file has to
  // stop the send rather than degrade it. And it is read per send, not cached: a cached copy keeps
  // sending last month's version after somebody updates the PDF in the repo.
  const route = ROUTES.slice(ROUTES.indexOf("'/events/cphi/contacts/:id/email'"),
                             ROUTES.indexOf('OUTREACH STATUS'));
  assert.match(route, /if \(!fs\.existsSync\(p\)\) return res\.status\(500\)/,
    'a missing overview PDF must refuse the send, never send without it');
  assert.match(route, /fs\.readFileSync\(p\)/, 'read per send, so an updated PDF takes effect');
  assert.ok(!/attachmentCache|OVERVIEW_BUF/.test(route), 'the PDF must not be cached in memory');
});

test('the supplier overview actually ships with the deploy', () => {
  // The route refuses to send without it, so the file being absent turns every attached follow-up
  // into a 500. It is committed rather than generated at build time for exactly that reason.
  const p = path.join(ROOT, 'public/docs/abiozen-supplier-overview.pdf');
  assert.ok(fs.existsSync(p), 'public/docs/abiozen-supplier-overview.pdf is missing');
  const buf = fs.readFileSync(p);
  assert.equal(buf.slice(0, 5).toString(), '%PDF-', 'that file is not a PDF');
  assert.ok(buf.length > 20000, 'the overview PDF looks truncated');
});

test('the drawer checks for an error body — API() does not throw on 4xx/5xx', () => {
  // THE BUG THIS EXISTS FOR, reported from the floor as:
  //   "Could not load that: Cannot read properties of undefined (reading 'holder')"
  // API() is `fetch(...).then(r => r.json())`. It resolves with the parsed body whatever the HTTP
  // status, so an error response is an ordinary object with an `error` key. The drawer read
  // `r.exhibitor.holder` straight off it, which threw a TypeError naming a property instead of
  // showing the server's message — the real fault stayed invisible through two deploys.
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const open = html.slice(html.indexOf('window.cmOpen = async function'),
                          html.indexOf('function cmClose()'));
  assert.ok(open.length > 200, 'could not find cmOpen — this guard needs rewriting');
  assert.ok(!/r\.exhibitor\.holder/.test(open),
    'the drawer reads a property off a response body that may be an error object');
  assert.equal((open.match(/if \(r && r\.error\) throw new Error\(r\.error\)/g) || []).length, 2,
    'both branches of cmOpen must check for an error body before using the reply');

  const send = html.slice(html.indexOf('window.cmSend = async function'),
                          html.indexOf('function cmSet('));
  assert.match(send, /if \(sent && sent\.error\) throw new Error\(sent\.error\)/,
    'a failed send must not report success — API() resolves on a 502 too');
});

test('the molecules query has no correlated sub-select over a grouped column', () => {
  // The first version put the holder count in a SELECT-list subquery referencing an outer column
  // from a GROUP BY query. It now mirrors the thin-supply query, which has been correct in
  // production since the briefing was built.
  const route = ROUTES.slice(ROUTES.indexOf("'/events/cphi/exhibitors/:id/molecules'"),
                             ROUTES.indexOf("'/events/cphi/contacts'"));
  assert.match(route, /WITH mine AS/, 'the molecule query should be built from CTEs');
  assert.ok(!/\(SELECT COUNT\(DISTINCT d2\.holder_normalized\)/.test(route),
    'the correlated sub-select is back');
});
