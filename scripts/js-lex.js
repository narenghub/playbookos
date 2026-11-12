// ── WHAT IS CODE, AND WHAT ONLY LOOKS LIKE IT ────────────────────────────────
//
//   const { lex, blankNonCode, blankCommentsOnly } = require('./js-lex');
//
// A security scanner that greps source has to answer one question first: which characters are
// code? A `//` inside 'https://api.resend.com' is not a comment, and `.users.messages.send(`
// inside a test fixture string is not a transmission. Getting that wrong in one direction invents
// violations; getting it wrong in the other HIDES them.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// It was two near-identical character scanners inside check-email-transport-coverage.js, and
// neither understood REGEX LITERALS. src/lib/mailer.js contains one with quotes inside it:
//
//     const m = /not authorized to send emails from ([^"'\s]+)/i.exec(...)
//
// The `"` was read as the start of a string literal, so everything from there to the next `"`
// elsewhere in the file was blanked. On 2026-11-12 that span grew to cover an entire
// `async function sendEmailDetailed(` declaration. The scanner did not fail — it simply could not
// see that function, attributed its provider call to the function above it, and printed
// "all 1 caller(s) gate first" about a function with two callers. One of the two roads to the mail
// provider was never checked and the verdict was PASS.
//
// Worse, measured afterwards: a planted file with an ungated `gmail.users.messages.send` placed
// after a quote-bearing regex produced ZERO discovered call sites. An unauthorized sender was
// invisible to the control whose entire job is finding unauthorized senders.
//
// Three conclusions are built into this file.
//
// FIRST, one lexer, not two — and one LOOP, not several. The file this came from argues at length
// that a single shared decision function is what stops two transports drifting apart; it then
// carried two copies of its own lexer, which drifted exactly as predicted. The first draft of this
// file repeated the mistake in miniature: `lex()` understood regex literals and its separate
// template-scanning helper did not, so `` `"${n.replace(/(["\\])/g, '\\$1')}"` `` in
// src/lib/gmail/message.js blew a 6,800-character hole through three declarations. Everything is
// now one loop with an explicit context stack, so a construct is understood everywhere or nowhere.
//
// SECOND, A LEXER IN A SECURITY CONTROL MUST NOT GUESS. A silent wrong guess produces a smaller
// scan, and a smaller scan looks identical to a clean one. Every construct this file cannot
// classify with certainty is recorded as a CONCERN, and the caller is expected to fail closed on
// it rather than scan what is left. Refusing to answer is a usable outcome; answering PASS without
// having looked is not.
//
// THIRD, it has to finish. The first draft recomputed the trailing identifier with
// `src.slice(0, i + 1).match(...)` on every identifier character — O(n²), minutes on
// src/api/routes.js. A check that takes minutes is a check somebody deletes.
//
// ── LIMITATIONS, STATED ──────────────────────────────────────────────────────
//
// This is a hand-written lexer, not a parser, and it is the weakest link in the controls built on
// it. A real JavaScript parser (acorn, which Node vendors internally but does not expose, or
// @babel/parser) would make the classification correct by construction, and would also let the
// ordering checks ask about scopes rather than text. That is the right destination. It is a new
// runtime dependency in the security path, which is an owner decision rather than a refactor, and
// this branch's own scripts/check-dependency-additions.js exists to make that decision deliberate.
//
// Until then, the specific things this lexer does not do — each of which produces a CONCERN rather
// than a silent answer:
//
//   · Regex-versus-division is decided from the previous significant token. The heuristic is the
//     standard one and is correct for every construct in this repository, but it is a heuristic;
//     where it cannot decide it records `unterminated-regex` rather than picking.
//   · A regex literal and a quoted string are assumed not to span a newline, which JavaScript
//     forbids. An unterminated one is reported, never swallowed to end of file.
//   · Template interpolations ARE lexed as code, so a regex or string inside one is handled. The
//     emitted span still covers the whole template including its interpolations, because that is
//     what a caller blanking non-code wants; `interpolations` gives their ranges so a caller can
//     check whether blanking one hid something it cares about.
//   · No JSX, no TypeScript, no ESM-only syntax is handled specially. Callers should additionally
//     require that each file compiles (`new vm.Script(src)`), which proves the input is at least
//     syntactically valid JavaScript of the form this was written for. All 704 .js files under
//     src/ and scripts/ compiled when this was written.
//
// Nothing here executes the source it reads.

'use strict';

