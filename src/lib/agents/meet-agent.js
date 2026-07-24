// Google Meet Agent — transcribes/ingests standup recordings, extracts action items
// with Claude, and assigns tasks in PlaybookOS.
//
// Two ingestion paths:
//  1. Google Calendar/Drive (fetchMeetingRecordings + getTranscript) — best-effort.
//     The shared GOOGLE_REFRESH_TOKEN is scoped for Search Console, so Calendar/Drive
//     calls may 403 for lack of scope; the agent degrades gracefully (returns no
//     meetings + a reason) rather than throwing.
//  2. Manual transcript upload (analyzeAndStore from a pre-filled meeting row) — the
//     reliable fallback: Naresh pastes a transcript and gets the full analysis.
const crypto = require('crypto');
const { query } = require('../db');
const { sendEmail } = require('../mailer');
const { sendWhatsApp } = require('../whatsapp');
const { createDailyTask, logAgentActivity, parseClaudeJSON, businessToday } = require('../agent-core');
const { getGoogleAccessToken: getGoogleToken, SCOPES } = require('../google-auth');
const workspace = require('./workspace-activity');

const AGENT = 'meet-agent';
const MEET_MODEL = 'claude-opus-4-8';
const BASE_URL = () => process.env.BASE_URL || 'https://playbook.abiozen.com';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isoDate = d => new Date(d).toISOString().slice(0, 10);

async function callClaude(prompt, { maxTokens = 3000, json = false } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { data: null, text: null, error: 'ANTHROPIC_API_KEY not configured' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MEET_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) return { data: null, text: null, error: `Claude ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const text = (await res.json()).content?.[0]?.text || '';
    return { data: json ? parseClaudeJSON(text) : null, text };
  } catch (e) { return { data: null, text: null, error: e.message }; }
}

// Service-account token (DWD, impersonating naren@abiozen.com) with refresh-token
// fallback. Needs calendar.readonly + drive.readonly.
const MEET_IMPERSONATE = () => process.env.MEET_IMPERSONATE || 'naren@abiozen.com';
async function getGoogleAccessToken() {
  return getGoogleToken({ subject: MEET_IMPERSONATE(), scopes: [SCOPES.calendarReadonly, SCOPES.driveReadonly] });
}

async function teamMembers() {
  return (await query(`SELECT id, name, email, role, whatsapp_number FROM users WHERE is_active=1 ORDER BY name`)).rows;
}
async function getNaresh() {
  const r = (await query(
    `SELECT id, name, email FROM users WHERE is_active=1 AND role IN ('admin','super_admin')
     ORDER BY CASE WHEN LOWER(email) LIKE 'naren%' THEN 0 ELSE 1 END, created_at LIMIT 1`)).rows[0];
  return r || { name: 'Naresh', email: 'naren@abiozen.com', id: null };
}

// Fuzzy-match an action item's owner ("person name or email") to a user. Matches by
// email, exact name, first-name, or containment. Returns the user or null.
function matchUser(assignedTo, users) {
  const raw = String(assignedTo || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes('@')) { const u = users.find(u => (u.email || '').toLowerCase() === raw); if (u) return u; }
  let best = null;
  for (const u of users) {
    const name = (u.name || '').toLowerCase();
    if (!name) continue;
    if (name === raw) return u;
    const first = name.split(/\s+/)[0];
    if (first === raw || raw === first) best = best || u;
    else if (name.includes(raw) || raw.includes(first)) best = best || u;
  }
  return best;
}

const log = (...a) => console.log('[meet]', ...a);

// Search Drive with a raw query string. Returns { ok, files, status, error }.
// Logs the query and the resulting count so a failed pickup is diagnosable.
async function searchDrive(tok, q, { label = 'drive', pageSize = 25 } = {}) {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
    + `&orderBy=createdTime desc&pageSize=${pageSize}`
    + `&fields=${encodeURIComponent('files(id,name,mimeType,createdTime,webViewLink,parents)')}`
    + `&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  log(`Drive search [${label}]: q=${q}`);
  try {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + tok.access_token } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      log(`Drive search [${label}] FAILED ${res.status}: ${body}`);
      return { ok: false, files: [], status: res.status, error: body };
    }
    const files = (await res.json()).files || [];
    log(`Drive search [${label}] → ${files.length} file(s): ${files.slice(0, 5).map(f => f.name).join(' | ') || '(none)'}`);
    return { ok: true, files };
  } catch (e) {
    log(`Drive search [${label}] ERROR: ${e.message}`);
    return { ok: false, files: [], error: e.message };
  }
}

// Google Meet recordings + transcripts land in Drive (folder "Meet Recordings")
// shortly after the call ends: an .mp4 named after the meeting, and a .vtt/
// "…- Transcript" doc. Pull both for the lookback window so getTranscript() can
// match one to a meeting by title.
async function findMeetDriveArtifacts(tok, { lookbackDays = 7 } = {}) {
  const sinceIso = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  // mp4 recordings created in the window (name matched to a meeting later — the
  // "name contains 'Meet'" filter from the folder default is too narrow since Meet
  // names the file after the meeting title, so we window by createdTime instead).
  const rec = await searchDrive(tok, `mimeType='video/mp4' and createdTime > '${sinceIso}' and trashed=false`, { label: 'recordings' });
  // transcript/caption files created in the window.
  const tr = await searchDrive(tok, `(name contains '.vtt' or name contains 'Transcript' or name contains 'transcript') and createdTime > '${sinceIso}' and trashed=false`, { label: 'transcripts' });
  return { recordings: rec.files || [], transcripts: tr.files || [], warnings: [rec.error, tr.error].filter(Boolean) };
}

// Best file whose name references the meeting title (first 3 words), else the
// most recent file (already createdTime-desc ordered).
function matchArtifactByTitle(files, meetingTitle) {
  if (!files || !files.length) return null;
  const title = (meetingTitle || '').split(/\s+/).slice(0, 3).join(' ').replace(/[^\w ]/g, '').trim();
  if (title) { const hit = files.find(f => new RegExp(title, 'i').test(f.name)); if (hit) return hit; }
  return files[0];
}

