// ── SEVEN KINDS OF MONEY, AND THE REFUSAL TO ADD THEM TOGETHER ──────────────
//
// Owner's Priority 7, 2026-11-26: *"Distinguish estimated opportunity value, quotation value,
// actual orders, invoiced revenue, received payments, costs and margin."*
//
// ── WHY A MODULE AND NOT A QUERY ───────────────────────────────────────────
//
// Because the defect this prevents is not a wrong number, it is a number of the wrong KIND. The
// tracker already records one instance: *"A PO is not recognised revenue"*, written against B5.5
// because `metrics-snapshot` sums `orders` into the figure the CEO briefing quotes as revenue. A
// purchase order is a promise; an invoice is a claim; a payment is money. Three different facts
// about three different moments, and a dashboard that adds them reports a company that is three
// times better off than it is.
//
// So the seven kinds are a CLOSED VOCABULARY, each figure carries what established it, and the one
// arithmetic this module performs across kinds is margin — which is named, derived on demand, and
// refuses rather than guessing when either side is unmeasured.
//
// ── WHAT IT REFUSES, WHICH IS THE PRODUCT ──────────────────────────────────
//
//   · **Adding two kinds.** There is no `total`. `aggregate()` returns a figure PER KIND and no
//     sum across them, because no sum across them means anything.
//   · **A quotation counted as an order.** A supplier's price for work not yet ordered.
//   · **An order counted as revenue.** B5.5's rule, enforced rather than written down.
//   · **An invoice counted as a payment.** Invoiced revenue that nobody has paid is a receivable,
//     and a company can fail while that figure rises.
//   · **Mixing currencies.** Refused, never converted: a rate is a fact about a moment that this
//     module does not have and must not invent.
//   · **An estimate reported as a measurement.** An opportunity estimate is somebody's guess about
//     a deal that does not exist yet. It is carried with `basis: 'estimate'` and its status can
//     never be `measured`.
//
// ── READ-ONLY, AND MODEL-FREE, BOTH BY SHAPE ───────────────────────────────
//
// It contains no SQL and reaches no provider: facts are passed in, already read by whichever
// authorized accessor owns them, exactly as `operational-facts.js` does. A commercial ledger with
// its own queries would be a second copy of the company filter, and one that could reach a model
// would be a place where a generated number could become a financial fact.
//
// The four data states are DELIBERATELY the same four as `operational-facts.js`
// (`measured` / `measured_zero` / `missing` / `unavailable`), because an operator should not have
// to learn two vocabularies for "we do not know", and a second vocabulary is a second place for a
// fifth reading of zero to be invented.

'use strict';

/**
 * The seven kinds, in the order a deal moves through them. Frozen: a kind added at runtime would
 * be a kind nothing in this module knows how to refuse.
 */
const KINDS = Object.freeze({
  // Somebody's guess at what a deal might be worth. NOT a measurement, ever.
  OPPORTUNITY_ESTIMATE: 'opportunity_estimate',
  // A supplier's or our own stated price for work not yet ordered.
  QUOTATION: 'quotation',
  // A placed order. A promise, with a counterparty — and not revenue.
  ORDER: 'order',
  // Invoiced revenue: a claim issued. A receivable, not money.
  INVOICED: 'invoiced',
  // Money actually received.
  PAYMENT_RECEIVED: 'payment_received',
  // What it cost us — procurement, fulfilment, fees.
  COST: 'cost',
  // DERIVED ONLY. Never a stored fact; see `marginOf`.
  MARGIN: 'margin',
});

const STORABLE_KINDS = Object.freeze([
  KINDS.OPPORTUNITY_ESTIMATE, KINDS.QUOTATION, KINDS.ORDER,
  KINDS.INVOICED, KINDS.PAYMENT_RECEIVED, KINDS.COST,
]);

/** What established a figure. `estimate` can never become `measured`. */
const BASES = Object.freeze(['estimate', 'counterparty_stated', 'recorded', 'settled']);

