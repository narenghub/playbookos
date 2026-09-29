// Email extraction tests — run with:  node --test src/lib/agents/prospecting/site-email.test.js
// The contract: an address on the row must plausibly reach the BUSINESS. A designer's address, a
// builder's support address, or an asset filename reaching owner_email would send a rep to the
// wrong person or nowhere at all.

const { test } = require('node:test');
const assert = require('node:assert');
const { extractEmails, pickOwnerEmail, designerSignals, registrableDomain, looksReal } = require('./site-email');

test('mailto hrefs are found, and the contact page beats the homepage', () => {
  const home = '<a href="mailto:info@acme-machine.com">email us</a>';
  const contact = '<a href="mailto:sales@acme-machine.com">sales</a>';
  const r = extractEmails({ html: home, followedHtml: contact, siteUrl: 'https://acme-machine.com' });
  // Both are found, but the contact page's address is harvested first — it is the better source.
  assert.deepEqual(r.own.map(x => x.email), ['sales@acme-machine.com', 'info@acme-machine.com']);
  assert.match(r.own[0].source, /contact\/about/);
});

test('a plain-text address is found when there is no mailto', () => {
  const r = extractEmails({ html: '<p>Call or write: Shop@AcmeMachine.com </p>', siteUrl: 'http://acmemachine.com' });
  assert.deepEqual(r.own.map(x => x.email), ['shop@acmemachine.com']);
  assert.match(r.own[0].source, /text/);
});

test('an off-domain address is THIRD PARTY, never the owner — it is who built the site', () => {
  const html = '<footer>© 2011 Acme Machine · site by <a href="mailto:hello@brightsparkdesign.com">Bright Spark</a></footer>';
  const r = extractEmails({ html, siteUrl: 'https://acme-machine.com' });
  assert.deepEqual(r.own, []);
  assert.deepEqual(r.thirdParty.map(x => x.email), ['hello@brightsparkdesign.com']);
  assert.equal(pickOwnerEmail(r), null, 'a designer address must never become owner_email');
  const sig = designerSignals(r);
  assert.equal(sig[0].key, 'designer_email_on_site');
  assert.match(sig[0].evidence, /brightsparkdesign\.com/);
  assert.match(sig[0].evidence, /whoever built it/);
});

test('both own and designer addresses on one page are separated correctly', () => {
  const html = '<a href="mailto:info@acme-machine.com">us</a> <a href="mailto:studio@webguys.net">site by WebGuys</a>';
  const r = extractEmails({ html, siteUrl: 'https://www.acme-machine.com/' });
  assert.deepEqual(r.own.map(x => x.email), ['info@acme-machine.com']);
  assert.deepEqual(r.thirdParty.map(x => x.email), ['studio@webguys.net']);
  assert.equal(pickOwnerEmail(r), 'info@acme-machine.com');
  assert.equal(designerSignals(r).length, 1);
});

test('subdomains and www count as the same business', () => {
  const r = extractEmails({ html: 'mail: bob@shop.acme-machine.com', siteUrl: 'https://www.acme-machine.com' });
  assert.deepEqual(r.own.map(x => x.email), ['bob@shop.acme-machine.com']);
});

test('NOISE is filtered: builder support, placeholders, no-reply, asset filenames', () => {
  const junk = [
    'support@wix.com', 'help@squarespace.com', 'x@weebly.com', 'a@godaddy.com',
    'someone@example.com', 'no-reply@acme-machine.com', 'donotreply@acme-machine.com',
    'postmaster@acme-machine.com', 'logo@2x.png', 'sprite@3x.svg', 'font@2x.woff2',
  ];
  const html = junk.map(e => `<a href="mailto:${e}">x</a>`).join(' ');
  const r = extractEmails({ html, siteUrl: 'https://acme-machine.com' });
  assert.deepEqual(r.all, [], `none of these should survive: ${JSON.stringify(r.all)}`);
  assert.equal(pickOwnerEmail(r), null);
});

test('looksReal rejects asset filenames and version specifiers individually', () => {
  for (const bad of ['logo@2x.png', 'icon@3x.svg', 'pkg@1.2.3', 'x@y', 'a@b.c1', '', null]) {
    assert.equal(looksReal(bad), null, `${JSON.stringify(bad)} should be rejected`);
  }
  assert.equal(looksReal('  Info@Acme-Machine.COM.  '), 'info@acme-machine.com');
});

