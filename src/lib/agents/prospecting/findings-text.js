// Prospecting — SITE FINDINGS → PLAIN SENTENCES (pure; no DB, no I/O).
//
// site_findings.signals holds keys and penalties. That is right for sorting and wrong for saying
// out loud, so everything that shows a finding to a HUMAN comes through here:
//   • scripts/acbm-call-sheet.js  (the printed call sheet)
//   • the acbm-prospects screen   (expanded row)
// One implementation on purpose — two copies of this wording would drift, and then the sheet a
// rep reads and the screen a manager reads would describe the same site differently.
//
//   findingSentence(signal)        -> one speakable sentence
//   findingSentences(site_findings)-> [sentence] for every signal, in stored order
//   agencyNote(site_findings)      -> the "someone may already be looking after this" caution
//   packageLabel(code)             -> 'P2 · Renew (rebuild, 3 weeks)'
//
// Style rules, so future additions match: a speakable main clause first; the technical detail in
// brackets only if a prospect might ask what we looked at; never a key, never a number of points,
// never the score itself. The score is a sorting device; the findings are the argument.

const BUILDER_PRETTY = { weebly: 'Weebly', godaddy: 'GoDaddy', frontpage: 'Microsoft FrontPage', duda: 'Duda', wix: 'Wix', squarespace: 'Squarespace', wordpress: 'WordPress', joomla: 'Joomla', drupal: 'Drupal', shopify: 'Shopify' };

function findingSentence(sig) {
  if (!sig || !sig.key) return '';
  const ev = String(sig.evidence || '');
  switch (sig.key) {
    case 'no_viewport':
      return "The site doesn't resize on a phone — it loads at desktop width, so you have to pinch and drag to read it.";
    case 'legacy_layout': {
      const bits = [];
      if (/layout <table>/.test(ev)) bits.push('the layout is built out of tables');
      if (/<font>|<center>/.test(ev)) bits.push('the text styling is hard-coded into each page (font and center tags)');
      if (/Flash/.test(ev)) bits.push('there is still Flash content, which no browser has run since 2020');
      return `The page is built the way sites were built twenty years ago — ${bits.join(', and ')}.`;
    }
    case 'no_https':
      return 'The site is served over plain http, so browsers show "Not secure" next to the address.';
    case 'stale_copyright': {
      const y = (/reads (\d{4})/.exec(ev) || [])[1];
      return `The footer still says ${y || 'an old year'}.`;
    }
    case 'missing_title_or_desc':
      if (/no <title> and no meta description/.test(ev)) return 'The page has no title and no description, so Google has nothing to show for it in search results.';
      if (/no <title>/.test(ev)) return 'The page has no title, so it shows up in search results with a URL instead of a name.';
      return 'The page has no description, so Google writes its own snippet from whatever text it finds.';
    case 'dated_builder': {
      const raw = ((/built on (\w+)/.exec(ev) || [])[1] || '').toLowerCase();
      if (raw === 'frontpage') return 'The site was made in Microsoft FrontPage, which Microsoft discontinued in 2006.';
      return `It was put together with ${BUILDER_PRETTY[raw] || raw || 'a DIY builder'}'s DIY site builder.`;
    }
    case 'old_jquery': {
      const v = (/jQuery ([\d.]+)/.exec(ev) || [])[1];
      return `It still loads jQuery ${v || '1.x'}, a version that stopped getting security fixes years ago.`;
    }
    case 'social_as_website':
      return 'They have no website at all — the only web presence is a social page.';
    case 'site_unreachable':
      return "The website doesn't load at all.";
    default:
      // An unknown key must still say SOMETHING true rather than print a raw key at a prospect.
      return ev || String(sig.key).replace(/_/g, ' ');
  }
}

function findingSentences(findings) {
  const f = findings || {};
  if (f.unscannable) {
    return ['We could not load this site to check it — the server blocked us, so nothing here has been assessed.'];
  }
  if (f.no_website) {
    return ['They have no website at all.'];
  }
  return (f.signals || []).map(findingSentence).filter(Boolean);
}

// The "seat may be taken" caution. Deliberately a caution and not an exclusion: a rep decides.
function agencyNote(findings) {
  const sigs = (findings && findings.agency_signals) || [];
  if (!sigs.length) return null;
  const parts = sigs.map(a => a.key === 'reseller_builder'
    ? 'this site was built on a platform that agencies resell, so someone may already be looking after it'
    : 'the web address Google holds carries advertising tracking, so someone may already be running campaigns for them');
  return parts.join('; ');
}

// Google's own number, when the PageSpeed second pass has run. Absent until PAGESPEED_API_KEY.
function pageSpeedNote(findings) {
  const psi = findings && findings.psi;
  if (!psi || typeof psi.mobile_score !== 'number') return null;
  return `Google rates this site ${psi.mobile_score}/100 on mobile.`;
}

// Which bucket a row is in — the four honest states, not one pool. Mirrors how the scorer writes.
function bucketOf(row) {
  const f = (row && row.site_findings) || {};
  if (!row || !row.website) return 'no_website';
  if (f.unscannable) return 'unscannable';
  if (f.reachable === false) return 'dead_site';
  return 'scored';
}
const BUCKET_LABEL = {
  no_website: 'No website',
  unscannable: 'Blocked (not assessed)',
  dead_site: "Site doesn't load",
  scored: 'Scored',
};

const PACKAGE_LABEL = {
  P1: 'P1 · Launch (new site, 4 weeks)',
  P2: 'P2 · Renew (rebuild, 3 weeks)',
  P3: 'P3 · Platform (16 weeks)',
};
const packageLabel = (code) => PACKAGE_LABEL[code] || null;

module.exports = { findingSentence, findingSentences, agencyNote, pageSpeedNote, bucketOf, BUCKET_LABEL, packageLabel, PACKAGE_LABEL, BUILDER_PRETTY };