/** The same four states as operational-facts.js, on purpose. */
const STATUS = Object.freeze({
  MEASURED: 'measured',
  MEASURED_ZERO: 'measured_zero',
  MISSING: 'missing',
  UNAVAILABLE: 'unavailable',
  ESTIMATED: 'estimated',       // the fifth, and it exists ONLY for opportunity estimates
});

/**
 * Is this a well-formed fact of a storable kind?
 *
 * Returns `null` when fine, or a reason. Deliberately strict about the things that would let a
 * figure of one kind be read as another: the kind, the currency and the basis are all required,
 * because a figure with no basis is a figure whose reliability nobody can judge.
 */
function problemWith(fact) {
  if (!fact || typeof fact !== 'object') return 'a fact must be an object';
  if (!STORABLE_KINDS.includes(fact.kind)) {
    return `kind '${fact.kind}' is not one of the six storable kinds `
      + `(${STORABLE_KINDS.join(', ')}); margin is DERIVED and may never be supplied as a fact`;
  }
  if (typeof fact.amount !== 'number' || !Number.isFinite(fact.amount)) {
    return 'amount must be a finite number';
  }
  if (fact.amount < 0) {
    return 'amount must not be negative: a refund or a credit is its own fact with its own sign '
      + 'convention, and silently allowing a negative here would let one kind cancel another';
  }
  if (typeof fact.currency !== 'string' || !/^[A-Z]{3}$/.test(fact.currency)) {
    return 'currency must be a three-letter ISO code: this module refuses to convert, so a figure '
      + 'with no currency cannot be aggregated with anything';
  }
  if (!BASES.includes(fact.basis)) {
    return `basis must be one of ${BASES.join(', ')} — a figure with no stated basis is a figure `
      + 'whose reliability nobody can judge';
  }
  if (!fact.source || typeof fact.source !== 'string') {
    return 'source must name what established this figure (a quotation id, an order id, an '
      + 'invoice number, a payment reference)';
  }
  // An opportunity estimate must declare itself an estimate, and nothing else may.
  if (fact.kind === KINDS.OPPORTUNITY_ESTIMATE && fact.basis !== 'estimate') {
    return 'an opportunity estimate must carry basis "estimate": it is a guess about a deal that '
      + 'does not exist yet, and recording it as anything else is how a pipeline figure becomes a '
      + 'revenue figure';
  }
  if (fact.kind !== KINDS.OPPORTUNITY_ESTIMATE && fact.basis === 'estimate') {
    return `kind '${fact.kind}' may not carry basis "estimate": only an opportunity estimate is a `
      + 'guess, and labelling a quotation or an order as one would make the distinction useless '
      + 'in the other direction';
  }
  return null;
}

/**
 * One kind's figure, from the facts of that kind.
 *
 * ── THE ZERO RULE, CARRIED OVER FROM B3.19 ─────────────────────────────────
 *
 * No facts is NOT zero unless the caller can say the source was readable and genuinely empty.
 * `sourceReadable: false` means `unavailable`; readable with nothing in it means `measured_zero`;
 * and `sourceReadable` left undefined means `missing`, because "I did not ask" and "I asked and
 * there was nothing" are the two things this whole vocabulary exists to tell apart.
 */
