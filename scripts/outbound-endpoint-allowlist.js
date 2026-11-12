// ── WHAT ANY MODULE MAY ASK OF A MAIL PROVIDER ──────────────────────────────
//
// CEO decision 2026-11-12, Milestone 1. One declared table of approved
// (method, endpoint template) pairs with typed placeholders. Everything else is a violation.
//
// ── WHY A TEMPLATE ALLOWLIST AND NOT A FORBIDDEN-PATH LIST ──────────────────
//
// The first design forbade dynamic paths outright: every provider-REST call site had to pass a
// string literal. That was withdrawn, and the objection was right — `/messages/{id}/modify` and
// `/drafts/{id}` are legitimate and necessary, and a control that blocks the work it governs is a
// control somebody switches off. After that nothing is enforced.
//
// A forbidden list is also the wrong shape for the same reason a hand-written sender list was: it
// is a claim about the code that was true when it was written. `/messages/send` and
// `/drafts/{id}/send` are the send endpoints TODAY. The allowlist does not have to be revised when
// Google adds a seventh way to transmit.
//
// ── THIS FILE IS THE ONLY COPY ──────────────────────────────────────────────
//
// check-email-transport-coverage.js reads it. In Milestone 2 the runtime helper reads the same
// export and refuses a resolved path that does not match. Two copies of a security table drift,
// and the drift is silent until the day they disagree about something that matters.

'use strict';

const crypto = require('crypto');

/**
 * Hosts that are mail providers. A file naming one is treated as a provider client and its
 * endpoint expressions are classified.
 */
const PROVIDER_BASES = Object.freeze([
  { key: 'gmail-rest', host: 'gmail.googleapis.com', label: 'Gmail REST' },
  { key: 'resend-rest', host: 'api.resend.com', label: 'Resend REST' },
]);

/**
 * The approved shapes. `{id}` is a placeholder for one path segment.
 *
 * Read the absences as deliberately as the entries: there is no POST /messages/{id} — only GET —
 * so `'/messages/' + verb` cannot be approved whatever `verb` holds. Method is part of the key and
 * that does real work.
 */
// ── `modules` IS PART OF THE PERMISSION, NOT DOCUMENTATION ──────────────────
//
// An endpoint is approved for the modules named here and for no others. Drafting into the sales
// mailbox is the triage cron's job under the owner decision of 2026-11-09; it is not a capability
// every future agent inherits because one module was granted it.
//
// Without this axis the allowlist answers "may anything do this?", which is a weaker question than
// the one that matters. A new agent calling POST /drafts would have been approved by a table that
// was written for a different module entirely.
const TRIAGE = 'src/lib/agents/inquiry-triage.js';

const ALLOWLIST = Object.freeze([
  { provider: 'gmail-rest', method: 'GET', template: '/messages', modules: [TRIAGE], note: 'list' },
  { provider: 'gmail-rest', method: 'GET', template: '/messages/{id}', modules: [TRIAGE], note: 'read one' },
  { provider: 'gmail-rest', method: 'POST', template: '/messages/{id}/modify', modules: [TRIAGE], note: 'labels on a message' },
  { provider: 'gmail-rest', method: 'GET', template: '/labels', modules: [TRIAGE], note: 'list labels' },
  { provider: 'gmail-rest', method: 'POST', template: '/labels', modules: [TRIAGE], note: 'create a label' },
  { provider: 'gmail-rest', method: 'GET', template: '/threads/{id}', modules: [TRIAGE], note: 'read a thread' },
  { provider: 'gmail-rest', method: 'POST', template: '/drafts', modules: [TRIAGE], note: 'create a draft' },
  { provider: 'gmail-rest', method: 'GET', template: '/drafts/{id}', modules: [TRIAGE], note: 'read a draft' },
  { provider: 'gmail-rest', method: 'PUT', template: '/drafts/{id}', modules: [TRIAGE], note: 'update a draft' },
]);

/**
 * Segments that must never appear where a placeholder is expected.
 *
 * This is the list the Milestone 2 runtime helper checks a RESOLVED placeholder against. It is
 * declared here, now, because the static leg cannot use it — `/messages/{}` and `/messages/send`
 * are the same skeleton when the segment is computed, and only the runtime sees which one it got.
 *
 * Exported unused by Milestone 1 on purpose: the table is the shared artifact, and the milestone
 * boundary is about who reads it, not about where it lives.
 */
const RESERVED_SEGMENTS = Object.freeze([
  'send', 'import', 'insert', 'trash', 'untrash', 'delete',
  'batchModify', 'batchDelete', 'stop', 'watch',
]);

const PLACEHOLDER = '{}';

/**
 * Reduce a raw first-argument expression to a comparable skeleton.
 *
 * Literals keep their text; interpolations become `{}`; the query string is dropped, because
 * `?format=full` is not part of the endpoint's identity and every caller spells it differently.
 *
 * Returns { skeleton, classifiable }. **`classifiable: false` is a VIOLATION, never an implicit
 * approval** — a scanner that shrugs at what it cannot read grants permission by silence, which is
 * the defect class this repository has now hit four times.
 */
