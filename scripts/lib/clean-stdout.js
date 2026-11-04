// ── WHEN STDOUT IS THE PRODUCT, NOTHING ELSE MAY WRITE TO IT ─────────────────
//
// `initDB()` announces itself:
//
//     ✅ PostgreSQL database ready. 2 admin account(s); super_admin: naren@abiozen.com
//
// Exporters write their payload to stdout so it can be redirected into a file. So that line became
// LINE 1 of a spreadsheet on its way to a customer — a junk row in Excel, and the company's
// super-admin address published to somebody outside the company. Nothing errored. The file simply
// had an extra line nobody looked at, and three CSVs sat staged for commit that way on 3 Nov:
// `approved.csv`, `supplier-products.csv`, `paul-*.csv`, each with the banner above the real header.
//
// `export-trial-cut.js` had already been fixed in place, which is how the defect survived: one
// exporter carried the knowledge and three did not. The same shape as the Postgres search path
// copied into 35 harnesses — a fix that lives in one copy protects one copy.
//
// ── WHY IT INTERCEPTS process.stdout.write AND NOT JUST console.log ─────────
//
// The in-place fix swapped `console.log` for the duration of `initDB()`. That is narrower than the
// guarantee needed in two ways. It only covered the one call known to print at the time, so any
// later `console.log` — a new diagnostic, a library, a migration notice — lands back in the file.
// And it only covered `console.log`: anything writing straight to the stream goes around it.
//
// This takes the stream itself. Once `payloadMode()` is on, **the only writes that reach stdout are
// the explicit `emit*` calls**, and everything else is diverted to stderr. The guarantee stops
// depending on anybody remembering to wrap the next thing that prints.
//
// ── AND WHY THE JSON DOCUMENT IS BUFFERED ──────────────────────────────────
//
//   stdout must contain exactly one valid JSON document.
//
// Streaming a document and then failing halfway leaves a truncated one — which `JSON.parse` rejects,
// but only after the file has been written, named, and in some cases sent. `emitJson` serialises
// first and writes once, so a failure produces an EMPTY stdout and a non-zero exit rather than half
// a handover file. Nothing is a weaker signal than a file that is almost right.
'use strict';

// Administrative identifiers must not ride along on a diagnostic either. The banner names
// super-admins by address, and diverting it to stderr still puts it in anybody's captured logs,
// terminal scrollback or CI output. Redaction happens at the moment of forwarding, so it covers
// whatever prints next as well as what prints today.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const scrub = (s) => String(s).replace(EMAIL, '[redacted-address]');

let active = null;

// Turn on payload mode. From here, stdout belongs to the caller's emit* calls alone.
// Returns the emitters plus `restore()`. Idempotent: a second call returns the same handle, so a
// script cannot accidentally nest two interceptors and restore the wrong one.
function payloadMode() {
  if (active) return active;

  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const realLog = console.log;
  const realInfo = console.info;
  const realDebug = console.debug;

  let emitting = false;      // true only inside an emit* call

  // Everything written to stdout that is not an explicit emit is a diagnostic. Divert it, scrubbed.
  process.stdout.write = (chunk, enc, cb) => {
    if (emitting) return realStdoutWrite(chunk, enc, cb);
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    realStderrWrite(scrub(text));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };
  // console.log goes through process.stdout.write, so it is already covered — but it is reassigned
  // as well so that a library holding an early reference to the ORIGINAL console.log (captured
  // before this ran) still cannot reach stdout.
  const toStderr = (...a) => realStderrWrite(`${scrub(a.map(String).join(' '))}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const write = (text) => { emitting = true; try { realStdoutWrite(text); } finally { emitting = false; } };

  active = {
    // Exactly one JSON document, serialised before a single write so a mid-run failure leaves
    // stdout empty rather than truncated.
    emitJson(value) { write(`${JSON.stringify(value, null, 2)}\n`); },
    // One line of a line-oriented payload (CSV). The newline is added here so a caller cannot
    // forget it and glue two records together.
    emitLine(line) { write(`${line}\n`); },
    emitRaw(text) { write(String(text)); },
    restore() {
      process.stdout.write = realStdoutWrite;
      console.log = realLog;
      console.info = realInfo;
      console.debug = realDebug;
      active = null;
    },
  };
  return active;
}

// For the human-readable mode of an exporter, where stdout is prose and not a payload: keep the
// banner and its addresses out of it anyway, because that output gets pasted into mail and tickets.
async function quietly(fn) {
  const realLog = console.log;
  console.log = (...a) => process.stderr.write(`${scrub(a.map(String).join(' '))}\n`);
  try { return await fn(); } finally { console.log = realLog; }
}

module.exports = { payloadMode, quietly, scrub };