// ── Function 1 — fetch meeting recordings from Google Calendar ─────────────────
async function fetchMeetingRecordings({ lookbackDays = 7 } = {}) {
  const tok = await getGoogleAccessToken();
  if (tok.error) { log('Google auth unavailable:', tok.error); return { meetings: [], warning: 'Google auth unavailable: ' + tok.error }; }
  log(`auth OK via ${tok.via || 'unknown'}; impersonating ${MEET_IMPERSONATE()}, lookback ${lookbackDays}d`);
  const timeMin = new Date(Date.now() - lookbackDays * 86400000).toISOString();
  const timeMax = new Date().toISOString();
  try {
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=100`;
    log(`Calendar GET events ${timeMin} → ${timeMax}`);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + tok.access_token } });
    log(`Calendar API responded ${res.status}`);
    if (!res.ok) {
      // Almost always a scope problem (the shared token is GSC-scoped). Surface it.
      const body = (await res.text()).slice(0, 160);
      log(`Calendar API FAILED: ${body}`);
      return { meetings: [], warning: `Calendar API ${res.status}: ${body}. The Google token likely lacks Calendar scope — use manual transcript upload.` };
    }
    const items = (await res.json()).items || [];
    log(`Calendar returned ${items.length} event(s) in the last ${lookbackDays} days`);
    const withMeet = items.filter(ev => (ev.conferenceData?.entryPoints || []).some(e => e.entryPointType === 'video') || ev.hangoutLink);
    log(`${withMeet.length} of ${items.length} event(s) have a Google Meet link`);

    // Pull Drive recordings/transcripts once for the window so we can attach them.
    const artifacts = await findMeetDriveArtifacts(tok, { lookbackDays });
    log(`Drive: ${artifacts.recordings.length} recording(s), ${artifacts.transcripts.length} transcript(s) in window`);

    const kw = /(standup|stand-up|update|sync|meeting|briefing|review)/i;
    const meetings = [];
    for (const ev of items) {
      const attendees = (ev.attendees || []).map(a => a.email).filter(Boolean);
      const abiozen = attendees.some(e => /@abiozen\.com$/i.test(e));
      if (!abiozen || !kw.test(ev.summary || '')) continue;
      const start = ev.start?.dateTime || ev.start?.date;
      const end = ev.end?.dateTime || ev.end?.date;
      const meetLink = (ev.conferenceData?.entryPoints || []).find(e => e.entryPointType === 'video')?.uri || ev.hangoutLink || null;
      const recFile = matchArtifactByTitle(artifacts.recordings, ev.summary);
      const trFile = matchArtifactByTitle(artifacts.transcripts, ev.summary);
      meetings.push({
        meeting_id: ev.id,
        meeting_title: ev.summary || 'Untitled meeting',
        meeting_date: start ? isoDate(start) : businessToday(),
        duration_seconds: start && end ? Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000)) : null,
        attendees,
        description: ev.description || '',
        recording_url: (recFile && recFile.webViewLink) || (ev.attachments || []).map(a => a.fileUrl).find(Boolean) || meetLink || null,
        _transcriptFileId: trFile ? trFile.id : null,
        _event: ev,
      });
    }
    log(`${meetings.length} event(s) match the standup/update keyword + Abiozen attendee filter`);
    // Filter out meetings already processed.
    const out = [];
    for (const m of meetings) {
      const done = (await query('SELECT id FROM meeting_recordings WHERE meeting_id=$1 AND processed=1', [m.meeting_id])).rows[0];
      if (!done) out.push(m);
    }
    log(`${out.length} unprocessed meeting(s) to analyze`);
    return { meetings: out, warning: artifacts.warnings[0] || null };
  } catch (e) { log('fetchMeetingRecordings error:', e.message); return { meetings: [], warning: e.message }; }
}

// ── Function 2 — get a transcript for a meeting ───────────────────────────────
// Cleans timestamps/cue numbers and normalises to "Speaker: text" lines.
function cleanTranscript(raw) {
  return String(raw || '')
    .replace(/^WEBVTT.*$/gim, '')
    .replace(/^\d+\s*$/gm, '')                                   // SRT cue numbers
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}.*$/gim, '') // timestamps
    .replace(/^\[\d{1,2}:\d{2}(:\d{2})?\]\s*/gm, '')             // [00:12] leading stamps
    .replace(/<[^>]+>/g, '')                                     // vtt tags
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
async function getTranscript(meeting) {
  // meeting can be a fetched meeting object (with _event/description) or a stored row.
  const tok = await getGoogleAccessToken();
  if (!tok.error && meeting.meeting_id) {
    try {
      // Prefer the transcript file already matched during fetch; otherwise search now.
      let fileId = meeting._transcriptFileId || null;
      if (!fileId) {
        const r = await searchDrive(tok, `(name contains 'Transcript' or name contains '.vtt') and (name contains '.vtt' or name contains '.txt' or name contains '.srt' or mimeType='text/plain') and trashed=false`, { label: 'transcript-lookup', pageSize: 10 });
        const hit = matchArtifactByTitle(r.files, meeting.meeting_title);
        fileId = hit ? hit.id : null;
      }
      if (fileId) {
        log(`downloading transcript file ${fileId} for "${meeting.meeting_title}"`);
        const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: 'Bearer ' + tok.access_token } });
        if (dl.ok) { const t = cleanTranscript(await dl.text()); if (t) return t; }
        else log(`transcript download ${dl.status}`);
      }
    } catch (e) { log('getTranscript drive error:', e.message); }
  }
  // Fallbacks: an already-stored transcript, then the calendar description/notes.
  return cleanTranscript(meeting.transcript_text || meeting.description || meeting._event?.description || '');
}

// ── Function 3 — analyse the transcript with Claude ───────────────────────────
async function analyzeMeetingWithClaude(transcript, meetingTitle, attendees, date, members) {
  const teamList = (members || []).map(m => `${m.name} (${m.email}, ${m.role})`).join('; ');
  const prompt = `You are analyzing a standup/update meeting transcript for Abiozen LLC, a pharmaceutical API marketplace.

Meeting: ${meetingTitle}
Date: ${date}
Attendees: ${(attendees || []).join(', ')}

Transcript:
${String(transcript || '').slice(0, 24000)}

Extract and return as JSON:
{
  "summary": "3-4 sentence executive summary of the meeting",
  "decisions": ["key decisions made"],
  "blockers": ["blockers or issues raised"],
  "risks": ["risks mentioned"],
  "opportunities": ["opportunities or ideas mentioned"],
  "action_items": [
    {"assigned_to": "person name or email", "task": "specific action item", "due_date": "YYYY-MM-DD or null", "priority": "high/medium/low", "source_quote": "exact quote from transcript that generated this task"}
  ]
}

Rules:
- Only extract SPECIFIC action items with a clear owner.
- If no owner mentioned, assign to the person who raised the topic.
- Be specific — "Follow up with Sigma-Aldrich about Semaglutide pricing" not "follow up".
- Priority: high if a deadline is mentioned or urgent language is used.
- Match assigned_to to these team members: ${teamList || '(none listed)'}
Return ONLY the JSON object, no prose, no code fences.`;
  const { data, error } = await callClaude(prompt, { maxTokens: 3500, json: true });
  if (!data) return { error: error || 'unparseable analysis', summary: '', decisions: [], blockers: [], risks: [], opportunities: [], action_items: [] };
  return {
    summary: String(data.summary || ''),
    decisions: Array.isArray(data.decisions) ? data.decisions : [],
    blockers: Array.isArray(data.blockers) ? data.blockers : [],
    risks: Array.isArray(data.risks) ? data.risks : [],
    opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
    action_items: Array.isArray(data.action_items) ? data.action_items : [],
  };
}

// ── Function 4 — assign extracted action items to the team ────────────────────
async function assignTasksToTeam(meetingId, actionItems, { dryRun = false } = {}) {
  const users = await teamMembers();
  let created = 0; const assigned = [];
  for (const it of actionItems || []) {
    const user = matchUser(it.assigned_to, users);
    const pri = ['high', 'medium', 'low'].includes(String(it.priority || '').toLowerCase()) ? String(it.priority).toLowerCase() : 'medium';
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(it.due_date || '')) ? it.due_date : null;
    const mtId = crypto.randomUUID();
    let dailyTaskId = null;
    if (!dryRun) {
      if (user) {
        dailyTaskId = await createDailyTask({
          user_id: user.id, task_date: due || businessToday(),
          task_title: String(it.task || 'Action item from meeting').slice(0, 300),
          task_description: it.source_quote ? `From meeting: "${String(it.source_quote).slice(0, 400)}"` : '',
          priority: pri.toUpperCase(), agent_name: AGENT,
          reasoning: `Action item extracted from meeting ${meetingId}.`,
        }).catch(() => null);
      }
      await query(
        `INSERT INTO meeting_tasks (id, meeting_id, assigned_to_user_id, assigned_to_name, task_title,
           task_description, due_date, priority, source_quote, status, daily_task_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
        [mtId, meetingId, user ? user.id : null, user ? user.name : (it.assigned_to || null),
         String(it.task || '').slice(0, 300), it.source_quote ? String(it.source_quote).slice(0, 500) : null,
         due, pri, it.source_quote ? String(it.source_quote).slice(0, 500) : null,
         user && dailyTaskId ? 'assigned' : 'pending', dailyTaskId]
      );
      // Notify the assignee on WhatsApp if we have a number.
      if (user && user.whatsapp_number) {
        await sendWhatsApp(user.whatsapp_number,
          `📋 New task from a meeting:\n${it.task}\n${due ? 'Due ' + due + ' · ' : ''}${pri.toUpperCase()} priority\nOpen My Tasks in PlaybookOS.`,
          { user_id: user.id, message_type: 'meeting_task' }).catch(() => {});
      }
    }
    created++;
    assigned.push({ task: it.task, assigned_to: user ? user.name : (it.assigned_to || 'unassigned'), matched: !!user, priority: pri, due });
  }
  if (!dryRun) {
    await logAgentActivity({ agent_name: AGENT, action_type: 'meeting_tasks_assigned', user_id: null,
      reasoning: `Assigned ${created} tasks from meeting ${meetingId} (${assigned.filter(a => a.matched).length} matched to users).`,
      source_kpi: 'kpi-vision', output_summary: `meeting=${meetingId} tasks=${created}` }).catch(() => {});
  }
  return { tasks_created: created, assigned };
}

