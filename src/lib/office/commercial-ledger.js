// ── ELEVEN KINDS OF MONEY, AND THE REFUSAL TO ADD THEM TOGETHER ─────────────
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
// So the kinds are a CLOSED VOCABULARY, each figure carries what established it, and the only
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
 * Eleven kinds — eight storable, three derived — in the order a deal moves through them. Frozen: a
 * kind added at runtime would be a kind nothing in this module knows how to refuse.
 *
 * It was seven. Requirement 7 of 2026-11-26 split `cost` into three commitment states and `margin`
 * into three named results; the reasons are at each group below.
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

  // ── COST, IN THREE COMMITMENT STATES, BECAUSE THEY ARE NOT THE SAME MONEY ─
  //
  // Owner's requirement 7, 2026-11-26: *"Quoted procurement costs are not incurred expenses.
  // Distinguish projected margin, invoiced margin and realized financial results. Do not suppress
  // legitimate losses merely because revenue is zero."*
  //
  // There was ONE `cost` kind, and it is what made the earlier defect possible. A supplier's quoted
  // $6,200 for unordered work was filed as `cost`, subtracted from an un-invoiced revenue, and
  // reported as margin −$6,200. The repair at the time was to REFUSE that subtraction when revenue
  // was zero — which treated the symptom and introduced a worse fault: it also suppressed the case
  // where costs genuinely were incurred and no revenue ever arrived, which is a real loss and the
  // single figure a CEO most needs not to have hidden.
  //
  // The cause was the kind, not the arithmetic. A quote, an obligation and an expense are three
  // different commitments:
  //
  //   COST_QUOTED     a supplier has named a price. Nobody is owed anything. Not an expense.
  //   COST_COMMITTED  we have placed the order. An OBLIGATION exists; no expense is incurred yet.
  //   COST_INCURRED   the supplier has invoiced us, or we have paid. This is an expense.
  //
  // With these apart, each margin draws on the cost state that belongs to it, a quoted cost cannot
  // reach an invoiced-margin computation at all, and the zero-revenue suppression is unnecessary —
  // so it is gone, and a realized loss is reported as a loss.
  COST_QUOTED: 'cost_quoted',
  COST_COMMITTED: 'cost_committed',
  COST_INCURRED: 'cost_incurred',

  // ── THREE DERIVED FIGURES, NEVER STORED, NEVER NAMED "MARGIN" ALONE ──────
  //
  // "Margin" on its own is the word that let two people read one number two ways, so there is no
  // kind by that name. Each of these states its own two sides:
  //
  //   PROJECTED_MARGIN  quotation − cost_quoted.        What the deal WOULD earn. Nothing happened.
  //   INVOICED_MARGIN   invoiced − cost_incurred.       The accrual view: billed against expensed.
  //   REALIZED_RESULT   payment_received − settled cost. The cash view: collected against paid.
  PROJECTED_MARGIN: 'projected_margin',
  INVOICED_MARGIN: 'invoiced_margin',
  REALIZED_RESULT: 'realized_result',
});

const STORABLE_KINDS = Object.freeze([
  KINDS.OPPORTUNITY_ESTIMATE, KINDS.QUOTATION, KINDS.ORDER,
  KINDS.INVOICED, KINDS.PAYMENT_RECEIVED,
  KINDS.COST_QUOTED, KINDS.COST_COMMITTED, KINDS.COST_INCURRED,
]);

/** Derived on demand from storable facts. Supplying one as a fact is refused. */
const DERIVED_KINDS = Object.freeze([
  KINDS.PROJECTED_MARGIN, KINDS.INVOICED_MARGIN, KINDS.REALIZED_RESULT,
]);

/**
 * Which bases each cost state may carry. This is what makes the mislabel structural rather than a
 * matter of care: a supplier's quote is `counterparty_stated` by nature and an incurred expense is
 * something we recorded or settled, so filing a quote as an incurred cost requires also lying about
 * its basis — and these rules refuse that.
 */
