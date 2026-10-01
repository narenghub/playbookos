// ── Rendering a contract to .docx ─────────────────────────────────────────────
//
// Knows how to DRAW each block kind and nothing about what any of them say. The document lives in
// contract-template.js so an attorney can review and replace it without touching this file.
//
// IT REFUSES RATHER THAN PRODUCING A BAD DOCUMENT. Two refusals, both before any bytes are generated:
//
//   1. A MISSING REQUIRED FIELD. The alternative is a .docx containing the literal `{{client_company}}`
//      arriving at a real business, which is the one failure mode that is glaring to the client and
//      invisible to us — we would never see the file. So the field set is checked first, the error
//      names every missing field at once (fixing them one 400 at a time is its own small cruelty),
//      and nothing is rendered.
//
//   2. AN UNBALANCED PAYMENT SCHEDULE. A contract whose installments do not sum to its total is a
//      document two people will read differently, which is the entire thing a contract exists to
//      prevent. Checked here as well as in the write handler, because this is the last point before
//      bytes exist and the handler is not the only possible caller.
//
// And a third, belt-and-braces: after rendering, the text is swept for any surviving `{{...}}`. The
// field check should make that impossible; if a template ever references a field that is not in FIELDS
// at all, this is what catches it.

const { TEMPLATE_VERSION, FIELDS, SUPPLIER, BLOCKS } = require('./contract-template');

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

const money = (cents) => {
  if (cents == null) return null;
  const n = cents / 100;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
                                           maximumFractionDigits: 2 });
};

// due_trigger → the words that go in the document. Vocabulary from the column COMMENT.
const TRIGGER_TEXT = {
  on_signature: 'on signature',
  on_intake_complete: 'on completion of intake',
  on_first_draft: 'on delivery of the first draft',
  on_launch: 'on launch',
  monthly: 'monthly',
  date: 'on the date shown',
};

// ── the field set ─────────────────────────────────────────────────────────────

// Builds the flat {{field}} resolution map from a contract/deal-shaped object. Pure.
function fieldsFor(input) {
  const d = input || {};
  const starts = d.starts_at_intake === false
    ? 'on signature of this agreement'
    : 'on completion of intake';
  return {
    ...SUPPLIER,
    contract_no: d.contract_no || null,
    contract_date: d.contract_date || null,
    client_company: d.client_company || null,
    client_address: d.client_address || null,
    client_contact: d.client_contact || null,
    client_title: d.client_title || null,
    client_email: d.client_email || null,
    client_phone: d.client_phone || null,
    partner_name: d.partner_name || null,
    package_name: d.package_name || d.package_code || null,
    duration_weeks: d.duration_weeks == null ? null : String(d.duration_weeks),
    start_basis: starts,
    total_value: money(d.value_cents),
    monthly_value: money(d.monthly_cents),
    terms_note: d.terms_note || null,
  };
}

// What is missing, as a list. Empty means renderable.
function missingFields(input) {
  const f = fieldsFor(input);
  return Object.entries(FIELDS)
    .filter(([name, spec]) => spec.required && (f[name] == null || String(f[name]).trim() === ''))
    .map(([name, spec]) => ({ field: name, label: spec.label }));
}

// Does the schedule sum to the total? Returns null when fine, or the discrepancy.
//
// An EMPTY schedule is allowed: a deal may legitimately have no installment plan agreed yet, and the
// document then states the total without a table. A schedule that EXISTS and does not balance is the
// refusal — a partial schedule is the dangerous case, not an absent one.
function scheduleImbalance(input) {
  const d = input || {};
  const rows = Array.isArray(d.payments) ? d.payments : [];
  if (!rows.length) return null;
  if (d.value_cents == null) {
    return { reason: 'no_total', message: 'a payment schedule was given but the deal has no value_cents to balance it against' };
  }
  const sum = rows.reduce((s, r) => s + (Number(r.amount_cents) || 0), 0);
  if (sum !== d.value_cents) {
    return { reason: 'unbalanced', sum, total: d.value_cents,
      message: `the payment schedule sums to ${money(sum)} but the deal total is ${money(d.value_cents)}`
             + ` — a difference of ${money(Math.abs(sum - d.value_cents))}` };
  }
  return null;
}