// Characters after which a `/` begins a regex literal rather than a division. The complement — an
// identifier, a number, `)`, `]` — is a value that has just ended, so the `/` divides it.
const REGEX_PRECEDERS = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<',
    '>', '\n'],
);
// Keywords after which a `/` is also a regex: `return /x/`, `typeof /x/`, `case /x/:`.
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await', 'throw']);
// Identifier and numeric characters, for accumulating the trailing word.
const IDENT = /[A-Za-z0-9_$]/;
const SPACE = /\s/;

/**
 * Classify every non-code span in `src`.
 *
 * Returns { spans, concerns, interpolations }:
 *   spans          — [{ start, end, kind }], kind ∈ line-comment | block-comment | string |
 *                    template | regex. `end` is exclusive. A template span covers its own
 *                    interpolations; nested templates emit their own spans too, and overlapping
 *                    spans are harmless to blank.
 *   concerns       — [{ index, line, why }] for anything that could not be classified. A caller
 *                    building a safety verdict MUST treat a non-empty list as "not executed"
 *                    rather than as a pass.
 *   interpolations — [{ start, end }] for each `${...}` inside a template literal.
 */
function lex(src) {
  const n = src.length;
  const spans = [];
  const concerns = [];
  const interpolations = [];

  // Lines are counted once, lazily, and only for the rare concern.
  const lineOf = (i) => {
    let line = 1;
    for (let k = 0; k < i && k < n; k += 1) if (src[k] === '\n') line += 1;
    return line;
  };
  const concern = (index, why) => concerns.push({ index, line: lineOf(index), why });

  // ── THE CONTEXT STACK ──────────────────────────────────────────────────────
  //
  // Frames are { kind: 'template', start } — inside a template's raw text — and
  // { kind: 'interp', start, depth } — inside a `${ ... }`, where the content is ordinary code and
  // must be lexed as such. With no frame, we are at the top level, which is also ordinary code.
  // One loop handles both, which is the point: an interpolation gets the same regex, string and
  // comment handling as the top level, because it IS the same handling.
  const stack = [];
  const top = () => (stack.length ? stack[stack.length - 1] : null);

  let lastCode = '\n';          // start of file behaves like the start of a line
  let lastWord = '';
  let word = '';                // the identifier currently being accumulated
  const afterValue = (ch) => { lastCode = ch; lastWord = ''; word = ''; };

  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    const frame = top();

    // ── raw template text: only an escape, a closing backtick and `${` matter ──
    if (frame && frame.kind === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        stack.pop();
        spans.push({ start: frame.start, end: i + 1, kind: 'template' });
        afterValue('`');
        i += 1;
        continue;
      }
      if (c === '$' && d === '{') {
        stack.push({ kind: 'interp', start: i, depth: 1 });
        lastCode = '{'; lastWord = ''; word = '';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // ── ordinary code: top level, or inside an interpolation ──
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      spans.push({ start: i, end: j, kind: 'line-comment' });
      i = j;
      continue;
    }

    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
      if (j >= n) {
        concern(i, 'unterminated-block-comment');
        spans.push({ start: i, end: n, kind: 'block-comment' });
        break;
      }
      spans.push({ start: i, end: j + 2, kind: 'block-comment' });
      i = j + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const end = scanQuoted(src, i);
      if (end === -1) {
        concern(i, 'unterminated-string');
        spans.push({ start: i, end: n, kind: 'string' });
        break;
      }
      spans.push({ start: i, end, kind: 'string' });
      afterValue('"');
      i = end;
      continue;
    }

    if (c === '`') {
      stack.push({ kind: 'template', start: i });
      i += 1;
      continue;
    }

    if (c === '/') {
      const isRegex = REGEX_PRECEDERS.has(lastCode) || REGEX_KEYWORDS.has(lastWord);
      if (isRegex) {
        const end = scanRegex(src, i);
        if (end === -1) {
          // Either a division after something this lexer misread, or a regex running past the end
          // of its line. Neither is known, so it is reported rather than assumed — guessing
          // "regex to end of line" would blank real code, and guessing "division" would leave a
          // regex body to be matched as code.
          concern(i, 'unterminated-regex');
          i += 1;
          continue;
        }
        spans.push({ start: i, end, kind: 'regex' });
        afterValue('/');
        i = end;
        continue;
      }
      // Division. Nothing to blank.
      afterValue('/');
      i += 1;
      continue;
    }

    // Brace tracking, but only to find the end of an interpolation.
    if (frame && frame.kind === 'interp' && (c === '{' || c === '}')) {
      if (c === '{') frame.depth += 1;
      else {
        frame.depth -= 1;
        if (frame.depth === 0) {
          stack.pop();
          interpolations.push({ start: frame.start, end: i + 1 });
          lastCode = '}'; lastWord = ''; word = '';
          i += 1;
          continue;                       // back into the enclosing template's raw text
        }
      }
      lastCode = c; lastWord = ''; word = '';
      i += 1;
      continue;
    }

    if (IDENT.test(c)) {
      word += c;
      lastWord = word;
      lastCode = c;
    } else {
      // ANY whitespace ends the identifier but must NOT clear lastWord: `return /x/` has a space
      // between them, and that space is the whole reason lastWord is tracked separately.
      word = '';
      if (!SPACE.test(c)) {
        lastWord = '';
        lastCode = c;
      } else if (c === '\n'
        && (lastCode === ';' || lastCode === '{' || lastCode === '}' || lastCode === '\n')) {
        // A newline is a regex preceder only where a statement could begin. Keeping it as the last
        // significant character would misread `a\n/ b/` — vanishingly rare, and ASI makes the
        // regex reading the correct one anyway.
        lastCode = '\n';
        lastWord = '';
      }
    }
    i += 1;
  }

  // Anything still open at the end was never closed. Reported, with the opening position, so the
  // caller can fail closed and a person can go and look at it.
  for (const frame of stack) {
    concern(frame.start, frame.kind === 'template' ? 'unterminated-template' : 'unterminated-interpolation');
    spans.push({ start: frame.start, end: n, kind: 'template' });
  }

  return { spans, concerns, interpolations };
}