// ── Function 5 — email the meeting brief to Naresh ────────────────────────────
async function sendMeetingBriefToNaresh(meeting, analysis, { subject } = {}) {
  const naresh = await getNaresh();
  const list = (arr, empty) => (arr && arr.length) ? '<ul style="margin:6px 0 14px;padding-left:18px">' + arr.map(x => `<li style="margin:3px 0">${esc(typeof x === 'string' ? x : x.task)}</li>`).join('') + '</ul>' : `<p style="color:#888;font-size:13px">${empty}</p>`;
  const actions = (analysis.action_items || []).length
    ? '<ul style="margin:6px 0 14px;padding-left:18px">' + analysis.action_items.map(a => `<li style="margin:3px 0"><strong>${esc(a.assigned_to || 'Unassigned')}</strong>: ${esc(a.task)}${a.due_date ? ` <span style="color:#888">(due ${esc(a.due_date)})</span>` : ''} <span style="color:#B45309">[${esc(a.priority || 'medium')}]</span></li>`).join('') + '</ul>'
    : '<p style="color:#888;font-size:13px">No action items extracted.</p>';
  const html = `<div style="font-family:Arial;max-width:640px;color:#222">
    <div style="background:#1B3A6B;padding:16px 22px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0">Meeting Brief</h2><p style="color:#9FE1CB;margin:4px 0 0;font-size:13px">${esc(meeting.meeting_title)} · ${esc(meeting.meeting_date)}</p></div>
    <div style="padding:18px 22px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
      <h3 style="color:#1B3A6B;margin:0 0 6px">Summary</h3><p style="font-size:14px;line-height:1.6">${esc(analysis.summary) || '—'}</p>
      <h3 style="color:#1B3A6B;margin:14px 0 6px">Decisions</h3>${list(analysis.decisions, 'None recorded.')}
      <h3 style="color:#991B1B;margin:14px 0 6px">Blockers to resolve</h3>${list(analysis.blockers, 'None raised.')}
      <h3 style="color:#166534;margin:14px 0 6px">Action items assigned</h3>${actions}
      <h3 style="color:#6B21A8;margin:14px 0 6px">Risks &amp; opportunities</h3>${list([...(analysis.risks || []), ...(analysis.opportunities || [])], 'None flagged.')}
      <p style="margin-top:16px"><a href="${BASE_URL()}/#meet-agent" style="background:#0D7377;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open Meet Agent →</a></p>
    </div></div>`;
  return sendEmail({ to: naresh.email, subject: subject || `Meeting Brief: ${meeting.meeting_title} — ${meeting.meeting_date}`, html });
}

