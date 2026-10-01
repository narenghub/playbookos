/* ── LABCONNECT UI ─────────────────────────────────────────────────────────────
 *
 * A SEPARATE FILE, loaded by one <script src> at the end of index.html — the same structure as
 * public/sitenex-phase3.js and for the same reason: `const pages = { ... }` is an object literal,
 * a `function` declaration inside it is a syntax error that kills the whole inline script, and on
 * 30 September that took production down for hours while /health stayed green. Here there is no
 * literal to be inside. A syntax error in THIS file cannot take the app down either; a separate
 * <script> that fails to parse leaves every other script running.
 *
 * Two rules it still has to obey:
 *   • HANDLERS GO ON window. An inline onclick resolves against the global object, and Annex B does
 *     not hoist an async function out of a block, so a bare `async function f()` inside one throws
 *     ReferenceError on click and the control silently does nothing.
 *   • THE WRAPPER IS `.lc`. public/console.css puts its tokens on `.sn, .lc`; drop the wrapper and
 *     every class in the markup below stops matching and the screen renders as unstyled text with
 *     every control still live and nothing erroring.
 *
 * WHAT THIS SCREEN IS FOR. A directory of QC testing laboratories, filterable by region, which is
 * what an order needs in order to be routed. Most rows arrive from the FDA register and have NOT
 * been contacted — they are 'discovered', and the screen says so, because the one thing this
 * product must never do is send a client's sample to a firm that never agreed to receive one.
 */

