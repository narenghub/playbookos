// ── THE LEXER UNDER THE SCANNERS ─────────────────────────────────────────────
//
//   node --test scripts/js-lex.test.js
//
// CEO decision 2026-11-12, M1 correction items 2-4. The scanner's pre-pass did not understand
// regex literals; a quote inside one swallowed the rest of the file up to the next quote, and on
// 2026-11-12 that span covered a whole function declaration. The consequence was not a failing
// check — it was a PASS over code nobody had looked at, and a planted ungated Gmail sender that
// produced zero discovered call sites.
//
// So the first test here is that exact input, and the ones after it are the constructs a
// hand-written lexer is most likely to get wrong. Where this lexer cannot be certain it must say
// so, because the thing being defended against is not a wrong answer — it is a confident one.
'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LEX = require('./js-lex');

// ── 1. THE DEFECT, AS IT WAS ────────────────────────────────────────────────

test('1. a quote inside a regex literal does not swallow the code after it', () => {
  const src = [
    'async function first(x) {',
    '  const m = /not authorized to send emails from ([^"\'\\s]+)/i.exec(x);',
    '  return m;',
    '}',
    'async function second(msg) {',
    '  await g.gmail.users.messages.send(msg);',
    '}',
  ].join('\n');

  const code = LEX.blankNonCode(src);

  assert.strictEqual(code.length, src.length, 'length changed — reported line numbers would lie');
  assert.ok(code.includes('async function second('),
    'the declaration after the regex was erased. This is the defect: the scanner cannot see that '
    + 'function, so it cannot check the path through it, and it does not know it is blind.');
  assert.ok(code.includes('g.gmail.users.messages.send('),
    'THE TRANSPORT CALL ITSELF WAS ERASED — an unauthorized sender invisible to the scanner whose '
    + 'job is finding unauthorized senders');
  assert.ok(!code.includes('not authorized'), 'the regex body survived and can match as code');
  assert.deepStrictEqual(LEX.concernsIn(src), [], 'valid input should raise no concern');
});

test('1b. and the regex is reported as a regex, not as a string', () => {
  const src = 'const m = /from ([^"\']+)/i.exec(x);';
  const kinds = LEX.lex(src).spans.map((s) => s.kind);
  assert.deepStrictEqual(kinds, ['regex'],
    'the span was classified as something else — the kinds are what a caller uses to decide '
    + 'whether a thing it lost was lost legitimately');
});

// ── 2. DIVISION IS NOT A REGEX ──────────────────────────────────────────────
//
// The failure in the other direction. A lexer that blanks every `/` would erase real code, and
// "blank more" is the tempting over-correction after a miss.

test('2. division is left alone', () => {
  for (const src of [
    'const half = total / 2;',
    'const r = count/n;',
    'const pct = (a / b) / c;',
    'const x = arr[i] / arr[j];',
    'const y = f(a) / g(b);',
    'const z = obj.count / 100;',
  ]) {
    const code = LEX.blankNonCode(src);
    assert.strictEqual(code, src, `a division was blanked as a regex: ${src}`);
  }
});

test('2b. and a regex after each kind of preceding token IS found', () => {
  const cases = [
    ['const re = /a"b/;', 'assignment'],
    ['if (/a"b/.test(s)) f();', 'open paren'],
    ['f(x, /a"b/);', 'comma'],
    ['return /a"b/;', 'return'],
    ['const o = { re: /a"b/ };', 'colon'],
    ['const bad = !/a"b/.test(s);', 'bang'],
    ['x = a || /a"b/.test(s);', 'or'],
  ];
  for (const [src, label] of cases) {
    const kinds = LEX.lex(src).spans.map((s) => s.kind);
    assert.ok(kinds.includes('regex'), `regex after ${label} was not recognised: ${src}`);
    assert.ok(!LEX.blankNonCode(src).includes('a"b'), `the regex body survived after ${label}`);
  }
});

// ── 3. THE CONSTRUCTS THAT MADE THE OLD SCANNER WRONG ───────────────────────

test('3. a URL inside a string is not a comment', () => {
  const src = "const u = 'https://api.resend.com/emails';\nconst real = 1;";
  const code = LEX.blankNonCode(src);
  assert.ok(code.includes('const real = 1;'), 'the // inside the URL was read as a comment');
});

test('3b. a quote inside a comment does not open a string', () => {
  const src = "// it's fine\nconst real = 1;\nconst s = 'x';";
  const code = LEX.blankNonCode(src);
  assert.ok(code.includes('const real = 1;'),
    "the apostrophe in \"it's\" opened a string that swallowed the next line");
});

test('3c. a slash inside a character class does not close the regex', () => {
  const src = 'const re = /[/"]+/g;\nconst real = 1;';
  const code = LEX.blankNonCode(src);
  assert.ok(code.includes('const real = 1;'), 'the regex was closed early at the class slash');
  assert.ok(!code.includes('[/"]'), 'the regex body survived');
});

