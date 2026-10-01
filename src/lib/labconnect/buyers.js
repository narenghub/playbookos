// ── WHO NEEDS OUTSOURCED QC TESTING ───────────────────────────────────────────
//
// The LabConnect Agent has to find customers. This module decides who they are, and the useful part
// is that the answer is already in the database.
//
// ── THE SIGNAL ────────────────────────────────────────────────────────────────
//
// `fda_establishments.operations` is a semicolon-joined list of what each registered site is
// licensed to do: MANUFACTURE, PACK, LABEL, STERILIZE, ANALYSIS, and so on. The supply side of
// LabConnect is every site whose operations include ANALYSIS — it has a testing laboratory.
//
// THE DEMAND SIDE IS THE COMPLEMENT. A site registered to MANUFACTURE (or pack, or sterilize) and
// NOT registered for ANALYSIS has no in-house analytical laboratory on that registration, and every
// batch it releases still needs testing. It is buying that testing from somebody today.
//
// That is the sharpest buyer signal available without acquiring any new data, and it comes from the
// same table as the labs. It is a signal and not a certainty, and the ways it can be wrong are worth
// stating because the agent's first email depends on them:
//
//   • A FIRM MAY HAVE A LAB AT ANOTHER SITE. Registration is per site. A company with a plant in New
//     Jersey and a laboratory in Pennsylvania appears here as an outsourcer and is not one. This is
//     the main false positive, so `siblingAnalysisSql` detects it by the normalized firm name and it
//     is reported separately rather than silently included.
//   • THEY ALREADY HAVE A PROVIDER. Almost all of them will. That makes this a displacement sale,
//     not a greenfield one — which changes the first email completely, and is why the agent must not
//     open with "do you need testing?".
//   • OPERATIONS CAN BE STALE OR ABSENT. A site with no operations recorded is invisible to both
//     sides of this query. Counted, never guessed at.
//
// Pure SQL fragments and classification, no database handle: the route and the script that use this
// run the query, so the logic can be read and tested without one.

// Operations that mean the site makes or finishes product, and therefore has batches to release.
// Deliberately broad — a packager and a sterilizer both have release testing obligations — and
// deliberately NOT including 'ANALYSIS', which is the thing whose absence defines this list.
const MAKER_TOKENS = ['MANUFACTURE', 'API MANUFACTURE', 'PACK', 'REPACK', 'LABEL', 'RELABEL', 'STERILIZE'];

// The buyer segments the agent targets, with what each one actually needs. These came from the CEO
// directly; the `needs` text is what makes the difference between a mail-merge and a reason to
// reply, so it is data rather than prose in a template.
const SEGMENTS = {
  virtual_pharma: {
    label: 'Virtual / small pharma',
    needs: 'release testing, stability and method transfer with no laboratory of their own',
    gmp: true,
  },
  generic_manufacturer: {
    label: 'Generic manufacturer',
    needs: 'overflow and second-source testing when their own laboratory is at capacity',
    gmp: true,
  },
  cro_cdmo: {
    label: 'CRO / CDMO / CMO',
    needs: 'testing they do not run in-house, under their client’s quality agreement',
    gmp: true,
  },
  compounding_pharmacy: {
    label: 'Compounding pharmacy',
    needs: 'USP 797/800 potency, sterility and endotoxin testing, recurring by regulation',
    gmp: true,
  },
  research_biotech: {
    label: 'Research lab / biotech',
    needs: 'molecule characterisation and non-GMP analytical work',
    gmp: false,
  },
};

/**
 * The WHERE fragment selecting sites that make product but hold no ANALYSIS registration.
 *
 *   const { sql, params } = outsourcerSql(1);
 *   await query(`SELECT ... FROM fda_establishments WHERE ${sql}`, params);
 *
 * `startIndex` is the first bind position, so this composes with other clauses the way
 * territoryScopeSql does.
 */