// The whole pre-flight, so a caller can ask "would this render?" without rendering.
function checkRenderable(input) {
  const missing = missingFields(input);
  const imbalance = scheduleImbalance(input);
  if (missing.length) {
    return { ok: false, code: 'missing_fields', missing,
      error: `Cannot generate a contract: ${missing.length} required field(s) are empty — `
           + `${missing.map(m => m.label).join(', ')}. A document containing {{placeholders}} must never `
           + `reach a client, so nothing has been generated.` };
  }
  if (imbalance) {
    return { ok: false, code: 'unbalanced_schedule', imbalance, error: `Cannot generate a contract: ${imbalance.message}.` };
  }
  return { ok: true };
}

// ── drawing ───────────────────────────────────────────────────────────────────

// A DECLARED field that is empty resolves to '' — that is an optional value legitimately absent.
// A name that is NOT DECLARED AT ALL is left as `{{name}}`, deliberately, so the post-render sweep
// refuses the document.
//
// The first version blanked both, which made the sweep unreachable: a template referencing a field
// that does not exist produced a silent gap in the prose, and the check written to catch exactly that
// could never fire. A belt-and-braces check that cannot fail is decoration.
function fill(text, fields) {
  if (text == null) return null;
  return String(text).replace(PLACEHOLDER, (whole, name) => {
    if (!(name in FIELDS)) return whole;
    const v = fields[name];
    return v == null || String(v).trim() === '' ? '' : String(v);
  });
}