const lcEsc = (x) => (typeof apEsc === 'function' ? apEsc(x)
  : String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const lcDash = '<span class="sn-dash">—</span>';
const lcMoney = (cents) => cents == null ? lcDash
  : '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });

window._lcFilters = { region: '', status: '', capability: '', test: '', q: '', priced: '', page: 1 };
window._lcState = { total: 0, pageSize: 50, summary: null, facets: null, canManage: false, routable: ['active'] };

function lcSet(k, v) { window._lcFilters[k] = v; window._lcFilters.page = 1; pages['lab-connect'](); }
function lcReset() {
  window._lcFilters = { region: '', status: '', capability: '', test: '', q: '', priced: '', page: 1 };
  pages['lab-connect']();
}
function lcPage(d) {
  const st = window._lcState, f = window._lcFilters;
  const max = Math.max(1, Math.ceil((st.total || 0) / (st.pageSize || 50)));
  f.page = Math.min(max, Math.max(1, (f.page || 1) + d));
  pages['lab-connect']();
}

/* Search re-renders, which destroys the input being typed into — so the same two things the
   prospects screen needs: a debounce, and focus put back with the caret at the end. */
window._lcSearchTimer = null;
function lcSearchNow(v) {
  clearTimeout(window._lcSearchTimer); window._lcSearchTimer = null;
  const f = window._lcFilters, next = String(v || '').trim();
  if (next === (f.q || '')) return;
  f.q = next; f.page = 1; window._lcRefocus = true;
  pages['lab-connect']();
}
function lcSearchInput(v) {
  clearTimeout(window._lcSearchTimer);
  window._lcSearchTimer = setTimeout(() => lcSearchNow(v), 350);
}
function lcRestoreFocus() {
  if (!window._lcRefocus) return;
  window._lcRefocus = false;
  const el = document.getElementById('lc-q');
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {}
}

function lcToast(msg, bad) {
  const el = document.getElementById('lc-msg');
  if (!el) { if (bad) console.error(msg); return; }
  el.className = 'sn-msg ' + (bad ? 'bad' : 'ok');
  el.textContent = msg;
}

async function lcSend(method, path, body) {
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

/* ── the page ──────────────────────────────────────────────────────────────── */

async function lcDirectoryPage() {
  const c = document.getElementById('content');
  const f = window._lcFilters, st = window._lcState;
  c.innerHTML = '<p style="color:#888;padding:20px">Loading LabConnect…</p>';

  const qs = new URLSearchParams();
  ['region', 'status', 'capability', 'test', 'q', 'priced'].forEach(k => { if (f[k]) qs.set(k, f[k]); });
  qs.set('page', String(f.page || 1)); qs.set('pageSize', String(st.pageSize));
  const got = await apGet('/labconnect/labs?' + qs.toString());
  if (!got.ok) { c.innerHTML = apErrorCard('LabConnect', got, "pages['lab-connect']()"); return; }

  const res = got.data || {};
  const items = res.items || [];
  st.total = res.total || 0; st.summary = res.summary || {}; st.facets = res.facets || {};
  st.canManage = !!res.can_manage;
  st.routable = res.routable_status || ['active'];
  const sm = st.summary, fa = st.facets;

  const header = '<div class="sn-head">'
    + '<div><h2>LabConnect</h2>'
    +   '<p class="sn-sub">Quality-control testing laboratories, by region. '
    /* THE MOST IMPORTANT SENTENCE ON THE SCREEN. Most of these firms came out of the FDA register
       and have never been contacted; only an active lab may be sent an order. Saying it here, in
       the header, rather than relying on somebody reading a status column. */
    +     '<strong>Only ' + lcEsc(st.routable.join(' / ')) + ' labs can receive an order.</strong> '
    +     'Everything marked discovered came from the FDA register and has not been approached — '
    +     'they have agreed to nothing and do not know they are listed.</p></div>'
    + '<div class="sn-head-right">'
    +   '<span class="sn-count">' + (st.total).toLocaleString() + ' lab' + (st.total === 1 ? '' : 's') + '</span>'
    + '</div></div>';

  const stat = (label, val, cls, hint) =>
    '<div class="sn-stat' + (cls ? ' ' + cls : '') + '">'
    + '<div class="sn-stat-v">' + ((val == null ? 0 : val).toLocaleString()) + '</div>'
    + '<div class="sn-stat-l">' + label + '</div>'
    + (hint ? '<div class="sn-stat-h">' + hint + '</div>' : '')
    + '</div>';
  /* ACTIVE IS THE ONLY GREEN FIGURE, because it is the only one that represents capacity we can
     actually sell. A strip where 'discovered' looked like an achievement would flatter a directory
     that nobody has worked yet. */
  const strip = '<div class="sn-stats">'
    + stat('Total', sm.total)
    + stat('Active', sm.active, 'is-good', 'can take an order')
    + stat('Onboarding', sm.onboarding)
    + stat('Invited', sm.invited, 'is-quiet', 'awaiting a reply')
    + stat('Discovered', sm.discovered, 'is-quiet', 'never contacted')
    + stat('GMP', sm.gmp, null, 'release testing')
    + stat('Research', sm.research, null, 'non-GMP')
    + stat('Contactable', sm.contactable, 'is-good', 'has an email')
    + (sm.no_region ? stat('No region', sm.no_region, 'is-warn', 'cannot be routed') : '')
    + '</div>';

  const sel = (key, blank, opts) => '<select class="sn-select" onchange="lcSet(\'' + key + '\', this.value)">'
    + '<option value="">' + blank + '</option>'
    + opts.map(o => '<option value="' + lcEsc(o.v) + '"' + (f[key] === o.v ? ' selected' : '') + '>'
        + lcEsc(o.l) + '</option>').join('')
    + '</select>';

  /* REGIONS COME FROM THE DATA, not from a hardcoded list of four zones. A zone with no labs in it
     should not be offered as a filter — picking it would produce an empty screen that looks broken
     — and the row count sits in the label so the choice is informed before it is made. */
  const regionOpts = (fa.regions || []).map(r => ({
    v: r.region == null ? 'none' : r.region,
    l: (r.region == null ? 'region not determined' : r.label) + ' · ' + r.n
       + (r.active ? ' (' + r.active + ' active)' : ''),
  }));
  const testOpts = (fa.tests || []).filter(t => t.labs > 0)
    .map(t => ({ v: t.code, l: t.name + ' · ' + t.labs + ' lab' + (t.labs === 1 ? '' : 's') }));

  const filters = '<div class="sn-toolbar">'
    + '<input id="lc-q" class="sn-input sn-grow" type="search" placeholder="Search by lab or city…" '
    +   'value="' + lcEsc(f.q || '') + '" oninput="lcSearchInput(this.value)" '
    +   'onkeydown="if(event.key===\'Enter\'){lcSearchNow(this.value)}">'
    + sel('region', 'region: any', regionOpts)
    + sel('status', 'status: any', (fa.statuses || []).map(s => ({ v: s, l: s })))
    + sel('capability', 'capability: any', [{ v: 'gmp', l: 'GMP' }, { v: 'research', l: 'research' },
        { v: 'none', l: 'not yet assessed' }])
    + (testOpts.length ? sel('test', 'runs test: any', testOpts) : '')
    + sel('priced', 'priced: any', [{ v: 'true', l: 'has priced tests' }])
    + '<button onclick="lcReset()" class="btn-secondary sn-btn-sm">Reset</button></div>';

  const statusPill = (s) => '<span class="sn-pill s-' + lcEsc(lcPillClass(s)) + '">' + lcEsc(s) + '</span>';

  const rows = items.map(l => {
    const place = [l.city, l.state || (l.country === 'USA' ? null : l.country)].filter(Boolean).join(', ');
    return '<tr>'
      + '<td><span class="sn-strong">' + lcEsc(l.name) + '</span>'
      +   (l.fei_number ? '<span class="sn-sub2">FEI ' + lcEsc(l.fei_number) + '</span>' : '')
      +   '</td>'
      + '<td class="nowrap">' + (lcEsc(place) || lcDash)
      +   (l.region ? '<span class="sn-sub2">' + lcEsc(lcRegionLabel(l.region, fa)) + '</span>'
                    : '<span class="sn-sub2 sn-fine is-bad">no region — cannot be routed</span>')
      +   '</td>'
      + '<td>' + (l.contact_email
          ? '<a href="mailto:' + lcEsc(l.contact_email) + '">' + lcEsc(l.contact_email) + '</a>'
            + (l.contact_name ? '<span class="sn-sub2">' + lcEsc(l.contact_name) + '</span>' : '')
          : '<span class="sn-fine">no email in the register</span>') + '</td>'
      /* The two sides of the business as two marks rather than one tier: a lab may serve research
         and not GMP, and the regulatory burden is entirely different. */
      + '<td class="mid nowrap">'
      +   (l.gmp_capable ? '<span class="sn-pill s-signed">GMP</span> ' : '')
      +   (l.research_capable ? '<span class="sn-pill s-intake">R&amp;D</span>' : '')
      +   (!l.gmp_capable && !l.research_capable ? '<span class="sn-fine">not assessed</span>' : '')
      +   '</td>'
      /* A lab with no priced tests cannot be quoted against, which is the difference between a
         directory entry and a supplier. Said as a count, not a tick. */
      + '<td class="num nowrap">' + (l.test_count
          ? l.priced_count + ' / ' + l.test_count
            + (l.fastest_days != null ? '<span class="sn-sub2">from ' + l.fastest_days + 'd</span>' : '')
          : '<span class="sn-fine">no catalogue</span>') + '</td>'
      + '<td class="nowrap">' + statusPill(l.status) + '</td>'
      + '<td class="nowrap">'
      +   '<button onclick="lcOpenLab(' + l.id + ')" class="btn-secondary sn-btn-xs">Open</button>'
      +   '</td>'
      + '</tr>';
  }).join('');

  const maxPage = Math.max(1, Math.ceil(st.total / (st.pageSize || 50)));
  const pager = '<div class="sn-panel-head" style="border-bottom:0;border-top:1px solid var(--sn-line)">'
    + '<span class="sn-note">' + st.total.toLocaleString() + ' lab' + (st.total === 1 ? '' : 's')
    +   (f.q ? ' matching “' + lcEsc(f.q) + '”' : '') + '</span>'
    + '<span class="sn-note">'
    +   '<button onclick="lcPage(-1)" class="btn-secondary sn-btn-xs" ' + ((f.page || 1) <= 1 ? 'disabled' : '') + '>‹</button> '
    +   'page ' + (f.page || 1) + ' of ' + maxPage + ' '
    +   '<button onclick="lcPage(1)" class="btn-secondary sn-btn-xs" ' + ((f.page || 1) >= maxPage ? 'disabled' : '') + '>›</button>'
    + '</span></div>';

  const empty = '<tr><td colspan="7"><div class="sn-empty" style="border:0">'
    + '<strong>' + (sm.total
        ? 'No lab matches these filters.'
        : 'The directory is empty.') + '</strong>'
    + (sm.total
        ? 'Reset clears them all.'
        : 'Run <code>scripts/seed-labs-from-fda.js</code> to populate it from the FDA register — '
          + 'without <code>--write</code> first, which reports the count and changes nothing.')
    + '</div></td></tr>';

  const table = '<div class="sn-panel"><div class="sn-table-wrap">'
    + '<table class="sn-table"><thead><tr>'
    + '<th>Laboratory</th><th>Where</th><th>Contact</th>'
    + '<th class="mid" title="GMP release testing and non-GMP research work are different regulatory worlds. A lab may serve one and not the other.">Serves</th>'
    + '<th class="num" title="Priced tests over total tests in this lab&#39;s catalogue. A lab with no priced test cannot be quoted against.">Priced</th>'
    + '<th>Status</th><th></th>'
    + '</tr></thead><tbody>' + (rows || empty) + '</tbody></table></div>' + pager + '</div>';

  c.innerHTML = '<div class="lc">' + header + '<div id="lc-msg" class="sn-msg"></div>'
    + strip + filters + table + '</div>';
  lcRestoreFocus();
}

/* The pill colour. The status vocabulary here is LabConnect's, and console.css keys its pill
   colours on SiteNex's — so this maps one to the other rather than adding six near-duplicate rules
   to a shared stylesheet. 'active' borrows the signed green because it means the same thing in
   both: this one is live. */
function lcPillClass(status) {
  return ({
    discovered: 'new', invited: 'contacted', onboarding: 'intake',
    active: 'signed', paused: 'superseded', rejected: 'lost',
  })[status] || 'new';
}

function lcRegionLabel(region, facets) {
  const hit = ((facets && facets.regions) || []).find(r => r.region === region);
  return hit ? hit.label : region;
}

/* ── one lab ───────────────────────────────────────────────────────────────── */

window.lcOpenLab = async function lcOpenLab(id) {
  const c = document.getElementById('content');
  c.innerHTML = '<p style="color:#888;padding:20px">Loading lab…</p>';
  const got = await apGet('/labconnect/labs/' + encodeURIComponent(id));
  if (!got.ok) { c.innerHTML = apErrorCard('Lab', got, "pages['lab-connect']()"); return; }
  const l = got.data.lab, tests = got.data.tests || [];
  const canManage = !!got.data.can_manage;

  const field = (label, value) => '<div class="sn-field"><span>' + label + '</span>'
    + '<div style="font-size:13px;padding:4px 0">' + (value || lcDash) + '</div></div>';

  const testRows = tests.length
    ? tests.map(t => '<tr>'
        + '<td><span class="sn-strong">' + lcEsc(t.test_name) + '</span>'
        +   (t.typical_method ? '<span class="sn-sub2">' + lcEsc(t.typical_method) + '</span>' : '') + '</td>'
        + '<td class="sn-fine nowrap">' + lcEsc(t.category) + '</td>'
        /* A null price shows as a dash and the words "not quoted" — never as $0, which would read
           as free. The same rule the SiteNex packages screen follows. */
        + '<td class="num nowrap">' + (t.price_cents == null
            ? '<span class="sn-fine">not quoted</span>'
            : '<span class="sn-strong">' + lcMoney(t.price_cents) + '</span>') + '</td>'
        + '<td class="num nowrap">' + (t.turnaround_days == null ? lcDash : t.turnaround_days + ' d') + '</td>'
        + '<td class="mid nowrap">' + (t.accredited ? '✓' : lcDash) + '</td>'
        + '<td class="mid nowrap">' + (t.gmp ? '✓' : lcDash) + '</td>'
        + '</tr>').join('')
    : '<tr><td colspan="6" class="sn-fine" style="padding:14px">No catalogue yet. Until this lab has '
      + 'priced at least one test, an order cannot be quoted against it.</td></tr>';

  const statusSel = '<select id="lc-status" class="sn-select">'
    + (window._lcState.facets && window._lcState.facets.statuses || ['discovered'])
        .map(s => '<option value="' + s + '"' + (s === l.status ? ' selected' : '') + '>' + s + '</option>').join('')
    + '</select>';

  c.innerHTML = '<div class="lc">'
    + '<div class="sn-head is-record">'
    + '<div><h2>' + lcEsc(l.name) + '</h2>'
    +   '<p class="sn-sub">' + lcEsc([l.city, l.state, l.country].filter(Boolean).join(', '))
    +     ' · ' + lcEsc(l.region_label || 'region not determined')
    +     ' · from the ' + lcEsc(l.source === 'fda_register' ? 'FDA register' : l.source) + '</p></div>'
    + '<div class="sn-head-right">' + '<span class="sn-pill s-' + lcPillClass(l.status) + '">' + lcEsc(l.status) + '</span>'
    +   '<button onclick="pages[\'lab-connect\']()" class="btn-secondary sn-btn-sm">Back to the directory</button>'
    + '</div></div>'
    + '<div id="lc-msg" class="sn-msg"></div>'

    /* NOT ROUTABLE, AND WHY, AT THE TOP. "This lab cannot receive an order" is the single fact that
       decides whether the rest of the screen matters, and the server supplies the sentence so the
       page cannot drift from the rule. */
    + (got.data.routable
        ? ''
        : '<div class="sn-attn"><div class="sn-attn-row">'
          + '<div class="sn-attn-name">This lab cannot receive an order</div>'
          + '<div class="sn-attn-meta">' + lcEsc(got.data.not_routable_because) + '</div>'
          + '</div></div>')

    + '<div class="sn-cols">'
    + '<div class="sn-panel"><div class="sn-panel-head"><h3>The laboratory</h3>'
    +   '<span class="sn-note">' + (l.fei_number ? 'FEI ' + lcEsc(l.fei_number) : 'no FEI') + '</span></div>'
    + '<div class="sn-panel-body"><div class="sn-form">'
    +   field('Address', lcEsc(l.address))
    +   field('Contact', l.contact_email
            ? '<a href="mailto:' + lcEsc(l.contact_email) + '">' + lcEsc(l.contact_email) + '</a>'
              + (l.contact_name ? ' · ' + lcEsc(l.contact_name) : '')
            : null)
    +   field('Telephone', lcEsc(l.contact_phone))
    +   field('Website', l.website
            ? '<a href="' + lcEsc(l.website) + '" target="_blank" rel="noopener noreferrer">' + lcEsc(l.website) + '</a>'
            : null)
    +   field('Serves', [l.gmp_capable ? 'GMP' : null, l.research_capable ? 'research' : null]
              .filter(Boolean).join(' · ') || '<span class="sn-fine">not assessed</span>')
    +   field('Accreditations', (l.accreditations && l.accreditations.length)
            ? l.accreditations.map(a => lcEsc([a.body, a.certificate].filter(Boolean).join(' '))).join(', ')
            : '<span class="sn-fine">none recorded — this is what decides whether a lab may run a given test</span>')
    + '</div>'
    + (l.notes ? '<div class="sn-fine" style="margin-top:12px">' + lcEsc(l.notes) + '</div>' : '')
    + (canManage
        ? '<div class="sn-actions">'
          + '<span class="sn-field" style="flex-direction:row;align-items:center;gap:7px">'
          +   '<span>Status</span>' + statusSel + '</span>'
          + '<input id="lc-note" class="sn-input sn-grow" placeholder="What did they agree to? (required to activate)" '
          +   'value="' + lcEsc(l.status_note || '') + '">'
          + '<button onclick="lcSaveStatus(' + l.id + ')" class="btn-primary sn-btn-sm">Save</button>'
          + '</div>'
          /* The requirement stated BEFORE the 400 arrives, because discovering it after clicking is
             a worse way to learn it. The server still enforces it. */
          + '<div class="sn-fine" style="margin-top:6px">Moving a lab to <strong>active</strong> makes it '
          + 'eligible to receive client samples, so it needs a note saying what was agreed.</div>'
        : '')
    + '</div></div>'

    + '<div class="sn-panel"><div class="sn-panel-head"><h3>Tests and prices</h3>'
    +   '<span class="sn-note">' + tests.length + ' in the catalogue · '
    +   tests.filter(t => t.price_cents != null).length + ' priced</span></div>'
    + '<div class="sn-table-wrap"><table class="sn-table"><thead><tr>'
    + '<th>Test</th><th>Category</th><th class="num">Their price</th><th class="num">Days</th>'
    + '<th class="mid" title="Accredited for THIS test, which is narrower than holding an accreditation at all.">Accr.</th>'
    + '<th class="mid">GMP</th>'
    + '</tr></thead><tbody>' + testRows + '</tbody></table></div>'
    + '<div class="sn-panel-body" style="border-top:1px solid var(--sn-line)">'
    + '<div class="sn-fine">Prices are the <strong>lab’s own</strong>. Abiozen does not set them — '
    + 'the margin is the commission on top, so a blank price means not yet quoted, never free.</div>'
    + '</div></div>'
    + '</div></div>';
};

window.lcSaveStatus = async function lcSaveStatus(id) {
  const status = (document.getElementById('lc-status') || {}).value;
  const note = (document.getElementById('lc-note') || {}).value || '';
  /* Checked here as well as on the server, so the requirement is visible before the click rather
     than arriving as a 400. The server remains the one that enforces it. */
  if (status === 'active' && String(note).trim().length < 3) {
    lcToast('Say what they agreed to before activating — an active lab can be sent a client sample.', true);
    const box = document.getElementById('lc-note');
    if (box) box.focus();
    return;
  }
  lcToast('Saving…');
  const r = await lcSend('PUT', '/labconnect/labs/' + encodeURIComponent(id), { status, status_note: note });
  if (!r.ok) { lcToast((r.data && r.data.error) || r.error, true); return; }
  lcToast(r.data.note);
  await window.lcOpenLab(id);
};

/* ── attach ────────────────────────────────────────────────────────────────────
 * `pages` is a top-level const in the inline script, so it is a visible global here. Attached from
 * OUTSIDE the object literal, which is the whole structural point of this file.
 */
pages['lab-connect'] = (typeof apGuard === 'function')
  ? apGuard('lab-connect', 'LabConnect', lcDirectoryPage)
  : lcDirectoryPage;
