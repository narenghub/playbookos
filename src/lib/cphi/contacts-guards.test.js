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
  // Every join onto molecule_dmf_matches in this route must carry the filter; the query has
  // several aliases, so assert on the count rather than one spelling.
  const confirmed = (route.match(/review_status = 'auto_confirmed'/g) || []).length;
  assert.ok(confirmed >= 3,
    `unconfirmed molecule links must be excluded on every join (found ${confirmed})`);
  assert.ok(!/review_status <> 'rejected'|review_status != 'rejected'/.test(route),
    'the filter must be a positive test for auto_confirmed, not an exclusion of rejected');
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
  assert.match(route, /WITH demand AS/, 'the molecule query should be built from CTEs');
  assert.ok(!/\(SELECT COUNT\(DISTINCT d2\.holder_normalized\)/.test(route),
    'the correlated sub-select is back');
});

test('the drawer lists the SAME molecules the row count is computed from', () => {
  // THE INCONSISTENCY REPORTED FROM THE FLOOR: tapping 23 on Dr Reddy's produced a far longer
  // list, and every big Indian generic looked alike. `molecules_covered` counts only the TOP-N
  // molecules by clinical demand (scripts/lookup-cphi-exhibitors.js --top); the drawer query had
  // no such restriction, so it added a long tail those firms all share. The number you tap and the
  // rows you get have to come from one definition.
  assert.match(ROUTES, /const CPHI_TOP_N = 100;/,
    'CPHI_TOP_N must exist and match --top in the lookup script');
  const lookup = fs.readFileSync(path.join(ROOT, 'scripts/lookup-cphi-exhibitors.js'), 'utf8');
  const m = /flag\('--top',\s*(\d+)\)/.exec(lookup);
  assert.ok(m, 'could not read --top from the lookup script');
  assert.equal(Number(m[1]), 100,
    'the lookup script\'s --top changed; CPHI_TOP_N in routes.js must change with it');

  const route = ROUTES.slice(ROUTES.indexOf("'/events/cphi/exhibitors/:id/molecules'"),
                             ROUTES.indexOf("'/events/cphi/contacts'"));
  assert.match(route, /LIMIT \$2/, 'the drawer query must be bounded by the same top-N');
  assert.match(route, /sourceable AS/, 'and must use the same demand/sourceable shape as the count');
});

test('the drawer finds its row by STRING id — bigint comes back as a string', () => {
  // node-postgres returns BIGSERIAL as a string; the onclick passes a number literal. `===` between
  // them is always false, so the drawer header fell back to "This company" on every open.
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const open = html.slice(html.indexOf('window.cmOpen = async function'),
                          html.indexOf('function cmClose()'));
  assert.match(open, /String\(x\.id\) === String\(id\)/);
  assert.ok(!/find\(x => x\.id === id\)/.test(open), 'the strict id comparison is back');
});

test("TAPI is tied to the register's name, not the card's", () => {
  // The card reads TAPI; the register and the CPHI stand read TAPI NL BV. The fold cannot bridge a
  // different legal name, so without this the largest DMF bench on the list has no booth and no
  // molecules against it.
  assert.match(SEED, /company: 'TAPI NL BV'/,
    "TAPI must seed under the register's holder name or it ties to nothing");
  assert.match(SEED, /Card reads "TAPI"/, 'and the card name must survive in the note');
});

