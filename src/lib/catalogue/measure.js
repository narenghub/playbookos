// ── COUNTING SUPPLIER EVIDENCE WITHOUT OVERSTATING IT ───────────────────────
//
// `cphi-catalogue-extract.js` printed:
//
//     508 product row(s) from 19 supplier(s)
//
// Nine suppliers had contributed all 508. The other ten replied, their threads were read, and they
// contributed nothing — scans, screenshots, a .doc, or a prose reply with no list. The number came
// from the length of the query that selected threads to EXAMINE, so it measured the attempt and
// read as coverage. On its way to a board update that is supplier onboarding overstated twofold.
//
// The counts live here, as pure functions over plain data, because a measurement that cannot be
// tested is a measurement nobody can trust twice. The fixtures in measure.test.js include the real
// Sinopep duplicate and the real 19-against-9 shape.
//
// ── NINE LEVELS, AND NONE IS A PROXY FOR ANOTHER ───────────────────────────
//
// The levels descend from "we looked" to "a buyer can order it", and almost all of the loss happens
// in the middle. Collapsing any two of them is how 508 rows came to sound like a catalogue.
'use strict';

const crypto = require('crypto');

const normText = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const normName = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── DOCUMENT IDENTITY ──────────────────────────────────────────────────────
//
// Sinopep sent `Brochure_3.12.2026_Generic_APIs_Sinopep.pdf` and
// `Brochure_Generic_APIs_--Sinopep 2026.pdf`: both 24 pages, both 37,094 characters, both 26
// products. One document, two names, counted twice at every level.
//
// Filename cannot settle it, because these differ. Bytes cannot either: a PDF re-exported or a
// workbook re-saved has different bytes and identical content, and that is the common case when a
// supplier attaches "the latest version". Identity is therefore the hash of the EXTRACTED CONTENT —
// what the parser actually read — with whitespace normalised, since a re-export routinely changes
// line breaks without changing a word.
//
// Duplicates are RECORDED, NEVER REMOVED. The supplier did send the second file; deleting it would
// lose that fact, and the original evidence is the thing a reviewer checks a disposition against.
// It is marked `duplicate_of` and excluded from the distinct count — two different operations.
function makeDocRegistry() {
  const docs = [];
  const firstByContent = new Map();

  function register({ supplier, filename, content, buf, extent }) {
    const content_sha256 = sha256(normText(content));
    const prior = firstByContent.get(content_sha256);
    const doc = {
      index: docs.length,
      supplier,
      filename,
      extent: extent || null,
      bytes: buf ? buf.length : null,
      bytes_sha256: buf ? sha256(buf) : null,
      content_sha256,
      duplicate_of: prior ? prior.filename : null,
      duplicate_of_index: prior ? prior.index : null,
    };
    if (!prior) firstByContent.set(content_sha256, doc);
    docs.push(doc);
    return doc;
  }

  return { docs, register };
}

// ── THE LADDER ─────────────────────────────────────────────────────────────
//
// `threads` are the supplier threads selected for reading. `rows` are extracted product rows, each
// carrying `supplier`, `name`, `cas`, `confidence` and `duplicate_of_file`.
//
// identity_verified is deliberately strict: a checksum-valid CAS printed ON THE SAME LINE as the
// name. Not a CAS nearby, not a name matched against a dictionary, not a name taken from the line
// above. Those are the inferences that pair row 12's name with row 13's number, and on a pharma
// listing that is not a typo — it is a different molecule, discovered by the buyer who ordered it.
//
// commercially_cleared is 0 unless something has actually cleared a molecule for a jurisdiction. A
// DMF filing is evidence a manufacturer intends commercial supply; it is not freedom to operate,
// which is a legal question about one molecule, one territory and one date. published is 0 because
// nothing here writes to the marketplace.
// `docs` is the document registry. `suppliersWithCatalogue` is the set of suppliers who ATTACHED
// something that could be a product list, readable or not — the level between "replied" and
// "parseable", and the one whose absence let fifteen catalogues sound like nine.
function ladder({
  threads = [], rows = [], docs = [], suppliersWithCatalogue = null,
  normalizeCompany = normName, cleared = 0, published = 0,
} = {}) {
  const notDup = rows.filter((r) => !r.duplicate_of_file);
  const distinct = new Set(notDup.map(
    (r) => `${normalizeCompany(r.supplier)}|${normName(r.name)}|${r.cas || ''}`));
  const verified = notDup.filter((r) => r.cas && r.confidence === 'high');
  const parseable = new Set(rows.map((r) => normalizeCompany(r.supplier)));
  // Fall back to the parseable set only when the caller does not know who attached something. It is
  // a floor, never an estimate: a supplier whose file could be read certainly sent one.
  const withCatalogue = suppliersWithCatalogue === null
    ? parseable.size
    : (suppliersWithCatalogue instanceof Set ? suppliersWithCatalogue.size : suppliersWithCatalogue);

  return [
    ['supplier threads examined', threads.length],
    ['suppliers who replied', new Set(threads.map((t) => normalizeCompany(t.company))).size],
    ['suppliers who sent a catalogue', withCatalogue],
    ['suppliers with a MACHINE-READABLE catalogue', parseable.size],
    ['source documents received', docs.length],
    ['distinct source documents', docs.filter((d) => !d.duplicate_of).length],
    ['extracted candidate rows', rows.length],
    ['duplicate rows (identical document content)', rows.length - notDup.length],
    ['distinct candidate products', distinct.size],
    ['identity-verified (same-line checksum CAS)', verified.length],
    ['commercially qualified products', cleared],
    ['published marketplace products', published],
  ];
}

const ladderKey = (label) => label.replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_|_$/g, '');

// ── IS THIS NESTED FILE THE SAME AS ONE ATTACHED BESIDE IT? ─────────────────
//
// Rakesh forwarded an August message to Palash whose attachment is `Abiozen - Samples -
// Revised.xlsx`, and attached a file of that same name and the same 17 KB to the covering message.
// Whether the August list is a version we have never parsed, or simply the same file again, is
// decided by the digest and by nothing else.
//
// The first attempt compared inside the read loop, which is wrong by construction: the `.eml` is
// opened before the covering message's own attachments have been collected, so the lookup searched
// a list the match was not in yet. It printed "NOT seen elsewhere in this thread" for two files
// whose digests were visibly identical three lines apart, and only the printed digests contradicted
// it. Resolution therefore happens ONCE, over the complete set.
function linkIdenticalAttachments(attachments) {
  const byDigest = new Map();
  for (const a of attachments || []) {
    if (!a || !a.sha256) continue;
    if (!byDigest.has(a.sha256)) byDigest.set(a.sha256, []);
    byDigest.get(a.sha256).push(a.filename);
  }
  for (const a of attachments || []) {
    if (!a || !a.nested || !a.nested.ok) continue;
    for (const q of a.nested.attachments || []) {
      // "Elsewhere" excludes the container the nested file came out of — a file is not a duplicate
      // of the envelope that carried it.
      const elsewhere = (byDigest.get(q.sha256) || []).filter((f) => f !== a.filename);
      q.identical_to = elsewhere.length ? elsewhere[0] : null;
    }
  }
  return attachments;
}

module.exports = { makeDocRegistry, ladder, ladderKey, linkIdenticalAttachments, normName, normText, sha256 };