function figureFor(kind, facts, { sourceReadable = undefined } = {}) {
  if (kind === KINDS.MARGIN) {
    return Object.freeze({ kind, status: STATUS.UNAVAILABLE, amount: null, currency: null,
      detail: 'margin is DERIVED and is never a stored figure — use marginOf()' });
  }
  if (!STORABLE_KINDS.includes(kind)) {
    return Object.freeze({ kind, status: STATUS.UNAVAILABLE, amount: null, currency: null,
      detail: `'${kind}' is not a kind this ledger knows` });
  }

  if (sourceReadable === false) {
    return Object.freeze({ kind, status: STATUS.UNAVAILABLE, amount: null, currency: null,
      count: null,
      detail: `the source of ${kind} could not be read, so this figure is UNKNOWN — which is not `
        + 'the same as zero, and reporting it as zero is how a dashboard claims a company has no '
        + 'costs' });
  }

  const mine = (facts || []).filter((f) => f && f.kind === kind);
  const bad = mine.map(problemWith).find((p) => p);
  if (bad) {
    return Object.freeze({ kind, status: STATUS.UNAVAILABLE, amount: null, currency: null,
      count: null, detail: `a ${kind} fact is malformed and the whole figure is refused: ${bad}` });
  }

  if (!mine.length) {
    return Object.freeze({
      kind,
      status: sourceReadable === true ? STATUS.MEASURED_ZERO : STATUS.MISSING,
      amount: sourceReadable === true ? 0 : null,
      currency: null, count: 0,
      detail: sourceReadable === true
        ? `the source was readable and holds no ${kind}: a measured zero`
        : `no ${kind} facts were supplied and the caller did not say whether the source was `
          + 'readable, so this is MISSING rather than zero',
    });
  }

  // ── CURRENCIES ARE NOT CONVERTED ────────────────────────────────────────
  const currencies = [...new Set(mine.map((f) => f.currency))];
  if (currencies.length > 1) {
    return Object.freeze({ kind, status: STATUS.UNAVAILABLE, amount: null, currency: null,
      count: mine.length,
      detail: `${kind} facts are in ${currencies.length} currencies (${currencies.join(', ')}) and `
        + 'this module refuses to convert: an exchange rate is a fact about a moment that it does '
        + 'not have, and inventing one would put a made-up number inside a financial figure' });
  }

  // Cents, so repeated addition of two-decimal money cannot drift.
  const cents = mine.reduce((a, f) => a + Math.round(f.amount * 100), 0);
  const estimated = kind === KINDS.OPPORTUNITY_ESTIMATE;

  return Object.freeze({
    kind,
    // An estimate is NEVER `measured`, however many of them there are and however readable the
    // source was. That is the whole point of carrying the basis.
    status: estimated ? STATUS.ESTIMATED : STATUS.MEASURED,
    amount: cents / 100,
    currency: currencies[0],
    count: mine.length,
    bases: Object.freeze([...new Set(mine.map((f) => f.basis))].sort()),
    sources: Object.freeze(mine.map((f) => f.source)),
    detail: estimated
      ? `${mine.length} opportunity estimate(s) totalling ${currencies[0]} ${(cents / 100).toFixed(2)} `
        + '— a PIPELINE figure about deals that do not exist yet, not revenue and not a forecast'
      : null,
  });
}

/**
 * Margin, derived, and only when both sides are genuinely measured.
 *
 * ── WHY IT REFUSES SO READILY ──────────────────────────────────────────────
 *
 * Margin is the figure a CEO acts on, and it is the one most easily made up: subtract a cost you
 * have not measured from a revenue you have not received and the answer looks like a number. So:
 *
 *   · invoiced must be `measured` or `measured_zero` — not estimated, not missing, not unavailable
 *   · cost must be the same
 *   · both in the SAME currency
 *
 * and anything else returns `unavailable` naming which side failed. Note the base is INVOICED, not
 * payments received: margin on money collected is a different and also useful figure, and calling
 * either one "margin" without saying which is how two people read one number two ways. The base is
 * stated in the result.
 */