// Core: analyse a stored meeting row and run assignment + brief. Used by both the
// Google pipeline and the manual upload endpoint.
async function analyzeAndStore(meeting, { dryRun = false, skipBrief = false, briefSubject = null, analysisOverride = null } = {}) {
  // analysisOverride: skip Claude and use a pre-computed analysis (e.g. parsed
  // Gemini notes, where the "[Name] task" next steps are the authoritative
  // assignments). Otherwise derive the analysis from the transcript with Claude.
  const transcript = meeting.transcript_text || (analysisOverride ? '' : await getTranscript(meeting));
  let analysis = analysisOverride;
  if (!analysis) {
    const members = await teamMembers();
    analysis = await analyzeMeetingWithClaude(transcript, meeting.meeting_title, meeting.attendees, meeting.meeting_date, members);
  }

  if (!dryRun) {
    // Upsert the recording row (may already exist for a Google meeting).
    await query(
      `INSERT INTO meeting_recordings (id, meeting_id, meeting_title, meeting_date, duration_seconds,
         attendees, transcript_text, summary, recording_url, is_standup, status, processed, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processed',1,NOW())
       ON CONFLICT (meeting_id) DO UPDATE SET transcript_text=EXCLUDED.transcript_text,
         summary=EXCLUDED.summary, is_standup=EXCLUDED.is_standup, status='processed', processed=1`,
      [meeting.id || crypto.randomUUID(), meeting.meeting_id, meeting.meeting_title, meeting.meeting_date,
       meeting.duration_seconds || null, JSON.stringify(meeting.attendees || []), transcript,
       analysis.summary, meeting.recording_url || null, meeting.is_standup ? 1 : 0]
    );
    // Insights
    const insert = (type, arr) => Promise.all((arr || []).map(c =>
      query(`INSERT INTO meeting_insights (id, meeting_id, insight_type, content, created_at) VALUES ($1,$2,$3,$4,NOW())`,
        [crypto.randomUUID(), meeting.meeting_id, type, String(c).slice(0, 800)]).catch(() => {})));
    await Promise.all([insert('decision', analysis.decisions), insert('blocker', analysis.blockers), insert('risk', analysis.risks), insert('opportunity', analysis.opportunities)]);
  }

  const assign = await assignTasksToTeam(meeting.meeting_id, analysis.action_items, { dryRun });
  let briefed = false;
  if (!dryRun && !skipBrief) {
    const subject = briefSubject ? briefSubject.replace('{n}', assign.tasks_created).replace('{title}', meeting.meeting_title) : null;
    briefed = !!(await sendMeetingBriefToNaresh(meeting, analysis, { subject }).catch(() => false));
  }
  return { meeting_id: meeting.meeting_id, analysis, tasks_created: assign.tasks_created, assigned: assign.assigned, brief_sent: briefed };
}

// ── Function 6 — full pipeline for one Google meeting ─────────────────────────
async function processMeeting(meeting, { dryRun = false } = {}) {
  return analyzeAndStore(meeting, { dryRun });
}

// ── PART 4 — smart standup detection over org-wide Meet sessions ───────────────
// Given reconstructed Meet sessions (from the Reports API), ask Claude which are
// likely Abiozen team meetings/standups. Returns the sessions Claude picked, each
// annotated with a likelihood, most-likely first. Falls back to a heuristic
// (2+ participants, 10–75 min) if Claude is unavailable.
async function detectStandups(sessions) {
  const list = (sessions || []).filter(s => s.meeting_code);
  if (!list.length) return [];
  const heuristic = () => list
    .filter(s => s.attendee_count >= 2 && s.duration_minutes >= 10 && s.duration_minutes <= 75)
    .map(s => ({ ...s, likelihood: 60, why: 'heuristic: multi-person, 10–75 min' }));

  const rows = list.slice(0, 60).map((s, i) =>
    `${i}. code=${s.meeting_code} organizer=${s.organizer_email || '?'} attendees=${s.attendee_count} duration=${s.duration_minutes}min date=${s.date || '?'} participants=${(s.participants || []).slice(0, 6).join(',')}`).join('\n');
  const prompt = `From these Google Meet sessions in the last 7 days, identify which ones are likely standups/team meetings for Abiozen LLC, a pharmaceutical API marketplace (team emails are @abiozen.com and @adificetechnologies.com).

${rows}

A standup/team meeting typically:
- Has multiple Abiozen/Adifice team members
- Duration 15-60 minutes
- Happens regularly (Mon/Fri or daily)
- Organizer is an Abiozen/Adifice employee

Return ONLY a JSON array, most-likely first, no prose:
[{"index": <the number above>, "likelihood": <0-100>, "why": "<short reason>"}]`;
  const { data } = await callClaude(prompt, { maxTokens: 1500, json: true });
  if (!Array.isArray(data)) return heuristic();
  const picked = [];
  for (const d of data) {
    const idx = Number(d.index);
    if (Number.isInteger(idx) && list[idx] && Number(d.likelihood) >= 50) {
      picked.push({ ...list[idx], likelihood: Number(d.likelihood), why: String(d.why || '').slice(0, 160) });
    }
  }
  return picked.length ? picked : heuristic();
}

