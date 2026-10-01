// ── THE COVERING NOTE that carries the contract ────────────────────────────────
//
// Separate from the route for the same reason contract-template.js is separate from the renderer: this is
// WORDING that goes to a real business, and it has to be reviewable and replaceable without reading
// routing code. Pure — it builds a subject and an HTML body from a contract row and returns them.
//
// SHORT ON PURPOSE. What it is, the price, and please sign and return. The document carries the detail;
// a covering email that restates the terms creates a second version of them, and the moment the two
// disagree the client has grounds to pick whichever suits.
//
// NO OUTCOME CLAIMS and no sales language. This email arrives attached to a contract — it is an
// administrative note, not another pitch, and anything persuasive in it reads as pressure at the exact
// moment somebody is deciding whether to sign.

const { money } = require('./contract-render');

// Only an AUTHORIZED domain works. The Resend key is authorized for adificetechnologies.com and NOT for
// abiozen.com (403: "This API key is not authorized to send emails from abiozen.com"), which is what
// silently lost eight weeks of internal email. A client-facing contract must not be the thing that
// rediscovers that, so the sender is pinned to the domain that works and is overridable by env for when
// abiozen.com is authorized.
const CONTRACT_FROM_ADDRESS = 'naren@adificetechnologies.com';
function contractFrom(env = process.env) {
  return env.SITENEX_CONTRACT_FROM || `Naren Boda <${CONTRACT_FROM_ADDRESS}>`;
}

const esc = (x) => String(x == null ? '' : x)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The price, in one line, from the figures ON THE CONTRACT ROW — the snapshot, never the live deal. The
// email and the attachment must agree, and they can only be guaranteed to if both read the same snapshot.
function priceLine(c) {
  const bits = [];
  if (c.value_cents != null) bits.push(`${money(c.value_cents)} in total`);
  if (c.monthly_cents) bits.push(`${money(c.monthly_cents)} a month thereafter`);
  if (!bits.length) return null;
  return bits.join(', then ');
}

function contractEmail(c) {
  const row = c || {};
  const company = row.client_company || 'your business';
  const name = (row.client_contact || '').trim();
  const first = name ? name.split(/\s+/)[0] : null;
  const price = priceLine(row);
  const pkg = row.package_name || row.package_code || null;

  const subject = `${row.contract_no} — agreement for ${company}`;

  const p = [];
  // A greeting IS included here, unlike the prospecting email: that one is pasted into a partner's own
  // message between their greeting and sign-off, whereas this is a complete email sent by us.
  p.push(first ? `Hi ${esc(first)},` : 'Hello,');
  p.push(`Attached is the agreement for ${esc(company)}${pkg ? `, covering the ${esc(pkg)} package` : ''}`
       + ` — reference <strong>${esc(row.contract_no)}</strong>.`);
  if (price) {
    p.push(`The price is <strong>${esc(price)}</strong>, with the payment stages set out in the document.`);
  } else {
    // Said rather than omitted. An agreement arriving with no price mentioned invites the reply "how
    // much?", and the honest version of that is to say the figures are in the document.
    p.push('The commercial terms are set out in the document.');
  }
  p.push('Please have a read, and if you are happy with it, <strong>sign and return it</strong> to this address. '
       + 'If anything in it is wrong or needs changing, reply and tell me what — nothing is settled until '
       + 'you have signed.');
  p.push('Thanks,<br>Naren');

  const html = '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;'
    + 'line-height:1.5;color:#222;max-width:560px">'
    + p.map(x => `<p style="margin:0 0 12px">${x}</p>`).join('')
    + '</div>';

  return { subject, html, price };
}

module.exports = { contractEmail, priceLine, contractFrom, CONTRACT_FROM_ADDRESS };
