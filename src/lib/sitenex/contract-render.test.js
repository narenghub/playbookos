// Contract rendering — and above all, REFUSING.
//
//   node --test src/lib/sitenex/contract-render.test.js
//
// The thing being protected is a document arriving at a real business with `{{client_company}}` in it.
// That failure is glaring to the client and invisible to us, because we never see the file again — so
// the refusals are tested harder than the happy path, and the rendered bytes are unzipped and read as
// text, because "it returned a buffer" does not prove what is inside it.

const { test } = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { renderContract, checkRenderable, missingFields, scheduleImbalance, fieldsFor, money } =
  require('./contract-render');
const { FIELDS, BLOCKS, TEMPLATE_VERSION, SUPPLIER } = require('./contract-template');

const FULL = {
  contract_no: 'SN-2026-0001', contract_date: '30 September 2026',
  client_company: 'Acme Machine Works LLC', client_address: '412 W Main St, Rockford, IL 61101',
  client_contact: 'Dale Prentice', client_title: 'Owner', client_email: 'dale@acmemachine.example',
  client_phone: '(815) 555-0142', partner_name: 'ACBM Partners',
  package_code: 'P2', package_name: 'P2 · Renew (rebuild, 3 weeks)',
  duration_weeks: 3, starts_at_intake: true, value_cents: 450000, monthly_cents: 9900,
  terms_note: 'Logo files to be supplied by the client in SVG.',
  included: ['Everything in Launch (P1)', 'content migration', '301 redirect map from old URLs'],
  not_included: ['content writing', 'photography', 'booking system'],
  payments: [{ seq: 1, label: 'Deposit', amount_cents: 225000, due_trigger: 'on_signature' },
             { seq: 2, label: 'On launch', amount_cents: 225000, due_trigger: 'on_launch' }],
};

const textOf = (buffer) => new AdmZip(buffer).readAsText('word/document.xml')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ── REFUSALS ──────────────────────────────────────────────────────────────────

test('REFUSES on a missing required field, and NAMES every one at once', async () => {
  const { client_company, client_email, client_address, ...rest } = FULL;
  const r = await renderContract(rest);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'missing_fields');
  // All three, not the first — fixing them one 400 at a time is its own small cruelty.
  assert.deepEqual(r.missing.map(m => m.field).sort(), ['client_address', 'client_company', 'client_email']);
  for (const label of ['Client company', 'Client email', 'Client address']) assert.ok(r.error.includes(label));
  assert.equal(r.buffer, undefined, 'nothing may be rendered when a field is missing');
});

test('every REQUIRED field is individually enough to cause a refusal', async () => {
  // A check that only looks at one field would pass the test above. Each required field is removed in
  // turn, so none of them can quietly stop being checked.
  for (const [name, spec] of Object.entries(FIELDS)) {
    if (!spec.required) continue;
    const row = { ...FULL };
    // start_basis and the supplier fields are derived, not supplied — removed via their sources.
    if (name === 'start_basis' || name === 'supplier_name') continue;
    if (name === 'package_name') { delete row.package_name; delete row.package_code; }
    else if (name === 'total_value') row.value_cents = null;
    else if (name === 'duration_weeks') row.duration_weeks = null;
    else delete row[name];
    const r = await renderContract(row);
    assert.equal(r.ok, false, `removing '${name}' did NOT cause a refusal — it is marked required but unchecked`);
    assert.equal(r.code, 'missing_fields');
  }
});

test('an empty string is as missing as an absent field', async () => {
  // A form posts '' rather than omitting a key, which is the realistic shape of this bug.
  for (const v of ['', '   ', '\t']) {
    const r = await renderContract({ ...FULL, client_company: v });
    assert.equal(r.ok, false, `'${JSON.stringify(v)}' should count as missing`);
    assert.equal(r.code, 'missing_fields');
  }
});

