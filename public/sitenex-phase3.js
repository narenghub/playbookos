/* ── SiteNex Phase 3 UI — Contracts register, deal editing, call script ─────────
 *
 * A SEPARATE FILE, loaded by one <script src> at the end of index.html.
 *
 * THIS STRUCTURALLY CANNOT REPEAT THE 30 SEPTEMBER OUTAGE. That outage was
 * `async function outreachPage()` inserted INSIDE the `const pages = { ... }` object literal — a
 * syntax error that killed the whole inline script, so the SPA rendered nothing while /health stayed
 * green and the container logs stayed empty. The hazard is specific to editing inside that literal.
 * Here there is no literal to be inside: `const pages` is declared at the top level of the inline
 * script, so by the time this file runs it is simply a visible global, and pages are attached with
 * `pages['x'] = fn` from outside. A syntax error in THIS file also cannot take the app down with it —
 * a separate <script> that fails to parse leaves every other script running.
 *
 * Two rules it still has to obey:
 *   • HANDLERS GO ON window. An inline onclick resolves against the global object, and Annex B does
 *     not hoist an async function out of a block, so a bare `async function f()` inside one throws
 *     ReferenceError on click and the control silently does nothing. Every handler here is assigned to
 *     window explicitly, under its own name.
 *     (Described rather than shown on purpose: inline-handlers.test.js reads window assignments out of
 *     this file to decide what is reachable, and it does not know a comment from code — so an EXAMPLE of
 *     the syntax registers a global that does not exist, which is exactly what makes a guard pass over a
 *     genuinely missing handler. Two different placeholder names did it before this sentence replaced
 *     them.)
 *   • A DOWNLOAD MUST FETCH WITH THE Authorization HEADER AND CLICK A BLOB ANCHOR. A bare href gets a
 *     401: the browser sends no header on a plain navigation, and the contract routes are gated.
 */

/* ── helpers ───────────────────────────────────────────────────────────────────
 * esc/get/err are taken from the inline script when present (they are — this file loads after it) and
 * fall back to local definitions so this file can be loaded and unit-tested on its own.
 */
