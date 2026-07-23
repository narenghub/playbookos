// Workspace Activity — org-wide visibility via the Google Admin SDK.
//
// Two Admin SDK surfaces, both impersonating a Workspace SUPER ADMIN
// (WORKSPACE_SUPER_ADMIN) via Domain-Wide Delegation:
//   • Directory API  — list every user across every configured domain.
//   • Reports API    — audit activity for Meet / Calendar / Drive, org-wide,
//                      in a single call per application (no per-user scanning).
//
// IMPORTANT operational notes (kept honest in the code, not glossed over):
//   1. These need TWO scopes added to the DWD client in admin.google.com:
//        admin.directory.user.readonly, admin.reports.audit.readonly
//      Until they're added, every call here 403s and the callers fall back.
//   2. The impersonated subject MUST be a super admin — a normal user 403s on
//      Reports even with the scope.
//   3. Meet audit logs emit ONE `call_ended` event PER PARTICIPANT (all sharing
//      a meeting_code), so a session is reconstructed by grouping on
//      meeting_code — see extractMeetSessions(). There is no per-meeting
//      "recording_url" field in the Meet log; recordings surface in the DRIVE
//      audit log instead (getWorkspaceDriveActivity).
//   4. Reports data lags real time by up to a few hours.
const { getGoogleAccessToken, SCOPES } = require('../google-auth');

const log = (...a) => console.log('[workspace]', ...a);
const DAY_MS = 86400000;

const SUPER_ADMIN = () => process.env.WORKSPACE_SUPER_ADMIN || process.env.MEET_IMPERSONATE || 'naren@abiozen.com';
function workspaceDomains() {
  return (process.env.WORKSPACE_DOMAINS || 'abiozen.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Bearer token for Admin SDK calls (super-admin subject + the two admin scopes).
async function adminToken() {
  return getGoogleAccessToken({
    subject: SUPER_ADMIN(),
    scopes: [SCOPES.adminDirectoryUserReadonly, SCOPES.adminReportsAuditReadonly],
  });
}

// Pull a single value out of a Reports API parameters[] array.
function param(params, name) {
  const p = (params || []).find(x => x.name === name);
  if (!p) return null;
  if (p.value !== undefined) return p.value;
  if (p.intValue !== undefined) return p.intValue;
  if (p.boolValue !== undefined) return p.boolValue;
  if (p.multiValue !== undefined) return p.multiValue;
  return null;
}

// ── PART 1 — Workspace-wide user discovery (Directory API) ────────────────────
let _usersCache = null; // { at: epochMs, users: [...] }
const USERS_TTL_MS = DAY_MS; // 24 hours — the directory changes rarely

async function getAllWorkspaceUsers({ force = false } = {}) {
  if (!force && _usersCache && (Date.now() - _usersCache.at) < USERS_TTL_MS) {
    return { users: _usersCache.users, cached: true };
  }
  const tok = await adminToken();
  if (tok.error) { log('Directory auth unavailable:', tok.error); return { users: [], warning: 'Admin auth unavailable: ' + tok.error }; }

  const all = [];
  const warnings = [];
  for (const domain of workspaceDomains()) {
    let pageToken = null, pages = 0;
    do {
      const url = `https://admin.googleapis.com/admin/directory/v1/users?domain=${encodeURIComponent(domain)}`
        + `&maxResults=200&orderBy=email&viewType=admin_view`
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + tok.access_token } });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        log(`Directory ${domain} ${res.status}: ${body}`);
        warnings.push(`${domain}: ${res.status} ${body}`);
        break;
      }
      const data = await res.json();
      for (const u of (data.users || [])) {
        all.push({
          email: (u.primaryEmail || '').toLowerCase(),
          name: (u.name && u.name.fullName) || u.primaryEmail || '',
          domain,
          suspended: !!u.suspended,
          is_admin: !!u.isAdmin,
        });
      }
      pageToken = data.nextPageToken || null;
      pages++;
    } while (pageToken && pages < 20);
    log(`Directory ${domain}: ${all.filter(u => u.domain === domain).length} user(s)`);
  }
  const active = all.filter(u => !u.suspended);
  if (active.length) _usersCache = { at: Date.now(), users: active };
  return { users: active, all_including_suspended: all, cached: false, warning: warnings[0] || null, warnings };
}

// ── PARTs 2 & 3 — Reports API generic paginated fetch ─────────────────────────
async function reportsActivity(application, { lookbackDays = 7, maxPages = 5, eventName = null } = {}) {
  const tok = await adminToken();
  if (tok.error) return { items: [], warning: 'Admin auth unavailable: ' + tok.error };
  const startTime = new Date(Date.now() - lookbackDays * DAY_MS).toISOString();
  const items = [];
  let pageToken = null, pages = 0;
  try {
    do {
      const url = `https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/${application}`
        + `?startTime=${encodeURIComponent(startTime)}&maxResults=1000`
        + (eventName ? `&eventName=${encodeURIComponent(eventName)}` : '')
        + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      log(`Reports GET ${application}${eventName ? '/' + eventName : ''} page ${pages + 1}`);
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + tok.access_token } });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 220);
        log(`Reports ${application} ${res.status}: ${body}`);
        return { items, warning: `Reports API ${res.status} for ${application}: ${body}. Needs admin.reports.audit.readonly scope on the DWD client + a super-admin WORKSPACE_SUPER_ADMIN.` };
      }
      const data = await res.json();
      items.push(...(data.items || []));
      pageToken = data.nextPageToken || null;
      pages++;
    } while (pageToken && pages < maxPages);
  } catch (e) { return { items, warning: e.message }; }
  log(`Reports ${application}: ${items.length} raw activity record(s)`);
  return { items };
}

