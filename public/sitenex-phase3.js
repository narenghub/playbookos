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
 * an assignment from outside the literal. A syntax error in THIS file also cannot take the app down —
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
  /* The colour is a CLASS, not an inline style, so the two states are defined once in sitenex.css next to
     each other and cannot drift into two different reds. The element always reserves its height (.sn-msg
     has a min-height), so a message appearing never shifts the page under a cursor. */
  el.className = 'sn-msg ' + (bad ? 'bad' : 'ok');
  el.textContent = msg;
}

/* A status pill. The CLASS carries the wire value verbatim (`s-proposal_sent`), because that is the only
   spelling the server uses; only the LABEL is de-underscored. Two spellings of a stage is how a colour
   ends up applying to seven of eight columns. */
const snPill = (status) => '<span class="sn-pill s-' + snEsc(status) + '">'
  + snEsc(String(status || '').replace(/_/g, ' ')) + '</span>';

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
    return '<div class="sn-fine">Sent ' + snEsc(snDate(pv.sent_at))
         + ' to <strong>' + snEsc(pv.to) + '</strong>'
         + (pv.cc ? ' (cc ' + snEsc(pv.cc) + ')' : '') + '</div>';
  }
  if (!pv.can_send) {
    return '<div class="sn-fine is-bad">Cannot email: ' + snEsc(pv.blocked_because) + '</div>';
  }
  return '<div class="sn-fine">Will email <strong>' + snEsc(pv.to) + '</strong>'
       + (pv.cc ? ' and cc <strong>' + snEsc(pv.cc) + '</strong>' : '')
       + ' from ' + snEsc(pv.from) + '</div>'
       + (pv.price ? '<div class="sn-fine">The note will state: ' + snEsc(pv.price) + '</div>'
                   : '<div class="sn-fine is-bad">No price on this contract — the note will say the '
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
  const box = (label, value, hint, cls) =>
    '<div class="sn-stat' + (cls ? ' ' + cls : '') + '">'
    + '<div class="sn-stat-v">' + value + '</div>'
    + '<div class="sn-stat-l">' + snEsc(label) + '</div>'
    + (hint ? '<div class="sn-stat-h">' + snEsc(hint) + '</div>' : '')
    + '</div>';
  return '<div class="sn-stats">'
    + box('Signed — one-time', snMoney(t.signed_one_time_cents),
          t.signed_count + ' contract' + (t.signed_count === 1 ? '' : 's'), 'is-good')
    + box('Signed — monthly', snMoney(t.signed_monthly_cents), 'recurring', 'is-good')
    /* Labelled as a DERIVED figure, not as revenue. One-time plus twelve months of the retainer is an
       arithmetic statement about today's book, not a forecast and not money received. */
    + box('Annualised', snMoney(t.annualised_cents), 'one-time + 12 × monthly')
    + box('Pipeline', snMoney(t.pipeline_cents), t.pipeline_count + ' generated or sent', 'is-quiet')
    + (t.superseded_count
      ? box('Superseded', String(t.superseded_count), 'excluded from every total above', 'is-quiet')
      : '')
    + '</div>';
}