test('REFUSES an unbalanced payment schedule, and says by how much', async () => {
  // A contract whose installments do not sum to its total is a document two people read differently,
  // which is the entire thing a contract exists to prevent.
  const r = await renderContract({ ...FULL, payments: [{ seq: 1, label: 'Deposit', amount_cents: 100000 }] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unbalanced_schedule');
  assert.match(r.error, /\$1,000/);
  assert.match(r.error, /\$4,500/);
  assert.match(r.error, /difference of \$3,500/);
  assert.equal(r.buffer, undefined);
  // Off by one cent is still unbalanced. Rounding is exactly how this would slip through.
  const cent = await renderContract({ ...FULL, payments: [{ seq: 1, label: 'All', amount_cents: 449999 }] });
  assert.equal(cent.ok, false, 'one cent out must still refuse');
});

test('an EMPTY schedule is allowed — a partial one is the dangerous case, not an absent one', async () => {
  // A deal may legitimately have no installment plan agreed yet; the document then states the total.
  const r = await renderContract({ ...FULL, payments: [] });
  assert.equal(r.ok, true, r.error);
  assert.match(textOf(r.buffer), /No installment schedule was agreed/);
  const r2 = await renderContract({ ...FULL, payments: undefined });
  assert.equal(r2.ok, true, r2.error);
});

test('a schedule with no total to balance against refuses rather than guessing', () => {
  const imb = scheduleImbalance({ value_cents: null, payments: [{ amount_cents: 100 }] });
  assert.equal(imb.reason, 'no_total');
  assert.equal(scheduleImbalance({ value_cents: 100, payments: [{ amount_cents: 100 }] }), null);
  assert.equal(scheduleImbalance({ value_cents: null, payments: [] }), null, 'neither present is fine');
});

test('checkRenderable answers without rendering, so a UI can ask before it asks the user to wait', () => {
  assert.equal(checkRenderable(FULL).ok, true);
  const bad = checkRenderable({ ...FULL, client_company: null });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'missing_fields');
  assert.deepEqual(missingFields(FULL), []);
});

// ── THE DOCUMENT ITSELF ───────────────────────────────────────────────────────

test('the rendered file is a real .docx and contains NO surviving placeholder', async () => {
  const r = await renderContract(FULL);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.buffer.subarray(0, 4).toString('hex'), '504b0304', 'must be a zip');
  const text = textOf(r.buffer);
  assert.deepEqual(text.match(/\{\{[^}]*\}\}/g), null, 'an unresolved placeholder reached the document');
  assert.ok(!/undefined|\[object Object\]|NaN|null/.test(text), `leaked a JS value: ${text.slice(0, 200)}`);
});

test('every document is stamped with the template version that produced it', async () => {
  // This replaced a test that asserted a PLACEHOLDER NOTICE in the document. The notice came out with v1,
  // because the document now goes to real clients. What survives is the part that matters afterwards: a
  // signed file on somebody's disk in a year's time must say which wording they agreed to, because the
  // terms will have changed by then and the register alone cannot prove which text a given client saw.
  const r = await renderContract(FULL);
  const text = textOf(r.buffer);
  assert.ok(text.includes(TEMPLATE_VERSION), 'the document must name its template version');
  assert.equal(r.template_version, TEMPLATE_VERSION, 'and return it for the register');
  assert.doesNotMatch(text, /NOT BEEN REVIEWED BY AN ATTORNEY|not legal advice|placeholder/i,
    'a document sent to a client must not warn the client about itself');
});

test('every supplied value actually reaches the document', async () => {
  const { buffer } = await renderContract(FULL);
  const text = textOf(buffer);
  for (const probe of ['SN-2026-0001', '30 September 2026', 'Acme Machine Works LLC', '412 W Main St',
                       'Dale Prentice', 'Owner', 'dale@acmemachine.example', '(815) 555-0142',
                       'ACBM Partners', 'P2', '3 weeks', '$4,500', '$99', 'SVG',
                       'content migration', 'content writing', 'Deposit', 'On launch', '$2,250',
                       SUPPLIER.supplier_name]) {
    assert.ok(text.includes(probe), `'${probe}' was supplied but is not in the document`);
  }
});