function outsourcerSql(startIndex = 1) {
  // ILIKE per token rather than a regex: operations is free text with inconsistent spacing, and a
  // regex that works on today's values is a regex that breaks on tomorrow's.
  const parts = [];
  const params = [];
  let i = startIndex;
  for (const token of MAKER_TOKENS) {
    params.push('%' + token + '%');
    parts.push(`operations ILIKE $${i}`);
    i += 1;
  }
  return {
    // Makes something, is NOT registered for analysis, and has operations recorded at all — the
    // third clause matters because `NOT (NULL ILIKE ...)` is NULL, not true, so a row with no
    // operations would drop out silently rather than being counted as unknown.
    sql: `(operations IS NOT NULL AND btrim(operations) <> ''`
       + ` AND (${parts.join(' OR ')})`
       + ` AND operations NOT ILIKE '%ANALYSIS%')`,
    params,
    nextIndex: i,
  };
}

/**
 * Does the same FIRM hold an ANALYSIS registration at any site? The main false positive.
 *
 * Correlated on `firm_normalized`, which is the fold the establishment table already maintains as
 * its DMF join key — so this matches the same way the rest of the system matches firms, rather than
 * inventing a second notion of "the same company".
 */
const SIBLING_ANALYSIS_SQL =
  `EXISTS (SELECT 1 FROM fda_establishments s
            WHERE s.firm_normalized = fda_establishments.firm_normalized
              AND s.id <> fda_establishments.id
              AND s.operations ILIKE '%ANALYSIS%')`;

/**
 * Which segment is this establishment, from what the register says about it?
 *
 * Returns a segment key and the confidence in it, because the agent's opening line depends on it
 * and a wrong guess is worse than an honest 'unknown': addressing a contract manufacturer as a
 * virtual pharma company is the kind of mistake that ends the conversation.
 *
 * The register does not carry a business model, so this reads the signals it does carry and
 * REFUSES to guess when they do not distinguish. 'unknown' is a normal outcome, not a failure.
 */
function segmentFor(row) {
  const name = String((row && row.firm_name) || '').toLowerCase();
  const ops = String((row && row.operations) || '').toUpperCase();

  // Name tokens are weak evidence on their own and strong when the register agrees. A firm called
  // "... CDMO" that manufactures is a CDMO; the word alone in a research institute's name is not.
  const says = (...words) => words.some(w => name.includes(w));

  if (says('compounding', 'pharmacy', 'pharmacies')) {
    return { segment: 'compounding_pharmacy', confidence: 'name' };
  }
  if (says('cdmo', 'cmo', ' cro', 'contract manufact', 'contract develop')) {
    return { segment: 'cro_cdmo', confidence: 'name' };
  }
  if (says('laborator', 'bioscience', 'biosciences', 'research institute', 'university')) {
    // A research organisation that MAKES material is doing development work, not commercial supply.
    return { segment: 'research_biotech', confidence: 'name' };
  }
  if (/API MANUFACTURE/.test(ops) || row.is_api_manufacturer) {
    // An API manufacturer with no analysis registration is a generic-chain supplier outsourcing QC.
    return { segment: 'generic_manufacturer', confidence: 'operations' };
  }
  if (/MANUFACTURE/.test(ops)) {
    return { segment: 'generic_manufacturer', confidence: 'weak' };
  }
  if (/PACK|LABEL|STERILIZE/.test(ops)) {
    // A packager or steriliser is a service provider to somebody else's product, which is the CDMO
    // shape even when the name does not say so.
    return { segment: 'cro_cdmo', confidence: 'weak' };
  }
  return { segment: 'unknown', confidence: 'none' };
}

/** The tests a segment is most likely to need, as catalogue codes. Used to seed a first quote. */
function likelyTests(segment) {
  switch (segment) {
    case 'compounding_pharmacy': return ['potency_797', 'sterility', 'endotoxin'];
    case 'research_biotech': return ['characterisation', 'identification', 'assay_hplc'];
    case 'generic_manufacturer': return ['assay_hplc', 'related_subs', 'dissolution', 'elemental_imp'];
    case 'cro_cdmo': return ['assay_hplc', 'micro_limits', 'water_content'];
    case 'virtual_pharma': return ['assay_hplc', 'related_subs', 'stability_icha'];
    default: return ['assay_hplc'];
  }
}

module.exports = {
  outsourcerSql, SIBLING_ANALYSIS_SQL, segmentFor, likelyTests,
  MAKER_TOKENS, SEGMENTS,
};