// ── Function 7 — orchestration ────────────────────────────────────────────────
// Preferred path (PART 7): org-wide Meet activity via the Reports API → detect
// standups → pull a transcript from Drive if a recording exists → analyze →
// assign → brief. Falls back to the single-calendar scan when the Admin SDK
// scopes/super-admin aren't configured yet (both 403 gracefully).
async function runMeetAgent({ dryRun = false, lookbackDays = 7 } = {}) {
  const out = { meetings_processed: 0, tasks_created: 0, emails_sent: 0, standups_detected: 0, gemini_processed: 0, path: null, warning: null, errors: [] };

  // PRIMARY capture: Gemini meeting-notes emails (auto, no transcript paste).
  try {
    const g = await pollGeminiMeetingNotes({ dryRun, lookbackDays });
    out.gemini_processed = g.processed;
    out.meetings_processed += g.processed;
    out.tasks_created += g.tasks_created;
    out.emails_sent += g.meetings.filter(m => m.brief_sent).length;
    if (g.warning) out.errors.push('gemini: ' + g.warning);
    if (g.errors && g.errors.length) out.errors.push(...g.errors.map(e => 'gemini: ' + e));
    log(`Gemini poll: ${g.processed} processed, ${g.tasks_created} tasks`);
  } catch (e) { out.errors.push('gemini poll: ' + e.message); }

  // Secondary: org-wide Meet activity when domains are configured.
  let meetings = null, warning = null;
  const domainsConfigured = !!process.env.WORKSPACE_DOMAINS;
  if (domainsConfigured) {
    const act = await workspace.getWorkspaceMeetActivity({ lookbackDays });
    if (act.sessions && act.sessions.length) {
      const standups = await detectStandups(act.sessions);
      out.standups_detected = standups.length;
      out.path = 'workspace_reports';
      log(`workspace path: ${act.sessions.length} session(s), ${standups.length} detected standup(s)`);
      // Turn each detected standup session into a meeting object. Content still
      // comes from a Drive transcript (getTranscript searches by title); the
      // Reports API supplies only metadata (who/when/how long), not the words.
      meetings = [];
      for (const s of standups) {
        const mid = 'meet-' + s.meeting_code + (s.date ? '-' + s.date : '');
        const done = (await query('SELECT id FROM meeting_recordings WHERE meeting_id=$1 AND processed=1', [mid])).rows[0];
        if (done) continue;
        meetings.push({
          meeting_id: mid,
          meeting_title: `Team meeting ${s.meeting_code}${s.date ? ' — ' + s.date : ''}`,
          meeting_date: s.date || businessToday(),
          duration_seconds: s.duration_seconds || null,
          attendees: s.participants || [],
          description: `Meet session organized by ${s.organizer_email || 'unknown'} · ${s.attendee_count} participants · ${s.duration_minutes}min (detected ${s.likelihood}% standup).`,
          recording_url: null,
        });
      }
      warning = act.warning || null;
    } else {
      warning = act.warning || 'No Meet activity from Reports API';
      log(`workspace path yielded no sessions (${warning}); falling back to calendar scan`);
    }
  }

  // Fallback: the original single-calendar scan.
  if (!meetings) {
    const r = await fetchMeetingRecordings({ lookbackDays });
    meetings = r.meetings;
    warning = warning || r.warning || null;
    out.path = out.path || 'calendar_scan';
  }

  for (const m of meetings) {
    try {
      const r = await processMeeting(m, { dryRun });
      out.meetings_processed++;
      out.tasks_created += r.tasks_created;
      if (r.brief_sent) out.emails_sent++;
    } catch (e) { out.errors.push(`${m.meeting_title}: ${e.message}`); }
  }
  out.warning = warning;
  if (!dryRun) {
    await logAgentActivity({ agent_name: AGENT, action_type: 'meet_agent_run', user_id: null,
      reasoning: `[${out.path}] Processed ${out.meetings_processed} meetings, created ${out.tasks_created} tasks, detected ${out.standups_detected} standup(s).${warning ? ' Warning: ' + warning : ''}`,
      source_kpi: 'kpi-vision', confidence_score: out.errors.length ? 60 : 90,
      output_summary: `path=${out.path} meetings=${out.meetings_processed} tasks=${out.tasks_created} dryRun=${dryRun}` }).catch(() => {});
  }
  return out;
}

// ── Daily standup — the primary, no-OAuth workflow ───────────────────────────
// Naresh (or any admin) picks a date + attendees and pastes the standup notes;
// Claude extracts action items, they're matched to users and turned into tasks,
// and Naresh gets the brief. dryRun=true returns the extraction for review
// BEFORE anything is written/assigned (the "review before assigning" step).
async function runStandup({ date, attendees = [], notes = '', dryRun = false } = {}) {
  const meeting_date = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : businessToday();
  const list = Array.isArray(attendees)
    ? attendees.map(String).map(s => s.trim()).filter(Boolean)
    : String(attendees || '').split(',').map(s => s.trim()).filter(Boolean);
  const meeting = {
    meeting_id: 'standup-' + meeting_date + '-' + crypto.randomUUID().slice(0, 8),
    meeting_title: `Daily Standup — ${meeting_date}`,
    meeting_date,
    duration_seconds: null,
    attendees: list,
    transcript_text: String(notes || ''),
    recording_url: null,
    is_standup: true,
  };
  const result = await analyzeAndStore(meeting, { dryRun });
  return { meeting_id: meeting.meeting_id, meeting_title: meeting.meeting_title, meeting_date, is_standup: true, dryRun, ...result };
}