test('an empty OPTIONAL value drops its row rather than drawing a blank one', async () => {
  // "Telephone:" with nothing after it looks like a mistake in the document; its absence looks like a
  // detail that was not relevant.
  const { client_phone, partner_name, ...noOptionals } = FULL;
  const { buffer } = await renderContract(noOptionals);
  const text = textOf(buffer);
  assert.ok(!text.includes('Telephone'), 'an empty phone must not leave a labelled blank');
  // NOT asserted via the label 'Introduced by': the Referral partner clause quotes that label in its
  // prose by design, so the absence of the ROW has to be checked by the absence of its VALUE.
  assert.ok(!text.includes('ACBM Partners'), 'an absent partner must not appear');
  assert.ok(text.includes('Introduced by'), 'the clause that explains the label still stands');
  // And it still renders everything else.
  assert.ok(text.includes('Acme Machine Works LLC'));
});

test('an empty optional CLAUSE is dropped entirely, heading included', async () => {
  // "Additional agreed terms" followed by nothing reads as something lost in the post.
  const { terms_note, ...noTerms } = FULL;
  const text = textOf((await renderContract(noTerms)).buffer);
  assert.ok(!text.includes('Additional agreed terms'), 'the heading must go with its empty body');
  // Present when there IS a note.
  assert.ok(textOf((await renderContract(FULL)).buffer).includes('Additional agreed terms'));
});

test('clause numbering is sequential and skips the dropped clause', async () => {
  const text = textOf((await renderContract(FULL)).buffer);
  const nums = [...text.matchAll(/(?:^| )(\d{1,2})\. [A-Z]/g)].map(m => Number(m[1]));
  const headings = nums.filter((n, i) => i === 0 || n === nums[i - 1] + 1);
  assert.ok(headings.length >= 10, `expected a numbered clause list, found ${JSON.stringify(nums)}`);
  assert.equal(headings[0], 1, 'numbering starts at 1');
  // With the optional clause dropped the count falls by one and the numbering stays contiguous — i.e.
  // there is no gap where clause 15 used to be.
  const { terms_note, ...noTerms } = FULL;
  const t2 = textOf((await renderContract(noTerms)).buffer);
  const n2 = [...t2.matchAll(/(?:^| )(\d{1,2})\. [A-Z]/g)].map(m => Number(m[1]));
  const seq2 = n2.filter((n, i) => i === 0 || n === n2[i - 1] + 1);
  assert.equal(seq2.length, headings.length - 1, 'dropping a clause must renumber, not leave a hole');
});

test('an empty exclusions list is STATED, never implied by a gap', async () => {
  // An empty exclusions list in a signed contract means "nothing is excluded", which is a commitment.
  const text = textOf((await renderContract({ ...FULL, not_included: [] })).buffer);
  assert.match(text, /No specific exclusions were agreed/);
  const t2 = textOf((await renderContract({ ...FULL, included: [] })).buffer);
  assert.match(t2, /set out in the accompanying proposal/);
});

test('starts_at_intake changes the words, and TRUE is the standing arrangement', async () => {
  assert.match(textOf((await renderContract({ ...FULL, starts_at_intake: true })).buffer), /on completion of intake/);
  assert.match(textOf((await renderContract({ ...FULL, starts_at_intake: false })).buffer), /on signature of this agreement/);
  // Absent reads as TRUE, matching the column DEFAULT — a deal written before the column existed must
  // not silently flip to dating the term from signature.
  assert.equal(fieldsFor({ ...FULL, starts_at_intake: undefined }).start_basis, 'on completion of intake');
  assert.equal(fieldsFor({ ...FULL, starts_at_intake: null }).start_basis, 'on completion of intake');
});

test('the payment table shows every installment, its trigger in words, and a total', async () => {
  const text = textOf((await renderContract(FULL)).buffer);
  assert.match(text, /on signature/);
  assert.match(text, /on launch/);
  assert.match(text, /Total/);
  // Out-of-order rows are sorted by seq, because the order they fall due is the point of the table.
  const rev = await renderContract({ ...FULL, payments: [
    { seq: 2, label: 'Second stage', amount_cents: 225000, due_trigger: 'on_launch' },
    { seq: 1, label: 'First stage', amount_cents: 225000, due_trigger: 'on_signature' }] });
  const t = textOf(rev.buffer);
  assert.ok(t.indexOf('First stage') < t.indexOf('Second stage'), 'the schedule must read in due order');
});