function marginOf(invoicedFigure, costFigure) {
  const ok = (f) => f && (f.status === STATUS.MEASURED || f.status === STATUS.MEASURED_ZERO);

  if (!ok(invoicedFigure)) {
    return Object.freeze({ kind: KINDS.MARGIN, status: STATUS.UNAVAILABLE, amount: null,
      currency: null, basis: null,
      detail: `margin cannot be derived: invoiced revenue is ${invoicedFigure ? invoicedFigure.status : 'absent'}`
        + ' — subtracting a measured cost from an unmeasured revenue produces a number that looks '
        + 'like margin and is not one' });
  }
  if (!ok(costFigure)) {
    return Object.freeze({ kind: KINDS.MARGIN, status: STATUS.UNAVAILABLE, amount: null,
      currency: null, basis: null,
      detail: `margin cannot be derived: cost is ${costFigure ? costFigure.status : 'absent'} — and `
        + 'an unmeasured cost defaults to no cost, which reports the best possible margin on the '
        + 'least possible evidence' });
  }

  // ── A MEASURED-ZERO REVENUE AGAINST A REAL COST IS NOT A MARGIN ─────────
  //
  // Found by `check-synthetic-commercial-workflow-db.js` on its first run, which is why that
  // assertion was written: the synthetic deal had $6,200 of quoted procurement cost and nothing
  // invoiced, and this function happily returned **margin −$6,200**. Arithmetically true and
  // commercially meaningless — the deal has not happened, so there is no loss on it, and a
  // pipeline full of quoted-but-unordered work would report an enormous one.
  //
  // Both sides zero IS a margin of zero, and that is honest: no activity, no margin. What is
  // refused is the asymmetric case, and the refusal points at the figure that already says the
  // true thing — the cost figure itself.
  if (invoicedFigure.amount === 0 && costFigure.amount > 0) {
    return Object.freeze({ kind: KINDS.MARGIN, status: STATUS.UNAVAILABLE, amount: null,
      currency: null, basis: null,
      detail: `margin cannot be derived: nothing has been invoiced and ${costFigure.currency || ''} `
        + `${costFigure.amount.toFixed(2)} of cost is recorded. That is a cost awaiting revenue, `
        + 'not a loss — the deal has not happened. Read the cost figure, which says exactly that, '
        + 'and do not read a negative margin on work nobody has billed for' });
  }

  // A measured zero has no currency, which is correct — it is zero in every currency. Only a
  // mismatch between two NON-zero figures is a refusal.
  const ci = invoicedFigure.currency; const cc = costFigure.currency;
  if (ci && cc && ci !== cc) {
    return Object.freeze({ kind: KINDS.MARGIN, status: STATUS.UNAVAILABLE, amount: null,
      currency: null, basis: null,
      detail: `margin cannot be derived across currencies (${ci} vs ${cc}): this module does not `
        + 'convert' });
  }

  const cents = Math.round(invoicedFigure.amount * 100) - Math.round(costFigure.amount * 100);
  return Object.freeze({
    kind: KINDS.MARGIN,
    status: STATUS.MEASURED,
    amount: cents / 100,
    currency: ci || cc || null,
    // NAMED, because margin-on-invoiced and margin-on-collected are different figures and a
    // reader must never have to guess which one they are looking at.
    basis: 'invoiced_minus_cost',
    detail: 'invoiced revenue minus measured cost. NOT margin on money received — '
      + 'payment_received is a separate figure, and an invoice nobody has paid is a receivable',
  });
}

/**
 * Every kind at once, with no total.
 *
 * `readable` says, per kind, whether its source was readable — which is what lets a zero be a
 * measured zero. A kind absent from `readable` is `missing`, deliberately.
 */
function aggregate({ facts = [], readable = {} } = {}) {
  const figures = {};
  for (const kind of STORABLE_KINDS) {
    figures[kind] = figureFor(kind, facts, { sourceReadable: readable[kind] });
  }
  figures[KINDS.MARGIN] = marginOf(figures[KINDS.INVOICED], figures[KINDS.COST]);

  // ── THERE IS NO `total`, AND THAT IS THE POINT ──────────────────────────
  //
  // A sum across these kinds would double- and triple-count the same commercial event: a deal
  // appears as an estimate, then a quotation, then an order, then an invoice, then a payment. Any
  // total over them answers a question nobody asked with a number nobody can use, and the tracker
  // already records what that costs — `metrics-snapshot` sums orders into the figure the CEO
  // briefing calls revenue.
  return Object.freeze({
    figures: Object.freeze(figures),
    // The pipeline stage each figure belongs to, so a reader can see that these are five views of
    // one deal's life rather than five independent quantities.
    sequence: Object.freeze([...STORABLE_KINDS]),
    noTotal: 'deliberately absent: these kinds describe one commercial event at different moments, '
      + 'so a sum over them counts the same deal several times',
  });
}

module.exports = {
  KINDS, STORABLE_KINDS, BASES, STATUS,
  problemWith, figureFor, marginOf, aggregate,
};
