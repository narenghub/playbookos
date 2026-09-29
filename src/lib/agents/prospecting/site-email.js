// Prospecting — EMAIL EXTRACTION from a scanned site (PURE; the fetch stays in the orchestrator).
//
//   extractEmails({ html, followedHtml, siteUrl }) -> { own: [...], thirdParty: [...], all: [...] }
//
// Places does not return an email, but the scanner already fetches the homepage AND follows one
// link (about / contact / services), so the HTML is in hand. Reps need an address next to the phone.
//
// ORDER OF TRUST
//   1. `mailto:` hrefs — someone deliberately published that address as a contact.
//   2. A regex over the page text — catches addresses printed as text or lightly obfuscated.
//   The FOLLOWED page is preferred over the homepage, because a contact page is where the address
//   actually lives; a homepage footer often carries a generic one.
//
// THREE CLASSES, not two — the first version had only two and got it badly wrong.
// An off-domain address is NOT automatically a designer: a small machine shop using gmail is using
// its OWN address. Measured on the first real run: the "designer" list was topped by gmail.com (47),
// yahoo.com (7), comcast.net (5), att.net (4) — every one of those a business's own mailbox. That
// fabricated an agency signal AND threw away ~63 genuine leads.
//   own        — the address is on the site's own registrable domain
//   freeMail   — a consumer mailbox (gmail/yahoo/comcast/att/...): the BUSINESS's address, used when
//                there is no on-domain one. Never agency evidence.
//   thirdParty — off-domain AND not consumer mail: usually whoever built the site.
//
// A thirdParty address is wrong to call as the owner, but worth KEEPING: it identifies who built the
// site, which is the same "the seat is taken" signal as a reseller platform or campaign tracking. So
// it is never written to owner_email, and is surfaced as agency evidence instead.

const SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);
function registrableDomain(urlOrHost) {
  let host = String(urlOrHost || '').trim().toLowerCase();
  try { if (/^https?:\/\//.test(host)) host = new URL(host).hostname; } catch { /* fall through */ }
  host = host.replace(/^www\./, '');
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return host;
  if (parts.length >= 3 && SLD.has(parts[parts.length - 2])) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// Addresses that are never a lead. Builder/CMS support addresses, placeholder domains, and the
// no-reply class of address nobody answers.
const NOISE_DOMAIN = /(^|\.)(example|example\.com|test|localhost|sentry\.io|wix\.com|wixpress\.com|squarespace\.com|weebly\.com|godaddy\.com|shopify\.com|duda\.co|dudamobile\.com|wordpress\.com|automattic\.com|cloudflare\.com|google\.com|gstatic\.com|facebook\.com|sentry-next\.wixpress\.com)$/i;
const NOISE_LOCAL = /^(no-?reply|donotreply|do-not-reply|postmaster|abuse|webmaster@?$|support@?(wix|squarespace|weebly|godaddy|duda)|hostmaster|mailer-daemon|bounce|unsubscribe)/i;
// An "address" that is really an asset filename: name@2x.png, sprite@3x.svg, font@2x.woff.
const ASSET_LIKE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|eot|mp4|webm|pdf)$/i;
// Sentry/analytics DSNs and versioned package specifiers also look like addresses.
const VERSION_LIKE = /^[\d.]+$|@\d+\.\d+/;

// Consumer mailbox providers. An address here belongs to the BUSINESS (or its owner personally),
// never to a web designer, so it is a usable lead and is not agency evidence.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'att.net', 'sbcglobal.net',
  'verizon.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'juno.com', 'mail.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'zoho.com', 'yandex.com', 'ameritech.net', 'prodigy.net',
]);
const isFreeMail = (domain) => FREE_MAIL.has(String(domain || '').toLowerCase());

const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const MAILTO_RX = /href\s*=\s*["']\s*mailto:([^"'?>\s]+)/gi;

function looksReal(addr) {
  const a = String(addr || '').toLowerCase().trim().replace(/[.,;:)\]]+$/, '');
  if (!a || a.length > 120 || !a.includes('@')) return null;
  if (ASSET_LIKE.test(a) || VERSION_LIKE.test(a)) return null;
  const [local, domain] = a.split('@');
  if (!local || !domain || domain.indexOf('.') === -1) return null;
  if (NOISE_LOCAL.test(local) || NOISE_LOCAL.test(a)) return null;
  if (NOISE_DOMAIN.test(domain)) return null;
  // A domain whose last label is not alphabetic is not a hostname (catches trailing junk).
  if (!/^[a-z]{2,}$/i.test(domain.split('.').pop())) return null;
  return a;
}

// Ordered, de-duplicated harvest: mailto hrefs first, then text matches, followed page before
// homepage. The FIRST occurrence of an address wins its position, so ordering is the trust order.
function harvest({ html, followedHtml }) {
  const out = [];
  const seen = new Set();
  const push = (raw, source) => {
    const a = looksReal(raw);
    if (!a || seen.has(a)) return;
    seen.add(a);
    out.push({ email: a, source });
  };
  const scan = (doc, where) => {
    if (!doc) return;
    const s = String(doc);
    let m;
    const mailto = new RegExp(MAILTO_RX.source, 'gi');
    while ((m = mailto.exec(s))) push(decodeURIComponent(m[1]), `mailto on ${where}`);
    const text = new RegExp(EMAIL_RX.source, 'g');
    while ((m = text.exec(s))) push(m[0], `text on ${where}`);
  };
  // Followed page first: a contact page beats a homepage footer.
  scan(followedHtml, 'the contact/about page');
  scan(html, 'the homepage');
  return out;
}

function extractEmails({ html, followedHtml, siteUrl } = {}) {
  const siteDomain = registrableDomain(siteUrl);
  const found = harvest({ html, followedHtml });
  const own = [], freeMail = [], thirdParty = [];
  for (const f of found) {
    const d = registrableDomain(f.email.split('@')[1]);
    const entry = { ...f, domain: d };
    if (siteDomain && d === siteDomain) own.push(entry);
    else if (isFreeMail(d)) freeMail.push(entry);       // the business's own mailbox, not a designer
    else thirdParty.push(entry);
  }
  return { own, freeMail, thirdParty, all: found, site_domain: siteDomain };
}

// The one address to put on the row: the business's own, most-trusted first. Never a third-party
// address — calling the web designer and asking for the owner is a bad first impression.
function pickOwnerEmail(extracted) {
  const own = (extracted && extracted.own) || [];
  const free = (extracted && extracted.freeMail) || [];
  // On-domain first; a consumer mailbox is a real fallback (plenty of small shops have no other
  // address). A third-party address is NEVER used — calling the web designer to ask for the owner is
  // a bad first impression.
  const pool = own.length ? own : free;
  if (!pool.length) return null;
  // Prefer a role address a business actually monitors over a personal one, then earliest found.
  const preferred = pool.find(x => /^(info|contact|sales|hello|office|admin|enquir|inquir)/i.test(x.email.split('@')[0]));
  return (preferred || pool[0]).email;
}

// Third-party addresses as agency evidence, in the same shape site-score.js uses.
function designerSignals(extracted) {
  const tp = (extracted && extracted.thirdParty) || [];
  if (!tp.length) return [];
  const domains = [...new Set(tp.map(x => x.domain))].slice(0, 3);
  return [{
    key: 'designer_email_on_site',
    evidence: `the site carries an address at ${domains.join(', ')}, not the business's own domain — usually whoever built it`,
  }];
}

module.exports = { extractEmails, pickOwnerEmail, designerSignals, registrableDomain, looksReal, isFreeMail, FREE_MAIL };