const COST_BASES = Object.freeze({
  [KINDS.COST_QUOTED]: Object.freeze(['counterparty_stated']),
  [KINDS.COST_COMMITTED]: Object.freeze(['recorded', 'counterparty_stated']),
  [KINDS.COST_INCURRED]: Object.freeze(['recorded', 'settled']),
});

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
  if (DERIVED_KINDS.includes(fact.kind)) {
    return `kind '${fact.kind}' is DERIVED and may never be supplied as a fact: a stored margin is `
      + 'a figure whose two sides nobody can check, and the whole point of the three derived names '
      + 'is that each one states what it was computed from';
  }
  if (!STORABLE_KINDS.includes(fact.kind)) {
    return `kind '${fact.kind}' is not one of the ${STORABLE_KINDS.length} storable kinds `
      + `(${STORABLE_KINDS.join(', ')})`;
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
  // A cost state and its basis must agree. See COST_BASES: this is the rule that stops a supplier's
  // quotation being filed as an incurred expense, which is the defect requirement 7 names.
  if (COST_BASES[fact.kind] && !COST_BASES[fact.kind].includes(fact.basis)) {
    return `kind '${fact.kind}' may not carry basis '${fact.basis}' — only `
      + `${COST_BASES[fact.kind].join(' or ')}. A quoted cost is something a counterparty stated; `
      + 'an incurred cost is something we recorded or settled. Filing one as the other is how '
      + 'unordered work came to be reported as a loss.';
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
  if (DERIVED_KINDS.includes(kind)) {
    return Object.freeze({ kind, status: STATUS.UNAVAILABLE, amount: null, currency: null,
      detail: `${kind} is DERIVED and is never a stored figure — use projectedMarginOf(), `
        + 'invoicedMarginOf() or realizedResultOf(), each of which names its two sides' });
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

// ── THE THREE DERIVED FIGURES ───────────────────────────────────────────────
//
// One derivation, three named uses. Each refuses on an unmeasured side and on a currency mismatch,
// and NEITHER of those is the zero-revenue refusal that used to live here.
//
// ── WHAT WAS REMOVED, AND WHY ──────────────────────────────────────────────
//
// There was a rule: if revenue was `measured_zero` and cost was above zero, return `unavailable`
// with "that is a cost awaiting revenue, not a loss". It was written after this module reported
// margin −$6,200 on a deal consisting of one supplier quotation, and it was the wrong repair.
//
// It was wrong because it answered a question about COMMITMENT with a rule about ZERO. The $6,200
// was quoted, not incurred — nobody was owed it — and a quoted cost now cannot reach an invoiced
// margin at all, so the case that rule existed for no longer arises.
//
// And it was harmful, because `measured_zero` revenue against an INCURRED cost is the definition of
// a loss: work done, money spent, nothing billed or nothing collected. Suppressing that is
// suppressing the one number a CEO must not be shielded from. Owner's requirement 7: *"Do not
// suppress legitimate losses merely because revenue is zero."* A negative figure here is now
// returned as `measured`, with its sides named, and `isLoss` set so a reader cannot miss it.
//
// `measured_zero` on BOTH sides is still a zero: no activity, no result.
function deriveFigure(revenueFigure, costFigure, { kind, basis, revenueName, costName, note }) {
  const ok = (f) => f && (f.status === STATUS.MEASURED || f.status === STATUS.MEASURED_ZERO);
  const refuse = (detail) => Object.freeze({ kind, status: STATUS.UNAVAILABLE, amount: null,
    currency: null, basis: null, isLoss: null, detail });

  if (!ok(revenueFigure)) {
    return refuse(`${kind} cannot be derived: ${revenueName} is `
      + `${revenueFigure ? revenueFigure.status : 'absent'} — subtracting a measured cost from an `
      + 'unmeasured revenue produces a number that looks like a result and is not one. This is an '
      + 'absence of data, not a loss: the two must never be reported as the same thing.');
  }
  if (!ok(costFigure)) {
    return refuse(`${kind} cannot be derived: ${costName} is `
      + `${costFigure ? costFigure.status : 'absent'} — an unmeasured cost defaults to no cost, `
      + 'which reports the best possible result on the least possible evidence.');
  }

  // A measured zero carries no currency, which is correct: it is zero in every currency. Only two
  // NON-zero figures in different currencies are a refusal.
  const cr = revenueFigure.currency; const cc = costFigure.currency;
  if (cr && cc && cr !== cc) {
    return refuse(`${kind} cannot be derived across currencies (${cr} vs ${cc}): this module does `
      + 'not convert');
  }

  const cents = Math.round(revenueFigure.amount * 100) - Math.round(costFigure.amount * 100);
  const amount = cents / 100;
  return Object.freeze({
    kind,
    status: STATUS.MEASURED,
    amount,
    currency: cr || cc || null,
    basis,
    // Stated as its own field rather than left for the reader to infer from a sign, because a
    // negative number in a table of positives is easy to skim past and this is the figure that
    // must not be skimmed past.
    isLoss: amount < 0,
    detail: amount < 0
      ? `a LOSS of ${cr || cc || ''} ${Math.abs(amount).toFixed(2)}: ${revenueName} `
        + `${(revenueFigure.amount).toFixed(2)} against ${costName} `
        + `${(costFigure.amount).toFixed(2)}. ${note}`
      : `${revenueName} minus ${costName}. ${note}`,
  });
}

/**
 * What the deal would earn if it happened as quoted. A PROJECTION: both sides are prices, and
 * neither is an event. Negative means we would be underwater at the price we quoted — which is
 * worth knowing BEFORE the order, and is not a loss anybody has taken.
 */
function projectedMarginOf(quotationFigure, quotedCostFigure) {
  return deriveFigure(quotationFigure, quotedCostFigure, {
    kind: KINDS.PROJECTED_MARGIN,
    basis: 'quotation_minus_quoted_cost',
    revenueName: 'quoted revenue',
    costName: 'quoted cost',
    note: 'A PROJECTION on prices, not an outcome: nothing has been ordered, invoiced, expensed or '
      + 'collected. A negative projection is a pricing warning, not a realized loss.',
  });
}

/**
 * The accrual view: revenue billed against expense incurred. This is the figure that is a loss when
 * it is negative — costs are on the books and the billing is not.
 */
function invoicedMarginOf(invoicedFigure, incurredCostFigure) {
  return deriveFigure(invoicedFigure, incurredCostFigure, {
    kind: KINDS.INVOICED_MARGIN,
    basis: 'invoiced_minus_incurred_cost',
    revenueName: 'invoiced revenue',
    costName: 'incurred cost',
    note: 'The ACCRUAL view. Not margin on money received — an invoice nobody has paid is a '
      + 'receivable, and realizedResultOf() is the cash view.',
  });
}

/**
 * The cash view: money collected against money actually paid out. `settled` only — a supplier
 * invoice we have not paid is an incurred expense but not yet cash.
 */
function realizedResultOf(paymentFigure, settledCostFigure) {
  return deriveFigure(paymentFigure, settledCostFigure, {
    kind: KINDS.REALIZED_RESULT,
    basis: 'received_minus_settled_cost',
    revenueName: 'payments received',
    costName: 'settled cost',
    note: 'The CASH view, over settled costs only. A recorded-but-unpaid supplier invoice belongs '
      + 'to invoicedMarginOf(), not here.',
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
  // ── THE SETTLED SUBSET, FILTERED BY BASIS RATHER THAN BY KIND ────────────
  //
  // `realized_result` is the cash view, so its cost side is the SETTLED incurred costs only — a
  // supplier invoice we have recorded but not paid is an expense and not yet cash. Kind alone
  // cannot express that, so the facts are filtered by basis and run through the same figureFor,
  // which keeps the zero rule intact: incurred costs present but none settled, with a readable
  // source, is a measured zero — we have paid nothing — and not a missing figure.
  const settledCost = figureFor(KINDS.COST_INCURRED,
    facts.filter((f) => f && f.basis === 'settled'),
    { sourceReadable: readable[KINDS.COST_INCURRED] });

  figures[KINDS.PROJECTED_MARGIN] = projectedMarginOf(
    figures[KINDS.QUOTATION], figures[KINDS.COST_QUOTED]);
  figures[KINDS.INVOICED_MARGIN] = invoicedMarginOf(
    figures[KINDS.INVOICED], figures[KINDS.COST_INCURRED]);
  figures[KINDS.REALIZED_RESULT] = realizedResultOf(
    figures[KINDS.PAYMENT_RECEIVED], settledCost);

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
  KINDS, STORABLE_KINDS, DERIVED_KINDS, BASES, COST_BASES, STATUS,
  problemWith, figureFor, aggregate,
  // `marginOf` is deliberately NOT exported under that name any more. A caller asking for "the
  // margin" was asking a question with three answers, and the old single function answered the
  // accrual one while being handed, on its first real use, a quoted cost. Each of these states its
  // two sides in its name and in its result's `basis`.
  projectedMarginOf, invoicedMarginOf, realizedResultOf,
};
