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
// OWN vs THIRD-PARTY — the important distinction, and the reason this returns two lists.
// An address whose domain does not match the site's registrable domain is usually NOT the business:
// it is the web designer or agency who built the site and left their address in the footer. Those
// are wrong to call as the owner, but they are worth KEEPING, because they identify who built the
// site — which is the same "the seat is taken" signal as a reseller platform or campaign tracking.
// So they go to thirdParty, are never written to owner_email, and are surfaced as agency evidence.

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
  const own = [], thirdParty = [];
  for (const f of found) {
    const d = registrableDomain(f.email.split('@')[1]);
    const entry = { ...f, domain: d };
    if (siteDomain && d === siteDomain) own.push(entry); else thirdParty.push(entry);
  }
  return { own, thirdParty, all: found, site_domain: siteDomain };
}

// The one address to put on the row: the business's own, most-trusted first. Never a third-party
// address — calling the web designer and asking for the owner is a bad first impression.
function pickOwnerEmail(extracted) {
  const own = (extracted && extracted.own) || [];
  if (!own.length) return null;
  // Prefer a role address a business actually monitors over a personal one, then earliest found.
  const preferred = own.find(x => /^(info|contact|sales|hello|office|admin|enquir|inquir)/i.test(x.email.split('@')[0]));
  return (preferred || own[0]).email;
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

module.exports = { extractEmails, pickOwnerEmail, designerSignals, registrableDomain, looksReal };