async function renderContract(input) {
  const pre = checkRenderable(input);
  if (!pre.ok) return pre;

  // Required late so a missing dependency surfaces as a clear error from the one place that needs it,
  // rather than at require time for every consumer of this module.
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
          HeadingLevel, AlignmentType, WidthType, BorderStyle } = require('docx');

  const d = input || {};
  const fields = fieldsFor(d);
  const children = [];
  const emitted = [];   // plain text of everything drawn, for the placeholder sweep

  const para = (text, opts = {}) => {
    emitted.push(text);
    return new Paragraph({
      children: [new TextRun({ text, bold: !!opts.bold, italics: !!opts.italics, size: opts.size || 22,
                               color: opts.color })],
      heading: opts.heading, alignment: opts.alignment,
      spacing: { before: opts.before == null ? 120 : opts.before, after: opts.after == null ? 120 : opts.after },
    });
  };

  const cell = (text, opts = {}) => {
    emitted.push(text);
    return new TableCell({
      width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
      children: [new Paragraph({ children: [new TextRun({ text, bold: !!opts.bold, size: 20 })] })],
    });
  };
  const thinTable = (rows) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'EEEEEE' },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'EEEEEE' },
    },
    rows,
  });

  const isEmpty = (name) => fields[name] == null || String(fields[name]).trim() === '';

  let clauseNo = 0;
  for (const block of BLOCKS) {
    // A clause whose only content is an empty optional field is dropped ENTIRELY, heading included —
    // "Additional agreed terms" followed by nothing reads as something lost in the post. The heading
    // carries the same omit_if_empty as its body; marking only the body left the heading behind, and
    // the clause numbering then had a number spent on nothing.
    if (block.omit_if_empty && isEmpty(block.omit_if_empty)) continue;

    if (block.notice) {
      children.push(para(block.notice, { bold: true, color: 'B00020', size: 18, before: 0, after: 240 }));
    } else if (block.title) {
      children.push(para(fill(block.title, fields), { heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }));
    } else if (block.h) {
      clauseNo += 1;
      children.push(para(`${clauseNo}. ${fill(block.h, fields)}`, { heading: HeadingLevel.HEADING_2, before: 280 }));
    } else if (block.p) {
      const text = fill(block.p, fields);
      if (text.trim()) children.push(para(text));
    } else if (block.bullets || block.numbered) {
      const items = (block.bullets || block.numbered).map(x => fill(x, fields)).filter(x => x && x.trim());
      items.forEach((t, i) => children.push(para(block.numbered ? `${i + 1}. ${t}` : `•  ${t}`,
                                                 { before: 40, after: 40 })));
    } else if (block.kv) {
      // A row whose value is empty is DROPPED, not drawn blank. "Telephone:" with nothing after it
      // looks like a mistake in the document; its absence looks like a detail that was not relevant.
      const rows = block.kv
        .map(([label, ref]) => [label, fill(ref, fields)])
        .filter(([, v]) => v && v.trim() && v.trim() !== 'weeks')
        .map(([label, v]) => new TableRow({ children: [cell(label, { bold: true, width: 28 }), cell(v, { width: 72 })] }));
      if (rows.length) children.push(thinTable(rows));
    } else if (block.scope) {
      const list = Array.isArray(d[block.scope]) ? d[block.scope].filter(Boolean) : [];
      if (list.length) list.forEach(x => children.push(para(`•  ${x}`, { before: 40, after: 40 })));
      // Said explicitly rather than left blank. An empty exclusions list in a signed contract means
      // "nothing is excluded", so it has to be stated as a fact and not implied by a gap.
      else children.push(para(block.scope === 'included'
        ? 'The scope of work is set out in the accompanying proposal.'
        : 'No specific exclusions were agreed beyond those stated elsewhere in this agreement.', { italics: true }));
    } else if (block.payments) {
      const rows = Array.isArray(d.payments) ? d.payments : [];
      if (!rows.length) {
        children.push(para('The total is payable on invoice. No installment schedule was agreed.', { italics: true }));
      } else {
        const header = new TableRow({ children: [cell('#', { bold: true, width: 8 }),
          cell('Stage', { bold: true, width: 44 }), cell('When due', { bold: true, width: 28 }),
          cell('Amount', { bold: true, width: 20 })] });
        const body = rows.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(r => new TableRow({
          children: [cell(String(r.seq == null ? '' : r.seq)), cell(String(r.label || '')),
                     cell(r.due_date ? String(r.due_date).slice(0, 10)
                                     : (TRIGGER_TEXT[r.due_trigger] || r.due_trigger || '')),
                     cell(money(r.amount_cents) || '')],
        }));
        const total = new TableRow({ children: [cell(''), cell('Total', { bold: true }), cell(''),
          cell(money(rows.reduce((s, r) => s + (Number(r.amount_cents) || 0), 0)) || '', { bold: true })] });
        children.push(thinTable([header, ...body, total]));
      }
    } else if (block.signatures) {
      for (const s of block.signatures) {
        children.push(para(s.for, { bold: true, before: 320, after: 40 }));
        children.push(para('Signature: ______________________________________', { before: 40, after: 40 }));
        const nm = fill(s.name, fields);
        if (nm && nm.trim()) children.push(para(`Name: ${nm}`, { before: 20, after: 20 }));
        const ti = s.title ? fill(s.title, fields) : null;
        if (ti && ti.trim()) children.push(para(`Title: ${ti}`, { before: 20, after: 20 }));
        children.push(para('Date: ______________________', { before: 20, after: 80 }));
      }
    }
  }

  // Footer line: which template produced this, so a document found later can be traced to its version.
  children.push(para(`${fields.contract_no} · template ${TEMPLATE_VERSION}`,
                     { size: 16, color: '888888', before: 400, alignment: AlignmentType.CENTER }));

  // ── the belt-and-braces sweep ───────────────────────────────────────────────
  // The field check above should make this unreachable. It is here for the case the field check cannot
  // see: a template referencing a name that is not in FIELDS at all, which is required by nothing and
  // resolves to nothing, and would otherwise print as {{whatever}}.
  const leftover = [...new Set(emitted.join('\n').match(PLACEHOLDER) || [])];
  if (leftover.length) {
    return { ok: false, code: 'unresolved_placeholder', leftover,
      error: `Refusing to emit a contract containing unresolved placeholders: ${leftover.join(', ')}. `
           + `These names are referenced by the template but are not declared in FIELDS.` };
  }

  const doc = new Document({
    creator: SUPPLIER.supplier_name,
    title: `Website Development Agreement — ${fields.client_company}`,
    description: `${fields.contract_no} (template ${TEMPLATE_VERSION})`,
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children }],
  });
  const buffer = await Packer.toBuffer(doc);

  // A .docx is a zip. If this is not one, something upstream changed and the client would get a file
  // that will not open — better to fail here than to store it in the register.
  if (!Buffer.isBuffer(buffer) || buffer.subarray(0, 4).toString('hex') !== '504b0304') {
    return { ok: false, code: 'render_failed', error: 'the renderer did not produce a .docx' };
  }

  const safe = String(fields.client_company).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return {
    ok: true,
    buffer,
    file_name: `${fields.contract_no}-${safe || 'contract'}.docx`,
    template_version: TEMPLATE_VERSION,
    blocks: children.length,
  };
}

module.exports = { renderContract, checkRenderable, missingFields, scheduleImbalance, fieldsFor,
                   money, TRIGGER_TEXT, TEMPLATE_VERSION };