const snEsc = (x) => (typeof apEsc === 'function' ? apEsc(x)
  : String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const snGet = (p) => apGet(p);
const snDash = '<span style="color:var(--text-muted)">—</span>';

const snMoney = (cents) => cents == null ? snDash
  : '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const snDate = (d) => d ? String(d).slice(0, 10) : snDash;

/* A write. Every one goes through here so the Authorization header, the JSON parsing and the error
   shape are in one place rather than repeated per handler. */
async function snSend(method, path, body) {
  try {
    const r = await fetch('/api' + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!r.ok) return { ok: false, status: r.status, error: (data && data.error) || ('HTTP ' + r.status), data };
    return { ok: true, status: r.status, data };
  } catch (e) { return { ok: false, status: 0, error: 'request failed: ' + (e && e.message ? e.message : String(e)) }; }
}

function snToast(msg, bad) {
  const el = document.getElementById('sn-msg');
  if (!el) { if (bad) console.error(msg); return; }
  el.style.color = bad ? 'var(--danger,#b00020)' : 'var(--teal,#0a7)';
  el.textContent = msg;
}

const SN_CONTRACT_STATUS = ['generated', 'sent', 'signed', 'superseded', 'void'];
const SN_DEAL_STATUS = ['new', 'contacted', 'proposal_sent', 'signed', 'intake', 'building', 'live', 'lost'];
const SN_TRIGGERS = [['on_signature', 'On signature'], ['on_intake_complete', 'On intake complete'],
  ['on_first_draft', 'On first draft'], ['on_launch', 'On launch'], ['monthly', 'Monthly'], ['date', 'On a date']];

/* ── the download ──────────────────────────────────────────────────────────────
 *
 * A BARE href 401s. The contract routes require the Authorization header, and a browser sends none on
 * a plain navigation or an <a download>. So: fetch with the header, turn the bytes into a blob, click a
 * synthetic anchor, and revoke the URL. The revoke is deferred because Safari cancels an in-flight
 * download when the object URL goes away immediately.
 */
window.snDownloadContract = async function snDownloadContract(id, fileName) {
  snToast('Preparing ' + (fileName || 'the document') + '…');
  try {
    const r = await fetch('/api/sitenex/contracts/' + encodeURIComponent(id) + '/file',
      { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
      snToast('Could not download it: ' + msg, true);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || ('contract-' + id + '.docx');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    snToast('Downloaded ' + a.download);
  } catch (e) {
    snToast('Could not download it: ' + (e && e.message ? e.message : String(e)), true);
  }
};

/* ── emailing a contract to the client ─────────────────────────────────────────
 *
 * A SEPARATE BUTTON FROM GENERATE, never automatic, and THE ADDRESS IS ON SCREEN BEFORE IT IS CLICKED.
 * Generating is reversible — regenerate and the old one is superseded. Sending is not: a wrong address or
 * a wrong price has reached a real business and cannot be recalled.
 *
 * So the flow is: fetch the preview (which the server builds from the contract's own snapshot, so what is
 * shown is what will be sent), render the recipient beside the button, and on click confirm with the
 * address IN THE PROMPT. The confirm() is a courtesy, not the safeguard — the server independently
 * requires the address to be echoed back, because a dialog in the browser is one devtools line away.
 */

/* Drawn next to the button so the address is visible without any interaction at all. A tooltip would not
   count: nobody hovers before clicking a button they already intended to press. */
function snSendLine(pv) {
  if (!pv) return '';
  if (pv.sent_at) {
    return '<div style="font-size:11px;color:var(--text-muted)">Sent ' + snEsc(snDate(pv.sent_at))
         + ' to <strong>' + snEsc(pv.to) + '</strong>'
         + (pv.cc ? ' (cc ' + snEsc(pv.cc) + ')' : '') + '</div>';
  }
  if (!pv.can_send) {
    return '<div style="font-size:11px;color:#8a1f1f">Cannot email: ' + snEsc(pv.blocked_because) + '</div>';
  }
  return '<div style="font-size:11px;color:var(--text-muted)">Will email <strong>' + snEsc(pv.to) + '</strong>'
       + (pv.cc ? ' and cc <strong>' + snEsc(pv.cc) + '</strong>' : '')
       + ' from ' + snEsc(pv.from) + '</div>'
       + (pv.price ? '<div style="font-size:11px;color:var(--text-muted)">The note will state: ' + snEsc(pv.price) + '</div>'
                   : '<div style="font-size:11px;color:#8a1f1f">No price on this contract — the note will say the '
                     + 'terms are in the document</div>');
}

window.snEmailContract = async function snEmailContract(id) {
  snToast('Checking who this would go to…');
  const pv = await snGet('/sitenex/contracts/' + encodeURIComponent(id) + '/send');
  if (!pv.ok) { snToast(pv.error, true); return; }
  const d = pv.data;
  if (!d.can_send) { snToast('Cannot email this contract: ' + d.blocked_because, true); return; }

  /* THE ADDRESS IS IN THE PROMPT. "Send this contract?" is a question somebody answers yes to without
     reading; naming the recipient and the price is the only version that can be checked. The previous-send
     count is included because a second copy to the same client needs a different decision from a first. */
  const already = (d.previous_sends || []).filter(x => x.status === 'sent').length;
  const lines = [
    'Email contract ' + d.contract_no + ' to:',
    '',
    '    ' + d.to,
    d.cc ? '    cc ' + d.cc : null,
    '',
    'From: ' + d.from,
    'Price stated in the note: ' + (d.price || '(none — the note will point at the document)'),
    'Attachment: ' + d.file_name,
    already ? '\nThis contract has ALREADY been emailed ' + already + ' time(s).' : null,
    '',
    'A contract sent to the wrong address cannot be unsent.',
  ].filter(x => x !== null).join('\n');

  /* confirm() blocks the page, which is the point here: this is the one action in these screens that
     cannot be undone, so it should not be possible to click past it by accident. */
  if (!confirm(lines)) { snToast('Not sent.'); return; }

  snToast('Sending…');
  const r = await snSend('POST', '/sitenex/contracts/' + encodeURIComponent(id) + '/send', { confirm_to: d.to });
  if (!r.ok) {
    const body = r.data || {};
    if (body.code === 'sent_but_not_recorded') {
      /* The email HAS gone. This must not read as "it failed", or somebody will press it again. */
      snToast(body.error, true);
      return;
    }
    snToast(body.error || r.error, true);
    return;
  }
  snToast(r.data.note + ' (provider id ' + r.data.provider_id + ')');
  if (typeof pages !== 'undefined' && pages['sitenex-contracts']) await pages['sitenex-contracts']();
};

/* ── the contracts register ────────────────────────────────────────────────────  */

function snTotalsCard(t) {
  const box = (label, value, hint) =>
    '<div style="flex:1;min-width:150px;border:1px solid var(--border);border-radius:8px;padding:10px 12px;background:var(--white)">'
    + '<div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">' + snEsc(label) + '</div>'
    + '<div style="font-size:20px;font-weight:650;margin-top:2px">' + value + '</div>'
    + (hint ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + snEsc(hint) + '</div>' : '')
    + '</div>';
  return '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px">'
    + box('Signed — one-time', snMoney(t.signed_one_time_cents), t.signed_count + ' contract' + (t.signed_count === 1 ? '' : 's'))
    + box('Signed — monthly', snMoney(t.signed_monthly_cents), 'recurring')
    /* Labelled as a DERIVED figure, not as revenue. One-time plus twelve months of the retainer is an
       arithmetic statement about today's book, not a forecast and not money received. */
    + box('Annualised', snMoney(t.annualised_cents), 'one-time + 12 × monthly')
    + box('Pipeline', snMoney(t.pipeline_cents), t.pipeline_count + ' generated or sent')
    + (t.superseded_count
      ? box('Superseded', String(t.superseded_count), 'excluded from every total above')
      : '')
    + '</div>';
}

function snContractRow(c) {
  const dead = c.status === 'superseded' || c.status === 'void';
  const opts = SN_CONTRACT_STATUS
    .filter(s => s !== 'superseded')          /* set by generating a replacement, never by hand */
    .map(s => '<option value="' + s + '"' + (s === c.status ? ' selected' : '') + '>' + s + '</option>').join('');
  return '<tr style="' + (dead ? 'opacity:.55' : '') + '">'
    + '<td style="padding:6px 8px;font-family:ui-monospace,monospace;font-size:12px">' + snEsc(c.contract_no) + '</td>'
    + '<td style="padding:6px 8px">' + snEsc(c.client_company || '')
      + (c.client_contact ? '<div style="font-size:11px;color:var(--text-muted)">' + snEsc(c.client_contact) + '</div>' : '')
      + '</td>'
    + '<td style="padding:6px 8px">' + (c.partner_name ? snEsc(c.partner_name) : '<span style="color:var(--text-muted)">ours</span>') + '</td>'
    + '<td style="padding:6px 8px;font-size:12px">' + snEsc(c.package_name || c.package_code || '') + '</td>'
    + '<td style="padding:6px 8px;text-align:right">' + snMoney(c.value_cents)
      + (c.monthly_cents ? '<div style="font-size:11px;color:var(--text-muted)">+ ' + snMoney(c.monthly_cents) + '/mo</div>' : '')
      + '</td>'
    + '<td style="padding:6px 8px">'
      + (dead
        ? '<span style="font-size:11px;color:var(--text-muted)">' + snEsc(c.status)
          + (c.superseded_by ? ' by #' + snEsc(c.superseded_by) : '') + '</span>'
        : '<select onchange="snSetContractStatus(' + c.id + ',this)" '
          + 'style="font-size:11px;padding:3px 4px;border:1px solid var(--border);border-radius:4px;background:#fff">'
          + opts + '</select>')
      + '</td>'
    + '<td style="padding:6px 8px;font-size:11px;color:var(--text-muted)">' + snDate(c.created_at) + '</td>'
    + '<td style="padding:6px 8px;font-size:11px;color:var(--text-muted)">' + snEsc(c.template_version || '') + '</td>'
    + '<td style="padding:6px 8px;white-space:nowrap">'
      + '<button onclick="snDownloadContract(' + c.id + ',\'' + snEsc(c.file_name || '').replace(/'/g, "\\'") + '\')" '
      + 'class="btn-secondary" style="padding:3px 9px;font-size:11px">.docx</button>'
      /* A SEPARATE BUTTON, and only on a contract that is still current. The address it would go to is
         drawn beneath it by snSendRecipient() once the register has loaded the previews — the point is
         that it is readable without clicking anything. */
      + (dead ? ''
        : ' <button onclick="snEmailContract(' + c.id + ')" class="btn-secondary" '
          + 'style="padding:3px 9px;font-size:11px">Email to client</button>')
      + (dead ? '' : '<div id="sn-to-' + c.id + '" style="margin-top:2px"></div>')
      + '</td>'
    + '</tr>';
}

async function snContractsPage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="text-body">Loading contracts…</div>';
  const r = await snGet('/sitenex/contracts');
  if (!r.ok) { el.innerHTML = apErrorCard('SiteNex Contracts', r, "pages['sitenex-contracts']()"); return; }
  const d = r.data;

  const head = '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">'
    + '<h2 style="margin:0">SiteNex Contracts</h2>'
    + '<div style="font-size:12px;color:var(--text-muted)">' + d.total + ' in the register · ' + snEsc(d.scope) + '</div>'
    + '</div>'
    /* The template is a placeholder and the register says so on every visit, not only inside the file.
       A notice that lives only in the document is a notice nobody reads before sending it. */
    + '<div style="margin:10px 0 14px;padding:8px 10px;border:1px solid #f0c0c0;background:#fff6f6;border-radius:6px;'
    + 'font-size:12px;color:#8a1f1f">'
    + '<strong>The contract template has not been reviewed by an attorney.</strong> '
    + 'Clause text is placeholder content so the system can be built and tested. Do not send a generated '
    + 'document to a client until the wording has been replaced.'
    + '</div>'
    + '<div id="sn-msg" style="font-size:12px;min-height:16px;margin:0 0 8px"></div>';

  if (!d.contracts.length) {
    el.innerHTML = head
      + '<div style="border:1px dashed var(--border);border-radius:8px;padding:18px;text-align:center;color:var(--text-muted)">'
      + 'No contracts yet. Open a deal on the SiteNex Deals board and generate one from there.'
      + '</div>';
    return;
  }

  const th = (t, right) => '<th style="padding:6px 8px;text-align:' + (right ? 'right' : 'left')
    + ';font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;'
    + 'border-bottom:1px solid var(--border)">' + t + '</th>';
  el.innerHTML = head + snTotalsCard(d.totals)
    + '<div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:var(--white)">'
    + '<table style="width:100%;border-collapse:collapse;font-size:13px">'
    + '<thead><tr>' + th('Contract') + th('Client') + th('Partner') + th('Package') + th('Value', true)
    + th('Status') + th('Generated') + th('Template') + th('') + '</tr></thead>'
    + '<tbody>' + d.contracts.map(snContractRow).join('') + '</tbody>'
    + '</table></div>';

  /* Fill in each row's recipient AFTER the table is on screen. Done as a second pass rather than inside
     the row builder because it is one request per contract, and the register must not wait on them —
     a slow preview should delay the address appearing, never the register itself. */
  await snFillRecipients(d.contracts);
}

async function snFillRecipients(contracts) {
  const live = contracts.filter(c => c.status !== 'superseded' && c.status !== 'void');
  await Promise.all(live.map(async (c) => {
    const slot = document.getElementById('sn-to-' + c.id);
    if (!slot) return;
    const pv = await snGet('/sitenex/contracts/' + encodeURIComponent(c.id) + '/send');
    /* A failed preview says so rather than leaving a blank, which would read as "no recipient needed". */
    slot.innerHTML = pv.ok ? snSendLine(pv.data)
      : '<div style="font-size:11px;color:var(--text-muted)">could not read the recipient: ' + snEsc(pv.error) + '</div>';
  }));
}

window.snSetContractStatus = async function snSetContractStatus(id, sel) {
  const next = sel && sel.value;
  snToast('Saving…');
  const r = await snSend('PUT', '/sitenex/contracts/' + encodeURIComponent(id), { status: next });
  if (!r.ok) { snToast(r.error, true); await snContractsPage(); return; }
  snToast('Contract ' + r.data.contract.contract_no + ' is now ' + r.data.contract.status);
  /* Re-read rather than patch the row in place: the status change moves money between the totals above,
     and a card that disagrees with the totals beside it is worse than a redraw. */
  await snContractsPage();
};

/* ── generating a contract, from a deal ───────────────────────────────────────── */

window.snGenerateContract = async function snGenerateContract(dealId) {
  snToast('Generating…');
  const r = await snSend('POST', '/sitenex/contracts', { deal_id: dealId });
  if (!r.ok) {
    /* The server names every missing field at once. Shown as a list, because "Cannot generate" with one
       field named means three more round trips. */
    const d = r.data || {};
    if (d.code === 'missing_fields' && Array.isArray(d.missing)) {
      snToast('Cannot generate yet — still needed: ' + d.missing.map(m => m.label).join(', '), true);
    } else {
      snToast(r.error, true);
    }
    return;
  }
  snToast(r.data.note || 'Generated.');
  if (typeof pages !== 'undefined' && pages['sitenex-deals']) await pages['sitenex-deals']();
};

/* ── editing a deal ────────────────────────────────────────────────────────────
 *
 * Opened from the deals board. One form, saved whole, because the client details are only useful
 * together: a contract needs all of them or none of them.
 */

const SN_DEAL_FIELDS = [
  ['company_name', 'Client company', 'text', true],
  ['contact_name', 'Contact name', 'text', true],
  ['contact_title', 'Contact title', 'text', false],
  ['contact_email', 'Contact email', 'email', true],
  ['contact_phone', 'Contact phone', 'text', false],
  ['client_address', 'Client address', 'text', true],
  ['duration_weeks', 'Duration (weeks)', 'number', true],
  ['value_cents', 'Total value ($)', 'money', false],
  ['monthly_cents', 'Monthly ($)', 'money', false],
  ['terms_note', 'Additional agreed terms', 'textarea', false],
];

window.snEditDeal = async function snEditDeal(dealId) {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="text-body">Loading deal…</div>';
  const r = await snGet('/sitenex/deals/' + encodeURIComponent(dealId));
  if (!r.ok) { el.innerHTML = apErrorCard('SiteNex Deal', r, "pages['sitenex-deals']()"); return; }
  const d = r.data.deal, pays = r.data.payments || [], contracts = r.data.contracts || [];
  const ready = r.data.renderable || {};

  const field = ([key, label, kind, req]) => {
    const raw = d[key];
    const val = kind === 'money' ? (raw == null ? '' : raw / 100) : (raw == null ? '' : raw);
    /* The prospect's name is offered as a PLACEHOLDER on company_name, never pre-filled. prospects.name is
       the Google Places listing and is frequently abbreviated or stylised — "ACME MACHINE" for "Acme
       Machine Works LLC" — and this field goes on a contract. A placeholder puts it in front of the user
       without it being silently adopted; seeding the value would mean a legal entity name nobody typed. */
    const hint = (key === 'company_name' && d.prospect_name) ? d.prospect_name : '';
    const common = 'id="sn-f-' + key + '"'
      + (hint ? ' placeholder="' + snEsc(hint) + ' — check the full legal name"' : '')
      + ' style="width:100%;padding:5px 7px;font-size:13px;border:1px solid var(--border);border-radius:4px"';
    const input = kind === 'textarea'
      ? '<textarea ' + common + ' rows="2">' + snEsc(val) + '</textarea>'
      : '<input ' + common + ' type="' + (kind === 'money' || kind === 'number' ? 'number' : kind)
        + '" value="' + snEsc(val) + '">';
    return '<label style="display:block;margin:0 0 8px">'
      + '<span style="display:block;font-size:11px;color:var(--text-muted);margin-bottom:2px">'
      + snEsc(label) + (req ? ' <span style="color:#b00020">*</span>' : '') + '</span>' + input + '</label>';
  };

  const statusSel = '<select id="sn-f-status" style="padding:5px 7px;font-size:13px;border:1px solid var(--border);border-radius:4px">'
    + SN_DEAL_STATUS.map(s => '<option value="' + s + '"' + (s === d.status ? ' selected' : '') + '>' + s + '</option>').join('')
    + '</select>';

  const payRows = pays.length
    ? pays.map(p => '<tr>'
        + '<td style="padding:4px 8px">' + p.seq + '</td>'
        + '<td style="padding:4px 8px">' + snEsc(p.label) + '</td>'
        + '<td style="padding:4px 8px;font-size:12px">'
          + snEsc(p.due_date ? String(p.due_date).slice(0, 10)
                 : ((SN_TRIGGERS.find(t => t[0] === p.due_trigger) || [, p.due_trigger || ''])[1])) + '</td>'
        + '<td style="padding:4px 8px;text-align:right">' + snMoney(p.amount_cents) + '</td>'
        + '<td style="padding:4px 8px;font-size:12px;color:var(--text-muted)">' + snEsc(p.status) + '</td>'
        + '</tr>').join('')
    : '<tr><td colspan="5" style="padding:8px;color:var(--text-muted);font-size:12px">'
      + 'No installment schedule. The total is payable on invoice.</td></tr>';

  const paySum = pays.reduce((s, p) => s + (p.amount_cents || 0), 0);
  const balanced = !pays.length || paySum === d.value_cents;

  el.innerHTML = '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">'
    + '<h2 style="margin:0">' + snEsc(d.company_name || ('Deal #' + d.id)) + '</h2>'
    + '<button onclick="pages[\'sitenex-deals\']()" class="btn-secondary" style="padding:4px 10px;font-size:12px">Back to the board</button>'
    + '</div>'
    + '<div style="font-size:12px;color:var(--text-muted);margin:2px 0 12px">'
      + 'Deal #' + d.id + ' · ' + (d.partner_name ? 'via ' + snEsc(d.partner_name) : 'self-sourced')
      + (d.package_label ? ' · ' + snEsc(d.package_label) : '')
      /* Which prospect this came from, so the form is traceable back to the row somebody picked. */
      + (d.prospect_name ? ' · from ' + snEsc(d.prospect_name) : '')
      + (d.prospect_phone ? ' · ' + snEsc(d.prospect_phone) : '') + '</div>'
    + '<div id="sn-msg" style="font-size:12px;min-height:16px;margin:0 0 8px"></div>'
    + '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">'

    + '<div style="flex:1;min-width:280px;max-width:460px">'
      + '<h3 style="font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">The client</h3>'
      + SN_DEAL_FIELDS.map(field).join('')
      + '<label style="display:flex;align-items:center;gap:7px;margin:4px 0 10px;font-size:13px">'
        + '<input type="checkbox" id="sn-f-starts_at_intake"' + (d.starts_at_intake === false ? '' : ' checked') + '>'
        /* Default TRUE and stated in words, because the two readings differ by weeks and a contract that
           dates the term from signature while the client has not sent content is a dispute waiting. */
        + '<span>The term starts when <strong>intake completes</strong> (unchecked: on signature)</span>'
        + '</label>'
      + '<div style="display:flex;gap:8px;align-items:center;margin-top:6px">'
        + '<span style="font-size:11px;color:var(--text-muted)">Status</span>' + statusSel
        + '<button onclick="snSaveDeal(' + d.id + ')" class="btn-primary" style="padding:5px 14px;font-size:13px">Save</button>'
        + '</div>'
      + '</div>'

    + '<div style="flex:1;min-width:300px">'
      + '<h3 style="font-size:13px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Payment schedule</h3>'
      + '<table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--white)">'
      + '<tbody>' + payRows + '</tbody></table>'
      + '<div style="font-size:12px;margin-top:6px;color:' + (balanced ? 'var(--text-muted)' : '#b00020') + '">'
        + (pays.length
          ? 'Schedule totals ' + snMoney(paySum) + ' against a deal value of ' + snMoney(d.value_cents)
            + (balanced ? ' — balanced.' : ' — THESE DO NOT MATCH, so a contract cannot be generated.')
          : 'No schedule set.')
        + '</div>'
      + '<div style="margin-top:8px">'
        + '<textarea id="sn-sched" rows="3" placeholder="One installment per line:  Deposit | 2250 | on_signature&#10;On launch | 2250 | on_launch" '
        + 'style="width:100%;padding:6px;font-size:12px;font-family:ui-monospace,monospace;border:1px solid var(--border);border-radius:4px"></textarea>'
        + '<div style="font-size:11px;color:var(--text-muted);margin:2px 0 6px">'
          + 'label | amount in dollars | ' + SN_TRIGGERS.map(t => t[0]).join(' / ')
          + '. Leave empty and save to clear the schedule.</div>'
        + '<button onclick="snSaveSchedule(' + d.id + ')" class="btn-secondary" style="padding:4px 11px;font-size:12px">Save schedule</button>'
        + '</div>'

      + '<h3 style="font-size:13px;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)">Contracts</h3>'
      + (ready.ok === false
        ? '<div style="font-size:12px;color:#8a1f1f;margin-bottom:8px">Still needed before a contract can be generated: '
          + snEsc((ready.missing || []).map(m => m.label).join(', ')) + '</div>'
        : '')
      + '<button onclick="snGenerateContract(' + d.id + ')" class="btn-primary" style="padding:5px 12px;font-size:12px"'
        + (ready.ok === false ? ' disabled title="Fill in the fields listed above first"' : '') + '>'
        + (contracts.length ? 'Generate a replacement' : 'Generate contract') + '</button>'
      + (contracts.length
        ? '<div style="margin-top:8px">' + contracts.map(c =>
            '<div style="padding:5px 0;border-top:1px solid var(--border)'
            + (c.status === 'superseded' || c.status === 'void' ? ';opacity:.55' : '') + '">'
            + '<div style="display:flex;align-items:center;gap:8px;font-size:12px">'
            + '<span style="font-family:ui-monospace,monospace">' + snEsc(c.contract_no) + '</span>'
            + '<span style="color:var(--text-muted)">' + snEsc(c.status) + '</span>'
            + '<button onclick="snDownloadContract(' + c.id + ',\'' + snEsc(c.file_name || '').replace(/'/g, "\\'") + '\')" '
            + 'class="btn-secondary" style="padding:2px 8px;font-size:11px">.docx</button>'
            /* TWO SEPARATE BUTTONS. Generating is above and reversible; this one is not, so it is never
               part of the same click and never happens on its own. */
            + (c.status === 'superseded' || c.status === 'void' ? ''
              : '<button onclick="snEmailContract(' + c.id + ')" class="btn-secondary" '
                + 'style="padding:2px 8px;font-size:11px">Email to client</button>')
            + '</div>'
            + (c.status === 'superseded' || c.status === 'void' ? ''
              : '<div id="sn-to-' + c.id + '" style="margin-top:2px"></div>')
            + '</div>').join('') + '</div>'
        : '')
      + '</div>'
    + '</div>';

  /* The recipient under each button here too — the deal page is where the button was asked for, and the
     address being visible before the click is the property, not a feature of one screen. */
  await snFillRecipients(contracts.map(c => ({ id: c.id, status: c.status })));
};

const snVal = (key) => { const e = document.getElementById('sn-f-' + key); return e ? e.value : undefined; };

window.snSaveDeal = async function snSaveDeal(dealId) {
  const body = { status: snVal('status') };
  for (const [key, , kind] of SN_DEAL_FIELDS) {
    const raw = snVal(key);
    if (raw === undefined) continue;
    if (kind === 'money') {
      /* Dollars in the form, cents on the wire. '' means "clear it", not zero — a blank price field must
         not become $0, which is the same mistake the packages screen already refuses to make. */
      body[key] = raw === '' ? null : Math.round(Number(raw) * 100);
    } else if (kind === 'number') {
      body[key] = raw === '' ? null : Number(raw);
    } else {
      body[key] = raw === '' ? null : raw;
    }
  }
  const cb = document.getElementById('sn-f-starts_at_intake');
  if (cb) body.starts_at_intake = !!cb.checked;
  snToast('Saving…');
  const r = await snSend('PUT', '/sitenex/deals/' + encodeURIComponent(dealId), body);
  if (!r.ok) { snToast(r.error, true); return; }
  snToast('Saved: ' + (r.data.changed || []).join(', '));
  await window.snEditDeal(dealId);
};

/* Parses the textarea into a schedule. Plain text rather than a row-adding widget because the invariant
   is about the SET — it has to sum to the deal value — so it is edited and saved whole. */
function snParseSchedule(text) {
  const rows = [], bad = [];
  String(text || '').split('\n').map(l => l.trim()).filter(Boolean).forEach((line, i) => {
    const parts = line.split('|').map(x => x.trim());
    if (parts.length < 2) { bad.push('line ' + (i + 1) + ': needs at least "label | amount"'); return; }
    const amount = Number(parts[1]);
    if (!Number.isFinite(amount) || amount <= 0) { bad.push('line ' + (i + 1) + ': "' + parts[1] + '" is not a positive amount'); return; }
    const row = { label: parts[0], amount_cents: Math.round(amount * 100) };
    if (parts[2]) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(parts[2])) { row.due_trigger = 'date'; row.due_date = parts[2]; }
      else row.due_trigger = parts[2];
    }
    rows.push(row);
  });
  return { rows, bad };
}

window.snSaveSchedule = async function snSaveSchedule(dealId) {
  const el = document.getElementById('sn-sched');
  const { rows, bad } = snParseSchedule(el ? el.value : '');
  if (bad.length) { snToast(bad.join('; '), true); return; }
  snToast('Saving the schedule…');
  const r = await snSend('PUT', '/sitenex/deals/' + encodeURIComponent(dealId) + '/payments', { payments: rows });
  if (!r.ok) { snToast(r.error, true); return; }
  snToast(rows.length ? rows.length + ' installment(s) totalling ' + snMoney(r.data.total_cents) : 'Schedule cleared');
  await window.snEditDeal(dealId);
};

/* ── the call script and the email, for one prospect ──────────────────────────── */

window.snProspectContent = async function snProspectContent(prospectId, pkgCode) {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="text-body">Building the script…</div>';
  const q = pkgCode ? '?package=' + encodeURIComponent(pkgCode) : '';
  const r = await snGet('/sitenex/prospects/' + encodeURIComponent(prospectId) + '/content' + q);
  if (!r.ok) { el.innerHTML = apErrorCard('Call script', r, "pages['sitenex-prospects']()"); return; }
  const { prospect, call, email } = r.data;

  const section = (title, inner) => '<h3 style="font-size:12px;margin:16px 0 6px;text-transform:uppercase;'
    + 'letter-spacing:.04em;color:var(--text-muted)">' + title + '</h3>' + inner;
  const list = (items) => '<ul style="margin:0;padding-left:18px">'
    + items.map(x => '<li style="margin:2px 0">' + snEsc(x) + '</li>').join('') + '</ul>';

  el.innerHTML = '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">'
    + '<h2 style="margin:0">' + snEsc(prospect.name) + '</h2>'
    + '<button onclick="pages[\'sitenex-prospects\']()" class="btn-secondary" style="padding:4px 10px;font-size:12px">Back</button>'
    + '</div>'
    + '<div style="font-size:12px;color:var(--text-muted);margin:2px 0 4px">'
      + snEsc(prospect.phone || 'no phone listed') + (prospect.region ? ' · ' + snEsc(prospect.region) : '')
      + ' · ' + snEsc(r.data.package_code) + '</div>'
    + '<div id="sn-msg" style="font-size:12px;min-height:16px;margin:0 0 6px"></div>'
    + '<div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start">'

    + '<div style="flex:1;min-width:300px;max-width:560px">'
      + section('Open with', '<p style="margin:0;font-size:15px;line-height:1.45"><strong>' + snEsc(call.opening) + '</strong></p>')
      + section('What they have', list(call.what_they_have))
      + (call.one_other_thing ? section('If it is going well', '<p style="margin:0">' + snEsc(call.one_other_thing) + '</p>') : '')
      + section('What we would do', call.what_wed_do.length ? list(call.what_wed_do)
        : '<p style="margin:0;color:var(--text-muted)">The package has no scope listed.</p>')
      /* The exclusions are not optional and not a footnote. A caller who cannot say "content writing is
         not in this" is the one who accidentally sells it. */
      + section('What this is NOT', call.what_this_is_not.length ? list(call.what_this_is_not)
        : '<p style="margin:0;color:var(--text-muted)">No exclusions are stated for this package.</p>')
      + section('What it costs', '<p style="margin:0">' + snEsc(call.what_it_costs) + '</p>')
      + '</div>'

    + '<div style="flex:1;min-width:300px">'
      + section('If they say…', '<div style="border:1px solid var(--border);border-radius:8px;background:var(--white)">'
        + call.objections.map(o =>
          '<div style="padding:8px 10px;border-bottom:1px solid var(--border)">'
          + '<div style="font-weight:600;font-size:13px">' + snEsc(o.they_say) + '</div>'
          + '<div style="font-size:13px;color:var(--text-body,#333);margin-top:2px">' + snEsc(o.you_say) + '</div>'
          + '</div>').join('') + '</div>')
      + section('Email — paste between your own greeting and sign-off',
        '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">Subject: <strong>' + snEsc(email.subject) + '</strong></div>'
        + '<textarea id="sn-email" rows="14" readonly style="width:100%;padding:8px;font-size:13px;line-height:1.45;'
        + 'border:1px solid var(--border);border-radius:6px;background:var(--white)">' + snEsc(email.body) + '</textarea>'
        + '<div style="display:flex;gap:8px;margin-top:6px">'
        + '<button onclick="snCopyEmail(0)" class="btn-secondary" style="padding:4px 11px;font-size:12px">Copy subject</button>'
        + '<button onclick="snCopyEmail(1)" class="btn-primary" style="padding:4px 11px;font-size:12px">Copy body</button>'
        + '</div>'
        /* Said out loud, because somebody will otherwise look for a Send button and conclude it is broken. */
        + '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">'
        + 'There is no send button. This goes out from your own address, under your own name — nothing is '
        + 'sent from here.</div>')
      + '</div>'
    + '</div>';

  window._snEmail = { subject: email.subject, body: email.body };
};

window.snCopyEmail = async function snCopyEmail(which) {
  const e = window._snEmail || {};
  const text = which ? (e.body || '') : (e.subject || '');
  try {
    await navigator.clipboard.writeText(text);
    snToast(which ? 'Body copied' : 'Subject copied');
  } catch (_) {
    /* Clipboard access can be refused, and silently doing nothing would look like a dead button. */
    const ta = document.getElementById('sn-email');
    if (which && ta) { ta.focus(); ta.select(); snToast('Selected — press Cmd/Ctrl+C', true); }
    else snToast('Could not copy automatically — select the text and copy it', true);
  }
};

/* ── attach ────────────────────────────────────────────────────────────────────
 * `pages` is a top-level const in the inline script, so it is a visible global here. Attached from
 * OUTSIDE the object literal, which is the whole structural point of this file.
 */
pages['sitenex-contracts'] = (typeof apGuard === 'function')
  ? apGuard('sitenex-contracts', 'SiteNex Contracts', snContractsPage)
  : snContractsPage;

/* ── SITENEX PARTNERS: territories, and the out-of-territory approval queue ─────
 *
 * Built because the alternative is an API nobody can use. "Staff approve or reject with a stated reason"
 * describes a person doing something, and a person needs a screen — the deal form shipped complete and
 * unreachable once already, and that is the mistake this page exists not to repeat.
 *
 * PENDING APPROVALS COME FIRST. They are the only thing on this page with a clock on it: a partner has
 * registered a business outside their patch and nobody should start work until somebody here decides.
 */

const SN_DIMENSION_LABEL = { region: 'Region', subtype: 'Vertical', state: 'State' };

async function snPartnersPage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="text-body">Loading partners…</div>';
  const [terr, regs] = await Promise.all([
    snGet('/sitenex/territories'),
    snGet('/sitenex/lead-registrations'),
  ]);
  if (!terr.ok) { el.innerHTML = apErrorCard('SiteNex Partners', terr, "pages['sitenex-partners']()"); return; }
  const territories = (terr.data && terr.data.territories) || [];
  const registrations = (regs.ok && regs.data && regs.data.registrations) || [];
  const pending = registrations.filter(r => r.status === 'pending_approval');

  /* Grouped by partner, because the question is always "what does this firm hold" and never "who holds
     Rockford" — and because a partner with NO territory is the thing worth seeing, which a flat list of
     grants cannot show. */
  const byPartner = new Map();
  for (const t of territories) {
    const k = t.partner_id;
    if (!byPartner.has(k)) byPartner.set(k, { name: t.partner_name || ('partner #' + k), id: k, rows: [] });
    byPartner.get(k).rows.push(t);
  }

  const head = '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">'
    + '<h2 style="margin:0">SiteNex Partners</h2>'
    + '<div style="font-size:12px;color:var(--text-muted)">'
    + byPartner.size + ' partner' + (byPartner.size === 1 ? '' : 's') + ' with a territory · '
    + snEsc((terr.data && terr.data.scope) || '') + '</div></div>'
    /* The model, stated on the screen that could most easily drift from it. */
    + '<div class="text-body" style="margin:6px 0 14px">One product, many partners. Packages, prices, the '
    + 'contract template and the revenue tiers are <strong>identical for everyone</strong> — only territory '
    + 'and achieved volume differ. A partner with no territory sees no prospects at all, which is deliberate: '
    + 'an ungranted patch means nobody has decided, and that reads as nothing.</div>'
    + '<div id="sn-msg" style="font-size:12px;min-height:16px;margin:0 0 8px"></div>';

  /* ── the queue, first ── */
  const queue = '<h3 style="font-size:13px;margin:4px 0 8px;text-transform:uppercase;letter-spacing:.04em;'
    + 'color:' + (pending.length ? '#8a1f1f' : 'var(--text-muted)') + '">'
    + 'Out-of-territory approvals' + (pending.length ? ' — ' + pending.length + ' waiting' : '') + '</h3>'
    + (pending.length
      ? '<div style="border:1px solid #f0c0c0;border-radius:8px;background:#fff8f8;margin-bottom:18px">'
        + pending.map(r =>
          '<div style="padding:9px 11px;border-bottom:1px solid #f0d8d8">'
          + '<div style="font-weight:600;font-size:13px">' + snEsc(r.business_name) + '</div>'
          + '<div style="font-size:11px;color:var(--text-muted);margin-top:1px">'
          +   snEsc([r.partner_name, r.region || r.state, r.subtype && String(r.subtype).replace(/_/g, ' ')]
                .filter(Boolean).join(' · '))
          +   ' · registered ' + snEsc(snDate(r.created_at))
          + '</div>'
          /* The reason box sits WITH the reject button, because a rejection without one is refused by the
             server and discovering that after clicking is a worse way to learn it. */
          + '<div style="display:flex;gap:7px;align-items:center;margin-top:6px;flex-wrap:wrap">'
          + '<input id="sn-why-' + r.id + '" placeholder="Why — required to reject" '
          +   'style="flex:1;min-width:200px;padding:4px 7px;font-size:12px;border:1px solid var(--border);border-radius:4px">'
          + '<button onclick="snDecideLead(' + r.id + ',\'confirmed\')" class="btn-primary" '
          +   'style="padding:3px 11px;font-size:12px">Approve</button>'
          + '<button onclick="snDecideLead(' + r.id + ',\'rejected\')" class="btn-secondary" '
          +   'style="padding:3px 11px;font-size:12px">Reject</button>'
          + '</div></div>').join('')
        + '</div>'
      : '<div style="border:1px dashed var(--border);border-radius:8px;padding:12px;text-align:center;'
        + 'font-size:12px;color:var(--text-muted);margin-bottom:18px">Nothing waiting. '
        + 'Out-of-territory registrations should be rare — this is the backstop, not the path.</div>');

  /* ── territories, per partner ── */
  const grants = '<h3 style="font-size:13px;margin:4px 0 8px;text-transform:uppercase;letter-spacing:.04em;'
    + 'color:var(--text-muted)">Territories</h3>'
    + (byPartner.size
      ? [...byPartner.values()].map(p =>
          '<div style="border:1px solid var(--border);border-radius:8px;background:var(--white);padding:9px 11px;margin-bottom:8px">'
          + '<div style="font-weight:600;font-size:13px">' + snEsc(p.name) + '</div>'
          + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">'
          + p.rows.map(t =>
              '<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:2px 7px;'
              + 'border:1px solid var(--border);border-radius:12px;background:var(--bg-subtle,#f7f7f8)">'
              + '<span style="color:var(--text-muted)">' + snEsc(SN_DIMENSION_LABEL[t.dimension] || t.dimension) + '</span>'
              + snEsc(t.value)
              /* Exclusivity is shown, because a shared patch is a deliberate and unusual arrangement and
                 ought to be visible without opening anything. */
              + (t.exclusive ? '' : '<span style="color:var(--text-muted);font-size:10px">shared</span>')
              + '<a href="#" onclick="snRevokeTerritory(' + t.id + ',\'' + snEsc(String(t.value)).replace(/'/g, "\\'") + '\');return false" '
              +   'title="Revoke" style="text-decoration:none;color:#cbd5e1">✕</a>'
              + '</span>').join('')
          + '</div></div>').join('')
      : '<div style="border:1px dashed var(--border);border-radius:8px;padding:12px;text-align:center;'
        + 'font-size:12px;color:var(--text-muted)">No territories granted yet, so no partner sees any '
        + 'prospects.</div>');

  /* ── granting ── */
  const dims = (terr.data && terr.data.dimensions) || ['region', 'subtype', 'state'];
  const grantForm = '<h3 style="font-size:13px;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.04em;'
    + 'color:var(--text-muted)">Grant a territory</h3>'
    + '<div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">'
    + '<input id="sn-t-partner" type="number" placeholder="Partner id" '
    +   'style="width:100px;padding:5px 7px;font-size:13px;border:1px solid var(--border);border-radius:4px">'
    + '<select id="sn-t-dim" style="padding:5px 7px;font-size:13px;border:1px solid var(--border);border-radius:4px">'
    +   dims.map(d => '<option value="' + d + '">' + snEsc(SN_DIMENSION_LABEL[d] || d) + '</option>').join('')
    + '</select>'
    + '<input id="sn-t-value" placeholder="Rockford, IL  /  machine_shop  /  IL" '
    +   'style="flex:1;min-width:220px;padding:5px 7px;font-size:13px;border:1px solid var(--border);border-radius:4px">'
    + '<label style="display:flex;align-items:center;gap:5px;font-size:12px">'
    +   '<input type="checkbox" id="sn-t-excl" checked> exclusive</label>'
    + '<button onclick="snGrantTerritory()" class="btn-primary" style="padding:5px 12px;font-size:13px">Grant</button>'
    + '</div>'
    /* The constraint said out loud, so a 409 is expected rather than surprising. */
    + '<div style="font-size:11px;color:var(--text-muted);margin-top:5px">'
    + 'An exclusive patch can be held by one partner only — the database refuses the second grant. Uncheck '
    + 'exclusive if two partners are meant to share it.</div>';

  el.innerHTML = head + queue + grants + grantForm;
}

window.snGrantTerritory = async function snGrantTerritory() {
  const body = {
    partner_id: Number((document.getElementById('sn-t-partner') || {}).value),
    dimension: (document.getElementById('sn-t-dim') || {}).value,
    value: (document.getElementById('sn-t-value') || {}).value,
    exclusive: !!(document.getElementById('sn-t-excl') || {}).checked,
  };
  if (!body.partner_id || !body.value) { snToast('A partner id and a value are both needed.', true); return; }
  snToast('Granting…');
  const r = await snSend('POST', '/sitenex/territories', body);
  if (!r.ok) {
    /* The server names who already holds it, which is the only useful version of this refusal. */
    snToast((r.data && r.data.error) || r.error, true);
    return;
  }
  snToast(r.data.note);
  await snPartnersPage();
};

window.snRevokeTerritory = async function snRevokeTerritory(id, label) {
  /* Confirmed, naming the patch: revoking the last one silently blinds a partner, and the server's reply
     says so afterwards — but afterwards is late. */
  if (!confirm('Revoke ' + label + '?\n\nIf it is their last territory they will see no prospects at all.')) return;
  snToast('Revoking…');
  const r = await snSend('DELETE', '/sitenex/territories/' + encodeURIComponent(id));
  if (!r.ok) { snToast((r.data && r.data.error) || r.error, true); return; }
  snToast(r.data.note);
  await snPartnersPage();
};

window.snDecideLead = async function snDecideLead(id, status) {
  const why = ((document.getElementById('sn-why-' + id) || {}).value || '').trim();
  /* Checked HERE as well as on the server, so the requirement is visible before the click rather than
     arriving as a 400. The server is still the one that enforces it. */
  if (status === 'rejected' && why.length < 3) {
    snToast('Say why before rejecting — the partner is owed the sentence.', true);
    const box = document.getElementById('sn-why-' + id);
    if (box) box.focus();
    return;
  }
  snToast(status === 'confirmed' ? 'Approving…' : 'Rejecting…');
  const r = await snSend('PUT', '/sitenex/lead-registrations/' + encodeURIComponent(id),
    { status, decision_reason: why || undefined });
  if (!r.ok) { snToast((r.data && r.data.error) || r.error, true); return; }
  snToast(r.data.note);
  await snPartnersPage();
};

pages['sitenex-partners'] = (typeof apGuard === 'function')
  ? apGuard('sitenex-partners', 'SiteNex Partners', snPartnersPage)
  : snPartnersPage;