function skeletonOf(rawExpr) {
  const expr = String(rawExpr == null ? '' : rawExpr).trim();
  if (!expr) return { skeleton: null, classifiable: false, reason: 'empty expression' };

  const quote = expr[0];
  const closes = expr[expr.length - 1];

  // A plain string literal: '/labels'
  if ((quote === "'" || quote === '"') && closes === quote && expr.length >= 2) {
    const body = expr.slice(1, -1);
    if (body.includes('\\')) {
      return { skeleton: null, classifiable: false, reason: 'escaped characters in the path' };
    }
    return { skeleton: stripQuery(body), classifiable: true };
  }

  // A template literal: `/messages/${id}/modify`
  if (quote === '`' && closes === '`' && expr.length >= 2) {
    const body = expr.slice(1, -1);
    // Replace every ${...} — including nested braces — with one placeholder.
    let out = '';
    let i = 0;
    while (i < body.length) {
      if (body[i] === '$' && body[i + 1] === '{') {
        let depth = 1;
        let j = i + 2;
        while (j < body.length && depth > 0) {
          if (body[j] === '{') depth += 1;
          else if (body[j] === '}') depth -= 1;
          j += 1;
        }
        if (depth !== 0) {
          return { skeleton: null, classifiable: false, reason: 'unbalanced interpolation' };
        }
        out += PLACEHOLDER;
        i = j;
        continue;
      }
      out += body[i];
      i += 1;
    }
    return { skeleton: stripQuery(out), classifiable: true };
  }

  // Anything else — a bare identifier, a concatenation, a call — cannot be reduced.
  return {
    skeleton: null,
    classifiable: false,
    reason: `not a literal or template (${expr.length > 48 ? `${expr.slice(0, 48)}…` : expr})`,
  };
}

/** Drop `?...`. The query is not part of the endpoint's identity. */
function stripQuery(p) {
  const q = p.indexOf('?');
  return q === -1 ? p : p.slice(0, q);
}

/** The allowlist form of a template: `/messages/{id}/modify` → `/messages/{}/modify`. */
function normaliseTemplate(template) {
  return template.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, PLACEHOLDER);
}

/**
 * The approved entry for a (provider, method, skeleton), or null.
 * A null return from a CLASSIFIABLE skeleton is a violation; from an unclassifiable one it is the
 * same violation reached a different way. Both fail.
 */
function matchEndpoint({ provider, method, skeleton, file = null }) {
  if (skeleton == null) return null;
  const m = String(method || 'GET').toUpperCase();
  const shape = ALLOWLIST.find((e) => e.provider === provider
    && e.method === m
    && normaliseTemplate(e.template) === shapeKey(skeleton));
  if (!shape) return null;
  // THE MODULE AXIS. A shape approved for one module is not approved for another; `file: null`
  // asks only "is this shape in the table at all", which the unit tests use and the scanner
  // never does.
  if (file !== null && !shape.modules.includes(file)) return null;
  return shape;
}

/** Identity shim so a skeleton and a normalised template are compared in one place. */
function shapeKey(skeleton) { return skeleton; }

/** Why a classifiable skeleton was refused: an unknown shape, or a shape this module may not use. */
function refusalReason({ provider, method, skeleton, file }) {
  if (skeleton == null) return 'unclassifiable';
  if (matchEndpoint({ provider, method, skeleton })) return 'module-not-permitted';
  return 'shape-not-in-allowlist';
}

/**
 * A call site's identity, stable across unrelated edits.
 *
 * Keyed on path + enclosing function + the normalised call expression. A line number is NOT part
 * of it: adding a comment above a baselined violation would otherwise invalidate its entry and
 * force a baseline edit, which is exactly the routine churn that teaches people to re-accept a
 * baseline without reading it.
 *
 * Moving the call to a different function DOES change the fingerprint, and should: it is no longer
 * the same site.
 */
function fingerprint({ file, enclosing, expression }) {
  // Whitespace is REMOVED, not collapsed. Collapsing left `gapi( '/labels' )` and
  // `gapi('/labels')` with different hashes, so reformatting a line would have invalidated its
  // baseline entry — the routine churn that teaches people to re-accept a baseline unread.
  // Whitespace is never semantic in a call expression, so none of it belongs in the identity.
  const norm = String(expression).replace(/\s+/g, '');
  return crypto.createHash('sha256')
    .update(`${file}\0${enclosing || '(top level)'}\0${norm}`)
    .digest('hex')
    .slice(0, 32);
}

module.exports = {
  ALLOWLIST,
  PROVIDER_BASES,
  RESERVED_SEGMENTS,
  PLACEHOLDER,
  skeletonOf,
  stripQuery,
  normaliseTemplate,
  matchEndpoint,
  refusalReason,
  fingerprint,
};