test('a monitored role address is preferred over a personal one', () => {
  const html = 'mailto:dave@acme-machine.com and mailto:info@acme-machine.com';
  const r = extractEmails({ html: html.replace(/mailto:(\S+)/g, '<a href="mailto:$1">x</a>'), siteUrl: 'https://acme-machine.com' });
  assert.equal(pickOwnerEmail(r), 'info@acme-machine.com', 'info@ beats a named individual');
});

test('no emails anywhere yields nothing rather than a guess', () => {
  const r = extractEmails({ html: '<html><body>Call us on 815-555-1234</body></html>', siteUrl: 'https://acme-machine.com' });
  assert.deepEqual(r.all, []);
  assert.equal(pickOwnerEmail(r), null);
  assert.deepEqual(designerSignals(r), []);
});

test('missing html or siteUrl never throws', () => {
  for (const args of [{}, { html: null }, { html: '<a href="mailto:a@b.com">x</a>' }, { siteUrl: 'not a url' }]) {
    assert.doesNotThrow(() => extractEmails(args));
  }
  // With no site domain known, an address cannot be attributed as "own".
  const r = extractEmails({ html: '<a href="mailto:a@b.com">x</a>' });
  assert.equal(r.own.length + r.thirdParty.length, 1);
});

test('registrableDomain handles hosts, urls, www and multi-part TLDs', () => {
  assert.equal(registrableDomain('https://www.acme-machine.com/contact'), 'acme-machine.com');
  assert.equal(registrableDomain('shop.acme-machine.com'), 'acme-machine.com');
  assert.equal(registrableDomain('acme.co.uk'), 'acme.co.uk');
  assert.equal(registrableDomain('mail.acme.co.uk'), 'acme.co.uk');
  assert.equal(registrableDomain(''), '');
});

test('duplicates collapse, keeping the earliest (most trusted) source', () => {
  const r = extractEmails({
    html: 'text info@acme-machine.com',
    followedHtml: '<a href="mailto:info@acme-machine.com">x</a>',
    siteUrl: 'https://acme-machine.com',
  });
  assert.equal(r.own.length, 1);
  assert.match(r.own[0].source, /mailto on the contact\/about page/);
});

// ── free mail is the BUSINESS's address, not a designer's ───────────────────────
// The first version classified every off-domain address as a designer, which on real data made
// gmail.com the top "designer" domain (47 rows) — fabricating an agency signal and discarding the
// only address those businesses publish.
const { isFreeMail } = require('./site-email');

test('a gmail address on a shop site is the OWNER, not a designer', () => {
  const html = '<a href="mailto:acmemachine1978@gmail.com">email</a>';
  const r = extractEmails({ html, siteUrl: 'https://acme-machine.com' });
  assert.deepEqual(r.own, []);
  assert.deepEqual(r.thirdParty, [], 'a consumer mailbox is never a designer');
  assert.deepEqual(r.freeMail.map(x => x.email), ['acmemachine1978@gmail.com']);
  assert.equal(pickOwnerEmail(r), 'acmemachine1978@gmail.com', 'it is a usable lead');
  assert.deepEqual(designerSignals(r), [], 'and it raises NO agency signal');
});

test('an on-domain address still wins over a consumer one', () => {
  const html = '<a href="mailto:shop@gmail.com">g</a> <a href="mailto:info@acme-machine.com">own</a>';
  const r = extractEmails({ html, siteUrl: 'https://acme-machine.com' });
  assert.equal(pickOwnerEmail(r), 'info@acme-machine.com');
});

test('a genuine designer domain is still flagged, alongside a free-mail owner', () => {
  const html = '<a href="mailto:shop1978@yahoo.com">us</a> <a href="mailto:studio@webguys.net">site by</a>';
  const r = extractEmails({ html, siteUrl: 'https://acme-machine.com' });
  assert.equal(pickOwnerEmail(r), 'shop1978@yahoo.com');
  assert.deepEqual(r.thirdParty.map(x => x.domain), ['webguys.net']);
  assert.equal(designerSignals(r).length, 1);
  assert.match(designerSignals(r)[0].evidence, /webguys\.net/);
  assert.doesNotMatch(designerSignals(r)[0].evidence, /yahoo/, 'the owner mailbox must not appear as the builder');
});

test('isFreeMail covers the providers US small businesses actually use', () => {
  for (const d of ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','comcast.net','att.net','sbcglobal.net','icloud.com','verizon.net','cox.net','charter.net']) {
    assert.equal(isFreeMail(d), true, d);
  }
  for (const d of ['acme-machine.com','webguys.net','brightspark.co']) assert.equal(isFreeMail(d), false, d);
});