test('3d. an escaped closing slash does not close the regex', () => {
  const src = 'const re = /https:\\/\\/"x/;\nconst real = 1;';
  const code = LEX.blankNonCode(src);
  assert.ok(code.includes('const real = 1;'), 'an escaped slash closed the regex early');
});

test('3e. a backtick inside a template interpolation does not close the outer template', () => {
  const src = 'const s = `a ${ b ? `c"d` : e } f`;\nconst real = 1;';
  const code = LEX.blankNonCode(src);
  assert.ok(code.includes('const real = 1;'),
    'the nested template closed the outer one and the rest of the line leaked');
  assert.deepStrictEqual(LEX.concernsIn(src), []);
});

test('3f. a quote inside a template interpolation does not leak', () => {
  const src = "const s = `x ${ f(\"a`b\") } y`;\nconst real = 1;";
  const code = LEX.blankNonCode(src);
  assert.ok(code.includes('const real = 1;'), 'the backtick inside the string closed the template');
});

// ── 4. IT MUST NOT GUESS ────────────────────────────────────────────────────
//
// The whole argument of the corrective. A silent wrong guess yields a smaller scan, and a smaller
// scan is indistinguishable from a clean one.

test('4. an unterminated string is reported, not swallowed', () => {
  const src = "const s = 'oops;\nasync function later() {}";
  const c = LEX.concernsIn(src);
  assert.strictEqual(c.length, 1, `expected one concern, got ${JSON.stringify(c)}`);
  assert.strictEqual(c[0].why, 'unterminated-string');
  assert.strictEqual(c[0].line, 1, 'the concern must carry the line, or nobody can act on it');
});

test('4b. an unterminated template is reported', () => {
  const c = LEX.concernsIn('const s = `oops;\nconst x = 1;');
  assert.strictEqual(c.length, 1, JSON.stringify(c));
  assert.strictEqual(c[0].why, 'unterminated-template');
});

test('4c. an unterminated block comment is reported', () => {
  const c = LEX.concernsIn('/* oops\nconst x = 1;');
  assert.strictEqual(c.length, 1, JSON.stringify(c));
  assert.strictEqual(c[0].why, 'unterminated-block-comment');
});

test('4d. a slash that looks like a regex but never closes is reported, not assumed', () => {
  // The important one. Guessing "regex to end of line" here would blank real code; guessing
  // "division" would leave a regex body to be matched as code. Neither is known, so it says so.
  const c = LEX.concernsIn('const x = ( /unclosed\nconst real = 1;');
  assert.ok(c.some((e) => e.why === 'unterminated-regex'),
    `expected an unterminated-regex concern, got ${JSON.stringify(c)}`);
});

test('4e. template interpolations are reported so a caller can refuse to miss one', () => {
  // Interpolations are blanked along with the template, which is a real limitation. It is declared
  // rather than hidden: the caller gets the ranges and can check whether anything it cares about
  // was inside one.
  const src = 'const s = `${ g.gmail.users.messages.send(m) }`;';
  const { interpolations } = LEX.lex(src);
  assert.strictEqual(interpolations.length, 1, JSON.stringify(interpolations));
  const inside = src.slice(interpolations[0].start, interpolations[0].end);
  assert.match(inside, /messages\.send/,
    'the interpolation range does not cover its own expression, so a caller checking it would '
    + 'conclude there was nothing there');
});

// ── 5. THE TWO WRAPPERS CANNOT DRIFT ────────────────────────────────────────

test('5. blankCommentsOnly keeps string values but still kills comments', () => {
  const src = "const cap = 'email.alert'; // a comment mentioning email.send\n";
  const code = LEX.blankCommentsOnly(src);
  assert.ok(code.includes("'email.alert'"),
    'the string value was erased — a check for a capability literal could never match');
  assert.ok(!code.includes('email.send'),
    'the comment survived, so prose can be counted as code — the B6 false-positive route');
});

test('5b. blankCommentsOnly also kills regex literals', () => {
  // A regex is not a string value anybody searches for, and it is the one place where a quote or a
  // `//` can masquerade. Leaving it would let `/send("/` break the comment scan.
  const src = "const re = /email.send/; // prose\nconst cap = 'email.alert';";
  const code = LEX.blankCommentsOnly(src);
  assert.ok(!code.includes('/email.send/'), 'the regex survived blankCommentsOnly');
  assert.ok(code.includes("'email.alert'"), 'the string value was erased');
});

test('5c. both wrappers come from one lexer, so a fix reaches both', () => {
  // Structural, because this is the property that failed: the file this came from argued for one
  // shared decision function and then carried two copies of its own lexer.
  const src = fs.readFileSync(path.join(__dirname, 'js-lex.js'), 'utf8');
  for (const name of ['blankNonCode', 'blankCommentsOnly']) {
    const i = src.indexOf(`function ${name}(src)`);
    assert.ok(i > 0, `${name} not found`);
    const body = src.slice(i, src.indexOf('\n}', i));
    assert.match(body, /lex\(src\)/,
      `${name} does not call lex() — it has its own scanner again, and the two will drift`);
    assert.ok(!/while \(i < n\)/.test(body), `${name} contains a character loop of its own`);
  }
});