// A single- or double-quoted string. Returns the index AFTER the closing quote, or -1.
// A literal newline inside one is invalid JavaScript, so it ends the attempt as unterminated
// rather than being swallowed — being swallowed is what let the old scanner eat whole functions.
function scanQuoted(src, start) {
  const quote = src[start];
  const n = src.length;
  let j = start + 1;
  while (j < n) {
    if (src[j] === '\\') { j += 2; continue; }
    if (src[j] === quote) return j + 1;
    if (src[j] === '\n') return -1;
    j += 1;
  }
  return -1;
}

// A regex literal. A `/` inside a character class is literal, so `[...]` is tracked. A newline ends
// the attempt: JavaScript does not allow one inside a regex literal.
function scanRegex(src, start) {
  const n = src.length;
  let j = start + 1;
  let klass = false;
  while (j < n) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') return -1;
    if (c === '[') klass = true;
    else if (c === ']') klass = false;
    else if (c === '/' && !klass) {
      j += 1;
      while (j < n && /[a-z]/.test(src[j])) j += 1;   // flags
      return j;
    }
    j += 1;
  }
  return -1;
}

// Blank the given spans, preserving length and newlines so reported line numbers stay true.
// Overlapping spans are fine — blanking is idempotent.
function blankSpans(src, spans) {
  const out = src.split('');
  for (const s of spans) {
    for (let k = s.start; k < s.end && k < out.length; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  }
  return out.join('');
}

const COMMENTS = new Set(['line-comment', 'block-comment']);

/**
 * Everything that is not code becomes blanks: comments, strings, templates AND regex literals.
 * Use where the thing being looked for is a call or a declaration.
 */
function blankNonCode(src) {
  return blankSpans(src, lex(src).spans);
}

/**
 * Comments only — STRING LITERALS ARE KEPT. Use where the thing being looked for IS a string
 * value, such as `capability: 'email.alert'`. blankNonCode would erase exactly that and leave a
 * check that can never match: a test which passes against a planted bypass, which is worse than no
 * test. (It did: the planted probe in the containment suite went undetected until this existed.)
 *
 * Regex literals are blanked here too. They are not string values anybody searches for, and a
 * regex is the one place where a `//` or a quote can masquerade as something it is not.
 */
function blankCommentsOnly(src) {
  return blankSpans(src, lex(src).spans.filter((s) => COMMENTS.has(s.kind) || s.kind === 'regex'));
}

/** Convenience for callers that must fail closed: the concerns, with lines, or an empty list. */
function concernsIn(src) {
  return lex(src).concerns;
}

module.exports = { lex, blankNonCode, blankCommentsOnly, blankSpans, concernsIn,
  scanQuoted, scanRegex };