// Reconstruct Meet SESSIONS from per-participant call_ended events (grouped by
// meeting_code). Each session: organizer, time window, max duration, participants.
function extractMeetSessions(items) {
  const byCode = new Map();
  for (const it of items || []) {
    const time = it.id && it.id.time;
    for (const ev of (it.events || [])) {
      const code = param(ev.parameters, 'meeting_code') || param(ev.parameters, 'conference_id') || `unknown-${it.id?.uniqueQualifier || ''}`;
      const identifier = param(ev.parameters, 'identifier') || param(ev.parameters, 'display_name') || (it.actor && it.actor.email) || null;
      const organizer = param(ev.parameters, 'organizer_email');
      const dur = Number(param(ev.parameters, 'duration_seconds')) || 0;
      const s = byCode.get(code) || { meeting_code: code, organizer_email: null, participants: new Set(), duration_seconds: 0, first_time: time, last_time: time, event_names: new Set() };
      if (organizer) s.organizer_email = organizer;
      if (identifier) s.participants.add(String(identifier).toLowerCase());
      if (dur > s.duration_seconds) s.duration_seconds = dur;
      if (time && (!s.first_time || time < s.first_time)) s.first_time = time;
      if (time && (!s.last_time || time > s.last_time)) s.last_time = time;
      s.event_names.add(ev.name);
      byCode.set(code, s);
    }
  }
  return Array.from(byCode.values()).map(s => ({
    meeting_code: s.meeting_code,
    organizer_email: s.organizer_email,
    attendee_count: s.participants.size,
    participants: Array.from(s.participants),
    duration_seconds: s.duration_seconds,
    duration_minutes: Math.round(s.duration_seconds / 60),
    start_time: s.first_time,
    date: s.first_time ? String(s.first_time).slice(0, 10) : null,
    has_recording: s.event_names.has('recording_ended') || s.event_names.has('recording_started'),
  })).sort((a, b) => String(b.start_time || '').localeCompare(String(a.start_time || '')));
}

// ── PART 2 — org-wide Meet activity ───────────────────────────────────────────
async function getWorkspaceMeetActivity({ lookbackDays = 7 } = {}) {
  const { items, warning } = await reportsActivity('meet', { lookbackDays });
  const sessions = extractMeetSessions(items);
  log(`Meet: ${sessions.length} distinct session(s) reconstructed from ${items.length} record(s)`);
  return { sessions, raw_count: items.length, warning: warning || null };
}

// ── PART 2 — org-wide Calendar activity ───────────────────────────────────────
async function getWorkspaceCalendarActivity({ lookbackDays = 7 } = {}) {
  const { items, warning } = await reportsActivity('calendar', { lookbackDays });
  const events = [];
  for (const it of items || []) {
    for (const ev of (it.events || [])) {
      events.push({
        time: it.id && it.id.time,
        actor: it.actor && it.actor.email,
        event_name: ev.name,
        title: param(ev.parameters, 'event_title'),
        event_id: param(ev.parameters, 'event_id'),
        start_time: param(ev.parameters, 'start_time'),
      });
    }
  }
  return { events, raw_count: items.length, warning: warning || null };
}

// ── PART 3 — org-wide Drive activity (Meet recordings) ────────────────────────
async function getWorkspaceDriveActivity({ lookbackDays = 7 } = {}) {
  const { items, warning } = await reportsActivity('drive', { lookbackDays });
  const recordings = [];
  for (const it of items || []) {
    for (const ev of (it.events || [])) {
      const title = param(ev.parameters, 'doc_title');
      if (!title || !/meet|recording|\.mp4|transcript/i.test(String(title))) continue;
      recordings.push({
        time: it.id && it.id.time,
        actor: it.actor && it.actor.email,
        event_name: ev.name,
        doc_title: title,
        doc_id: param(ev.parameters, 'doc_id'),
        owner: param(ev.parameters, 'owner') || param(ev.parameters, 'owner_is_shared_drive'),
        doc_type: param(ev.parameters, 'doc_type'),
      });
    }
  }
  // Dedup by doc_id (a recording generates many drive events).
  const seen = new Set();
  const unique = recordings.filter(r => { const k = r.doc_id || r.doc_title; if (seen.has(k)) return false; seen.add(k); return true; });
  log(`Drive: ${unique.length} unique Meet recording/transcript file(s)`);
  return { recordings: unique, raw_count: items.length, warning: warning || null };
}

// Build a day×hour heatmap (PART 8) from Meet sessions. Returns { grid, maxCount }
// where grid[dow][hour] = session count. dow 0=Sun..6=Sat, hour 0..23 (UTC).
function meetHeatmap(sessions) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let maxCount = 0;
  for (const s of sessions || []) {
    if (!s.start_time) continue;
    const d = new Date(s.start_time);
    if (isNaN(d)) continue;
    const dow = d.getUTCDay(), hr = d.getUTCHours();
    grid[dow][hr]++;
    if (grid[dow][hr] > maxCount) maxCount = grid[dow][hr];
  }
  return { grid, maxCount };
}

module.exports = {
  getAllWorkspaceUsers, getWorkspaceMeetActivity, getWorkspaceCalendarActivity,
  getWorkspaceDriveActivity, extractMeetSessions, meetHeatmap, workspaceDomains,
};