// ── 6. AGAINST THE REAL REPOSITORY ──────────────────────────────────────────

test('6. every function declaration in mailer.js survives the pre-pass', () => {
  // The specific thing that went wrong, pinned against the real file so it cannot regress by
  // someone adding another quote-bearing regex above a declaration.
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'mailer.js'), 'utf8');
  const DECL = /\n(?:async )?function (\w+)\s*\(/g;
  const declared = [...raw.matchAll(DECL)].map((m) => m[1]);
  const visible = [...LEX.blankNonCode(raw).matchAll(DECL)].map((m) => m[1]);
  assert.ok(declared.length >= 8, `only ${declared.length} declarations found — update this guard`);
  assert.deepStrictEqual(visible, declared,
    `the pre-pass hid ${declared.filter((d) => !visible.includes(d)).join(', ') || '(none)'}`);
});

test('6b. no function declaration anywhere under src/ or scripts/ is hidden', () => {
  // Repository-wide, because the measurement that made this worth fixing was that the old pre-pass
  // hid declarations in 38 files — mailer.js was the one where it happened to matter.
  const roots = [path.join(__dirname, '..', 'src'), __dirname];
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p); } else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  roots.forEach(walk);

  // ── THE ONE LEGITIMATE REASON A DECLARATION IS INVISIBLE ─────────────────
  //
  // A file that PLANTS JavaScript source as fixture text really does contain
  // `\nfunction gapi(` inside a template literal, and blanking it is correct — that fixture is a
  // string value, not code this repository runs. So the sweep is not "zero hidden anywhere"; it is
  // "hidden only where a reviewed reason says so, and even there, only inside a literal".
  //
  // Pinned as a list rather than a pattern so that a NEW file which starts hiding declarations
  // goes red and gets looked at. That is the whole value: when this was written the old pre-pass
  // hid declarations in 38 files, and nobody knew.
  const FIXTURE_FILES = {
    'scripts/outbound-allowlist.test.js':
      'plants provider call sites as template-literal fixtures, so its `function gapi(` and '
      + '`function go(` are string values',
  };

  const DECL = /\n(?:async )?function (\w+)\s*\(/g;
  const unexplained = [];
  const notInALiteral = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), f);
    const declared = [...raw.matchAll(DECL)].map((m) => ({ name: m[1], at: m.index }));
    if (!declared.length) continue;
    const blanked = LEX.blankNonCode(raw);
    const visibleNames = [...blanked.matchAll(DECL)].map((m) => m[1]);
    const lost = declared.filter((d) => !visibleNames.includes(d.name));
    if (!lost.length) continue;

    if (!FIXTURE_FILES[rel]) {
      unexplained.push(`${rel}: ${lost.map((d) => d.name).join(', ')}`);
      continue;
    }
    // Even in an allowed file, each loss must be attributable to a string or template span. A loss
    // with no literal around it means a span over-ran, which is the defect, not a fixture.
    const { spans } = LEX.lex(raw);
    for (const d of lost) {
      const cover = spans.find((s) => s.start <= d.at && s.end > d.at);
      if (!cover || !['string', 'template'].includes(cover.kind)) {
        notInALiteral.push(`${rel}: ${d.name} is hidden but sits in ${cover ? cover.kind : 'NO span'}`);
      }
    }
  }

  assert.ok(files.length > 400, `only ${files.length} files walked — the sweep is not reaching them`);
  assert.deepStrictEqual(unexplained, [],
    `the pre-pass hides declarations in ${unexplained.length} file(s) with no reviewed reason:\n  `
    + `${unexplained.join('\n  ')}`);
  assert.deepStrictEqual(notInALiteral, [],
    `a declaration is hidden without a literal around it — a span over-ran:\n  `
    + `${notInALiteral.join('\n  ')}`);
});

test('6c. the repository raises no lexer concern, and every file compiles', () => {
  // Two things at once, because they answer the same question: is the input the kind of JavaScript
  // this lexer was written for? A file that does not compile is a file no hand-written lexer should
  // be trusted on, and the scanner is expected to fail closed on both.
  const roots = [path.join(__dirname, '..', 'src'), __dirname];
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p); } else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  roots.forEach(walk);

  const problems = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), f);
    for (const c of LEX.concernsIn(raw)) problems.push(`${rel}:${c.line} ${c.why}`);
    // Compiles only; nothing is executed.
    try { new vm.Script(raw, { filename: f }); } catch (e) {
      problems.push(`${rel} does not compile: ${e.message.slice(0, 80)}`);
    }
  }
  assert.deepStrictEqual(problems, [], `${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
});
