// ── ACBM call sheet generator (READ-ONLY; prints Markdown to stdout) ──
//
// Turns scored prospects into something a person can read down a phone line. The findings in
// site_findings are keys and penalties — correct for sorting, useless to say out loud — so this
// translates each one into a plain sentence. Nobody making calls should be reading JSON.
//
// The score itself is deliberately NOT printed next to the business. It is a sorting device; the
// FINDINGS are what gets said. rating_count IS printed, because it is the other half of the
// judgement ("busy shop with a bad site" reads differently from "quiet shop with a bad site")
// and it was kept out of the score precisely so a human could weigh it here.
//
// Run (output is prospect contact data — write it somewhere, do not commit it):
//   railway ssh 'node scripts/acbm-call-sheet.js' > docs/acbm-call-sheet-$(date +%F).md
//   node scripts/acbm-call-sheet.js --subtype funeral --limit 20
//
// Flags: --subtype <key> (default machine_shop) · --limit <n> (default 15) · --package <P1|P2>

const { query } = require('../src/lib/db');

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

// city from the Places address (authoritative), falling back to the tile region (which is only
// "the tile that found it", not where the business is).
function cityOf(address, region) {
  const m = /,\s*([^,]+),\s*[A-Z]{2}\s+\d{5}/.exec(address || '');
  return (m && m[1].trim()) || (region || '').replace(/,\s*(IL|Illinois)$/, '') || 'unknown';
}

// One signal -> one sentence someone can say. Reads the evidence string for the specifics
// (which year the footer says, which jQuery version) so the sentence is concrete.
function sentence(sig) {
  const ev = String(sig.evidence || '');
  switch (sig.key) {
    case 'no_viewport':
      return "The site doesn't resize on a phone — it loads at desktop width, so you have to pinch and drag to read it.";
    case 'legacy_layout': {
      // Speakable main clause, with the technical detail in brackets in case they ask what we saw.
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
      return /no <title> and no meta description/.test(ev)
        ? 'The page has no title and no description, so Google has nothing to show for it in search results.'
        : (/no <title>/.test(ev)
          ? 'The page has no title, so it shows up in search results with a URL instead of a name.'
          : 'The page has no description, so Google writes its own snippet from whatever text it finds.');
    case 'dated_builder': {
      const raw = (/built on (\w+)/.exec(ev) || [])[1] || '';
      const PRETTY = { weebly: 'Weebly', godaddy: 'GoDaddy', frontpage: 'Microsoft FrontPage', duda: 'Duda' };
      const b = PRETTY[raw.toLowerCase()] || raw || 'a DIY builder';
      return raw.toLowerCase() === 'frontpage'
        ? 'The site was made in Microsoft FrontPage, which Microsoft discontinued in 2006.'
        : `It was put together with ${b}'s DIY site builder.`;
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
      return ev || sig.key;
  }
}

(async () => {
  const subtype = arg('subtype', 'machine_shop');
  const limit = Math.max(1, Math.min(200, parseInt(arg('limit', '15'), 10) || 15));
  const pkg = arg('package', 'P2');
  const rows = (await query(
    `SELECT name, address, region, phone, site_url, site_score, rating_count, site_findings
       FROM prospects
      WHERE product='acbm' AND subtype=$1 AND status='qualified' AND recommended_package=$2
        AND site_score IS NOT NULL AND site_findings->>'unscannable' IS NULL
      ORDER BY site_score DESC, rating_count ASC NULLS FIRST
      LIMIT $3`, [subtype, pkg, limit])).rows;

  const today = new Date().toISOString().slice(0, 10);
  const label = subtype.replace(/_/g, ' ');
  const out = [];
  out.push(`# ACBM call sheet — ${label} (${pkg})`);
  out.push('');
  out.push(`${rows.length} businesses · generated ${today} · sorted worst site first`);
  out.push('');
  out.push(`Every one of these has a website with real problems, and none of them shows any sign of`);
  out.push(`already paying an agency. The bullet points are what's wrong with the site, in plain terms —`);
  out.push(`say them, don't read a score. Review count is there so you know whether you're talking to a`);
  out.push(`busy shop or a quiet one.`);
  out.push('');
  out.push('---');

  rows.forEach((r, i) => {
    const f = r.site_findings || {};
    const rev = r.rating_count == null ? 'no reviews yet' : `${r.rating_count} review${r.rating_count === 1 ? '' : 's'}`;
    out.push('');
    out.push(`## ${i + 1}. ${r.name}`);
    out.push('');
    out.push(`**${r.phone || 'no phone listed'}** · ${cityOf(r.address, r.region)} · ${rev}`);
    out.push('');
    out.push(`${r.site_url}`);
    out.push('');
    out.push(`What's wrong with it:`);
    (f.signals || []).forEach(s => out.push(`- ${sentence(s)}`));
    if ((f.agency_signals || []).length) {
      out.push('');
      out.push(`> Careful: ${f.agency_signals.map(a => a.key === 'reseller_builder'
        ? 'this site was built on a platform that agencies resell, so someone may already be looking after it'
        : 'the web address Google holds carries advertising tracking, so someone may already be running campaigns for them').join('; ')}.`);
    }
    if (f.psi && typeof f.psi.mobile_score === 'number') {
      out.push('');
      out.push(`> Google rates this site ${f.psi.mobile_score}/100 on mobile.`);
    }
    out.push('');
    out.push('Who answered: ______________________________________________');
    out.push('');
    out.push('What they said: ____________________________________________');
    out.push('');
    out.push('___________________________________________________________');
    out.push('');
    out.push('Call back: ____________________  Outcome: __________________');
    out.push('');
    out.push('---');
  });

  out.push('');
  out.push(`Packages: P1 = Launch (new site, 4 weeks) · P2 = Renew (rebuild, 3 weeks). Pricing is not set,`);
  out.push(`so quote nothing — take the requirement and say someone will follow up with numbers.`);
  console.log(out.join('\n'));
  process.exit(0);
})().catch(e => { console.error('call sheet error:', e.message); process.exit(1); });