// Summary of a standup processed on `date` (default: the day before today, CST),
// for the CEO morning briefing. Returns null when there was no standup that day.
async function getYesterdayStandupSummary(date) {
  const day = date || isoDate(new Date(Date.now() - 86400000));
  const rows = (await query(
    `SELECT meeting_id, meeting_title, summary FROM meeting_recordings
     WHERE is_standup=1 AND processed=1 AND meeting_date=$1
     ORDER BY created_at DESC`, [day])).rows;
  if (!rows.length) return null;
  const ids = rows.map(r => r.meeting_id);
  const decisions = parseInt((await query(`SELECT COUNT(*) c FROM meeting_insights WHERE meeting_id = ANY($1) AND insight_type='decision'`, [ids])).rows[0].c, 10);
  const blockers = parseInt((await query(`SELECT COUNT(*) c FROM meeting_insights WHERE meeting_id = ANY($1) AND insight_type='blocker'`, [ids])).rows[0].c, 10);
  const tasks = parseInt((await query(`SELECT COUNT(*) c FROM meeting_tasks WHERE meeting_id = ANY($1)`, [ids])).rows[0].c, 10);
  return {
    date: day, count: rows.length, decisions, blockers, tasks_assigned: tasks,
    summary: rows[0].summary || '',
    line: `Yesterday's standup: ${decisions} decision${decisions === 1 ? '' : 's'}, ${tasks} task${tasks === 1 ? '' : 's'} assigned, ${blockers} blocker${blockers === 1 ? '' : 's'}`,
  };
}

// Best-effort: download a Meet transcript for a session from the Drive audit
// list. We can only reliably map a Reports session (which carries a meeting_code,
// not a title) to a Drive file by DATE + owner==organizer, so this stays a
// heuristic — it returns null (→ needs_transcript) whenever it can't be sure.
async function fetchSessionTranscript(session, driveRecordings) {
  const transcripts = (driveRecordings || []).filter(r => /\.vtt|transcript/i.test(String(r.doc_title || '')) && r.doc_id);
  if (!transcripts.length) return null;
  const org = (session.organizer_email || '').toLowerCase();
  const cand = transcripts.find(r =>
    (!session.date || String(r.time || '').slice(0, 10) === session.date) &&
    (!org || String(r.owner || r.actor || '').toLowerCase() === org)) || null;
  if (!cand) return null;
  // Download impersonating the file's owner (falls back to the meet impersonate user).
  const subject = (cand.owner && cand.owner.includes('@')) ? cand.owner : (cand.actor || MEET_IMPERSONATE());
  const tok = await getGoogleToken({ subject, scopes: [SCOPES.driveReadonly] });
  if (tok.error) { log(`transcript token for ${subject} failed: ${tok.error}`); return null; }
  try {
    const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${cand.doc_id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: 'Bearer ' + tok.access_token } });
    if (!dl.ok) { log(`transcript download ${cand.doc_id} → ${dl.status}`); return null; }
    const text = cleanTranscript(await dl.text());
    return text || null;
  } catch (e) { log('fetchSessionTranscript error:', e.message); return null; }
}

// ── Sync workspace Meet sessions → meeting_recordings ─────────────────────────
// Bridges the org-wide Reports API data into the table the page reads from. Each
// detected standup becomes a row: 'processed' when a transcript could be fetched
// and analyzed, else 'needs_transcript' (Naresh pastes it later). Already-processed
// rows are left untouched. Returns per-session outcomes for the UI.
async function syncWorkspaceMeetings({ lookbackDays = 7, autoProcess = true } = {}) {
  const act = await workspace.getWorkspaceMeetActivity({ lookbackDays });
  const sessions = act.sessions || [];
  const out = { sessions_found: sessions.length, standups_detected: 0, processed: 0, needs_transcript: 0, already_processed: 0, rows: [], warning: act.warning || null };
  if (!sessions.length) return out;

  const standups = await detectStandups(sessions);
  out.standups_detected = standups.length;
  // Drive recordings once, for best-effort transcript matching.
  let driveRecordings = [];
  if (autoProcess) { try { driveRecordings = (await workspace.getWorkspaceDriveActivity({ lookbackDays })).recordings || []; } catch { driveRecordings = []; } }

  for (const s of standups) {
    const code = s.meeting_code;
    const date = s.date || businessToday();
    const mid = 'meet-' + code + (date ? '-' + date : '');
    const title = `Team meeting ${code}${date ? ' — ' + date : ''}`;
    const attendees = s.participants || [];
    const meetLink = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(code) ? `https://meet.google.com/${code}` : null;

    const existing = (await query('SELECT id, processed FROM meeting_recordings WHERE meeting_id=$1', [mid])).rows[0];
    if (existing && existing.processed) { out.already_processed++; out.rows.push({ meeting_id: mid, title, date, status: 'processed' }); continue; }

    // Try to pull + analyze a transcript; otherwise store as needs_transcript.
    let transcript = null;
    if (autoProcess) transcript = await fetchSessionTranscript(s, driveRecordings);
    if (transcript) {
      try {
        const r = await analyzeAndStore({ meeting_id: mid, meeting_title: title, meeting_date: date, duration_seconds: s.duration_seconds || null, attendees, transcript_text: transcript, recording_url: meetLink, is_standup: true }, { dryRun: false });
        out.processed++;
        out.rows.push({ meeting_id: mid, title, date, status: 'processed', tasks: r.tasks_created });
        continue;
      } catch (e) { log(`analyze failed for ${mid}: ${e.message}`); /* fall through to needs_transcript */ }
    }
    await query(
      `INSERT INTO meeting_recordings (id, meeting_id, meeting_title, meeting_date, duration_seconds, attendees, recording_url, is_standup, status, processed, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,'needs_transcript',0,NOW())
       ON CONFLICT (meeting_id) DO UPDATE SET meeting_title=EXCLUDED.meeting_title, meeting_date=EXCLUDED.meeting_date,
         duration_seconds=EXCLUDED.duration_seconds, attendees=EXCLUDED.attendees, recording_url=EXCLUDED.recording_url,
         status=CASE WHEN meeting_recordings.processed=1 THEN meeting_recordings.status ELSE 'needs_transcript' END`,
      [crypto.randomUUID(), mid, title, date, s.duration_seconds || null, JSON.stringify(attendees), meetLink]
    );
    out.needs_transcript++;
    out.rows.push({ meeting_id: mid, title, date, status: 'needs_transcript', attendee_count: s.attendee_count, duration_minutes: s.duration_minutes });
  }

  await logAgentActivity({ agent_name: AGENT, action_type: 'workspace_sync', user_id: null,
    reasoning: `Synced ${out.sessions_found} Meet session(s): ${out.standups_detected} standup(s) detected, ${out.processed} processed, ${out.needs_transcript} awaiting transcript.`,
    source_kpi: 'kpi-vision', confidence_score: 90,
    output_summary: `sessions=${out.sessions_found} standups=${out.standups_detected} processed=${out.processed} needs_transcript=${out.needs_transcript}` }).catch(() => {});
  return out;
}