test('a corrected company name removes the row it superseded — by exact key, and only after', () => {
  // Changing a card's company changes the unique key (event, company fold, lower(name)), so the
  // upsert inserts a SECOND row and orphans the first. TAPI hit it: 'tapi' and 'tapi nl' are
  // different folds, so a re-run would have left two Quyen Nguyens, one of them booth-less.
  //
  // The cleanup is narrow on purpose. This script runs against production, and the repo's rule for
  // anything that deletes there is: remove exactly what you know you replaced, by key, never by
  // pattern and never "anything unmatched".
  assert.match(SEED, /const SUPERSEDED = \[/);
  assert.match(SEED, /was: 'TAPI', now: 'TAPI NL BV', name: 'Quyen Nguyen'/);
  const del = SEED.slice(SEED.indexOf('DELETE FROM cphi_exhibitor_contacts'),
                         SEED.indexOf('RETURNING id'));
  assert.match(del, /company_normalized = \$2/, 'the delete must be keyed on the exact old fold');
  assert.match(del, /lower\(name\) = lower\(\$3\)/, 'and on the exact person');
  assert.match(del, /EXISTS \(SELECT 1 FROM cphi_exhibitor_contacts k/,
    'the old row may only go once the replacement exists, or the card is lost outright');
  assert.ok(!/DELETE FROM cphi_exhibitor_contacts[\s\S]{0,200}NOT EXISTS[\s\S]{0,120}exhibitor_match_id/.test(SEED),
    'a "delete anything without a booth match" sweep would discard the CDMO and intermediate cards');
});

test('the CPHI page declares `halls` before the option list that reads it', () => {
  // THE BUG THIS EXISTS FOR, reported from the floor as a render failure:
  //   "cphi-milan failed to render — Cannot access 'halls' before initialization"
  // hallOpts is built near the top of the page function; `halls` was computed lower down beside
  // `items`, leaving hallOpts reading a const still in its temporal dead zone. The whole page threw
  // and rendered nothing.
  //
  // scripts/check-spa-parse.js cannot catch this: it PARSES every inline script and asserts the
  // entry points exist. A temporal-dead-zone error is valid syntax and only fails when the function
  // runs, so it passed preflight and reached production.
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const hallsAt = html.indexOf('const halls = [...new Set((res.items');
  const optsAt = html.indexOf("const hallOpts = [['', 'hall: all']");
  assert.ok(hallsAt > 0 && optsAt > 0, 'could not find the hall filter — this guard needs rewriting');
  assert.ok(hallsAt < optsAt,
    '`halls` must be declared before hallOpts reads it, or the CPHI page throws on render');
});

test('role joins the unique key, or one conversation overwrites the other', () => {
  // A firm that manufactures AND runs a laboratory is legitimately two rows: a supplier we buy from
  // and a QC lab we recruit, at the same booth with different asks. Keyed on
  // (event, holder_normalized) alone, the second lookup would overwrite the first and one of those
  // conversations would vanish from the floor list without anything failing.
  // Comments stripped FIRST. The rollback note at the top of that file names both indexes, and
  // "DROP INDEX IF EXISTS idx_cem_unique" is a prefix of "...idx_cem_unique_role" — so an indexOf
  // over the raw text matches the comment and the ordering check passes or fails on prose.
  const MIG = fs.readFileSync(path.join(ROOT, 'scripts/migrate-cphi-roles.js'), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
  assert.match(MIG, /CREATE UNIQUE INDEX IF NOT EXISTS idx_cem_unique_role[\s\S]*?\(event_slug, role, holder_normalized\)/);
  // Created BEFORE the old one is dropped: if two existing rows collide on the new key the create
  // fails and the table is left protected rather than bare.
  assert.ok(MIG.indexOf('idx_cem_unique_role') < MIG.indexOf('DROP INDEX IF EXISTS idx_cem_unique`'),
    'the new index must be created before the old one is dropped');
  assert.match(MIG, /DEFAULT 'supplier'/, 'existing rows are suppliers, which is what they are');
});

test('the role lookup aborts rather than grinding on a refusing directory', () => {
  // Hundreds of serialised HTTP requests. Ten failures in a row is the widget refusing us, not ten
  // odd company names — and an hour of writing nothing that ends with a summary line looks exactly
  // like a completed run.
  const LOOK = fs.readFileSync(path.join(ROOT, 'scripts/lookup-cphi-roles.js'), 'utf8');
  assert.match(LOOK, /consecutiveErrors >= 10/);
  assert.match(LOOK, /ABORTED after 10 consecutive errors/);
  assert.match(LOOK, /const EXECUTE = argv\.includes\('--execute'\)/, 'dry run by default');
  assert.match(LOOK, /EXECUTE && !err/, 'a row whose lookup errored must not be written as "not exhibiting"');
});

test('the directory parser lives in ONE place', () => {
  // CPHI rebuilds this widget every year; two copies of the __NEXT_DATA__ parse means finding out twice.
  const dir = fs.readFileSync(path.join(ROOT, 'src/lib/cphi/directory.js'), 'utf8');
  assert.match(dir, /__NEXT_DATA__/);
  const look = fs.readFileSync(path.join(ROOT, 'scripts/lookup-cphi-roles.js'), 'utf8');
  assert.match(look, /require\('\.\.\/src\/lib\/cphi\/directory'\)/,
    'the role lookup must use the shared parser, not its own copy');
  assert.ok(!/__NEXT_DATA__/.test(look), 'the parse is duplicated into the role lookup');
});