test('a date-triggered installment shows the DATE, not the word', async () => {
  const r = await renderContract({ ...FULL, payments: [
    { seq: 1, label: 'Deposit', amount_cents: 225000, due_trigger: 'on_signature' },
    { seq: 2, label: 'Balance', amount_cents: 225000, due_trigger: 'date', due_date: '2026-12-01' }] });
  assert.match(textOf(r.buffer), /2026-12-01/);
});

test('the file name is safe and identifies the contract', async () => {
  const r = await renderContract(FULL);
  assert.match(r.file_name, /^SN-2026-0001-Acme-Machine-Works-LLC\.docx$/);
  // A company name full of punctuation must not produce a path or a broken download.
  const odd = await renderContract({ ...FULL, client_company: '../../etc/passwd & Co. "Ltd"' });
  assert.ok(!/[/\\"'&.]/.test(odd.file_name.replace(/\.docx$/, '')), `unsafe file name: ${odd.file_name}`);
  assert.match(odd.file_name, /\.docx$/);
});

// ── the template stays DATA ───────────────────────────────────────────────────

test('the template is data an attorney can read — no code, no logic', () => {
  // The whole reason it is a separate file. A function in here would have to be reviewed as code.
  const src = require('fs').readFileSync(__dirname + '/contract-template.js', 'utf8');
  const body = src.slice(src.indexOf('const BLOCKS'));
  for (const re of [/=>/, /\bfunction\b/, /\bif\s*\(/, /\brequire\(/, /\bquery\(/]) {
    assert.doesNotMatch(body, re, `the template must stay declarative — found /${re.source}/`);
  }
  for (const b of BLOCKS) {
    const kinds = ['h', 'p', 'title', 'bullets', 'numbered', 'kv', 'scope', 'payments', 'signatures', 'notice', 'pagebreak'];
    assert.ok(kinds.some(k => k in b), `a block the renderer cannot draw: ${JSON.stringify(b).slice(0, 80)}`);
  }
});

test('every {{field}} the template references is DECLARED in FIELDS', () => {
  // The gap this closes: a field referenced but not declared is required by nothing, so the missing-field
  // check cannot see it, and it would render as the literal {{name}}. The post-render sweep catches it
  // too, but catching it here means it fails in the suite rather than at a partner's desk.
  const refs = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { for (const m of v.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) refs.add(m[1]); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(BLOCKS);
  const undeclared = [...refs].filter(r => !(r in FIELDS));
  assert.deepEqual(undeclared, [], `referenced by the template but not in FIELDS: ${undeclared.join(', ')}`);
  assert.ok(refs.size > 8, `only ${refs.size} fields referenced — the walker has stopped working`);
});

test('the post-render sweep would catch an undeclared placeholder', async () => {
  // Proving the belt-and-braces check works, by rendering a template block that references a name
  // FIELDS does not declare. Done against the real renderer via a temporarily injected block.
  BLOCKS.push({ p: 'Owing: {{not_a_declared_field}}.' });
  try {
    const r = await renderContract(FULL);
    assert.equal(r.ok, false, 'an undeclared placeholder must be refused');
    assert.equal(r.code, 'unresolved_placeholder');
    assert.deepEqual(r.leftover, ['{{not_a_declared_field}}']);
  } finally { BLOCKS.pop(); }
  // And the real template still renders, i.e. the test cleaned up after itself.
  assert.equal((await renderContract(FULL)).ok, true);
});

test('money formats cents without inventing precision', () => {
  assert.equal(money(450000), '$4,500');
  assert.equal(money(9900), '$99');
  assert.equal(money(123456), '$1,234.56');
  assert.equal(money(0), '$0');
  assert.equal(money(null), null, 'null is not $0 — an unset price must not print as free');
  assert.equal(money(undefined), null);
});