// ══ Gemini meeting notes → auto-capture from Gmail ════════════════════════════
// Google Workspace Gemini emails meeting notes to naren@abiozen.com after each
// meeting (from gemini-notes@google.com, subject "Notes from <Title>"). We poll
// that mailbox and turn each note into a processed meeting — no manual paste.
const GEMINI_MAILBOX = () => process.env.GEMINI_MAILBOX || process.env.MEET_IMPERSONATE || 'naren@abiozen.com';
const GEMINI_SENDER = () => process.env.GEMINI_NOTES_SENDER || 'gemini-notes@google.com';

function b64urlDecode(d) { return Buffer.from(String(d || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
function gmailHeader(payload, name) {
  const h = (payload?.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}
function extractGmailBody(payload) {
  const walk = p => {
    if (!p) return '';
    if (p.mimeType === 'text/plain' && p.body?.data) return b64urlDecode(p.body.data);
    if (p.parts) { for (const sub of p.parts) { const t = walk(sub); if (t) return t; } }
    if (p.mimeType === 'text/html' && p.body?.data) return b64urlDecode(p.body.data).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    if (p.body?.data) return b64urlDecode(p.body.data);
    return '';
  };
  return String(walk(payload) || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n');
}
async function markGmailRead(user, gmailId, accessToken) {
  try {
    await fetch(`https://gmail.googleapis.com/gmail/v1/users/${user}/messages/${gmailId}/modify`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
    });
  } catch (_) {}
}
async function getGmailToken() {
  return getGoogleToken({ subject: GEMINI_MAILBOX(), scopes: [SCOPES.gmailReadonly, SCOPES.gmailModify] });
}

// ── PART 2 — parse the Gemini notes email into structured data ────────────────
function extractGeminiNotes(emailBody) {
  const body = String(emailBody || '').replace(/\r/g, '');
  const rawLines = body.split('\n').map(l => l.replace(/ /g, ' ').trim());
  const HEAD = /^(summary|recap|details|decisions?|suggested next steps|next steps|action items|attendees|invited|participants)\b/i;
  const sections = { _preamble: [] };
  let cur = '_preamble';
  for (const l of rawLines) {
    const h = l.match(HEAD);
    if (h && l.length < 42) { cur = h[1].toLowerCase().replace(/s$/, ''); sections[cur] = sections[cur] || []; continue; }
    (sections[cur] = sections[cur] || []).push(l);
  }
  const sec = names => { for (const n of names) if (sections[n]) return sections[n]; return []; };
  const deBullet = l => l.replace(/^[\-\*•·•\s]+/, '').trim();

  const summary = sec(['summary', 'recap']).map(deBullet).filter(Boolean).join(' ').slice(0, 2000).trim();
  const decisions = sec(['decision']).map(deBullet).filter(l => l && !HEAD.test(l)).slice(0, 30);

  // Next steps use "[Name] task". Prefer the next-steps section; else scan all.
  const nsSection = sec(['suggested next step', 'next step', 'action item']);
  const scan = nsSection.length ? nsSection : rawLines;
  const re = /\[([^\]]{2,60})\]\s*(.+)/;
  const next_steps = [];
  const seen = new Set();
  for (const l of scan) {
    const m = l.match(re);
    if (!m) continue;
    const task = deBullet(m[2]).replace(/\s+/g, ' ').trim();
    const key = (m[1] + '|' + task).toLowerCase();
    if (!task || seen.has(key)) continue;
    seen.add(key);
    next_steps.push({ assignee_name: m[1].trim(), task, raw_line: l });
  }

  let attendees = sec(['attendee', 'invited', 'participant'])
    .flatMap(l => deBullet(l).split(/[,;·|]| and /i)).map(x => x.trim())
    .filter(x => x && x.length > 1 && !/^https?:/i.test(x) && !HEAD.test(x));
  if (!attendees.length) attendees = [...new Set(next_steps.map(n => n.assignee_name))];

  return { summary, decisions, next_steps, attendees: attendees.slice(0, 40) };
}

// ── PART 7 — read the full "Open meeting notes" Google Doc ────────────────────
function extractDocId(body) {
  const m = String(body || '').match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : null;
}
async function fetchGeminiDoc(docId) {
  if (!docId) return null;
  const tok = await getGoogleToken({ subject: GEMINI_MAILBOX(), scopes: [SCOPES.driveReadonly] });
  if (tok.error) { log('doc token failed:', tok.error); return null; }
  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`, { headers: { Authorization: 'Bearer ' + tok.access_token } });
    if (!res.ok) { log(`doc export ${docId} → ${res.status}`); return null; }
    return cleanTranscript(await res.text());
  } catch (e) { log('fetchGeminiDoc error:', e.message); return null; }
}

// ── PARTs 3 & 4 — process ONE Gemini email into a processed meeting ────────────
async function processGeminiEmail({ title, date, body, docText }, { dryRun = false } = {}) {
  const notes = extractGeminiNotes(body);
  const isStandup = /stand[\s-]?up|daily|scrum/i.test(title || '');

  // If we have the full Google Doc, enrich blockers/risks/opportunities + summary
  // via Claude — but the "[Name] task" next steps remain the authoritative owners.
  let enriched = null;
  if (docText && docText.length > 200) {
    const members = await teamMembers();
    enriched = await analyzeMeetingWithClaude(docText, title, notes.attendees, date, members).catch(() => null);
  }

  // Authoritative assignments come from the parsed next steps; fall back to
  // Claude's action items only if Gemini listed none. Unmatched owners → admin.
  const users = await teamMembers();
  const naresh = await getNaresh();
  let action_items;
  if (notes.next_steps.length) {
    action_items = notes.next_steps.map(ns => {
      const matched = matchUser(ns.assignee_name, users);
      return {
        assigned_to: matched ? ns.assignee_name : naresh.email,
        task: matched ? ns.task : `(for ${ns.assignee_name}) ${ns.task}`,
        priority: 'medium', due_date: null, source_quote: ns.raw_line,
      };
    });
  } else {
    action_items = (enriched && enriched.action_items) || [];
  }

  const analysis = {
    summary: (enriched && enriched.summary) || notes.summary || '',
    decisions: notes.decisions.length ? notes.decisions : ((enriched && enriched.decisions) || []),
    blockers: (enriched && enriched.blockers) || [],
    risks: (enriched && enriched.risks) || [],
    opportunities: (enriched && enriched.opportunities) || [],
    action_items,
  };

  const slug = String(title || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const meeting = {
    meeting_id: `gemini-${date}-${slug}`,
    meeting_title: title || 'Gemini meeting notes',
    meeting_date: date,
    duration_seconds: null,
    attendees: notes.attendees,
    transcript_text: docText || body || '',
    recording_url: null,
    is_standup: isStandup,
  };

  const result = await analyzeAndStore(meeting, {
    dryRun, analysisOverride: analysis,
    briefSubject: `Meeting processed: ${meeting.meeting_title} — {n} tasks assigned`,
  });
  return { ...result, meeting_title: meeting.meeting_title, meeting_date: date, next_steps: notes.next_steps.length, had_doc: !!docText };
}

// ── PART 1 — poll Gmail for Gemini meeting notes ──────────────────────────────
async function pollGeminiMeetingNotes({ dryRun = false, lookbackDays = 7, maxMessages = 25 } = {}) {
  const out = { found: 0, processed: 0, tasks_created: 0, skipped: 0, meetings: [], warning: null, errors: [] };
  const tok = await getGmailToken();
  if (tok.error) { out.warning = `Gmail unavailable: ${tok.error}. Check the service account (DWD) can impersonate ${GEMINI_MAILBOX()} with gmail scopes.`; return out; }
  const user = encodeURIComponent(GEMINI_MAILBOX());
  const q = encodeURIComponent(`from:${GEMINI_SENDER()} subject:"Notes from" is:unread newer_than:${lookbackDays}d`);
  let list;
  try {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${user}/messages?q=${q}&maxResults=${maxMessages}`, { headers: { Authorization: 'Bearer ' + tok.access_token } });
    if (!res.ok) { out.warning = `Gmail list ${res.status}: ${(await res.text()).slice(0, 180)}`; return out; }
    list = await res.json();
  } catch (e) { out.warning = e.message; return out; }
  const refs = list.messages || [];
  out.found = refs.length;
  log(`Gemini poll: ${refs.length} unread note email(s) in last ${lookbackDays}d`);

  for (const ref of refs) {
    const gmailId = ref.id;
    try {
      // At-most-once: claim the id before processing (survives re-runs even if the
      // mark-as-read below fails).
      if (!dryRun) {
        const claimed = await query(`INSERT INTO processed_emails (id, source, processed_at) VALUES ($1,'gemini',NOW()) ON CONFLICT (id) DO NOTHING RETURNING id`, [gmailId]);
        if (!claimed.rows.length) { out.skipped++; continue; }
      }
      const dRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${user}/messages/${gmailId}?format=full`, { headers: { Authorization: 'Bearer ' + tok.access_token } });
      if (!dRes.ok) { out.errors.push(`${gmailId}: get ${dRes.status}`); continue; }
      const msg = await dRes.json();
      const subject = gmailHeader(msg.payload, 'Subject') || '';
      const title = subject.replace(/^\s*Notes from\s*[:\-]?\s*/i, '').trim() || 'Gemini meeting notes';
      const dateHeader = gmailHeader(msg.payload, 'Date');
      const date = dateHeader && !isNaN(new Date(dateHeader)) ? isoDate(dateHeader) : businessToday();
      const body = extractGmailBody(msg.payload) || msg.snippet || '';
      const docText = await fetchGeminiDoc(extractDocId(body));

      const r = await processGeminiEmail({ title, date, body, docText }, { dryRun });
      out.processed++;
      out.tasks_created += r.tasks_created || 0;
      out.meetings.push({ title, date, tasks: r.tasks_created || 0, next_steps: r.next_steps, had_doc: r.had_doc, brief_sent: r.brief_sent });
      if (!dryRun) await markGmailRead(user, gmailId, tok.access_token);
    } catch (e) { out.errors.push(`${gmailId}: ${e.message}`); }
  }

  if (!dryRun && (out.processed || out.errors.length)) {
    await logAgentActivity({ agent_name: AGENT, action_type: 'gemini_notes_poll', user_id: null,
      reasoning: `Polled ${GEMINI_MAILBOX()} for Gemini notes: ${out.processed} processed, ${out.tasks_created} tasks assigned, ${out.errors.length} error(s).`,
      source_kpi: 'kpi-vision', confidence_score: out.errors.length ? 65 : 92,
      output_summary: `found=${out.found} processed=${out.processed} tasks=${out.tasks_created}` }).catch(() => {});
  }
  return out;
}

module.exports = {
  runMeetAgent, processMeeting, fetchMeetingRecordings, getTranscript,
  analyzeMeetingWithClaude, assignTasksToTeam, sendMeetingBriefToNaresh, analyzeAndStore, matchUser,
  runStandup, getYesterdayStandupSummary, detectStandups, syncWorkspaceMeetings,
  pollGeminiMeetingNotes, extractGeminiNotes, processGeminiEmail, fetchGeminiDoc,
};
