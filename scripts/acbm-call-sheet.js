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
// Findings wording lives in ONE place — shared with the acbm-prospects screen so the sheet a rep
// reads and the screen a manager reads never describe the same site differently.
const { findingSentences, agencyNote, pageSpeedNote } = require('../src/lib/agents/prospecting/findings-text');

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
    findingSentences(f).forEach(line => out.push(`- ${line}`));
    const agency = agencyNote(f);
    if (agency) { out.push(''); out.push(`> Careful: ${agency}.`); }
    const psi = pageSpeedNote(f);
    if (psi) { out.push(''); out.push(`> ${psi}`); }
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