function snContractRow(c) {
  const dead = c.status === 'superseded' || c.status === 'void';
  const opts = SN_CONTRACT_STATUS
    .filter(s => s !== 'superseded')          /* set by generating a replacement, never by hand */
    .map(s => '<option value="' + s + '"' + (s === c.status ? ' selected' : '') + '>' + s + '</option>').join('');
  return '<tr' + (dead ? ' class="is-dead"' : '') + '>'
    + '<td class="sn-mono nowrap">' + snEsc(c.contract_no) + '</td>'
    + '<td><span class="sn-strong">' + snEsc(c.client_company || '') + '</span>'
      + (c.client_contact ? '<span class="sn-sub2">' + snEsc(c.client_contact) + '</span>' : '')
      + '</td>'
    /* ATTRIBUTION: "ACBM Partners · Rockford, IL". The region is the contract's own SNAPSHOT, so an old row
       keeps the place it was signed for even if the prospect has since been re-enumerated. A contract with no
       region — anything generated before the column existed — renders as just the partner rather than with a
       dangling separator.
       The second line uses .sn-sub2, which is the same treatment the client's contact name gets one column
       to the left — it is the same KIND of fact (a qualifier under a name) and ought to look like one. */
    + '<td>'
      + (c.partner_name ? snEsc(c.partner_name) : '<span class="sn-dash">ours</span>')
      + (c.region ? '<span class="sn-sub2">' + snEsc(c.region) + '</span>' : '')
      + '</td>'
    + '<td class="nowrap">' + snEsc(c.package_name || c.package_code || '') + '</td>'
    + '<td class="num nowrap"><span class="sn-strong">' + snMoney(c.value_cents) + '</span>'
      + (c.monthly_cents ? '<span class="sn-sub2">+ ' + snMoney(c.monthly_cents) + '/mo</span>' : '')
      + '</td>'
    + '<td class="nowrap">'
      /* A dead contract shows a PILL, not a dropdown. Its status is a fact about the past: superseded is
         set by generating a replacement and void is terminal, so offering a control that changes neither
         would be offering a control that lies. */
      + (dead
        ? snPill(c.status) + (c.superseded_by ? '<span class="sn-sub2">by #' + snEsc(c.superseded_by) + '</span>' : '')
        : '<select class="sn-select" style="height:26px;padding:2px 6px;font-size:11px" '
          + 'onchange="snSetContractStatus(' + c.id + ',this)">' + opts + '</select>')
      + '</td>'
    + '<td class="sn-fine nowrap">' + snDate(c.created_at) + '</td>'
    + '<td class="sn-fine nowrap">' + snEsc(c.template_version || '') + '</td>'
    + '<td class="nowrap">'
      + '<button onclick="snDownloadContract(' + c.id + ',\'' + snEsc(c.file_name || '').replace(/'/g, "\\'") + '\')" '
      + 'class="btn-secondary sn-btn-xs">.docx</button>'
      /* A SEPARATE BUTTON, and only on a contract that is still current. The address it would go to is
         drawn beneath it by snFillRecipients() once the register has loaded the previews — the point is
         that it is readable without clicking anything. */
      + (dead ? ''
        : ' <button onclick="snEmailContract(' + c.id + ')" class="btn-secondary sn-btn-xs">Email to client</button>')
      + (dead ? '' : '<div id="sn-to-' + c.id + '" style="margin-top:3px"></div>')
      + '</td>'
    + '</tr>';
}

async function snContractsPage() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="text-body">Loading contracts…</div>';
  const r = await snGet('/sitenex/contracts');
  if (!r.ok) { el.innerHTML = apErrorCard('SiteNex Contracts', r, "pages['sitenex-contracts']()"); return; }
  const d = r.data;

  const head = '<div class="sn-head">'
    + '<div><h2>SiteNex Contracts</h2>'
    +   '<p class="sn-sub">Every document generated from a deal, with what it is worth and whether it has '
    +     'been signed. Generating is reversible — a replacement supersedes the old one. <strong>Emailing is '
    +     'not</strong>, so it is a separate button and the address is shown before it is pressed.</p></div>'
    + '<div class="sn-head-right"><span class="sn-count">' + d.total + ' in the register · ' + snEsc(d.scope) + '</span></div>'
    + '</div>'
    + '<div id="sn-msg" class="sn-msg"></div>';

  if (!d.contracts.length) {
    el.innerHTML = '<div class="sn">' + head
      + '<div class="sn-empty">'
      + '<strong>No contracts yet.</strong>'
      + 'Open a deal on the SiteNex Deals board and generate one from there — a contract is always made '
      + 'from a deal, so the client details and the payment schedule can only say one thing.'
      + '</div></div>';
    return;
  }

  const th = (t, right) => '<th' + (right ? ' class="num"' : '') + '>' + t + '</th>';
  el.innerHTML = '<div class="sn">' + head + snTotalsCard(d.totals)
    + '<div class="sn-panel"><div class="sn-table-wrap">'
    + '<table class="sn-table">'
    + '<thead><tr>' + th('Contract') + th('Client') + th('Partner') + th('Package') + th('Value', true)
    + th('Status') + th('Generated') + th('Template') + th('') + '</tr></thead>'
    + '<tbody>' + d.contracts.map(snContractRow).join('') + '</tbody>'
    + '</table></div></div></div>';

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
      : '<div class="sn-fine">could not read the recipient: ' + snEsc(pv.error) + '</div>';
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
      + (hint ? ' placeholder="' + snEsc(hint) + ' — check the full legal name"' : '');
    const input = kind === 'textarea'
      ? '<textarea class="sn-textarea" ' + common + ' rows="2">' + snEsc(val) + '</textarea>'
      : '<input class="sn-input" ' + common + ' type="' + (kind === 'money' || kind === 'number' ? 'number' : kind)
        + '" value="' + snEsc(val) + '">';
    /* An address and a free-text note span the grid. Everything else is a short value and sits two to a
       row, which turns a ten-field scroll into something readable without moving. */
    const wide = (key === 'client_address' || kind === 'textarea');
    return '<label class="sn-field' + (wide ? ' wide' : '') + '">'
      + '<span>' + snEsc(label) + (req ? ' <span class="req">*</span>' : '') + '</span>' + input + '</label>';
  };

  const statusSel = '<select id="sn-f-status" class="sn-select">'
    + SN_DEAL_STATUS.map(s => '<option value="' + s + '"' + (s === d.status ? ' selected' : '') + '>'
      + s.replace(/_/g, ' ') + '</option>').join('')
    + '</select>';

  const payRows = pays.length
    ? pays.map(p => '<tr>'
        + '<td class="sn-dash">' + p.seq + '</td>'
        + '<td class="sn-strong">' + snEsc(p.label) + '</td>'
        + '<td class="sn-fine">'
          + snEsc(p.due_date ? String(p.due_date).slice(0, 10)
                 : ((SN_TRIGGERS.find(t => t[0] === p.due_trigger) || [, p.due_trigger || ''])[1])) + '</td>'
        + '<td class="num sn-strong">' + snMoney(p.amount_cents) + '</td>'
        + '<td class="sn-fine">' + snEsc(p.status) + '</td>'
        + '</tr>').join('')
    : '<tr><td colspan="5" class="sn-fine" style="padding:12px">'
      + 'No installment schedule. The total is payable on invoice.</td></tr>';

  const paySum = pays.reduce((s, p) => s + (p.amount_cents || 0), 0);
  const balanced = !pays.length || paySum === d.value_cents;

  el.innerHTML = '<div class="sn">'
    /* is-record: this heading is the CLIENT'S NAME, not the screen's — see sitenex.css. */
    + '<div class="sn-head is-record">'
    + '<div><h2>' + snEsc(d.company_name || ('Deal #' + d.id)) + '</h2>'
    +   '<p class="sn-sub">Deal #' + d.id + ' · ' + (d.partner_name ? 'via ' + snEsc(d.partner_name) : 'self-sourced')
    +     (d.package_label ? ' · ' + snEsc(d.package_label) : '')
        /* Which prospect this came from, so the form is traceable back to the row somebody picked. */
    +     (d.prospect_name ? ' · from ' + snEsc(d.prospect_name) : '')
    +     (d.prospect_phone ? ' · ' + snEsc(d.prospect_phone) : '') + '</p></div>'
    + '<div class="sn-head-right">' + snPill(d.status)
    +   '<button onclick="pages[\'sitenex-deals\']()" class="btn-secondary sn-btn-sm">Back to the board</button>'
    + '</div></div>'
    + '<div id="sn-msg" class="sn-msg"></div>'
    + '<div class="sn-cols">'

    /* ── left: the client ── */
    + '<div class="sn-panel">'
      + '<div class="sn-panel-head"><h3>The client</h3>'
      +   '<span class="sn-note">these go on the contract verbatim</span></div>'
      + '<div class="sn-panel-body">'
      + '<div class="sn-form">' + SN_DEAL_FIELDS.map(field).join('') + '</div>'
      + '<label class="sn-check" style="margin-top:12px">'
        + '<input type="checkbox" id="sn-f-starts_at_intake"' + (d.starts_at_intake === false ? '' : ' checked') + '>'
        /* Default TRUE and stated in words, because the two readings differ by weeks and a contract that
           dates the term from signature while the client has not sent content is a dispute waiting. */
        + '<span>The term starts when <strong>intake completes</strong> — unchecked, it starts on signature. '
        + 'The two can differ by weeks.</span>'
        + '</label>'
      + '<div class="sn-actions">'
        + '<span class="sn-field" style="flex-direction:row;align-items:center;gap:7px">'
        +   '<span>Status</span>' + statusSel + '</span>'
        + '<span class="sn-spacer"></span>'
        + '<button onclick="snSaveDeal(' + d.id + ')" class="btn-primary sn-btn-sm">Save</button>'
        + '</div>'
      + '</div></div>'

    /* ── right: money, then the contract ── */
    + '<div>'
      + '<div class="sn-panel">'
      + '<div class="sn-panel-head"><h3>Payment schedule</h3>'
      /* THE BALANCE IS IN THE HEADER, not under the textarea. It is the reason a contract will or will not
         generate, so it belongs where somebody looks before reading the rows, not after. */
      +   '<span class="sn-note' + (balanced ? '' : '" style="color:#b42318;font-weight:600') + '">'
      +     (pays.length
            ? (balanced ? 'balanced at ' + snMoney(paySum)
                        : snMoney(paySum) + ' vs a deal value of ' + snMoney(d.value_cents))
            : 'none set')
      +   '</span></div>'
      + '<div class="sn-table-wrap"><table class="sn-table"><tbody>' + payRows + '</tbody></table></div>'
      + '<div class="sn-panel-body" style="border-top:1px solid var(--sn-line)">'
        + (pays.length && !balanced
          ? '<div class="sn-fine is-bad" style="margin-bottom:8px">These do not match, so a contract cannot '
            + 'be generated. Either change the deal value or re-enter the installments below.</div>'
          : '')
        + '<textarea id="sn-sched" class="sn-textarea sn-mono" rows="3" style="width:100%" '
        + 'placeholder="One installment per line:  Deposit | 2250 | on_signature&#10;On launch | 2250 | on_launch"></textarea>'
        + '<div class="sn-fine" style="margin:4px 0 10px">'
          + 'label | amount in dollars | ' + SN_TRIGGERS.map(t => t[0]).join(' / ')
          + '. Saved whole — leave it empty and save to clear the schedule.</div>'
        + '<button onclick="snSaveSchedule(' + d.id + ')" class="btn-secondary sn-btn-sm">Save schedule</button>'
        + '</div></div>'

      + '<div class="sn-panel">'
      + '<div class="sn-panel-head"><h3>Contract</h3>'
      +   '<span class="sn-note">' + (contracts.length ? contracts.length + ' generated' : 'none yet') + '</span></div>'
      + '<div class="sn-panel-body">'
      + (ready.ok === false
        ? '<div class="sn-fine is-bad" style="margin-bottom:10px">Still needed before a contract can be '
          + 'generated: <strong>' + snEsc((ready.missing || []).map(m => m.label).join(', ')) + '</strong></div>'
        : '')
      + '<button onclick="snGenerateContract(' + d.id + ')" class="btn-primary sn-btn-sm"'
        + (ready.ok === false ? ' disabled title="Fill in the fields listed above first"' : '') + '>'
        + (contracts.length ? 'Generate a replacement' : 'Generate contract') + '</button>'
      + (contracts.length
        ? '<div style="margin-top:12px">' + contracts.map(c => {
            const dead = c.status === 'superseded' || c.status === 'void';
            return '<div class="sn-obj"' + (dead ? ' style="opacity:.5"' : '') + '>'
            + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
            + '<span class="sn-mono">' + snEsc(c.contract_no) + '</span>'
            + snPill(c.status)
            + '<button onclick="snDownloadContract(' + c.id + ',\'' + snEsc(c.file_name || '').replace(/'/g, "\\'") + '\')" '
            + 'class="btn-secondary sn-btn-xs">.docx</button>'
            /* TWO SEPARATE BUTTONS. Generating is above and reversible; this one is not, so it is never
               part of the same click and never happens on its own. */
            + (dead ? '' : '<button onclick="snEmailContract(' + c.id + ')" class="btn-secondary sn-btn-xs">Email to client</button>')
            + '</div>'
            + (dead ? '' : '<div id="sn-to-' + c.id + '" style="margin-top:3px"></div>')
            + '</div>';
          }).join('') + '</div>'
        : '')
      + '</div></div>'

      + '</div>'
    + '</div>'

    /* CLIENT INTAKE. An empty container, filled by snIntakePanel after the form is on screen: the deal
       form is what somebody opened this page for and should not wait on four more queries, and a failure
       in the panel must leave the form usable rather than replacing it.
       It sits BELOW the two columns rather than inside the right one: intake is the client's side of the
       work and runs the full width, and putting it in a column would have wedged a file list into 44% of
       the page under the contract buttons. */
    /* The panel's own contents are still inline-styled — it landed while the restyle was in flight and has
       not been converted. Giving it the container means it at least sits in a card like everything else on
       this page instead of floating as loose text; converting its insides is a follow-up, and a small one. */
    + '<div class="sn-panel"><div class="sn-panel-head"><h3>Client intake</h3></div>'
    + '<div class="sn-panel-body" id="sn-intake"></div></div>'
    + '</div>';

  /* The recipient under each button here too — the deal page is where the button was asked for, and the
     address being visible before the click is the property, not a feature of one screen. */
  await snFillRecipients(contracts.map(c => ({ id: c.id, status: c.status })));
  await snIntakePanel(d.id);
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

  const section = (title, inner) => '<div class="sn-label" style="margin-top:16px">' + title + '</div>' + inner;
  const list = (items) => '<ul class="sn-list">'
    + items.map(x => '<li>' + snEsc(x) + '</li>').join('') + '</ul>';

  el.innerHTML = '<div class="sn">'
    /* is-record: the business being called. A phone script with no business name on it is unusable. */
    + '<div class="sn-head is-record">'
    + '<div><h2>' + snEsc(prospect.name) + '</h2>'
    +   '<p class="sn-sub">' + snEsc(prospect.phone || 'no phone listed')
    +     (prospect.region ? ' · ' + snEsc(prospect.region) : '')
    +     ' · ' + snEsc(r.data.package_code) + '</p></div>'
    + '<div class="sn-head-right">'
    +   (prospect.phone
        ? '<a class="btn-primary sn-btn-sm" style="text-decoration:none" href="tel:'
          + snEsc(String(prospect.phone).replace(/[^0-9+]/g, '')) + '">Call</a>'
        : '')
    +   '<button onclick="pages[\'sitenex-prospects\']()" class="btn-secondary sn-btn-sm">Back</button>'
    + '</div></div>'
    + '<div id="sn-msg" class="sn-msg"></div>'
    + '<div class="sn-cols">'

    + '<div class="sn-panel"><div class="sn-panel-head"><h3>On the phone</h3>'
    +   '<span class="sn-note">read down the page</span></div>'
    +   '<div class="sn-panel-body">'
      /* The opening is the only thing on this page set bigger than body text. It is the sentence that is
         actually said out loud in the first four seconds, and on the old screen it was the same size as
         the bullet list under it. */
      + '<div class="sn-label" style="margin-top:0">Open with</div>'
      + '<p class="sn-script-open">' + snEsc(call.opening) + '</p>'
      + section('What they have', list(call.what_they_have))
      + (call.one_other_thing ? section('If it is going well', '<p class="sn-prose">' + snEsc(call.one_other_thing) + '</p>') : '')
      + section('What we would do', call.what_wed_do.length ? list(call.what_wed_do)
        : '<p class="sn-prose sn-dash">The package has no scope listed.</p>')
      /* The exclusions are not optional and not a footnote. A caller who cannot say "content writing is
         not in this" is the one who accidentally sells it. */
      + section('What this is NOT', call.what_this_is_not.length ? list(call.what_this_is_not)
        : '<p class="sn-prose sn-dash">No exclusions are stated for this package.</p>')
      + section('What it costs', '<p class="sn-prose">' + snEsc(call.what_it_costs) + '</p>')
      + '</div></div>'

    + '<div>'
      + '<div class="sn-panel"><div class="sn-panel-head"><h3>If they say…</h3></div>'
      + '<div class="sn-panel-body">'
        + call.objections.map(o =>
          '<div class="sn-obj">'
          + '<div class="sn-obj-q">' + snEsc(o.they_say) + '</div>'
          + '<div class="sn-obj-a">' + snEsc(o.you_say) + '</div>'
          + '</div>').join('')
      + '</div></div>'

      + '<div class="sn-panel"><div class="sn-panel-head"><h3>The email</h3>'
      +   '<span class="sn-note">paste between your own greeting and sign-off</span></div>'
      + '<div class="sn-panel-body">'
        + '<div class="sn-fine" style="margin-bottom:5px">Subject: <strong>' + snEsc(email.subject) + '</strong></div>'
        + '<textarea id="sn-email" class="sn-textarea" rows="14" readonly style="width:100%;font-size:13px">'
        + snEsc(email.body) + '</textarea>'
        + '<div class="sn-actions" style="margin-top:10px;padding-top:0;border-top:0">'
        + '<button onclick="snCopyEmail(0)" class="btn-secondary sn-btn-sm">Copy subject</button>'
        + '<button onclick="snCopyEmail(1)" class="btn-primary sn-btn-sm">Copy body</button>'
        + '</div>'
        /* Said out loud, because somebody will otherwise look for a Send button and conclude it is broken. */
        + '<div class="sn-fine" style="margin-top:8px">'
        + 'There is no send button. This goes out from your own address, under your own name — nothing is '
        + 'sent from here.</div>'
      + '</div></div>'
      + '</div>'
    + '</div></div>';

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

  const head = '<div class="sn-head">'
    + '<div><h2>SiteNex Partners</h2>'
    /* The model, stated on the screen that could most easily drift from it. */
    +   '<p class="sn-sub">One product, many partners. Packages, prices, the contract template and the '
    +     'revenue tiers are <strong>identical for everyone</strong> — only territory and achieved volume '
    +     'differ. A partner with no territory sees no prospects at all: an ungranted patch means nobody '
    +     'has decided, and that reads as nothing.</p></div>'
    + '<div class="sn-head-right"><span class="sn-count">'
    +   byPartner.size + ' partner' + (byPartner.size === 1 ? '' : 's') + ' with a territory · '
    +   snEsc((terr.data && terr.data.scope) || '') + '</span></div></div>'
    + '<div id="sn-msg" class="sn-msg"></div>';

  /* ── the queue, first ── */
  const queue = '<div class="sn-label' + (pending.length ? ' is-alert' : '') + '">'
    + 'Out-of-territory approvals' + (pending.length ? ' — ' + pending.length + ' waiting' : '') + '</div>'
    + (pending.length
      ? '<div class="sn-attn">'
        + pending.map(r =>
          '<div class="sn-attn-row">'
          + '<div class="sn-attn-name">' + snEsc(r.business_name) + '</div>'
          + '<div class="sn-attn-meta">'
          +   snEsc([r.partner_name, r.region || r.state, r.subtype && String(r.subtype).replace(/_/g, ' ')]
                .filter(Boolean).join(' · '))
          +   ' · registered ' + snEsc(snDate(r.created_at))
          + '</div>'
          /* The reason box sits WITH the reject button, because a rejection without one is refused by the
             server and discovering that after clicking is a worse way to learn it. */
          + '<div class="sn-attn-act">'
          + '<input id="sn-why-' + r.id + '" class="sn-input sn-grow" placeholder="Why — required to reject">'
          + '<button onclick="snDecideLead(' + r.id + ',\'confirmed\')" class="btn-primary sn-btn-sm">Approve</button>'
          + '<button onclick="snDecideLead(' + r.id + ',\'rejected\')" class="btn-secondary sn-btn-sm">Reject</button>'
          + '</div></div>').join('')
        + '</div>'
      : '<div class="sn-empty" style="margin-bottom:16px"><strong>Nothing waiting.</strong>'
        + 'Out-of-territory registrations should be rare — this is the backstop, not the path.</div>');

  /* ── territories, per partner ── */
  const grants = '<div class="sn-label">Territories</div>'
    + (byPartner.size
      ? [...byPartner.values()].map(p =>
          '<div class="sn-panel">'
          + '<div class="sn-panel-head"><h3>' + snEsc(p.name) + '</h3>'
          +   '<span class="sn-note">' + p.rows.length + ' granted</span></div>'
          + '<div class="sn-panel-body" style="display:flex;gap:7px;flex-wrap:wrap">'
          + p.rows.map(t =>
              '<span class="sn-tag">'
              + '<span class="sn-tag-dim">' + snEsc(SN_DIMENSION_LABEL[t.dimension] || t.dimension) + '</span>'
              + snEsc(t.value)
              /* Exclusivity is shown, because a shared patch is a deliberate and unusual arrangement and
                 ought to be visible without opening anything. */
              + (t.exclusive ? '' : '<span class="sn-tag-shared">shared</span>')
              + '<a href="#" class="sn-x" onclick="snRevokeTerritory(' + t.id + ',\'' + snEsc(String(t.value)).replace(/'/g, "\\'") + '\');return false" '
              +   'title="Revoke">✕</a>'
              + '</span>').join('')
          + '</div></div>').join('')
      : '<div class="sn-empty"><strong>No territories granted yet, so no partner sees any prospects.</strong>'
        + 'Grant one below. A region is the usual first grant — it is the patch a partner actually works.</div>');

  /* ── granting ── */
  const dims = (terr.data && terr.data.dimensions) || ['region', 'subtype', 'state'];
  const grantForm = '<div class="sn-panel" style="margin-top:16px">'
    + '<div class="sn-panel-head"><h3>Grant a territory</h3>'
    /* The constraint said out loud, so a 409 is expected rather than surprising.
       KEPT IN ONE STRING LITERAL. It used to be split across a concatenation, and the test that asserts
       this sentence exists had to match it in halves — which means the test would pass on a page that
       said the two halves in different places, or in the wrong order. */
    +   '<span class="sn-note">an exclusive patch can be held by one partner only — the database refuses the second grant</span></div>'
    + '<div class="sn-panel-body">'
    + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + '<input id="sn-t-partner" class="sn-input" type="number" placeholder="Partner id" style="width:104px">'
    + '<select id="sn-t-dim" class="sn-select">'
    +   dims.map(d => '<option value="' + d + '">' + snEsc(SN_DIMENSION_LABEL[d] || d) + '</option>').join('')
    + '</select>'
    + '<input id="sn-t-value" class="sn-input sn-grow" placeholder="Rockford, IL  /  machine_shop  /  IL">'
    + '<label class="sn-check" style="align-items:center">'
    +   '<input type="checkbox" id="sn-t-excl" checked><span>exclusive</span></label>'
    + '<button onclick="snGrantTerritory()" class="btn-primary sn-btn-sm">Grant</button>'
    + '</div>'
    + '<div class="sn-fine" style="margin-top:8px">Uncheck exclusive if two partners are meant to share it. '
    + 'Revoking a partner’s last territory blinds them to every prospect.</div>'
    + '</div></div>';

  el.innerHTML = '<div class="sn">' + head + queue + grants + grantForm + '</div>';
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

/* ══ (6) CLIENT INTAKE — the staff panel on the deal page ═══════════════════════

   Issuing the link, seeing what came back, naming the developer, and reading the brief.

   LOADED SEPARATELY from the deal, into a container the deal page renders empty. The deal form is what
   somebody opened this screen for; it should not wait on four more queries to appear, and a failure here
   must leave the form usable rather than replacing it with an error card.

   WHAT THIS SCREEN MAY DO comes from the server (can_manage), not from a role check here. `currentUser`
   is script-scoped inside index.html's inline script and is NOT on window, so reading it from this file
   returns undefined and every user falls into the same branch — the bug that comment exists to prevent. */

const snBytes = (b) => {
  b = Number(b || 0);
  return b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB'
    : (Math.round((b / 1048576) * 10) / 10) + ' MB';
};

window.snIntakePanel = async function snIntakePanel(dealId) {
  const box = document.getElementById('sn-intake');
  if (!box) return;
  box.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Loading intake…</div>';
  const r = await snGet('/sitenex/deals/' + encodeURIComponent(dealId) + '/intake');
  if (!r.ok) {
    /* Not apErrorCard: that replaces the whole page, and the deal form above is still perfectly usable. */
    box.innerHTML = '<div style="font-size:12px;color:#8a1f1f">Could not load the intake: '
      + snEsc(r.error || 'unknown error') + '</div>';
    return;
  }
  const d = r.data, link = d.live_link, ik = d.intake, files = d.files || [], proj = d.project;
  const q = d.quota || { used_bytes: 0, limit_bytes: 1, remaining_bytes: 0 };
  const pct = Math.min(100, Math.round((q.used_bytes / q.limit_bytes) * 100));
  const manage = !!d.can_manage;
  const done = !!(ik && ik.completed_at);
  const h = [];

  /* ── the link ─────────────────────────────────────────────────────────────── */
  h.push('<div style="font-size:12px;margin-bottom:8px">');
  if (done) {
    h.push('<span style="color:#1a6b3c;font-weight:600">Intake complete</span> '
      + '<span style="color:var(--text-muted)">' + snDate(ik.completed_at)
      + ' — the link was switched off automatically.</span>');
  } else if (link) {
    const days = Math.ceil((new Date(link.expires_at) - Date.now()) / 86400000);
    h.push('<span style="color:#1a6b3c;font-weight:600">Link live</span>'
      + ' <span style="color:var(--text-muted)">ending <span style="font-family:ui-monospace,monospace">'
      + snEsc(link.token_tail) + '</span>'
      + ', expires in ' + days + ' day' + (days === 1 ? '' : 's')
      + (link.last_used_at ? ', last used ' + snDate(link.last_used_at) : ', not opened yet')
      + ' (' + link.request_count + ' request' + (link.request_count === 1 ? '' : 's') + ')</span>');
  } else {
    h.push('<span style="color:var(--text-muted)">No live link'
      + (d.links && d.links.length ? ' — ' + d.links.length + ' previously issued' : '') + '.</span>');
  }
  h.push('</div>');

  if (manage && !done) {
    h.push('<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px">');
    h.push('<button onclick="snIssueIntakeLink(' + dealId + ',' + (link ? 'true' : 'false') + ')" '
      + 'class="btn-' + (link ? 'secondary' : 'primary') + '" style="padding:4px 11px;font-size:12px">'
      + (link ? 'Issue a new link' : 'Issue intake link') + '</button>');
    if (link) {
      h.push('<button onclick="snRevokeIntakeLink(' + dealId + ')" class="btn-secondary" '
        + 'style="padding:4px 11px;font-size:12px">Revoke</button>');
    }
    h.push('</div>');
    /* WHERE THE TOKEN APPEARS, once. Nothing reads it back — it is not stored. */
    h.push('<div id="sn-intake-url"></div>');
  }

  /* ── what they have sent ──────────────────────────────────────────────────── */
  if (ik) {
    const answered = Object.keys(ik.fields || {}).filter(k => {
      const v = ik.fields[k];
      return v != null && v !== '' && !(Array.isArray(v) && !v.length);
    });
    h.push('<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">'
      + answered.length + ' answer' + (answered.length === 1 ? '' : 's') + ' · '
      + files.length + ' file' + (files.length === 1 ? '' : 's') + ' · '
      + snBytes(q.used_bytes) + ' of ' + snBytes(q.limit_bytes) + '</div>');
    h.push('<div style="height:4px;background:var(--border);border-radius:99px;overflow:hidden;margin-bottom:8px">'
      + '<div style="height:100%;width:' + pct + '%;background:'
      + (pct > 90 ? '#8a1f1f' : 'var(--accent, #1f6feb)') + '"></div></div>');

    if ((ik.missing || []).length) {
      h.push('<div style="font-size:12px;color:#8a5a00;margin-bottom:8px">Still outstanding: '
        + snEsc(ik.missing.join(', ')) + '</div>');
    }
    if (answered.length) {
      h.push('<div style="margin-bottom:8px">' + answered.map(k => {
        const v = ik.fields[k];
        const text = Array.isArray(v) ? v.join(', ') : String(v);
        return '<div style="font-size:12px;padding:3px 0;border-top:1px solid var(--border)">'
          + '<span style="color:var(--text-muted)">' + snEsc(k) + '</span> '
          + snEsc(text.length > 240 ? text.slice(0, 240) + '…' : text) + '</div>';
      }).join('') + '</div>');
    }
    if (files.length) {
      h.push('<div style="margin-bottom:8px">' + files.map(f =>
        '<div style="display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0;border-top:1px solid var(--border)">'
        + '<span style="flex:1">' + snEsc(f.file_name)
        + (f.field ? ' <span style="color:var(--text-muted)">(' + snEsc(f.field) + ')</span>' : '') + '</span>'
        + '<span style="color:var(--text-muted)">' + snBytes(f.file_size) + '</span>'
        + '<button onclick="snDownloadIntakeFile(' + f.id + ',\'' + snEsc(f.file_name).replace(/'/g, "\\'") + '\')" '
        + 'class="btn-secondary" style="padding:2px 8px;font-size:11px">Download</button>'
        + '</div>').join('') + '</div>');
    }
  } else {
    h.push('<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">'
      + 'Nothing sent yet.</div>');
  }

  if (manage && !done && ik) {
    h.push('<button onclick="snCompleteIntake(' + dealId + ')" class="btn-secondary" '
      + 'style="padding:4px 11px;font-size:12px;margin-bottom:10px">Mark intake complete</button>');
  }

  /* ── the developer, and the brief ─────────────────────────────────────────── */
  if (proj) {
    h.push('<div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px">');
    h.push('<div style="font-size:12px;margin-bottom:6px">'
      + '<span style="color:var(--text-muted)">Developer</span> '
      + (proj.assigned_to_name
        ? '<strong>' + snEsc(proj.assigned_to_name) + '</strong>'
        /* NO ALGORITHM CHOSE THIS and none ever will — capacity is the constraint and nothing in the
           database knows it. Said plainly so nobody waits for an assignment that is not coming. */
        : '<span style="color:#8a5a00">nobody yet — this is a decision, not something we can infer</span>')
      + '</div>');
    if (manage && (d.developers || []).length) {
      h.push('<div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">'
        + '<select id="sn-dev" style="padding:4px 6px;font-size:12px;border:1px solid var(--border);border-radius:4px">'
        + '<option value="">— nobody —</option>'
        + d.developers.map(u => '<option value="' + snEsc(u.id) + '"'
            + (u.id === proj.assigned_to ? ' selected' : '') + '>' + snEsc(u.name) + '</option>').join('')
        + '</select>'
        + '<button onclick="snAssignDeveloper(' + proj.id + ',' + dealId + ')" class="btn-secondary" '
        + 'style="padding:4px 11px;font-size:12px">Assign</button></div>');
    }
    if (proj.brief) {
      h.push('<details style="font-size:12px"><summary style="cursor:pointer;color:var(--text-muted)">'
        + 'Brief (' + snEsc(proj.brief_model || 'generated') + ', ' + snDate(proj.brief_generated_at) + ')</summary>'
        + '<div style="white-space:pre-wrap;margin-top:6px;padding:8px;background:var(--bg-subtle,#f6f7f9);'
        + 'border-radius:6px">' + snEsc(proj.brief) + '</div></details>');
    } else if (proj.brief_error) {
      /* SHOWN, not swallowed. A failed brief is a missing convenience, never a missing handover — the
         task carries the raw intake either way — but somebody should be able to see that it failed and
         press the button again rather than wonder where it went. */
      h.push('<div style="font-size:12px;color:#8a1f1f">The brief could not be generated: '
        + snEsc(proj.brief_error) + '</div>');
    }
    if (manage && done) {
      h.push('<button onclick="snRegenerateBrief(' + dealId + ')" class="btn-secondary" '
        + 'style="padding:3px 10px;font-size:11px;margin-top:6px">'
        + (proj.brief ? 'Regenerate brief' : 'Generate brief') + '</button>');
    }
    h.push('</div>');
  }

  box.innerHTML = h.join('');
};

/* ISSUING INVALIDATES THE PREVIOUS LINK, so the confirmation says so.

   A client who is halfway through uploading photos loses their link the moment somebody presses this,
   and the only symptom they see is a page that stops working. That is not something to discover from a
   support email, so the destructive half of the action is named before the click and not after. */
window.snIssueIntakeLink = async function snIssueIntakeLink(dealId, replacing) {
  if (replacing && !confirm(
      'Issue a NEW intake link?\n\n'
    + 'The link this client already has will stop working immediately — if they are part way through '
    + 'uploading, they will need the new one.\n\n'
    + 'Only do this if the old link is lost or has expired.')) return;

  const r = await snSend('POST', '/sitenex/deals/' + encodeURIComponent(dealId) + '/intake-link');
  if (!r.ok) { snToast(r.error, true); return; }

  /* SHOWN ONCE, in a selectable box, with the reason it cannot be shown again. We store a hash, not the
     token — so "copy this now" is a real constraint and not an interface affectation. */
  const el = document.getElementById('sn-intake-url');
  if (el) {
    el.innerHTML = '<div style="border:1px solid #c8a84a;background:#fffbeb;border-radius:6px;padding:9px;margin-bottom:10px">'
      + '<div style="font-size:11px;font-weight:600;color:#8a5a00;margin-bottom:4px">'
      + 'COPY THIS NOW — it cannot be shown again</div>'
      + '<input id="sn-intake-url-input" readonly value="' + snEsc(r.data.url) + '" '
      + 'style="width:100%;padding:5px 7px;font-size:12px;font-family:ui-monospace,monospace;'
      + 'border:1px solid var(--border);border-radius:4px;background:#fff">'
      + '<div style="font-size:11px;color:#8a5a00;margin-top:4px">' + snEsc(r.data.note) + '</div>'
      + '<button onclick="snCopyIntakeUrl()" class="btn-secondary" style="padding:3px 10px;font-size:11px;margin-top:6px">Copy link</button>'
      + '</div>';
    const input = document.getElementById('sn-intake-url-input');
    if (input) { input.focus(); input.select(); }
  }
  snToast('Link issued. Copy it before you leave this page.');
};

window.snCopyIntakeUrl = async function snCopyIntakeUrl() {
  const input = document.getElementById('sn-intake-url-input');
  if (!input) return;
  input.select();
  try { await navigator.clipboard.writeText(input.value); snToast('Copied.'); }
  catch (e) { snToast('Copy it by hand — the browser refused clipboard access.', true); }
};

window.snRevokeIntakeLink = async function snRevokeIntakeLink(dealId) {
  if (!confirm('Revoke this intake link?\n\nThe client will not be able to upload anything until you issue a new one.')) return;
  const r = await snSend('DELETE', '/sitenex/deals/' + encodeURIComponent(dealId) + '/intake-link');
  if (!r.ok) { snToast(r.error, true); return; }
  snToast(r.data.message || 'Revoked.');
  await snIntakePanel(dealId);
};

window.snCompleteIntake = async function snCompleteIntake(dealId) {
  if (!confirm('Mark this intake complete?\n\nThis switches the client\'s upload link off and creates the build task.')) return;
  const r = await snSend('POST', '/sitenex/deals/' + encodeURIComponent(dealId) + '/intake/complete');
  if (!r.ok) { snToast(r.error, true); return; }
  snToast(r.data.already ? 'It was already complete.'
    : 'Intake complete — the task went to ' + (r.data.assignee && r.data.assignee.rule || 'the deal owner') + '.');
  await snIntakePanel(dealId);
};

window.snAssignDeveloper = async function snAssignDeveloper(projectId, dealId) {
  const sel = document.getElementById('sn-dev');
  if (!sel) return;
  const r = await snSend('PUT', '/sitenex/projects/' + encodeURIComponent(projectId),
    { assigned_to: sel.value || null });
  if (!r.ok) { snToast(r.error, true); return; }
  snToast(sel.value ? 'Assigned.' : 'Unassigned.');
  await snIntakePanel(dealId);
};

window.snRegenerateBrief = async function snRegenerateBrief(dealId) {
  snToast('Generating the brief…');
  const r = await snSend('POST', '/sitenex/deals/' + encodeURIComponent(dealId) + '/brief');
  if (!r.ok) { snToast(r.error, true); return; }
  snToast('Brief generated.');
  await snIntakePanel(dealId);
};

/* A bare href would 401: these bytes need the Authorization header, so the file is fetched and clicked
   as a blob — the same arrangement as the contract download above. */
window.snDownloadIntakeFile = async function snDownloadIntakeFile(id, fileName) {
  try {
    const res = await fetch('/api/sitenex/intake-files/' + encodeURIComponent(id),
      { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
    if (!res.ok) {
      let msg = 'Download failed (' + res.status + ')';
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
      snToast(msg, true); return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName || ('intake-file-' + id);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) { snToast('Download failed: ' + e.message, true); }
};
