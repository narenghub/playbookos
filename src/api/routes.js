const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { signToken, authMiddleware, adminOnly, requireTier, requireAnyTier, syncGitHubForUser, analyzeTeamProgress, runClaudeAnalysis } = require('../lib/core');
const { query, withTransaction } = require('../lib/db');
const { sendEmail } = require('../lib/mailer');
const { checkMilestoneTriggers } = require('../lib/jobs');
const { cascadeGoals, assignWeeklyKPIs, assignWeeklyKPIsForAll, mondayOf } = require('../lib/agents/goal-engine');
const { getWarmLeads, generateOutreachRecommendations } = require('../lib/agents/customer-agent');
const { takeMetricsSnapshot } = require('../lib/agents/metrics-snapshot');
const { getAllRoles, isBuiltIn, getRolePages } = require('../lib/roles');
const { identifyContentGaps, trackAlgoliaNoResults, trackKeywordRankings, generateCatalogSeoPages, pushSeoContentToAbiozen } = require('../lib/agents/seo-agent');
const { syncAlgoliaSearchData, generateSEORecommendations, runMarketIntelligence } = require('../lib/agents/growth-agent');
const { runEmailEngine, SEGMENTS, sanitizeHtml, publishSequenceToApollo } = require('../lib/agents/email-engine');
const { processApolloReplies, generateFollowUp, getLeadPipeline } = require('../lib/agents/sales-agent');
const { runProcurementAgent, scoreAndRankSuppliers } = require('../lib/agents/procurement-agent');
const { runMeetAgent, analyzeAndStore } = require('../lib/agents/meet-agent');
const { runResearchAgent } = require('../lib/agents/research-agent');
const { runReorderAgent, syncBuyersFromOrders, identifyReorderCandidates } = require('../lib/agents/reorder-agent');
const { receiveInquiry, processInboundReply, generateQuote, escalateToHuman, runInquiryAgent, pollSalesEmailbox, gmailConnectionTest } = require('../lib/agents/inquiry-agent');
const { getKPIHierarchy, getBottlenecks, getCrossTeamDependencies, calculateKPIScore } = require('../lib/kpi-engine');
const { runMorningBriefing, runPerformanceCheck, runEscalationCheck } = require('../lib/agents/orchestrator');
const { sendWhatsApp } = require('../lib/whatsapp');
const { generateProductPost, generateMarketIntelligencePost, generateCompanyUpdate, runWeeklyLinkedInCampaign, scheduleLinkedInContent, getCombinedDemandMolecules, enrichWithCatalog, getMoleculeStructureImage, generatePostImage, publishPost: publishLinkedInPost } = require('../lib/agents/linkedin-agent');
const { syncPlaybookOSSkus, syncAbiozenProducts } = require('../lib/algolia-sync');
const { createDailyTask, logAgentActivity, parseClaudeJSON, businessToday, enqueueApproval } = require('../lib/agent-core');

const router = express.Router();

// Role-based "director sees their team" map (inverse of getDirectorRole). Used by
// the employee-activity timeline permission gate. No schema — pure role mapping.
const DIRECTOR_TEAM = {
  procurement_director: ['procurement_team', 'procurement_director'],
  recruitment_director: ['recruitment_team', 'recruitment_director'],
  sales_director:       ['sales_team', 'account_manager', 'sales_director'],
};
// Can `viewer` (JWT payload) see `targetId`'s activity? admin/super_admin → anyone;
// self → always; director → only users whose role is in their team set; else false.
async function canViewUser(viewer, targetId) {
  if (viewer.role === 'admin' || viewer.role === 'super_admin') return true;
  if (viewer.id === targetId) return true;
  const team = DIRECTOR_TEAM[viewer.role];
  if (!team) return false;
  const tgt = (await query('SELECT role FROM users WHERE id=$1', [targetId])).rows[0];
  return !!tgt && team.includes(tgt.role);
}

const rateLimitStore = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (rateLimitStore.get(ip) || []).filter(t => now - t < windowMs);
    if (recent.length >= maxRequests) {
      const retryAfter = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Too many requests. Try again in ${retryAfter}s.` });
    }
    recent.push(now);
    rateLimitStore.set(ip, recent);
    next();
  };
}
const authLimiter = rateLimit(10, 60 * 1000);

router.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = await query('SELECT * FROM users WHERE email=$1 AND is_active=1', [email.toLowerCase().trim()]);
    const user = result.rows[0];
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role, github_username: user.github_username, can_run_standup: !!user.can_run_standup } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/auth/accept-invite', authLimiter, async (req, res) => {
  try {
    const { token, password, name } = req.body;
    if (!token || !password || !name) return res.status(400).json({ error: 'Token, name, and password required' });
    const result = await query('SELECT * FROM users WHERE invite_token=$1', [token]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid or expired invite token' });
    const hash = bcrypt.hashSync(password, 10);
    await query('UPDATE users SET password_hash=$1, name=$2, invite_token=NULL, joined_at=$3 WHERE id=$4', [hash, name, new Date().toISOString(), user.id]);
    const updated = (await query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
    res.json({ token: signToken(updated), user: { id: updated.id, name: updated.name, email: updated.email, role: updated.role } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT id,name,email,role,github_username,can_run_standup FROM users WHERE id=$1', [req.user.id]);
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/roles', authMiddleware, async (req, res) => {
  try {
    const catalog = await getAllRoles();
    const list = Object.entries(catalog).map(([role_name, def]) => ({
      role_name,
      display_name: def.display_name,
      level: def.level,
      domain: def.domain,
      data_scope: def.data_scope,
      pages: def.pages,
      tiers: def.tiers,
      metrics: def.metrics,
      baseline: def.baseline,
      built_in: !!def.built_in,
      custom: !!def.custom,
    }));
    res.json({ count: list.length, roles: list });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/roles', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { role_name, display_name, metrics } = req.body || {};
    if (!role_name) return res.status(400).json({ error: 'role_name is required (snake_case identifier)' });
    if (!/^[a-z][a-z0-9_]*$/.test(role_name)) return res.status(400).json({ error: 'role_name must be snake_case starting with a letter' });
    if (isBuiltIn(role_name)) return res.status(400).json({ error: `role_name "${role_name}" is a built-in role; pick a different identifier or modify in src/lib/roles.js` });
    if (!display_name) return res.status(400).json({ error: 'display_name is required' });
    if (!Array.isArray(metrics) || metrics.length === 0) return res.status(400).json({ error: 'metrics must be a non-empty array of metric names' });
    if (metrics.some(m => typeof m !== 'string' || !/^[a-z][a-z0-9_]*$/.test(m))) return res.status(400).json({ error: 'each metric must be a snake_case string' });
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO custom_roles (id, role_name, display_name, metrics_json) VALUES ($1, $2, $3, $4)
       ON CONFLICT (role_name) DO UPDATE SET display_name=$3, metrics_json=$4`,
      [id, role_name, display_name, JSON.stringify(metrics)]
    );
    res.json({ success: true, role_name, display_name, metrics });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/users', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT id,name,email,role,github_username,joined_at,is_active FROM users ORDER BY role,name');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/users/invite', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { email, role, github_username, whatsapp_number } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'Email and role required' });
    const catalog = await getAllRoles();
    if (!catalog[role]) {
      return res.status(400).json({ error: `Unknown role "${role}". Valid roles: ${Object.keys(catalog).join(', ')}` });
    }
    const existing = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(400).json({ error: 'User already exists' });
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID();
    const wa = whatsapp_number ? String(whatsapp_number).trim() : null;
    await query('INSERT INTO users (id,email,name,role,github_username,whatsapp_number,invite_token,invited_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, email.toLowerCase(), email.split('@')[0], role, github_username || null, wa, inviteToken, new Date().toISOString()]);
    const baseUrl = process.env.BASE_URL || 'https://playbookos-production.up.railway.app';
    const inviteUrl = `${baseUrl}/#/accept-invite?token=${inviteToken}`;
    sendEmail({ to: email, subject: `You've been invited to Abiozen PlaybookOS`, triggerType: 'invite',
      html: `<div style="font-family:Arial;max-width:600px"><h2 style="color:#1B3A6B">Abiozen PlaybookOS</h2><p>You've been invited as <strong>${role}</strong>.</p><a href="${inviteUrl}" style="background:#0D7377;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">Accept Invite</a><p style="color:#666;font-size:13px">Or copy: ${inviteUrl}</p></div>` });

    // Fire-and-forget WhatsApp welcome if a number was provided. Skips
    // gracefully when Twilio env vars are unset (sendWhatsApp returns
    // { skipped, reason }). Failures must not break the invite response.
    let whatsapp_status = null;
    if (wa) {
      const welcome = `Welcome to Abiozen PlaybookOS! 🚀 You've been invited as ${role}. Login at ${baseUrl} with your email. You'll receive daily task assignments and KPI updates here on WhatsApp.`;
      try {
        const r = await sendWhatsApp(wa, welcome, { user_id: id, message_type: 'welcome' });
        whatsapp_status = r.success ? 'sent' : (r.skipped ? 'skipped:' + r.reason : 'error:' + r.error);
      } catch(e) { whatsapp_status = 'error:' + e.message; }
    }

    res.json({ success: true, message: `Invite sent to ${email}`, inviteUrl, whatsapp_status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/profile', authMiddleware, async (req, res) => {
  try {
    const { github_username, name, whatsapp_number, user_id } = req.body;
    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    const targetId = (isAdmin && user_id) ? user_id : req.user.id;
    const wa = whatsapp_number === undefined ? null : String(whatsapp_number || '').trim();
    await query(
      `UPDATE users SET
         github_username = COALESCE($1, github_username),
         name = COALESCE($2, name),
         whatsapp_number = COALESCE($3, whatsapp_number)
       WHERE id = $4`,
      [github_username || null, name || null, wa || null, targetId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.id !== id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { github_username, name, role, user_id } = req.body;
    const targetId = (req.user.role === 'admin' && user_id) ? user_id : id;

    // role changes are admin-only and validated against the catalog —
    // a non-admin editing their own profile must not be able to self-escalate.
    let validatedRole = null;
    if (role !== undefined && role !== null && role !== '') {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can change a user role' });
      const catalog = await getAllRoles();
      if (!catalog[role]) return res.status(400).json({ error: `Unknown role "${role}". Valid roles: ${Object.keys(catalog).join(', ')}` });
      validatedRole = role;
    }

    await query(
      'UPDATE users SET github_username=COALESCE($1,github_username), name=COALESCE($2,name), role=COALESCE($3,role) WHERE id=$4',
      [github_username || null, name || null, validatedRole, targetId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /users/:id — default is a soft delete (is_active=0). With
// ?permanent=true it hard-deletes the row (the "Delete Permanently" action).
router.delete('/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
    const target = (await query('SELECT id, role FROM users WHERE id=$1', [id])).rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin') return res.status(403).json({ error: 'A super_admin account cannot be removed' });
    if (req.query.permanent === 'true') {
      await query('DELETE FROM users WHERE id=$1', [id]);
      return res.json({ success: true, id, deleted: 'permanent' });
    }
    await query('UPDATE users SET is_active=0 WHERE id=$1', [id]);
    res.json({ success: true, id, is_active: 0, deleted: 'soft' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /users/:id/toggle-status — if the body carries is_active (0|1) the
// status is set explicitly; otherwise the current value is flipped.
router.put('/users/:id/toggle-status', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot change your own status' });
    const target = (await query('SELECT id, role, is_active FROM users WHERE id=$1', [id])).rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin') return res.status(403).json({ error: 'A super_admin account status cannot be changed' });
    const desired = req.body && (req.body.is_active === 0 || req.body.is_active === 1) ? req.body.is_active : null;
    const newStatus = desired !== null ? desired : (target.is_active ? 0 : 1);
    await query('UPDATE users SET is_active=$1 WHERE id=$2', [newStatus, id]);
    res.json({ success: true, id, is_active: newStatus, status: newStatus ? 'active' : 'inactive' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Unambiguous alphabet for generated temp passwords — excludes 0/O/o/1/l/I so a
// password is easy to read aloud / type when shared over Slack or WhatsApp.
const TEMP_PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function generateTempPassword(len = 12) {
  const alpha = TEMP_PW_ALPHABET;
  // Rejection-sampling ceiling: discard bytes >= max so we never introduce
  // modulo bias toward the first (256 % alpha.length) characters.
  const max = 256 - (256 % alpha.length);
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < max) { out += alpha[b % alpha.length]; if (out.length === len) break; }
    }
  }
  return out;
}

// POST /admin/users/:user_id/reset-password — admin-driven password reset that
// preserves ALL of the target's data (tasks, KPIs, scores, audit history); only
// password_hash is updated. The temp password is returned ONCE in the response
// body and is never persisted or logged in plaintext. super_admin and self are
// blocked, mirroring the delete / toggle-status guards above.
router.post('/admin/users/:user_id/reset-password', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { user_id } = req.params;
    if (user_id === req.user.id) return res.status(400).json({ error: 'You cannot reset your own password here' });
    const target = (await query('SELECT id, email, role FROM users WHERE id=$1', [user_id])).rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin') return res.status(403).json({ error: 'A super_admin password cannot be reset here' });
    const tempPassword = generateTempPassword(12);
    const hash = bcrypt.hashSync(tempPassword, 10);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, target.id]);
    await logAgentActivity({
      agent_name: req.user.email,
      action_type: 'admin_password_reset',
      user_id: target.id,
      reasoning: `Admin ${req.user.email} reset password for ${target.email}`,
    });
    res.json({ success: true, temp_password: tempPassword, email: target.email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Edit a user's display name (admin-only). Fixes invite typos without delete +
// re-invite, so all of the user's data (tasks, KPIs, scores, history) is kept.
// Name only — no role/email/other-field changes here.
router.post('/admin/users/:user_id/edit-name', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { user_id } = req.params;
    if (typeof req.body?.name !== 'string') return res.status(400).json({ error: 'name must be a string' });
    const name = req.body.name.trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    if (name.length > 100) return res.status(400).json({ error: 'name must be 100 characters or fewer' });
    const target = (await query('SELECT id, name, email, role FROM users WHERE id=$1', [user_id])).rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    const oldName = target.name;
    await query('UPDATE users SET name=$1 WHERE id=$2', [name, target.id]);
    await logAgentActivity({
      agent_name: req.user.email,
      action_type: 'admin_user_edit',
      user_id: target.id,
      reasoning: `Admin ${req.user.email} renamed ${target.email}: "${oldName}" → "${name}"`,
    });
    res.json({ success: true, user: { id: target.id, name, email: target.email, role: target.role } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /users/send-onboarding (admin) — daily-usage nudge to active users currently
// at a 0 performance score (engagement, not activation — everyone has logged in).
// Excludes super_admin + scoring-excluded users. ?dryRun=1 previews recipients
// without sending. sendEmail() logs each send to email_log.
router.post('/users/send-onboarding', authMiddleware, adminOnly, async (req, res) => {
  try {
    const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
    const recips = (await query(`
      SELECT u.id, u.name, u.email, u.role,
             COALESCE(s.total_score, 0) AS score,
             COALESCE(s.consecutive_days_below_60, 0) AS streak_below_60
      FROM users u
      LEFT JOIN LATERAL (
        SELECT total_score, consecutive_days_below_60 FROM performance_scores p
        WHERE p.user_id = u.id AND COALESCE(p.is_weekly_summary, 0) = 0
        ORDER BY score_date DESC LIMIT 1
      ) s ON true
      WHERE u.is_active = 1 AND u.email IS NOT NULL
        AND u.role <> 'super_admin'
        AND COALESCE(u.excluded_from_scoring, false) = false
        AND COALESCE(s.total_score, 0) = 0
      ORDER BY u.name`)).rows;

    if (dryRun) {
      return res.json({ dryRun: true, count: recips.length,
        recipients: recips.map(r => ({ name: r.name, email: r.email, role: r.role, score: r.score })) });
    }

    const base = process.env.BASE_URL || 'https://playbook.abiozen.com';
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let sent = 0; const results = [];
    for (const u of recips) {
      const streakLine = u.streak_below_60 > 1
        ? ` · below target for ${u.streak_below_60} days` : '';
      const html = `<div style="font-family:Arial;max-width:600px;line-height:1.65;color:#333">
  <div style="background:#1B3A6B;padding:18px 22px;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0">Hi ${esc(u.name)}, let's get your score moving 📈</h2>
    <p style="color:#9FE1CB;margin:6px 0 0;font-size:13px">A 5-minute daily routine on PlaybookOS</p>
  </div>
  <div style="padding:22px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px 16px;margin-bottom:16px">
      <div style="font-size:12px;color:#15803d">Your latest daily score</div>
      <div style="font-size:24px;font-weight:700;color:#166534">${u.score}/100${streakLine}</div>
    </div>
    <p>You're all set up and logged in — the score just reflects daily activity, and yours has room to climb. Here's the routine:</p>
    <ol style="padding-left:18px">
      <li><strong>Log in every morning</strong> at <a href="${base}">${base}</a></li>
      <li>Open <strong>My Tasks</strong> — see your AI-assigned tasks for the day</li>
      <li>Start a task — click <strong>In Progress</strong></li>
      <li>Finish it — click <strong>Done</strong></li>
      <li>Record what you did on the <strong>My Activity</strong> page</li>
    </ol>
    <p style="background:#f8fafc;border-radius:6px;padding:12px 14px"><strong>How scoring works:</strong> your daily score is calculated at 1pm CDT / 11:30pm IST. Complete your tasks and log activity before then to score above 70.</p>
    <p style="margin-top:16px"><a href="${base}/#my-tasks" style="background:#0D7377;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:700">Open My Tasks →</a></p>
    <p style="color:#666;font-size:13px;margin-top:16px">You've got this — small daily actions add up fast. 🙌</p>
  </div>
</div>`;
      const ok = await sendEmail({ to: u.email, subject: 'Your PlaybookOS daily guide — improve your score today', html });
      if (ok) sent++;
      results.push({ name: u.name, email: u.email, score: u.score, sent: !!ok });
    }
    res.json({ success: true, sent, total: recips.length, recipients: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /users/send-task-nudge (admin) — follow-up to the onboarding nudge, aimed
// at the specific gap it did not close: users work their tasks but never move them
// out of pending, so the KPI/completion components of the score stay at 0.
// Unlike send-onboarding this targets ALL active users, not just the 0-score ones.
// ?dryRun=1 previews recipients without sending. sendEmail() logs to email_log.
router.post('/users/send-task-nudge', authMiddleware, adminOnly, async (req, res) => {
  try {
    const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
    const recips = (await query(`
      SELECT u.id, u.name, u.email, u.role
      FROM users u
      WHERE u.is_active = 1 AND u.email IS NOT NULL
        AND u.role <> 'super_admin'
        AND COALESCE(u.excluded_from_scoring, false) = false
      ORDER BY u.name`)).rows;

    if (dryRun) {
      return res.json({ dryRun: true, count: recips.length,
        recipients: recips.map(r => ({ name: r.name, email: r.email, role: r.role })) });
    }

    const base = process.env.BASE_URL || 'https://playbook.abiozen.com';
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let sent = 0; const results = [];
    for (const u of recips) {
      const html = `<div style="font-family:Arial;max-width:600px;line-height:1.65;color:#333">
  <div style="background:#991B1B;padding:18px 22px;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0">Action required: mark your tasks complete</h2>
    <p style="color:#FECACA;margin:6px 0 0;font-size:13px">Hi ${esc(u.name)} — this takes under a minute per task</p>
  </div>
  <div style="padding:22px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
    <p><strong>Your score only improves when you mark tasks complete. Every task = points toward your daily score.</strong></p>
    <p>Doing the work isn't enough on its own — PlaybookOS scores what's marked done. Here's exactly how:</p>
    <ol style="padding-left:18px">
      <li>Go to <a href="${base}">${base}</a></li>
      <li>Click <strong>My Tasks</strong> in the left sidebar</li>
      <li>Find your assigned tasks</li>
      <li>Click the task → click <strong>In Progress</strong> when you start</li>
      <li>Click <strong>Done</strong> when you finish</li>
    </ol>
    <div style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:12px 16px;margin:16px 0">
      <strong>Please do this today.</strong> Naresh reviews everyone's scores daily — an unmarked task reads as no work done.
    </div>
    <p style="margin-top:16px"><a href="${base}/#my-tasks" style="background:#991B1B;color:#fff;padding:11px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:700">Open My Tasks →</a></p>
  </div>
</div>`;
      const ok = await sendEmail({ to: u.email, subject: 'Action required: mark your tasks complete in PlaybookOS', html });
      if (ok) sent++;
      results.push({ name: u.name, email: u.email, sent: !!ok });
    }
    res.json({ success: true, sent, total: recips.length, recipients: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/activity', authMiddleware, async (req, res) => {
  try {
    const { log_date, metric, value, notes } = req.body;
    if (!log_date || !metric || value === undefined) return res.status(400).json({ error: 'log_date, metric, value required' });
    const existing = await query(`SELECT id FROM activity_logs WHERE user_id=$1 AND log_date=$2 AND metric=$3 AND source='manual'`, [req.user.id, log_date, metric]);
    if (existing.rows[0]) {
      await query('UPDATE activity_logs SET value=$1, notes=$2 WHERE id=$3', [value, notes || null, existing.rows[0].id]);
    } else {
      await query(`INSERT INTO activity_logs (id,user_id,log_date,metric,value,notes,source) VALUES ($1,$2,$3,$4,$5,$6,'manual')`,
        [crypto.randomUUID(), req.user.id, log_date, metric, value, notes || null]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/activity/my', authMiddleware, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);
    const result = await query('SELECT * FROM activity_logs WHERE user_id=$1 AND log_date BETWEEN $2 AND $3 ORDER BY log_date DESC', [req.user.id, dateFrom, dateTo]);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Per-employee activity timeline. Permission: admin → anyone, director → their
// team, employee → self (enforced by canViewUser; the frontend filter is UX only).
// One UNION ALL across agent_activity_log + performance_scores + activity_logs,
// created_at cast to timestamptz to avoid text-comparison ordering bugs.
router.get('/employee-activity/:user_id', authMiddleware, async (req, res) => {
  try {
    const targetId = req.params.user_id;
    if (!(await canViewUser(req.user, targetId))) {
      return res.status(403).json({ error: 'Not permitted to view this user' });
    }
    const u = (await query('SELECT id, name, email, role FROM users WHERE id=$1', [targetId])).rows[0];
    if (!u) return res.status(404).json({ error: 'user not found' });

    const window = ['today', '7d', '30d', 'all'].includes(req.query.window) ? req.query.window : '7d';
    let cutoff = null;
    // Explicit CDT offset so "today" anchors to the business day, not UTC midnight.
    // NOTE: fixed -05:00 is correct under CDT; DST-fragile — refine to Intl-based
    // America/Chicago offset if this ever needs to survive a DST boundary.
    if (window === 'today') cutoff = businessToday() + ' 00:00:00-05:00';
    else if (window === '7d') cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    else if (window === '30d') cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    // 'all' → cutoff stays null (no lower bound)

    const cond = cutoff ? 'AND created_at::timestamptz >= $2::timestamptz' : '';
    const params = cutoff ? [targetId, cutoff] : [targetId];
    const sql = `
      SELECT * FROM (
        SELECT 'agent' AS type, action_type AS action, output_summary AS summary,
               reasoning AS detail, created_at AS ts
          FROM agent_activity_log
         WHERE user_id=$1 ${cond}
           AND action_type IN ('task_ai_assign','task_manual_assign','task_status_change','task_comment_added','kpi_progress_update')
        UNION ALL
        SELECT 'score' AS type, 'performance_score' AS action,
               ('Score ' || total_score || '/100 · ' || tasks_completed || '/' || tasks_assigned
                || ' tasks · KPI ' || weekly_kpi_pct || '%') AS summary,
               COALESCE(claude_coaching_note, notes) AS detail, created_at AS ts
          FROM performance_scores
         WHERE user_id=$1 ${cond} AND COALESCE(is_weekly_summary,0)=0
        UNION ALL
        SELECT 'metric' AS type, 'activity_logged' AS action,
               (metric || ' = ' || value) AS summary, notes AS detail, created_at AS ts
          FROM activity_logs
         WHERE user_id=$1 ${cond}
      ) ev
      ORDER BY ev.ts::timestamptz DESC
      LIMIT 500`;
    const events = (await query(sql, params)).rows;
    res.json({ user: u, window, count: events.length, events });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/activity/team', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { from, to, user_id } = req.query;
    const dateFrom = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const dateTo = to || new Date().toISOString().slice(0, 10);
    let q = 'SELECT a.*, u.name, u.role, u.email FROM activity_logs a JOIN users u ON u.id=a.user_id WHERE a.log_date BETWEEN $1 AND $2';
    const params = [dateFrom, dateTo];
    if (user_id) { q += ' AND a.user_id=$3'; params.push(user_id); }
    q += ' ORDER BY a.log_date DESC, u.role';
    const result = await query(q, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders', authMiddleware, requireTier('revenue'), async (req, res) => {
  try {
    const { order_date, amount, buyer_type, product_category, notes } = req.body;
    if (!order_date) return res.status(400).json({ error: 'order_date is required (format: YYYY-MM-DD)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(order_date)) return res.status(400).json({ error: 'order_date must be in YYYY-MM-DD format' });
    if (amount === undefined || amount === null) return res.status(400).json({ error: 'amount is required' });
    if (typeof amount !== 'number' || isNaN(amount)) return res.status(400).json({ error: 'amount must be a valid number' });
    if (amount < 0) return res.status(400).json({ error: 'amount cannot be negative' });
    const id = crypto.randomUUID();
    await query('INSERT INTO orders (id,order_date,amount,buyer_type,product_category,notes) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, order_date, amount, buyer_type || null, product_category || null, notes || null]);
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/orders/webhook', async (req, res) => {
  try {
    const secret = process.env.PLAYBOOKOS_WEBHOOK_SECRET;
    const provided = req.headers['x-playbookos-secret'];
    if (!secret) return res.status(503).json({ error: 'PLAYBOOKOS_WEBHOOK_SECRET not configured on server' });
    if (!provided || provided !== secret) return res.status(401).json({ error: 'Invalid or missing X-PlaybookOS-Secret header' });

    const { order_id, amount, buyer_email, buyer_type, product_category, product_name, order_date } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'order_id is required' });
    if (!order_date) return res.status(400).json({ error: 'order_date is required (format: YYYY-MM-DD)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(order_date)) return res.status(400).json({ error: 'order_date must be in YYYY-MM-DD format' });
    const amt = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (amt === undefined || amt === null || typeof amt !== 'number' || isNaN(amt)) return res.status(400).json({ error: 'amount is required and must be a number' });
    if (amt < 0) return res.status(400).json({ error: 'amount cannot be negative' });

    const noteParts = [];
    if (buyer_email) noteParts.push(`buyer: ${buyer_email}`);
    if (product_name) noteParts.push(`product: ${product_name}`);
    noteParts.push('source: abiozen-webhook');
    const notes = noteParts.join(' · ');

    await query(
      `INSERT INTO orders (id, order_date, amount, buyer_type, product_category, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [order_id, order_date, amt, buyer_type || null, product_category || null, notes]
    );

    await query(
      `INSERT INTO email_log (id, to_email, subject, trigger_type, status) VALUES ($1, $2, $3, 'webhook', 'received')`,
      [crypto.randomUUID(), buyer_email || 'webhook', `Order webhook: $${amt} ${product_category || ''} from ${buyer_type || 'unknown'}`.trim()]
    );

    res.json({ received: true, order_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders', authMiddleware, requireTier('revenue'), async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = 'SELECT * FROM orders';
    const params = [];
    if (from && to) { q += ' WHERE order_date BETWEEN $1 AND $2'; params.push(from, to); }
    q += ' ORDER BY order_date DESC LIMIT 200';
    const result = await query(q, params);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/dashboard/summary', authMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const thisMonth = today.slice(0, 7);
    const thisYear = today.slice(0, 4);
    const monthRev = (await query(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text LIKE $1`, [thisMonth + '%'])).rows[0].v;
    const yearRev = (await query(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text LIKE $1`, [thisYear + '%'])).rows[0].v;
    const monthTargetR = await query(`SELECT target_value FROM targets WHERE period_type='monthly' AND period_key=$1 AND metric='revenue'`, [thisMonth]);
    const monthTarget = monthTargetR.rows[0]?.target_value || 0;
    const annualTarget = 10000000;
    const recentOrders = (await query('SELECT * FROM orders ORDER BY order_date DESC LIMIT 5')).rows;
    const teamActivity = (await query(`SELECT u.name, u.role, a.metric, SUM(a.value) as total FROM activity_logs a JOIN users u ON u.id=a.user_id WHERE a.log_date >= (NOW() - INTERVAL '7 days')::date::text GROUP BY u.id, u.name, u.role, a.metric ORDER BY u.role`)).rows;
    const milestones = (await query('SELECT * FROM milestones ORDER BY target_date')).rows;
    const launchDate = new Date('2026-05-01');
    const now = new Date();
    const activeDays = Math.max(1, Math.ceil((now - launchDate) / 86400000));
    const remainingDays = Math.ceil((new Date('2026-12-31') - now) / 86400000);
    const dailyRunRate = parseFloat(yearRev) / activeDays;
    const projectedTotal = parseFloat(yearRev) + (dailyRunRate * remainingDays);
    res.json({ revenue: { month: parseFloat(monthRev), year: parseFloat(yearRev), monthTarget, annualTarget, projectedTotal, dailyRunRate }, recentOrders, teamActivity, milestones, onTrack: projectedTotal >= annualTarget });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/dashboard/export', authMiddleware, requireTier('revenue'), async (req, res) => {
  try {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const orders = (await query(
      `SELECT order_date, amount, buyer_type, product_category FROM orders WHERE order_date::text LIKE $1 ORDER BY order_date`,
      [thisMonth + '%']
    )).rows;

    const total = orders.reduce((s, o) => s + parseFloat(o.amount || 0), 0);
    const count = orders.length;
    const avg = count > 0 ? total / count : 0;

    const escape = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = ['Order Date,Amount,Buyer Type,Product Category'];
    for (const o of orders) {
      const date = typeof o.order_date === 'string' ? o.order_date : new Date(o.order_date).toISOString().slice(0, 10);
      lines.push([escape(date), parseFloat(o.amount).toFixed(2), escape(o.buyer_type), escape(o.product_category)].join(','));
    }
    lines.push('', 'Summary', `Total Revenue,${total.toFixed(2)}`, `Order Count,${count}`, `Average Order Value,${avg.toFixed(2)}`);

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="orders-${thisMonth}.csv"`);
    res.send(lines.join('\n') + '\n');
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/dashboard/my', authMiddleware, async (req, res) => {
  try {
    const activity = (await query(`SELECT metric, SUM(value) as total, MAX(log_date) as last_logged FROM activity_logs WHERE user_id=$1 AND log_date >= (NOW() - INTERVAL '7 days')::date::text GROUP BY metric`, [req.user.id])).rows;
    const userR = await query('SELECT github_username FROM users WHERE id=$1', [req.user.id]);
    const gh = userR.rows[0]?.github_username;
    const github = gh ? (await query(`SELECT * FROM github_stats WHERE github_username=$1 AND stat_date >= (NOW() - INTERVAL '7 days')::date::text ORDER BY stat_date DESC`, [gh])).rows : [];
    const targets = (await query('SELECT * FROM targets WHERE user_id=$1', [req.user.id])).rows;
    res.json({ activity, github, targets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/github/sync', authMiddleware, requireTier('technical'), async (req, res) => {
  try {
    const { date } = req.body;
    const syncDate = date || new Date().toISOString().slice(0, 10);
    let users;
    if (req.user.role === 'admin') {
      users = (await query(`SELECT * FROM users WHERE github_username IS NOT NULL AND is_active=1`)).rows;
    } else {
      users = (await query(`SELECT * FROM users WHERE id=$1 AND github_username IS NOT NULL`, [req.user.id])).rows;
    }
    for (const u of users) { await syncGitHubForUser(u, syncDate); }
    res.json({ success: true, synced: users.length, date: syncDate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/milestones', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT * FROM milestones ORDER BY target_date');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/milestones/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { status, actual_date } = req.body;
    await query('UPDATE milestones SET status=COALESCE($1,status), actual_date=COALESCE($2,actual_date) WHERE id=$3', [status || null, actual_date || null, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/ai/analyze', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const monthRev = parseFloat((await query(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text LIKE $1`, [thisMonth + '%'])).rows[0].v);
    const monthTarget = parseFloat((await query(`SELECT target_value FROM targets WHERE period_type='monthly' AND period_key=$1 AND metric='revenue'`, [thisMonth])).rows[0]?.target_value || 1200000);
    const teamRows = (await query(`SELECT u.name, u.role, a.metric, SUM(a.value) as total FROM activity_logs a JOIN users u ON u.id=a.user_id WHERE a.log_date >= (NOW() - INTERVAL '7 days')::date::text GROUP BY u.id, u.name, u.role, a.metric`)).rows;
    const teamText = teamRows.map(r => `${r.name} (${r.role}): ${r.metric} = ${r.total}`).join('\n') || 'No activity logged this week.';
    const behind = monthRev < monthTarget * 0.8 ? `Revenue ${Math.round((monthRev / monthTarget) * 100)}% of monthly target` : '';
    const analysis = await analyzeTeamProgress({ period: thisMonth, revenue: monthRev, revenueTarget: monthTarget, teamActivity: teamText, behindMetrics: behind });
    await query('INSERT INTO ai_analyses (id,analysis_type,period_key,content) VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), 'weekly_review', thisMonth, analysis]);
    res.json({ analysis, period: thisMonth, revenue: monthRev, target: monthTarget });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/ai/latest', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const result = await query('SELECT * FROM ai_analyses ORDER BY created_at DESC LIMIT 1');
    res.json(result.rows[0] || { content: 'No analysis yet. Click "Run AI Analysis" on the admin dashboard.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/targets', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT * FROM targets ORDER BY period_type, period_key');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/targets', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { period_type, period_key, user_id, team, metric, target_value } = req.body;
    if (!period_type || !period_key || !metric || target_value === undefined) return res.status(400).json({ error: 'Missing fields' });
    const existing = await query(`SELECT id FROM targets WHERE period_type=$1 AND period_key=$2 AND metric=$3 AND user_id IS NOT DISTINCT FROM $4`, [period_type, period_key, metric, user_id || null]);
    if (existing.rows[0]) {
      await query('UPDATE targets SET target_value=$1 WHERE id=$2', [target_value, existing.rows[0].id]);
    } else {
      await query('INSERT INTO targets (id,period_type,period_key,user_id,team,metric,target_value) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [crypto.randomUUID(), period_type, period_key, user_id || null, team || null, metric, target_value]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/triggers/check', async (req, res) => {
  try {
    const secret = process.env.TRIGGERS_SECRET;
    const provided = (req.headers.authorization || '').replace('Bearer ', '');
    if (!secret || provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const result = await checkMilestoneTriggers();
    res.json({ ...result, checked: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

router.get('/decision-rules', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const result = await query('SELECT * FROM decision_rules ORDER BY created_at');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/decision-rules/evaluate', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const crypto = require('crypto');
    const yearRev = parseFloat((await query(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text LIKE '2026%'`)).rows[0].v);
    const thisMonth = new Date().toISOString().slice(0,7);
    const monthRev = parseFloat((await query(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text LIKE $1`, [thisMonth+'%'])).rows[0].v);
    const monthTarget = parseFloat((await query(`SELECT COALESCE(target_value,1200000) as v FROM targets WHERE period_type='monthly' AND period_key=$1 AND metric='revenue'`, [thisMonth])).rows[0]?.v || 1200000);
    const monthPct = monthTarget > 0 ? (monthRev / monthTarget) * 100 : 0;
    const metrics = { monthly_revenue_pct: monthPct, monthly_revenue: monthRev, cumulative_revenue: yearRev, daily_emails_sent: 0, weekly_prs_merged: 0, weekly_skus_priced: 0, invoice_overdue_days: 0, top10_sku_revenue_pct: 0 };
    const rules = (await query('SELECT * FROM decision_rules WHERE is_active=1')).rows;
    const fired = [];
    for (const rule of rules) {
      const val = metrics[rule.condition_metric] || 0;
      let triggered = false;
      if (rule.condition_operator === '<' && val < rule.condition_value) triggered = true;
      if (rule.condition_operator === '>=' && val >= rule.condition_value) triggered = true;
      if (triggered) {
        fired.push({ rule: rule.name, action: rule.action_type, message: rule.action_message });
        await query(`UPDATE decision_rules SET last_fired=$1, fire_count=fire_count+1 WHERE id=$2`, [new Date().toISOString(), rule.id]);
      }
    }
    res.json({ evaluated: rules.length, fired: fired.length, triggers: fired, metrics });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/skus', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    // 'own'-scoped roles (procurement_team) see only SKUs they own.
    const result = req.tierAccess === 'own'
      ? await query('SELECT * FROM skus WHERE is_active=1 AND owner_user_id=$1 ORDER BY revenue_total DESC', [req.user.id])
      : await query('SELECT * FROM skus WHERE is_active=1 ORDER BY revenue_total DESC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/skus', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const { name, category, cost_price, sale_price, units_in_stock, lead_time_days, supplier, is_gmp } = req.body;
    const crypto = require('crypto');
    const margin = sale_price > 0 ? ((sale_price - cost_price) / sale_price) * 100 : 0;
    const id = crypto.randomUUID();
    await query(`INSERT INTO skus (id,name,category,cost_price,sale_price,gross_margin,units_in_stock,lead_time_days,supplier,is_gmp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, name, category||null, cost_price||0, sale_price||0, margin, units_in_stock||0, lead_time_days||14, supplier||null, is_gmp||0]);
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/execution-steps', authMiddleware, requireTier('technical'), async (req, res) => {
  try {
    const result = await query('SELECT * FROM execution_steps ORDER BY step_order');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/execution-steps/:id', authMiddleware, requireTier('technical'), async (req, res) => {
  try {
    const { completion_pct, status } = req.body;
    await query(`UPDATE execution_steps SET completion_pct=COALESCE($1,completion_pct), status=COALESCE($2,status), updated_at=$3 WHERE id=$4`,
      [completion_pct, status||null, new Date().toISOString(), req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/integrations', authMiddleware, requireTier('technical'), async (req, res) => {
  try {
    const result = await query('SELECT * FROM integrations ORDER BY status DESC, name');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function formatScoreRow(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    role: r.role,
    score_date: r.score_date,
    score: r.score_0_to_100,
    metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
    blockers: r.blockers_json ? JSON.parse(r.blockers_json) : null,
    coaching_note: r.claude_coaching_note,
    escalated_to_admin: !!r.escalated_to_admin,
    created_at: r.created_at,
  };
}

router.post('/customers/engagement-event', async (req, res) => {
  try {
    const secret = process.env.ENGAGEMENT_SECRET;
    const provided = req.headers['x-engagement-secret'];
    if (!secret) return res.status(503).json({ error: 'ENGAGEMENT_SECRET not configured on server' });
    if (!provided || provided !== secret) return res.status(401).json({ error: 'Invalid or missing X-Engagement-Secret header' });
    const { contact_email, event_type, molecule_interest, sequence_id, event_at } = req.body || {};
    if (!contact_email) return res.status(400).json({ error: 'contact_email is required' });
    const valid = ['sent', 'opened', 'clicked', 'replied', 'bounced'];
    if (!valid.includes(event_type)) return res.status(400).json({ error: `event_type must be one of ${valid.join(', ')}` });
    await query(
      `INSERT INTO buyer_engagement (id, contact_email, event_type, event_at, sequence_id, molecule_interest)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), contact_email, event_type, event_at || new Date().toISOString(), sequence_id || null, molecule_interest || null]
    );
    res.json({ received: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/linkedin/log', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const { contact_name, contact_title, company, linkedin_url, message_sent, sent_at, connection_accepted, replied, reply_content, buyer_segment, molecule_interest } = req.body || {};
    if (!contact_name) return res.status(400).json({ error: 'contact_name is required' });
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO linkedin_outreach (id, contact_name, contact_title, company, linkedin_url, message_sent, sent_at, connection_accepted, replied, reply_content, buyer_segment, molecule_interest)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, contact_name, contact_title || null, company || null, linkedin_url || null, message_sent || null, sent_at || new Date().toISOString(), connection_accepted ? 1 : 0, replied ? 1 : 0, reply_content || null, buyer_segment || null, molecule_interest || null]
    );
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/linkedin/pipeline', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    // 'own'-scoped roles (sales_team) see only their own outreach rows.
    const ownClause = req.tierAccess === 'own' ? ' AND owner_user_id = $1' : '';
    const params = req.tierAccess === 'own' ? [req.user.id] : [];
    const stats = (await query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE connection_accepted = 1)::int as connected,
        COUNT(*) FILTER (WHERE replied = 1)::int as replied,
        COUNT(*) FILTER (WHERE sent_at >= (NOW() - INTERVAL '7 days')::text)::int as sent_this_week,
        COUNT(*) FILTER (WHERE connection_accepted = 1 AND sent_at >= (NOW() - INTERVAL '7 days')::text)::int as connected_this_week,
        COUNT(*) FILTER (WHERE replied = 1 AND sent_at >= (NOW() - INTERVAL '7 days')::text)::int as replied_this_week
      FROM linkedin_outreach WHERE 1=1${ownClause}
    `, params)).rows[0];
    const bySegment = (await query(`
      SELECT buyer_segment,
             COUNT(*)::int as total,
             COUNT(*) FILTER (WHERE connection_accepted = 1)::int as connected,
             COUNT(*) FILTER (WHERE replied = 1)::int as replied
      FROM linkedin_outreach WHERE 1=1${ownClause} GROUP BY buyer_segment ORDER BY total DESC
    `, params)).rows;
    const recent = (await query(`
      SELECT id, contact_name, contact_title, company, linkedin_url, sent_at, connection_accepted, replied, buyer_segment, molecule_interest
      FROM linkedin_outreach WHERE 1=1${ownClause} ORDER BY sent_at DESC NULLS LAST LIMIT 20
    `, params)).rows;
    res.json({ stats, by_segment: bySegment, recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/metrics/today', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const row = (await query(
      `SELECT * FROM metrics_snapshots ORDER BY snapshot_date DESC LIMIT 1`
    )).rows[0];
    if (!row) return res.json({ available: false, note: 'no snapshots yet — the midnight cron writes the first row' });
    res.json({ available: true, snapshot: row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/metrics/history', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const rows = (await query(
      `SELECT * FROM metrics_snapshots WHERE snapshot_date >= (NOW() - INTERVAL '${days} days')::date::text ORDER BY snapshot_date ASC`
    )).rows;
    res.json({ days, count: rows.length, snapshots: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/customers/warm-leads', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const leads = await getWarmLeads({
      limit: parseInt(req.query.limit) || 10,
      ownerUserId: req.tierAccess === 'own' ? req.user.id : null,
    });
    res.json({ count: leads.length, leads });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/customers/outreach-today', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const row = (await query(
      `SELECT id, period_key, content, created_at FROM ai_analyses
       WHERE analysis_type='outreach_recommendations' AND period_key=$1
       ORDER BY created_at DESC LIMIT 1`,
      [today]
    )).rows[0];
    if (row) {
      let content;
      try { content = JSON.parse(row.content); }
      catch { content = { raw_response: row.content, _parse_warning: 'content was not valid JSON' }; }
      return res.json({ available: true, fresh: false, id: row.id, generated_at: row.created_at, ...content });
    }
    // No today recommendations yet — generate fresh on demand
    const result = await generateOutreachRecommendations();
    res.json({ available: !result.skipped, fresh: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/goals/cascade', authMiddleware, requireTier('goals'), async (req, res) => {
  try {
    const cascade = await cascadeGoals();
    // A cascade that skipped (e.g. no annual targets) has nothing to assign from.
    if (cascade.skipped) {
      return res.json({ ...cascade, kpi_assignment: { skipped: true, reason: 'cascade was skipped — no KPIs assigned' } });
    }
    // Chain weekly KPI assignment so a manual cascade leaves users with KPIs,
    // matching what the Monday 8am cron already does.
    const kpi_assignment = await assignWeeklyKPIsForAll();
    res.json({ ...cascade, kpi_assignment });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/goals/assign-kpis', authMiddleware, requireTier('goals'), async (req, res) => {
  try {
    const result = await assignWeeklyKPIsForAll();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/goals/my-week', authMiddleware, async (req, res) => {
  try {
    const weekStart = mondayOf(new Date()).toISOString().slice(0, 10);
    let kpis = (await query(
      `SELECT k.*, u.name AS last_updated_by_name
       FROM weekly_kpis k
       LEFT JOIN users u ON u.id = k.last_updated_by
       WHERE k.user_id=$1 AND k.week_start=$2
       ORDER BY k.kpi_name`,
      [req.user.id, weekStart]
    )).rows;
    // If no KPIs exist yet for this week, assign them on demand from the cascade
    if (kpis.length === 0) {
      const assigned = await assignWeeklyKPIs(req.user.id, weekStart);
      if (!assigned.skipped) {
        kpis = (await query(
          `SELECT k.*, u.name AS last_updated_by_name
           FROM weekly_kpis k
           LEFT JOIN users u ON u.id = k.last_updated_by
           WHERE k.user_id=$1 AND k.week_start=$2
           ORDER BY k.kpi_name`,
          [req.user.id, weekStart]
        )).rows;
      }
    }
    res.json({ week_start: weekStart, kpis });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/goals/team-week', authMiddleware, requireTier('goals'), async (req, res) => {
  try {
    const weekStart = mondayOf(new Date()).toISOString().slice(0, 10);
    const rows = (await query(
      `SELECT k.*, u.name, u.role, lub.name AS last_updated_by_name
       FROM weekly_kpis k
       JOIN users u ON u.id = k.user_id
       LEFT JOIN users lub ON lub.id = k.last_updated_by
       WHERE k.week_start=$1
       ORDER BY u.role, u.name, k.kpi_name`,
      [weekStart]
    )).rows;
    res.json({ week_start: weekStart, kpis: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update KPI progress (actual_value + optional comment). The assignee may update
// their own KPI; admins may update anyone's. Permission enforced inside the
// handler (not via adminOnly middleware). Audit log uses agent_name='self' for
// owner self-updates and 'admin' for admin overrides.
router.put('/kpis/:id/progress', authMiddleware, async (req, res) => {
  try {
    const kpi = (await query(`SELECT * FROM weekly_kpis WHERE id=$1`, [req.params.id])).rows[0];
    if (!kpi) return res.status(404).json({ error: 'KPI not found' });
    const isAdmin = ['admin','super_admin'].includes(req.user.role);
    const isOwner = kpi.user_id === req.user.id;
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Not authorized to update this KPI' });
    const { actual_value, comment } = req.body || {};
    const n = Number(actual_value);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: 'actual_value must be a finite number >= 0' });
    }
    const c = (comment == null) ? null : String(comment).trim();
    if (c !== null && c.length > 500) {
      return res.status(400).json({ error: 'comment must be 500 chars or fewer' });
    }
    await query(
      `UPDATE weekly_kpis
       SET kpi_actual = $1, last_comment = $2, last_updated_at = NOW(), last_updated_by = $3
       WHERE id = $4`,
      [n, c, req.user.id, kpi.id]
    );
    await logAgentActivity({
      agent_name: isOwner ? 'self' : 'admin',
      action_type: 'kpi_progress_update',
      user_id: kpi.user_id,
      reasoning: `${req.user.email} updated ${kpi.kpi_name} (${kpi.week_start}) from ${kpi.kpi_actual} to ${n}${c ? ': ' + c.slice(0, 200) : ''}`,
      source_kpi: kpi.kpi_name,
      confidence_score: 100,
      output_summary: `kpi_id=${kpi.id} actual=${n} comment_len=${c ? c.length : 0}`,
    });
    res.json({ success: true, kpi_id: kpi.id, kpi_actual: n, last_comment: c });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/seo/rankings', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    // Aggregate per query: most-recent vs oldest position in the trailing 30 days
    const rows = (await query(`
      SELECT query,
             (array_agg(position ORDER BY recorded_date DESC))[1] as current_position,
             (array_agg(position ORDER BY recorded_date ASC))[1]  as oldest_position,
             (array_agg(impressions ORDER BY recorded_date DESC))[1] as current_impressions,
             (array_agg(clicks ORDER BY recorded_date DESC))[1] as current_clicks,
             (array_agg(ctr ORDER BY recorded_date DESC))[1] as current_ctr,
             (array_agg(recorded_date ORDER BY recorded_date DESC))[1] as latest_date,
             COUNT(*)::int as snapshots,
             MAX(impressions)::int as peak_impressions
      FROM seo_rankings
      WHERE recorded_date >= (NOW() - INTERVAL '30 days')::date::text
      GROUP BY query
      ORDER BY peak_impressions DESC
      LIMIT 50
    `)).rows;

    const formatted = rows.map(r => {
      const current = parseFloat(r.current_position);
      const oldest = parseFloat(r.oldest_position);
      const delta = current - oldest;
      let trend = 'flat';
      if (r.snapshots < 2) trend = 'new';
      else if (delta <= -2) trend = 'improving';
      else if (delta >= 2) trend = 'declining';
      return {
        query: r.query,
        current_position: parseFloat(current.toFixed(1)),
        position_30d_ago: parseFloat(oldest.toFixed(1)),
        delta: parseFloat(delta.toFixed(1)),
        trend,
        current_impressions: parseInt(r.current_impressions),
        current_clicks: parseInt(r.current_clicks),
        current_ctr_pct: parseFloat((parseFloat(r.current_ctr) * 100).toFixed(2)),
        latest_date: r.latest_date,
        snapshots: r.snapshots,
      };
    });
    res.json({ count: formatted.length, rankings: formatted });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual trigger — pulls GSC keyword data, persists it into seo_rankings
// (trackKeywordRankings stores non-dry runs itself), and returns the result.
router.post('/seo/rankings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await trackKeywordRankings();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/seo/gaps', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const result = await identifyContentGaps();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual trigger — runs the content-gap analysis on demand and returns it.
router.post('/seo/gaps', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await identifyContentGaps();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/seo/no-results', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const result = await trackAlgoliaNoResults();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual trigger — runs the Algolia no-result-search analysis on demand.
router.post('/seo/no-results', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await trackAlgoliaNoResults();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// AI SEO content generator — produces a full publish-ready product page for a
// molecule via Claude, stored in seo_content. Admin-only per spec.
router.post('/seo/generate-content', authMiddleware, adminOnly, async (req, res) => {
  try {
    const molecule_name = (req.body?.molecule_name || '').trim();
    const cas_number = (req.body?.cas_number || '').trim();
    const purity = (req.body?.purity || '99').toString().trim();
    if (!molecule_name) return res.status(400).json({ error: 'molecule_name is required' });
    if (!cas_number) return res.status(400).json({ error: 'cas_number is required' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured' });

    const prompt = `You are an SEO content writer for Abiozen LLC, a US-based pharmaceutical API distribution company. Generate a complete, SEO-optimized product page for the molecule below.

Molecule: ${molecule_name}
CAS number: ${cas_number}
Purity grade: ${purity}%

Return EXACTLY one JSON object and nothing else (no markdown fences, no commentary):
{
  "title": "Buy ${molecule_name} API | ${purity}% Pure | US Stock | Abiozen",
  "meta_desc": "compelling meta description, 160 characters MAXIMUM, includes the molecule name and a buyer hook",
  "content_html": "valid HTML string for the page body",
  "schema_json": { schema.org Product JSON-LD object }
}

Requirements:
- "title": use exactly the format shown above (Buy ... API | ...% Pure | US Stock | Abiozen).
- "meta_desc": 160 characters maximum — count carefully.
- "content_html": one <h1> with the molecule name, then a logical <h2>/<h3> heading structure, a product description of roughly 500 words targeting buyer-intent keywords (buy, supplier, bulk, US stock, COA, SDS, GMP, research grade, lead time). End with an FAQ section: an <h2>Frequently Asked Questions</h2> followed by EXACTLY 5 <h3> questions buyers actually ask (pricing, minimum order quantity, shipping/lead time, documentation/COA/SDS, purity/grade), each followed by a <p> answer. Return the whole thing as a single HTML string.
- "schema_json": a valid schema.org "Product" JSON-LD object — "@context", "@type":"Product", name, description, an identifier using the CAS number, brand "Abiozen LLC", and an "offers" object.
- Do NOT invent specific prices, lot numbers, or regulatory/medical claims. Keep language factual and conservative.
- Return ONLY the JSON object.`;

    const ares = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!ares.ok) {
      const body = await ares.text().catch(() => '');
      return res.status(502).json({ error: `Claude API ${ares.status}: ${body.slice(0, 200)}` });
    }
    const adata = await ares.json();
    const raw = (adata.content?.[0]?.text || '').trim();
    let content;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      content = JSON.parse(match ? match[0] : raw);
    } catch (e) {
      return res.status(502).json({ error: 'Claude returned unparseable content', raw: raw.slice(0, 500) });
    }
    if (!content.title || !content.content_html) {
      return res.status(502).json({ error: 'Claude response missing required fields (title / content_html)', raw: raw.slice(0, 500) });
    }

    const schemaStr = content.schema_json != null
      ? (typeof content.schema_json === 'string' ? content.schema_json : JSON.stringify(content.schema_json))
      : null;

    await query(
      `INSERT INTO seo_content (id, molecule_name, cas_number, title, meta_desc, content_html, schema_json, generated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (molecule_name, cas_number) DO UPDATE
         SET title=EXCLUDED.title, meta_desc=EXCLUDED.meta_desc,
             content_html=EXCLUDED.content_html, schema_json=EXCLUDED.schema_json,
             generated_at=NOW()`,
      [crypto.randomUUID(), molecule_name, cas_number, content.title || null,
       content.meta_desc || null, content.content_html || null, schemaStr]
    );

    res.json({
      success: true,
      molecule_name, cas_number, purity,
      title: content.title,
      meta_desc: content.meta_desc,
      content_html: content.content_html,
      schema_json: content.schema_json ?? null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk-generate SEO landing pages for every molecule in the Algolia catalog
// (~114). Runs async (each page is a Claude call; the full run takes minutes) and
// returns 202 immediately. ?force=1 regenerates pages that already exist.
router.post('/seo/generate-catalog', authMiddleware, adminOnly, async (req, res) => {
  const force = req.body?.force === true || req.query?.force === '1';
  const limit = parseInt(req.body?.limit || req.query?.limit || '0', 10) || 0;
  generateCatalogSeoPages({ force, limit })
    .then(r => console.log(`[seo] catalog generation done — generated ${r.generated}, skipped ${r.skipped}, failed ${r.failed} of ${r.total}`))
    .catch(e => console.error('[seo] catalog generation failed:', e.message));
  res.status(202).json({ started: true, message: 'Catalog SEO generation started (~few minutes). Check /seo/catalog-status.' });
});

// Progress / status of catalog SEO generation.
router.get('/seo/catalog-status', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const r = (await query(`SELECT COUNT(*)::int total, COUNT(url)::int with_url, MAX(generated_at) AS last FROM seo_content`)).rows[0];
    res.json({ pages: r.total, with_landing_url: r.with_url, last_generated: r.last });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generated SEO content, prioritized by Algolia search volume (highest buyer
// demand first). Falls back to recency ordering when Algolia is unconfigured.
router.get('/seo/content-queue', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const rows = (await query(
      `SELECT id, molecule_name, cas_number, title, meta_desc, content_html, schema_json, generated_at
       FROM seo_content`
    )).rows;

    const volumes = {};
    try {
      const algolia = await syncAlgoliaSearchData();
      if (!algolia.skipped) {
        for (const q of [...(algolia.top_queries || []), ...(algolia.no_result || [])]) {
          const k = (q.query || '').toLowerCase().trim();
          if (k) volumes[k] = Math.max(volumes[k] || 0, q.count || 0);
        }
      }
    } catch (e) { /* leave volumes empty — queue still returns, ordered by recency */ }

    const volumeFor = name => {
      const n = (name || '').toLowerCase().trim();
      if (volumes[n] != null) return volumes[n];
      let best = 0;
      for (const [q, c] of Object.entries(volumes)) {
        if (q && (q.includes(n) || n.includes(q))) best = Math.max(best, c);
      }
      return best;
    };

    const queue = rows
      .map(r => ({ ...r, search_volume: volumeFor(r.molecule_name) }))
      .sort((a, b) => b.search_volume - a.search_volume ||
        String(b.generated_at).localeCompare(String(a.generated_at)));

    res.json({ count: queue.length, algolia_priority: Object.keys(volumes).length > 0, queue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual trigger — runs the full growth-agent analysis (Algolia search data +
// GSC + Claude recommendations), stores it, and returns the result. May take
// 10-30s because of the Claude call.
router.post('/growth/analyze', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await generateSEORecommendations();
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/growth/intelligence', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const row = (await query(
      `SELECT id, period_key, content, created_at FROM ai_analyses WHERE analysis_type='growth_intelligence' ORDER BY created_at DESC LIMIT 1`
    )).rows[0];
    if (!row) return res.json({ available: false });
    let content;
    try { content = JSON.parse(row.content); }
    catch { content = { raw_recommendations: row.content, _parse_warning: 'content was not valid JSON' }; }
    res.json({ available: true, id: row.id, period_key: row.period_key, generated_at: row.created_at, ...content });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/briefing/latest', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const row = (await query(
      `SELECT id, period_key, content, created_at FROM ai_analyses WHERE analysis_type='daily_briefing' ORDER BY created_at DESC LIMIT 1`
    )).rows[0];
    if (!row) return res.json({ available: false });
    let content;
    try { content = JSON.parse(row.content); }
    catch { content = { briefing_text: row.content, _parse_warning: 'content was not valid JSON' }; }
    res.json({ available: true, id: row.id, period_key: row.period_key, generated_at: row.created_at, ...content });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/revenue/intelligence', authMiddleware, requireTier('revenue'), async (req, res) => {
  try {
    const row = (await query(
      `SELECT id, period_key, content, created_at FROM ai_analyses WHERE analysis_type='revenue_intelligence' ORDER BY created_at DESC LIMIT 1`
    )).rows[0];
    if (!row) return res.json({ available: false });
    let content;
    try { content = JSON.parse(row.content); }
    catch { content = { recommendations: row.content, _parse_warning: 'content was not valid JSON' }; }
    res.json({ available: true, id: row.id, period_key: row.period_key, generated_at: row.created_at, ...content });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/performance/scores', authMiddleware, adminOnly, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = (await query(
      `SELECT p.*, u.name, u.role
       FROM performance_scores p
       JOIN users u ON u.id = p.user_id
       WHERE p.score_date >= $1
       ORDER BY u.role, u.name, p.score_date DESC`,
      [thirtyDaysAgo]
    )).rows;
    res.json(rows.map(formatScoreRow));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Performance Accountability System ────────────────────────────────────────

// Team leaderboard — latest daily score per active user with 7d trend.
// Admin + directors only (directors see their team plus self).
router.get('/performance/team', authMiddleware, async (req, res) => {
  try {
    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    const isDirector = ['sales_director', 'procurement_director', 'recruitment_director'].includes(req.user.role);
    if (!isAdmin && !isDirector) return res.status(403).json({ error: 'admin or director only' });

    const today = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const rows = (await query(`
      SELECT u.id user_id, u.name, u.role, u.email,
             latest.total_score, latest.score_date,
             latest.consecutive_days_below_60, latest.consecutive_days_above_80,
             latest.tasks_assigned, latest.tasks_completed, latest.weekly_kpi_pct,
             prior.total_score AS prior_score
      FROM users u
      LEFT JOIN LATERAL (
        SELECT * FROM performance_scores
        WHERE user_id=u.id AND COALESCE(is_weekly_summary,0)=0
        ORDER BY score_date DESC LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT total_score FROM performance_scores
        WHERE user_id=u.id AND COALESCE(is_weekly_summary,0)=0 AND score_date < latest.score_date
        ORDER BY score_date DESC LIMIT 1
      ) prior ON true
      WHERE u.is_active=1
      ORDER BY COALESCE(latest.total_score, -1) DESC
    `)).rows.map(r => {
      const score = r.total_score == null ? null : Number(r.total_score);
      const ps = r.prior_score == null ? null : Number(r.prior_score);
      let trend = 'flat';
      if (score == null) trend = 'new';
      else if (ps != null && score > ps + 5) trend = 'up';
      else if (ps != null && score < ps - 5) trend = 'down';
      const bucket = score == null ? 'gray' : score > 80 ? 'green' : score >= 60 ? 'amber' : 'red';
      return {
        user_id: r.user_id, name: r.name, role: r.role,
        score, trend, bucket,
        score_date: r.score_date,
        streak_below_60: Number(r.consecutive_days_below_60) || 0,
        streak_above_80: Number(r.consecutive_days_above_80) || 0,
        tasks_assigned: Number(r.tasks_assigned) || 0,
        tasks_completed: Number(r.tasks_completed) || 0,
        weekly_kpi_pct: Number(r.weekly_kpi_pct) || 0,
      };
    });
    res.json({ as_of: today, count: rows.length, leaderboard: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// My performance — overrides the older /performance/my with the richer
// 4-component breakdown + rank + 7-day trend + motivational note.
router.get('/performance/my', authMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const todayRow = (await query(
      `SELECT * FROM performance_scores WHERE user_id=$1 AND score_date=$2 AND COALESCE(is_weekly_summary,0)=0`,
      [req.user.id, today]
    )).rows[0];
    const trend = (await query(
      `SELECT score_date, total_score FROM performance_scores
       WHERE user_id=$1 AND score_date >= $2 AND COALESCE(is_weekly_summary,0)=0
       ORDER BY score_date`,
      [req.user.id, sevenDaysAgo]
    )).rows.map(r => ({ date: r.score_date, score: Number(r.total_score) || 0 }));

    // Rank — count active users with a higher total_score today
    let rank = null, team_size = 0;
    if (todayRow) {
      const allToday = (await query(`
        SELECT u.id, p.total_score FROM users u
        LEFT JOIN performance_scores p ON p.user_id=u.id AND p.score_date=$1 AND COALESCE(p.is_weekly_summary,0)=0
        WHERE u.is_active=1
      `, [today])).rows;
      team_size = allToday.length;
      const myScore = Number(todayRow.total_score);
      rank = 1 + allToday.filter(r => r.id !== req.user.id && Number(r.total_score || -1) > myScore).length;
    }

    const score = todayRow ? Number(todayRow.total_score) : null;
    let note = '';
    if (score == null) note = 'No score yet today — finish tasks and log activity to get scored at 6pm.';
    else if (score >= 90) note = 'Outstanding day. Keep this rhythm and the team follows your lead.';
    else if (score >= 75) note = 'Strong day. Push one more task before EOD to crack 90.';
    else if (score >= 60) note = 'Solid effort. Focus on the KPI gap to lift the score tomorrow.';
    else note = 'Tough day. Pick the single highest-leverage task and finish it before EOD.';

    res.json({
      as_of: today, score,
      breakdown: todayRow ? {
        task_completion: Number(todayRow.task_completion_score) || 0,
        kpi_progress: Number(todayRow.kpi_progress_score) || 0,
        activity: Number(todayRow.activity_score) || 0,
        response: Number(todayRow.response_score) || 0,
      } : null,
      tasks_assigned: todayRow ? Number(todayRow.tasks_assigned) : 0,
      tasks_completed: todayRow ? Number(todayRow.tasks_completed) : 0,
      weekly_kpi_pct: todayRow ? Number(todayRow.weekly_kpi_pct) : 0,
      streak_below_60: todayRow ? Number(todayRow.consecutive_days_below_60) : 0,
      streak_above_80: todayRow ? Number(todayRow.consecutive_days_above_80) : 0,
      rank, team_size, trend, note,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Current escalations / alerts — anyone below 60 for 2+ days or above 90 consistently.
router.get('/performance/alerts', authMiddleware, adminOnly, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = (await query(`
      SELECT p.user_id, u.name, u.role, p.total_score, p.consecutive_days_below_60, p.consecutive_days_above_80
      FROM performance_scores p JOIN users u ON u.id=p.user_id
      WHERE p.score_date=$1 AND COALESCE(p.is_weekly_summary,0)=0 AND u.is_active=1
    `, [today])).rows;
    const red = [], amber = [], green = [];
    for (const r of rows) {
      const score = Number(r.total_score) || 0;
      const below = Number(r.consecutive_days_below_60) || 0;
      const above = Number(r.consecutive_days_above_80) || 0;
      if (score < 60 && below >= 3) red.push({ ...r, score, days: below, severity: 'red' });
      else if (score < 60 && below >= 2) amber.push({ ...r, score, days: below, severity: 'amber' });
      if (above >= 5 && score >= 90) green.push({ ...r, score, days: above, severity: 'green' });
    }
    res.json({ as_of: today, red, amber, green });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 30-day score history for a specific user (admin).
router.get('/performance/history/:userId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const u = (await query(`SELECT id, name, role FROM users WHERE id=$1`, [req.params.userId])).rows[0];
    if (!u) return res.status(404).json({ error: 'user not found' });
    const rows = (await query(
      `SELECT score_date, total_score, task_completion_score, kpi_progress_score, activity_score, response_score,
              tasks_assigned, tasks_completed, weekly_kpi_pct,
              consecutive_days_below_60, consecutive_days_above_80, is_weekly_summary
       FROM performance_scores WHERE user_id=$1 AND score_date >= $2 ORDER BY score_date`,
      [req.params.userId, thirtyDaysAgo]
    )).rows;
    res.json({ user: u, count: rows.length, history: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manually trigger scoring + escalation now (admin) — useful for demos.
router.post('/performance/calculate', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Optional ad-hoc backfill: score a specific past day. Accept only YYYY-MM-DD;
    // anything else falls through to the default (businessToday()).
    const raw = req.body?.date || req.query?.date;
    const date = (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) ? raw : undefined;
    const score = await runPerformanceCheck({ date });
    const esc = await runEscalationCheck();
    res.json({ scored: score.count, escalations: esc.count, date: score.date, score, esc });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/milestones/duplicates', authMiddleware, adminOnly, async (req, res) => {
  try {
    await query(`DELETE FROM milestones WHERE id NOT IN (SELECT MIN(id) FROM milestones GROUP BY name)`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// MARKET INTELLIGENCE ENGINE
// ============================================================
// ── Market Intelligence (150-molecule weekly engine) ─────────────────────────
// Shared helpers for the molecule_history endpoints below.
function mhRow(r) {
  let details = {};
  try { details = r.details_json ? JSON.parse(r.details_json) : {}; } catch (e) { /* keep {} */ }
  return {
    id: r.id, molecule_name: r.molecule_name, cas_number: r.cas_number,
    category: r.category, gmp_status: r.gmp_status, therapeutic_area: r.therapeutic_area,
    week_start: r.week_start, sourcing_status: r.sourcing_status,
    supplier_found: !!r.supplier_found, supplier_name: r.supplier_name,
    estimated_value: r.estimated_value, in_catalog: !!r.in_catalog, rank: r.rank,
    details,
  };
}
async function mhLatestWeek(reqWeek) {
  if (typeof reqWeek === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reqWeek)) return reqWeek;
  const r = (await query(`SELECT MAX(week_start) AS w FROM molecule_history`)).rows[0];
  return r && r.w ? r.w : null;
}
function toCsv(columns, rows) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [columns.map(c => esc(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map(c => esc(c.get(row))).join(','));
  return lines.join('\n');
}

// Manually trigger the full 150-molecule analysis. Runs async (≈2-5 min, 7 Claude
// calls) so the request returns immediately rather than holding the connection.
router.post('/market/analyze', authMiddleware, requireTier('procurement'), async (req, res) => {
  const weekStart = (typeof req.body?.week_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.week_start))
    ? req.body.week_start : undefined;
  runMarketIntelligence({ weekStart })
    .then(s => console.log(`[market] analysis done — ${s.total} molecules for ${s.week_start}`))
    .catch(e => console.error('[market] analysis failed:', e.message));
  res.status(202).json({ started: true, message: 'Market intelligence analysis started (~2-5 min). Refresh shortly.' });
});

// ── AI Email Engine ───────────────────────────────────────────────────────────
// Generation is 20 Claude calls (~3-6 min), so the trigger is fire-and-forget
// like /market/analyze. ?dryRun=1 resolves the molecule list without calling
// Claude and returns synchronously — use it to sanity-check demand signals.
router.post('/email-engine/run', authMiddleware, adminOnly, async (req, res) => {
  const weekStart = (typeof req.body?.week_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.week_start))
    ? req.body.week_start : undefined;
  const topMolecules = Math.min(20, Math.max(1, parseInt(req.body?.top_molecules, 10) || 10));
  if (req.query?.dryRun === '1' || req.body?.dryRun === true) {
    try { return res.json(await runEmailEngine({ weekStart, topMolecules, dryRun: true })); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  runEmailEngine({ weekStart, topMolecules })
    .then(s => console.log(`[email-engine] done — ${s.generated} campaigns for ${s.week_start}, ${s.errors.length} errors`))
    .catch(e => console.error('[email-engine] failed:', e.message));
  res.status(202).json({ started: true, message: `Email engine started — ${topMolecules} molecules x 4 segments (~3-6 min). Refresh shortly.` });
});

// Campaign list. HTML bodies are excluded here — 40 HTML documents would make
// this response multi-megabyte; the preview endpoint serves one at a time.
router.get('/email-engine/campaigns', authMiddleware, requireAnyTier('sales', 'intelligence'), async (req, res) => {
  try {
    const where = [], params = [];
    if (typeof req.query.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week)) {
      params.push(req.query.week); where.push(`week_start = $${params.length}`);
    }
    if (typeof req.query.segment === 'string' && req.query.segment !== 'all') {
      params.push(req.query.segment); where.push(`segment = $${params.length}`);
    }
    if (typeof req.query.status === 'string' && req.query.status !== 'all') {
      params.push(req.query.status); where.push(`status = $${params.length}`);
    }
    const rows = (await query(
      `SELECT id, week_start, segment, molecule_name, cas_number,
              variant_a_subject, variant_b_subject, status, apollo_sequence_id,
              sources, created_at, approved_at, approved_by
       FROM email_campaigns
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY week_start DESC, molecule_name, segment`, params
    )).rows;
    const totals = (await query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status='draft')::int pending,
              COUNT(*) FILTER (WHERE status='approved')::int approved,
              COUNT(*) FILTER (WHERE status='sent')::int sent
       FROM email_campaigns WHERE week_start = $1`,
      [req.query.week || mondayOf(new Date()).toISOString().slice(0, 10)]
    )).rows[0];
    res.json({ campaigns: rows, summary: totals, segments: SEGMENTS.map(s => ({ key: s.key, label: s.label })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Approve / reject. Only a draft can transition — an already-sent campaign must
// not be silently re-approved, and rejecting a sent campaign is meaningless.
router.put('/email-engine/campaigns/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }
    const c = (await query('SELECT id, status FROM email_campaigns WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (c.status !== 'draft') {
      return res.status(409).json({ error: `Campaign is already '${c.status}' — only draft campaigns can be approved or rejected` });
    }
    await query(
      `UPDATE email_campaigns SET status=$1, approved_at=NOW(), approved_by=$2 WHERE id=$3`,
      [status, req.user.email, req.params.id]
    );
    logAgentActivity({
      agent_name: 'email-engine', action_type: 'email_campaign_review',
      reasoning: `${req.user.email} ${status} campaign ${req.params.id}`,
      output_summary: `campaign_id=${req.params.id} -> ${status}`,
    }).catch(e => console.error('[email-engine] review audit failed:', e.message));
    res.json({ success: true, id: req.params.id, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Push an approved campaign to Apollo as a sequence.
//
// NOTE: Apollo's sequence-creation endpoint requires a MASTER API key (the
// read-only key used elsewhere in this file will 403), and its availability on
// a given plan is not guaranteed. Rather than pretend the call succeeded, a
// non-2xx from Apollo is surfaced verbatim with the stored payload attached so
// the sequence can be created by hand from the same content.
router.post('/email-engine/campaigns/:id/publish', authMiddleware, adminOnly, async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(400).json({ error: 'APOLLO_API_KEY not configured' });
    const c = (await query('SELECT * FROM email_campaigns WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (c.status !== 'approved') {
      return res.status(409).json({ error: `Campaign is '${c.status}' — approve it before publishing to Apollo` });
    }
    if (c.apollo_sequence_id) {
      return res.status(409).json({ error: `Already published as Apollo sequence ${c.apollo_sequence_id}` });
    }
    let payload;
    try { payload = JSON.parse(c.apollo_payload || 'null'); }
    catch { payload = null; }
    if (!payload) return res.status(500).json({ error: 'Stored Apollo payload is missing or unparseable — re-run the engine for this week' });

    const result = await publishSequenceToApollo(payload, apolloKey);

    if (!result.ok) {
      // If the sequence was created before the failure it exists in Apollo as a
      // partial. Record the id anyway (status stays 'approved' so it is NOT
      // counted as sent) — otherwise it becomes an orphan nobody can find, and a
      // retry would create a second copy.
      if (result.sequenceId) {
        await query(`UPDATE email_campaigns SET apollo_sequence_id=$1 WHERE id=$2`,
          [result.sequenceId, req.params.id]);
      }
      return res.status(502).json({
        error: `Apollo publish failed at ${result.stage} (HTTP ${result.status})`,
        apollo_response: result.detail,
        apollo_sequence_id: result.sequenceId || null,
        steps_created: result.stepsDone || [],
        hint: result.sequenceId
          ? `A partial sequence was created in Apollo (${result.sequenceId}) with steps ${JSON.stringify(result.stepsDone || [])}. Finish or delete it in Apollo before retrying — retrying here would create a duplicate.`
          : 'Sequence creation needs an Apollo master API key and a plan that exposes the endpoint. The payload below can be recreated manually.',
        payload,
      });
    }

    await query(
      `UPDATE email_campaigns SET status='sent', apollo_sequence_id=$1 WHERE id=$2`,
      [result.sequenceId, req.params.id]
    );
    logAgentActivity({
      agent_name: 'email-engine', action_type: 'email_campaign_published',
      reasoning: `${req.user.email} published "${c.molecule_name} / ${c.segment}" to Apollo as sequence ${result.sequenceId} with ${result.stepsDone.length} steps`,
      output_summary: `campaign_id=${req.params.id} apollo_sequence_id=${result.sequenceId} steps=${result.stepsDone.length}`,
    }).catch(e => console.error('[email-engine] publish audit failed:', e.message));
    res.json({ success: true, id: req.params.id, apollo_sequence_id: result.sequenceId,
               steps_created: result.stepsDone.length, status: 'sent' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Preview one variant's HTML. Returns JSON (not text/html) so the caller renders
// it inside a sandboxed iframe rather than the app's own document — this HTML is
// model-generated and must never execute in the dashboard's origin.
router.get('/email-engine/campaigns/:id/preview', authMiddleware, requireAnyTier('sales', 'intelligence'), async (req, res) => {
  try {
    const c = (await query(
      `SELECT id, molecule_name, cas_number, segment, status,
              variant_a_subject, variant_a_html, variant_b_subject, variant_b_html
       FROM email_campaigns WHERE id=$1`, [req.params.id]
    )).rows[0];
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    const variant = req.query.variant === 'b' ? 'b' : 'a';
    res.json({
      id: c.id, molecule_name: c.molecule_name, cas_number: c.cas_number,
      segment: c.segment, status: c.status, variant,
      subject: variant === 'b' ? c.variant_b_subject : c.variant_a_subject,
      html: sanitizeHtml(variant === 'b' ? c.variant_b_html : c.variant_a_html),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GMP Inquiry Agent ─────────────────────────────────────────────────────────
// Webhook from abiozen.com — secret-header auth (no JWT), like /orders/webhook.
router.post('/inquiry/receive', async (req, res) => {
  try {
    const secret = process.env.PLAYBOOKOS_WEBHOOK_SECRET;
    const provided = req.headers['x-playbookos-secret'];
    if (!secret) return res.status(503).json({ error: 'PLAYBOOKOS_WEBHOOK_SECRET not configured' });
    if (!provided || provided !== secret) return res.status(401).json({ error: 'Invalid or missing X-PlaybookOS-Secret header' });
    const b = req.body || {};
    if (!b.buyer_email || !b.molecule_name) return res.status(400).json({ error: 'buyer_email and molecule_name required' });
    const id = await receiveInquiry({
      molecule_name: b.molecule_name, cas_number: b.cas_number, buyer_name: b.buyer_name,
      buyer_email: b.buyer_email, buyer_company: b.buyer_company, country: b.country,
      quantity: b.quantity, quantity_unit: b.quantity_unit, intended_use: b.intended_use,
      message: b.message, source: b.source || 'abiozen_form',
    });
    res.json({ inquiry_id: id, status: 'received' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/inquiry/run', authMiddleware, adminOnly, async (req, res) => {
  const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
  if (dryRun) {
    try {
      const poll = await pollSalesEmailbox({ dryRun: true });
      const agent = await runInquiryAgent({ dryRun: true });
      return res.json({ dryRun: true, poll, agent });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  // Poll the sales mailbox for new inquiries first, then run follow-ups + summary.
  (async () => {
    const poll = await pollSalesEmailbox();
    console.log(`[inquiry] mailbox poll — ${poll.new_inquiries} new, ${poll.replies_routed} replies, ${poll.skipped} skipped${poll.warning ? ' · ' + poll.warning : ''}`);
    const r = await runInquiryAgent();
    console.log(`[inquiry] run — ${r.active_inquiries} active, ${r.follow_ups_sent} follow-ups`);
  })().catch(e => console.error('[inquiry] run failed:', e.message));
  res.status(202).json({ started: true, message: 'Inquiry agent started — polling sales mailbox, then follow-ups + daily summary.' });
});

// Gmail connection diagnostic — surfaces auth method, API/mailbox reachability,
// and unread inquiry count so we can test the poll without waiting for the cron.
router.get('/inquiry/gmail-test', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await gmailConnectionTest()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/inquiry/dashboard', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const month = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const inq = (await query(`SELECT
        COUNT(*) FILTER (WHERE status IN ('new','in_conversation','quote_sent','human_requested'))::int active,
        COUNT(*) FILTER (WHERE status='quote_sent')::int quotes_pending,
        COUNT(*) FILTER (WHERE status='order_placed' AND created_at >= ($1)::text)::int orders_month,
        COALESCE(SUM(order_value_usd) FILTER (WHERE status IN ('quote_sent','order_placed')),0) pipeline
      FROM inquiries`, [month])).rows[0];
    res.json({ active_inquiries: inq.active, quotes_pending: inq.quotes_pending, orders_month: inq.orders_month, pipeline_value: Number(inq.pipeline) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/inquiry/pricing', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try { res.json({ pricing: (await query(`SELECT * FROM molecule_pricing WHERE active=1 ORDER BY price_per_kg_usd DESC`)).rows }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/inquiry/pricing/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const b = req.body || {}, sets = [], params = [];
    const push = (c, v) => { params.push(v); sets.push(`${c}=$${params.length}`); };
    for (const f of ['price_per_kg_usd', 'min_quantity_g', 'lead_time_days', 'sample_price_usd', 'purity', 'regulatory_status', 'notes']) if (b[f] !== undefined) push(f, b[f]);
    for (const f of ['gmp_certified', 'dmf_available', 'coa_available', 'sds_available', 'sample_available', 'active']) if (b[f] !== undefined) push(f, b[f] ? 1 : 0);
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=NOW()'); params.push(req.params.id);
    const r = await query(`UPDATE molecule_pricing SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/inquiry', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const where = [], params = [];
    for (const [q, col] of [['status', 'status'], ['priority', 'priority']]) if (typeof req.query[q] === 'string' && req.query[q] !== 'all') { params.push(req.query[q]); where.push(`${col}=$${params.length}`); }
    const rows = (await query(`SELECT i.*, (SELECT COUNT(*)::int FROM inquiry_quotes q WHERE q.inquiry_id=i.id) AS quote_count
      FROM inquiries i ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, updated_at DESC LIMIT 200`, params)).rows;
    res.json({ inquiries: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/inquiry/:id', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const inq = (await query('SELECT * FROM inquiries WHERE id=$1', [req.params.id])).rows[0];
    if (!inq) return res.status(404).json({ error: 'inquiry not found' });
    const messages = (await query('SELECT * FROM inquiry_messages WHERE inquiry_id=$1 ORDER BY created_at', [req.params.id])).rows;
    const quotes = (await query('SELECT * FROM inquiry_quotes WHERE inquiry_id=$1 ORDER BY created_at DESC', [req.params.id])).rows;
    res.json({ inquiry: inq, messages, quotes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manually add a buyer's inbound reply → triggers the AI response.
router.post('/inquiry/:id/reply', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    if (!req.body?.email_text) return res.status(400).json({ error: 'email_text required' });
    const r = await processInboundReply(req.params.id, req.body.email_text, { dryRun: req.body.dryRun === true });
    if (r.error) return res.status(404).json({ error: r.error });
    res.json({ success: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/inquiry/:id/quote', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try { const r = await generateQuote(req.params.id); if (r.error) return res.status(400).json(r); res.json({ success: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/inquiry/:id/escalate', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try { const r = await escalateToHuman(req.params.id, req.body?.reason || 'manually escalated'); if (r.error) return res.status(404).json(r); res.json({ success: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/inquiry/:id', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const b = req.body || {}, sets = [], params = [];
    const push = (c, v) => { params.push(v); sets.push(`${c}=$${params.length}`); };
    if (b.status !== undefined && ['new', 'in_conversation', 'quote_sent', 'order_placed', 'human_requested', 'closed'].includes(b.status)) push('status', b.status);
    if (b.assigned_to_user_id !== undefined) push('assigned_to_user_id', b.assigned_to_user_id || null);
    if (b.order_value_usd !== undefined) push('order_value_usd', Number(b.order_value_usd) || 0);
    if (b.notes !== undefined) push('intended_use', String(b.notes).slice(0, 500)); // notes stored on intended_use if no dedicated col
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=NOW()'); params.push(req.params.id);
    const r = await query(`UPDATE inquiries SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'inquiry not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Reorder Agent ─────────────────────────────────────────────────────────────
const jArr = v => { try { return JSON.parse(v || '[]'); } catch { return []; } };

router.post('/reorder/run', authMiddleware, adminOnly, async (req, res) => {
  const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
  const topN = Math.min(50, Math.max(1, parseInt(req.body?.topN, 10) || 20));
  if (dryRun) {
    try { return res.json(await runReorderAgent({ dryRun: true, topN })); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  runReorderAgent({ topN })
    .then(r => console.log(`[reorder] run — ${r.candidates_found} candidates, ${r.campaigns_created} campaigns`))
    .catch(e => console.error('[reorder] run failed:', e.message));
  res.status(202).json({ started: true, message: 'Reorder agent started — analyzing buyers and drafting campaigns (Apollo sequences created inactive).' });
});

router.get('/reorder/dashboard', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const month = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const b = (await query(`SELECT COUNT(*) FILTER (WHERE status='active')::int active_buyers FROM buyer_accounts`)).rows[0];
    const camp = (await query(`SELECT
        COUNT(*) FILTER (WHERE created_at >= ($1)::text)::int campaigns_month,
        COUNT(*) FILTER (WHERE campaign_status='ordered')::int orders,
        COALESCE(SUM(order_value_usd) FILTER (WHERE campaign_status='ordered'),0) revenue_recovered,
        COUNT(*) FILTER (WHERE campaign_status IN ('email_sent','replied'))::int sent
      FROM reorder_campaigns`, [month])).rows[0];
    let candidates = 0;
    try { candidates = (await identifyReorderCandidates({ topN: 100 })).length; } catch {}
    const convRate = camp.sent > 0 ? Number(((camp.orders / camp.sent) * 100).toFixed(1)) : 0;
    res.json({ active_buyers: b.active_buyers, reorder_candidates: candidates, campaigns_month: camp.campaigns_month, revenue_recovered: Number(camp.revenue_recovered), conversion_rate_pct: convRate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reorder/candidates', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const topN = Math.min(100, Math.max(1, parseInt(req.query.topN, 10) || 20));
    const c = await identifyReorderCandidates({ topN });
    res.json({ candidates: c.map(x => ({ buyer_id: x.buyer.id, contact_name: x.buyer.contact_name, company_name: x.buyer.company_name, email: x.buyer.email, buyer_type: x.buyer.buyer_type, molecule: x.molecule, days_since: x.daysSince, score: x.score, total_orders: x.buyer.total_orders })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reorder/buyers', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const rows = (await query(`SELECT * FROM buyer_accounts ORDER BY total_spent_usd DESC NULLS LAST, last_order_date DESC NULLS LAST LIMIT 200`)).rows;
    res.json({ buyers: rows.map(b => ({ ...b, molecules_purchased: jArr(b.molecules_purchased), preferred_molecules: jArr(b.preferred_molecules) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reorder/buyers', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.email && !b.company_name) return res.status(400).json({ error: 'email or company_name required' });
    const id = crypto.randomUUID();
    const mols = Array.isArray(b.molecules_purchased) ? b.molecules_purchased : String(b.molecules_purchased || '').split(',').map(x => x.trim()).filter(Boolean);
    await query(`INSERT INTO buyer_accounts (id, contact_name, company_name, email, phone, buyer_type,
        first_order_date, last_order_date, total_orders, total_spent_usd, molecules_purchased, preferred_molecules,
        reorder_frequency_days, status, notes, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$10,$11,'active',$12,NOW(),NOW())
      ON CONFLICT (email) DO NOTHING`,
      [id, b.contact_name || null, b.company_name || null, b.email || null, b.phone || null,
       ['compounding_pharmacy', 'research_lab', 'university', 'generic_manufacturer'].includes(b.buyer_type) ? b.buyer_type : 'research_lab',
       b.last_order_date || null, parseInt(b.total_orders, 10) || 1, Number(b.total_spent_usd) || 0,
       JSON.stringify(mols), b.reorder_frequency_days ? parseInt(b.reorder_frequency_days, 10) : null, b.notes || null]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/reorder/buyers/:id', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const b = req.body || {}, sets = [], params = [];
    const push = (c, v) => { params.push(v); sets.push(`${c}=$${params.length}`); };
    for (const f of ['contact_name', 'company_name', 'phone', 'notes', 'last_order_date']) if (b[f] !== undefined) push(f, b[f]);
    if (b.buyer_type !== undefined && ['compounding_pharmacy', 'research_lab', 'university', 'generic_manufacturer'].includes(b.buyer_type)) push('buyer_type', b.buyer_type);
    if (b.status !== undefined && ['active', 'inactive', 'churned'].includes(b.status)) push('status', b.status);
    if (b.total_orders !== undefined) push('total_orders', parseInt(b.total_orders, 10) || 0);
    if (b.total_spent_usd !== undefined) push('total_spent_usd', Number(b.total_spent_usd) || 0);
    if (b.molecules_purchased !== undefined) push('molecules_purchased', JSON.stringify(Array.isArray(b.molecules_purchased) ? b.molecules_purchased : String(b.molecules_purchased).split(',').map(x => x.trim()).filter(Boolean)));
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=NOW()'); params.push(req.params.id);
    const r = await query(`UPDATE buyer_accounts SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    if (!r.rowCount) return res.status(404).json({ error: 'buyer not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/reorder/campaigns', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const where = [], params = [];
    if (typeof req.query.status === 'string' && req.query.status !== 'all') { params.push(req.query.status); where.push(`c.campaign_status=$${params.length}`); }
    const rows = (await query(`SELECT c.*, b.contact_name, b.company_name, b.email, b.buyer_type
      FROM reorder_campaigns c LEFT JOIN buyer_accounts b ON b.id=c.buyer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.reorder_probability DESC, c.created_at DESC LIMIT 200`, params)).rows;
    res.json({ campaigns: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a reorder campaign's status; 'ordered' records the recovered revenue.
router.put('/reorder/campaigns/:id', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['pending', 'email_sent', 'replied', 'ordered', 'declined'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    const c = (await query('SELECT * FROM reorder_campaigns WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'campaign not found' });
    const sets = ['campaign_status=$1'], params = [status];
    if (status === 'replied' && !c.replied_at) sets.push('replied_at=NOW()');
    if (req.body?.order_value_usd !== undefined) { params.push(Number(req.body.order_value_usd) || 0); sets.push(`order_value_usd=$${params.length}`); }
    params.push(req.params.id);
    await query(`UPDATE reorder_campaigns SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    // Bump the buyer's order stats when an order is recorded.
    if (status === 'ordered' && c.buyer_id) {
      await query(`UPDATE buyer_accounts SET total_orders=COALESCE(total_orders,0)+1,
        total_spent_usd=COALESCE(total_spent_usd,0)+$1, last_order_date=$2, updated_at=NOW() WHERE id=$3`,
        [Number(req.body?.order_value_usd) || c.order_value_usd || 0, new Date().toISOString().slice(0, 10), c.buyer_id]).catch(() => {});
    }
    res.json({ success: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Research Agent ────────────────────────────────────────────────────────────
router.post('/research/run', authMiddleware, adminOnly, async (req, res) => {
  const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
  if (dryRun) {
    try { return res.json(await runResearchAgent({ dryRun: true })); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  runResearchAgent()
    .then(r => console.log(`[research] run — ${r.findings_total} findings, ${r.high_relevance} high`))
    .catch(e => console.error('[research] run failed:', e.message));
  res.status(202).json({ started: true, message: 'Research agent started — scanning PubMed/FDA/patents/trials (~1-2 min).' });
});

router.get('/research/dashboard', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const wk = (await query(`SELECT
      COUNT(*) FILTER (WHERE found_at >= (NOW() - INTERVAL '7 days')::text AND title NOT LIKE 'Research Report%')::int week_findings,
      COUNT(*) FILTER (WHERE relevance_score >= 80 AND title NOT LIKE 'Research Report%')::int high_relevance,
      COUNT(*) FILTER (WHERE source='fda' AND found_at >= (NOW() - INTERVAL '30 days')::text)::int fda_approvals
      FROM research_findings`)).rows[0];
    const pat = (await query(`SELECT COUNT(*)::int c FROM patent_watch WHERE status='expiring_soon'`)).rows[0].c;
    const top = (await query(`SELECT id, source, molecule_name, title, therapeutic_area, relevance_score FROM research_findings
      WHERE title NOT LIKE 'Research Report%' ORDER BY relevance_score DESC, found_at DESC LIMIT 5`)).rows;
    res.json({ ...wk, patents_expiring_soon: pat, top_opportunities: top });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/research/findings', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const where = [`title NOT LIKE 'Research Report%'`], params = [];
    for (const [q, col] of [['source', 'source'], ['type', 'finding_type']]) {
      if (typeof req.query[q] === 'string' && req.query[q] !== 'all') { params.push(req.query[q]); where.push(`${col}=$${params.length}`); }
    }
    if (req.query.minScore) { params.push(parseInt(req.query.minScore, 10) || 0); where.push(`relevance_score >= $${params.length}`); }
    if (req.query.actioned === '0') where.push('actioned=0');
    const rows = (await query(`SELECT * FROM research_findings WHERE ${where.join(' AND ')} ORDER BY relevance_score DESC, found_at DESC LIMIT 200`, params)).rows;
    res.json({ findings: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/research/patents', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const sort = req.query.sort === 'market' ? 'market_size_usd_millions DESC' : 'expiry_date ASC';
    const rows = (await query(`SELECT * FROM patent_watch ORDER BY ${sort}`)).rows;
    res.json({ patents: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/research/patents', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.molecule_name) return res.status(400).json({ error: 'molecule_name required' });
    const id = crypto.randomUUID();
    await query(`INSERT INTO patent_watch (id, molecule_name, cas_number, patent_number, patent_holder, expiry_date,
        therapeutic_area, market_size_usd_millions, generic_opportunity_score, status, notes, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
      [id, b.molecule_name, b.cas_number || null, b.patent_number || null, b.patent_holder || null, b.expiry_date || null,
       b.therapeutic_area || null, b.market_size_usd_millions != null ? Number(b.market_size_usd_millions) : null,
       Math.min(100, Math.max(0, parseInt(b.generic_opportunity_score, 10) || 0)),
       ['active', 'expiring_soon', 'expired'].includes(b.status) ? b.status : 'active', b.notes || null]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark a finding actioned (+ optional note / send to procurement approval queue).
router.put('/research/findings/:id', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const f = (await query('SELECT * FROM research_findings WHERE id=$1', [req.params.id])).rows[0];
    if (!f) return res.status(404).json({ error: 'finding not found' });
    const actioned = req.body?.actioned !== undefined ? (req.body.actioned ? 1 : 0) : f.actioned;
    const note = req.body?.action_taken !== undefined ? String(req.body.action_taken).slice(0, 500) : f.action_taken;
    await query('UPDATE research_findings SET actioned=$1, action_taken=$2 WHERE id=$3', [actioned, note, req.params.id]);
    if (req.body?.to_procurement) {
      await enqueueApproval({
        agent_name: 'research-agent', action_type: 'source_molecule',
        action_payload: { task: `Source ${f.molecule_name || f.title} — research finding (${f.source}, score ${f.relevance_score})`, molecule_name: f.molecule_name, cas_number: f.cas_number, source: 'research-agent' },
        priority: f.relevance_score >= 80 ? 'HIGH' : 'MEDIUM',
      });
      await query(`UPDATE research_findings SET actioned=1, action_taken='queued for procurement approval' WHERE id=$1`, [req.params.id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/research/report', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const r = (await query(`SELECT title, summary, created_at FROM research_findings WHERE title LIKE 'Research Report%' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    res.json({ report: r ? { title: r.title, text: r.summary, generated_at: r.created_at } : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Google Meet Agent ─────────────────────────────────────────────────────────
const parseJson = v => { try { return JSON.parse(v || '[]'); } catch { return []; } };

// Trigger the full agent (Google Calendar/Drive path). admin, async 202.
router.post('/meetings/run', authMiddleware, adminOnly, async (req, res) => {
  const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
  const lookbackDays = Math.min(30, Math.max(1, parseInt(req.body?.lookbackDays, 10) || 7));
  if (dryRun) {
    try { return res.json(await runMeetAgent({ dryRun: true, lookbackDays })); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  runMeetAgent({ lookbackDays })
    .then(r => console.log(`[meet] run — ${r.meetings_processed} meetings, ${r.tasks_created} tasks`))
    .catch(e => console.error('[meet] run failed:', e.message));
  res.status(202).json({ started: true, message: 'Meet agent started. Note: needs Google Calendar/Drive scope — use manual upload if it finds nothing.' });
});

// Manual transcript upload → full analysis + assignment + brief. The reliable path.
router.post('/meetings/upload-transcript', authMiddleware, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.transcript_text || !b.meeting_title) return res.status(400).json({ error: 'meeting_title and transcript_text required' });
    const attendees = Array.isArray(b.attendees) ? b.attendees
      : String(b.attendees || '').split(',').map(x => x.trim()).filter(Boolean);
    const meeting = {
      meeting_id: 'manual-' + crypto.randomUUID(),
      meeting_title: String(b.meeting_title).slice(0, 300),
      meeting_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.meeting_date || '')) ? b.meeting_date : new Date().toISOString().slice(0, 10),
      duration_seconds: null,
      attendees,
      transcript_text: String(b.transcript_text),
      recording_url: null,
    };
    const dryRun = b.dryRun === true; // preview extraction before assigning
    const result = await analyzeAndStore(meeting, { dryRun });
    res.json({ success: true, meeting_id: meeting.meeting_id, dryRun, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/meetings/dashboard', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const month = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const m = (await query(`SELECT COUNT(*)::int c FROM meeting_recordings WHERE meeting_date >= $1`, [month])).rows[0].c;
    const t = (await query(`SELECT COUNT(*)::int c, COUNT(*) FILTER (WHERE status='completed')::int done FROM meeting_tasks`)).rows[0];
    const ins = (await query(`SELECT insight_type, COUNT(*)::int c FROM meeting_insights GROUP BY insight_type`)).rows;
    const by = Object.fromEntries(ins.map(r => [r.insight_type, r.c]));
    res.json({ meetings_month: m, tasks_created: t.c, tasks_completed: t.done, decisions: by.decision || 0, blockers: by.blocker || 0, opportunities: by.opportunity || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/meetings', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const rows = (await query(`
      SELECT r.id, r.meeting_id, r.meeting_title, r.meeting_date, r.duration_seconds, r.attendees, r.summary, r.processed, r.created_at,
        (SELECT COUNT(*)::int FROM meeting_tasks t WHERE t.meeting_id=r.meeting_id) AS tasks_generated
      FROM meeting_recordings r ORDER BY r.meeting_date DESC, r.created_at DESC LIMIT 100`)).rows;
    res.json({ meetings: rows.map(m => ({ ...m, attendees: parseJson(m.attendees) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/meetings/:id', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const mtg = (await query(`SELECT * FROM meeting_recordings WHERE meeting_id=$1 OR id=$1`, [req.params.id])).rows[0];
    if (!mtg) return res.status(404).json({ error: 'meeting not found' });
    const tasks = (await query(`SELECT * FROM meeting_tasks WHERE meeting_id=$1 ORDER BY created_at`, [mtg.meeting_id])).rows;
    const insights = (await query(`SELECT * FROM meeting_insights WHERE meeting_id=$1 ORDER BY insight_type`, [mtg.meeting_id])).rows;
    res.json({ meeting: { ...mtg, attendees: parseJson(mtg.attendees) }, tasks, insights });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/meetings/:id/tasks', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const mtg = (await query(`SELECT meeting_id FROM meeting_recordings WHERE meeting_id=$1 OR id=$1`, [req.params.id])).rows[0];
    const mid = mtg ? mtg.meeting_id : req.params.id;
    const tasks = (await query(`SELECT * FROM meeting_tasks WHERE meeting_id=$1 ORDER BY created_at`, [mid])).rows;
    res.json({ tasks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a meeting task's status; syncs the linked daily_task when completed.
router.put('/meetings/tasks/:id', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['pending', 'assigned', 'completed'].includes(status)) return res.status(400).json({ error: 'invalid status' });
    const t = (await query('SELECT * FROM meeting_tasks WHERE id=$1', [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ error: 'task not found' });
    await query('UPDATE meeting_tasks SET status=$1 WHERE id=$2', [status, req.params.id]);
    if (status === 'completed' && t.daily_task_id) {
      await query(`UPDATE daily_tasks SET status='completed', updated_at=NOW() WHERE id=$1`, [t.daily_task_id]).catch(() => {});
    }
    res.json({ success: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Procurement Agent v2 (RFQs, suppliers, comparison) ────────────────────────
const jsonArr = v => { try { return JSON.parse(v || '[]'); } catch { return []; } };

// Trigger the full agent (generate RFQs from approvals → send supplier emails).
// adminOnly: this sends REAL emails to external suppliers. ?dryRun=1 to preview.
router.post('/procurement/run', authMiddleware, adminOnly, async (req, res) => {
  const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
  if (dryRun) {
    try { return res.json(await runProcurementAgent({ dryRun: true })); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  runProcurementAgent()
    .then(r => console.log(`[procurement] run — ${r.rfqs_created} RFQs, ${r.emails_sent} emails`))
    .catch(e => console.error('[procurement] run failed:', e.message));
  res.status(202).json({ started: true, message: 'Procurement agent started — generating and sending RFQs.' });
});

router.get('/procurement/dashboard', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const month = new Date(Date.now() - 30 * 86400000).toISOString();
    const s = (await query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('pending','sent','responded','compared'))::int active_rfqs,
        COUNT(*) FILTER (WHERE status='sent')::int awaiting_response,
        COUNT(*) FILTER (WHERE status IN ('responded','compared'))::int responses_in,
        COUNT(*) FILTER (WHERE status='approved' AND created_at >= $1)::int approved_month
      FROM rfq_requests`, [month])).rows[0];
    const responses = (await query(`SELECT COUNT(*)::int c FROM rfq_responses`)).rows[0].c;
    const suppliers = (await query(`SELECT COUNT(*)::int c FROM suppliers`)).rows[0].c;
    res.json({ ...s, total_responses: responses, total_suppliers: suppliers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/procurement/rfqs', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const params = [], where = [];
    if (typeof req.query.status === 'string' && req.query.status !== 'all') { params.push(req.query.status); where.push(`r.status=$${params.length}`); }
    const rows = (await query(`
      SELECT r.*,
        (SELECT COUNT(*)::int FROM supplier_outreach_log o WHERE o.rfq_id=r.id) AS suppliers_contacted,
        (SELECT COUNT(*)::int FROM rfq_responses rr WHERE rr.rfq_id=r.id) AS responses_received
      FROM rfq_requests r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE r.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, r.created_at DESC`, params)).rows;
    res.json({ rfqs: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/procurement/rfqs/:id', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const rfq = (await query('SELECT * FROM rfq_requests WHERE id=$1', [req.params.id])).rows[0];
    if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
    const outreach = (await query('SELECT * FROM supplier_outreach_log WHERE rfq_id=$1 ORDER BY sent_at', [req.params.id])).rows;
    const responses = (await query('SELECT * FROM rfq_responses WHERE rfq_id=$1 ORDER BY score DESC NULLS LAST', [req.params.id])).rows;
    res.json({ rfq, outreach, responses });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Palash logs a supplier's reply. Re-scores the RFQ (no email) so the comparison
// stays current; the response moves the RFQ to 'responded'.
router.post('/procurement/rfqs/:id/responses', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const rfq = (await query('SELECT id FROM rfq_requests WHERE id=$1', [req.params.id])).rows[0];
    if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
    const b = req.body || {};
    if (!b.supplier_name && !b.supplier_id) return res.status(400).json({ error: 'supplier_name or supplier_id required' });
    let supplierName = b.supplier_name;
    if (!supplierName && b.supplier_id) supplierName = (await query('SELECT name FROM suppliers WHERE id=$1', [b.supplier_id])).rows[0]?.name;
    const id = crypto.randomUUID();
    await query(`INSERT INTO rfq_responses
      (id, rfq_id, supplier_id, supplier_name, price_per_kg, currency, lead_time_days, available_quantity,
       purity_offered, gmp_status, coa_available, sample_available, min_order_qty, response_email, raw_response, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
      [id, req.params.id, b.supplier_id || null, supplierName || null,
       b.price_per_kg != null ? Number(b.price_per_kg) : null, b.currency || 'USD',
       b.lead_time_days != null ? parseInt(b.lead_time_days, 10) : null, b.available_quantity || null,
       b.purity_offered || null, b.gmp_status || null, b.coa_available ? 1 : 0, b.sample_available ? 1 : 0,
       b.min_order_qty || null, b.response_email || null, b.raw_response || null]);
    await query(`UPDATE rfq_requests SET status='responded' WHERE id=$1 AND status='sent'`, [req.params.id]);
    let ranking = null;
    try { ranking = await scoreAndRankSuppliers(req.params.id, { notify: false }); } catch {}
    res.json({ success: true, response_id: id, ranking });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Scored comparison. ?notify=1 emails Palash the comparison table (Claude summary).
router.get('/procurement/compare/:rfqId', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const notify = req.query?.notify === '1';
    const result = await scoreAndRankSuppliers(req.params.rfqId, { notify });
    if (result.error) return res.status(result.scored === 0 ? 200 : 404).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Approve the winning supplier → records the decision + a PO draft, status 'approved'.
router.post('/procurement/rfqs/:id/approve-supplier', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const rfq = (await query('SELECT * FROM rfq_requests WHERE id=$1', [req.params.id])).rows[0];
    if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
    const respId = req.body?.response_id;
    const resp = respId
      ? (await query('SELECT * FROM rfq_responses WHERE id=$1 AND rfq_id=$2', [respId, req.params.id])).rows[0]
      : (await query('SELECT * FROM rfq_responses WHERE rfq_id=$1 ORDER BY score DESC NULLS LAST LIMIT 1', [req.params.id])).rows[0];
    if (!resp) return res.status(400).json({ error: 'no supplier response to approve' });
    await query('UPDATE rfq_responses SET recommended=0 WHERE rfq_id=$1', [req.params.id]);
    await query('UPDATE rfq_responses SET recommended=1 WHERE id=$1', [resp.id]);
    await query(`UPDATE rfq_requests SET status='approved' WHERE id=$1`, [req.params.id]);
    const poDraft = {
      molecule: rfq.molecule_name, cas_number: rfq.cas_number, supplier: resp.supplier_name,
      price_per_kg: resp.price_per_kg, currency: resp.currency, quantity: rfq.target_quantity,
      lead_time_days: resp.lead_time_days, approved_by: req.user.email, approved_at: new Date().toISOString(),
    };
    logAgentActivity({ agent_name: req.user.email, action_type: 'procurement_decision', user_id: null,
      reasoning: `${req.user.email} approved ${resp.supplier_name} for ${rfq.molecule_name} at ${resp.currency} ${resp.price_per_kg}/kg (${rfq.target_quantity}).`,
      source_kpi: 'kpi-sg-procurement', output_summary: `rfq=${req.params.id} supplier=${resp.supplier_name} price=${resp.price_per_kg}` }).catch(() => {});
    res.json({ success: true, status: 'approved', po_draft: poDraft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/procurement/suppliers', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const params = [], where = [];
    if (typeof req.query.region === 'string' && req.query.region !== 'all') { params.push(req.query.region); where.push(`region=$${params.length}`); }
    if (req.query.gmp === '1') where.push('gmp_certified=1');
    const rows = (await query(`SELECT * FROM suppliers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY reliability_score DESC, name`, params)).rows;
    res.json({ suppliers: rows.map(s => ({ ...s, specialties: jsonArr(s.specialties) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/procurement/suppliers', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const id = crypto.randomUUID();
    await query(`INSERT INTO suppliers (id, name, country, region, contact_email, contact_name, website,
        specialties, reliability_score, avg_response_days, gmp_certified, total_orders, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,NOW(),NOW())`,
      [id, b.name, b.country || null, ['apac','india','china','europe','us'].includes(b.region) ? b.region : null,
       b.contact_email || null, b.contact_name || null, b.website || null,
       JSON.stringify(Array.isArray(b.specialties) ? b.specialties : String(b.specialties || '').split(',').map(x => x.trim()).filter(Boolean)),
       Math.min(100, Math.max(0, parseInt(b.reliability_score, 10) || 50)), Number(b.avg_response_days) || 3, b.gmp_certified ? 1 : 0]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/procurement/suppliers/:id', authMiddleware, requireAnyTier('procurement'), async (req, res) => {
  try {
    const s = (await query('SELECT id FROM suppliers WHERE id=$1', [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ error: 'supplier not found' });
    const b = req.body || {}, sets = [], params = [];
    const push = (col, val) => { params.push(val); sets.push(`${col}=$${params.length}`); };
    if (b.name !== undefined) push('name', b.name);
    if (b.country !== undefined) push('country', b.country);
    if (b.region !== undefined && ['apac','india','china','europe','us'].includes(b.region)) push('region', b.region);
    if (b.contact_email !== undefined) push('contact_email', b.contact_email);
    if (b.contact_name !== undefined) push('contact_name', b.contact_name);
    if (b.website !== undefined) push('website', b.website);
    if (b.specialties !== undefined) push('specialties', JSON.stringify(Array.isArray(b.specialties) ? b.specialties : String(b.specialties).split(',').map(x => x.trim()).filter(Boolean)));
    if (b.reliability_score !== undefined) push('reliability_score', Math.min(100, Math.max(0, parseInt(b.reliability_score, 10) || 50)));
    if (b.avg_response_days !== undefined) push('avg_response_days', Number(b.avg_response_days) || 3);
    if (b.gmp_certified !== undefined) push('gmp_certified', b.gmp_certified ? 1 : 0);
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=NOW()');
    params.push(req.params.id);
    await query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push SEO content to the live abiozen product DB ───────────────────────────
// Writes seo_content → abiozen products (matched on CAS) via ABIOZEN_DATABASE_URL.
// Async 202; ?dryRun=1 reports eligible/excluded counts without writing.
router.post('/seo/push-to-abiozen', authMiddleware, adminOnly, async (req, res) => {
  const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
  if (dryRun) {
    try { return res.json(await pushSeoContentToAbiozen({ dryRun: true })); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  pushSeoContentToAbiozen()
    .then(r => console.log(`[seo] push to abiozen — ${r.matched} matched, ${r.updated} product rows updated, ${r.errors.length} errors`))
    .catch(e => console.error('[seo] push to abiozen failed:', e.message));
  res.status(202).json({ started: true, message: 'SEO content push to abiozen started. Check back shortly.' });
});

// ── Sales Pipeline (leads from Apollo replies) ────────────────────────────────
// Read access: admin + sales_director. Mutations: admin only.
router.get('/leads', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const where = [], params = [];
    if (typeof req.query.status === 'string' && req.query.status !== 'all') {
      params.push(req.query.status); where.push(`status = $${params.length}`);
    }
    if (typeof req.query.classification === 'string' && req.query.classification !== 'all') {
      params.push(req.query.classification.toUpperCase()); where.push(`classification = $${params.length}`);
    }
    const leads = (await query(
      `SELECT l.*, (SELECT COUNT(*)::int FROM follow_ups f WHERE f.lead_id=l.id) AS follow_up_count
       FROM leads l ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY CASE classification WHEN 'HOT' THEN 0 WHEN 'WARM' THEN 1 ELSE 2 END, updated_at DESC`,
      params
    )).rows;
    res.json({ leads });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/leads/pipeline', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try { res.json(await getLeadPipeline()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Update status / notes / assignee / value. Bumps updated_at (drives the
// avg-response-time metric — the first move off 'new' is the response).
router.put('/leads/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const lead = (await query('SELECT id, status FROM leads WHERE id=$1', [req.params.id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const sets = [], params = [];
    if (req.body.status !== undefined) {
      if (!['new', 'contacted', 'qualified', 'closed'].includes(req.body.status)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      params.push(req.body.status); sets.push(`status = $${params.length}`);
    }
    if (req.body.notes !== undefined) { params.push(String(req.body.notes).slice(0, 2000)); sets.push(`notes = $${params.length}`); }
    if (req.body.assigned_to !== undefined) { params.push(req.body.assigned_to || null); sets.push(`assigned_to = $${params.length}`); }
    if (req.body.estimated_value !== undefined) { params.push(Number(req.body.estimated_value) || 0); sets.push(`estimated_value = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at = NOW()');
    params.push(req.params.id);
    await query(`UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    logAgentActivity({
      agent_name: req.user.email, action_type: 'lead_updated', user_id: null,
      reasoning: `${req.user.email} updated lead ${req.params.id}: ${sets.filter(s => !s.startsWith('updated_at')).join(', ')}`,
      output_summary: `lead_id=${req.params.id}`,
    }).catch(() => {});
    const updated = (await query('SELECT * FROM leads WHERE id=$1', [req.params.id])).rows[0];
    res.json({ success: true, lead: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Follow-up drafts for a lead (for the "Send follow-up" quick action to preview).
router.get('/leads/:id/follow-ups', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const rows = (await query('SELECT * FROM follow_ups WHERE lead_id=$1 ORDER BY created_at DESC', [req.params.id])).rows;
    res.json({ follow_ups: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate (or regenerate) a follow-up draft for a lead on demand.
router.post('/leads/:id/follow-up', authMiddleware, adminOnly, async (req, res) => {
  try {
    const lead = (await query('SELECT * FROM leads WHERE id=$1', [req.params.id])).rows[0];
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const draft = await generateFollowUp(lead);
    res.json({ success: true, follow_up: draft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manually trigger Apollo reply processing (async 202; the hourly cron does this
// automatically). ?dryRun=1 reports what would be fetched without writing.
router.post('/leads/process-replies', authMiddleware, adminOnly, async (req, res) => {
  const dryRun = req.query?.dryRun === '1' || req.body?.dryRun === true;
  if (dryRun) {
    try { return res.json(await processApolloReplies({ dryRun: true })); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  processApolloReplies()
    .then(r => console.log(`[sales] replies processed — ${r.new_leads} new leads (${r.hot} hot)`))
    .catch(e => console.error('[sales] reply processing failed:', e.message));
  res.status(202).json({ started: true, message: 'Apollo reply processing started. Refresh the pipeline shortly.' });
});

// Current (or ?week=) week's 150 molecules, split into the two tabs.
router.get('/market/weekly', authMiddleware, requireAnyTier('procurement', 'intelligence'), async (req, res) => {
  try {
    const week = await mhLatestWeek(req.query.week);
    if (!week) return res.json({ week_start: null, research: [], gmp: [], summary: { research_count: 0, gmp_count: 0, total: 0, in_catalog: 0, new_opportunities: 0 } });
    const rows = (await query(`SELECT * FROM molecule_history WHERE week_start=$1 ORDER BY gmp_status, rank`, [week])).rows.map(mhRow);
    const research = rows.filter(r => r.gmp_status === 'non_gmp');
    const gmp = rows.filter(r => r.gmp_status === 'gmp');
    const weeksTracked = (await query(`SELECT COUNT(DISTINCT week_start) AS n FROM molecule_history`)).rows[0]?.n || 0;
    res.json({
      week_start: week, research, gmp,
      summary: {
        research_count: research.length, gmp_count: gmp.length, total: rows.length,
        in_catalog: rows.filter(r => r.in_catalog).length,
        new_opportunities: rows.filter(r => !r.in_catalog).length,
        tasks_queued: Math.min(20, research.length) + Math.min(10, gmp.length),
        weeks_tracked: Number(weeksTracked),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All historical molecules with sourcing status. Filters: week, gmp_status,
// sourcing_status, category. Also returns the distinct week list for the UI.
router.get('/market/history', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const where = [], params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('?', '$' + params.length)); };
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '')) add('week_start=?', req.query.week);
    if (['gmp', 'non_gmp'].includes(req.query.gmp_status)) add('gmp_status=?', req.query.gmp_status);
    if (['pending', 'in_progress', 'sourced', 'unavailable'].includes(req.query.sourcing_status)) add('sourcing_status=?', req.query.sourcing_status);
    if (req.query.category) add('LOWER(category)=LOWER(?)', req.query.category);
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = (await query(`SELECT * FROM molecule_history ${clause} ORDER BY week_start DESC, gmp_status, rank LIMIT 3000`, params)).rows.map(mhRow);
    const weeks = (await query(`SELECT DISTINCT week_start FROM molecule_history ORDER BY week_start DESC`)).rows.map(r => r.week_start);
    res.json({ molecules: rows, weeks, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a molecule's sourcing status (Palash's pipeline). Optionally supplier info.
router.put('/market/molecule/:id', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const { sourcing_status, supplier_name, supplier_found } = req.body || {};
    if (sourcing_status !== undefined && !['pending', 'in_progress', 'sourced', 'unavailable'].includes(sourcing_status)) {
      return res.status(400).json({ error: 'sourcing_status must be pending, in_progress, sourced or unavailable' });
    }
    const existing = (await query(`SELECT id FROM molecule_history WHERE id=$1`, [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'molecule not found' });
    await query(
      `UPDATE molecule_history SET
         sourcing_status = COALESCE($1, sourcing_status),
         supplier_name   = COALESCE($2, supplier_name),
         supplier_found  = COALESCE($3, supplier_found)
       WHERE id=$4`,
      [sourcing_status ?? null, supplier_name ?? null,
       supplier_found === undefined ? null : (supplier_found ? 1 : 0), req.params.id]
    );
    const updated = (await query(`SELECT * FROM molecule_history WHERE id=$1`, [req.params.id])).rows[0];
    res.json({ success: true, molecule: mhRow(updated) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Molecules not in the catalog, sorted by demand (rank), newest week first — the
// procurement gap list.
router.get('/market/gaps', authMiddleware, requireAnyTier('procurement', 'intelligence'), async (req, res) => {
  try {
    const week = await mhLatestWeek(req.query.week);
    const params = [week];
    const clause = week ? 'WHERE in_catalog=0 AND week_start=$1' : 'WHERE in_catalog=0';
    const rows = (await query(`SELECT * FROM molecule_history ${week ? clause : 'WHERE in_catalog=0'} ORDER BY gmp_status, rank LIMIT 500`, week ? params : [])).rows.map(mhRow);
    res.json({ week_start: week, gaps: rows, total: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV export — research chemicals (latest or ?week=).
router.get('/market/export/research', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const week = await mhLatestWeek(req.query.week);
    const rows = week ? (await query(`SELECT * FROM molecule_history WHERE week_start=$1 AND gmp_status='non_gmp' ORDER BY rank`, [week])).rows.map(mhRow) : [];
    const cols = [
      { label: 'Rank', get: r => r.rank }, { label: 'Molecule', get: r => r.molecule_name },
      { label: 'CAS', get: r => r.cas_number }, { label: 'Category', get: r => r.category },
      { label: 'Purity', get: r => r.details.typical_purity }, { label: 'Price/kg', get: r => r.details.typical_price_per_kg },
      { label: 'Primary use', get: r => r.details.primary_use_case }, { label: 'Buyer segment', get: r => r.details.target_buyer_segment },
      { label: 'Demand driver', get: r => r.details.demand_driver }, { label: 'APAC availability', get: r => r.details.apac_supplier_availability },
      { label: 'In catalog', get: r => r.in_catalog ? 'yes' : 'no' }, { label: 'Sourcing status', get: r => r.sourcing_status },
    ];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="research-chemicals-${week || 'none'}.csv"`);
    res.send(toCsv(cols, rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CSV export — GMP APIs (latest or ?week=).
router.get('/market/export/gmp', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const week = await mhLatestWeek(req.query.week);
    const rows = week ? (await query(`SELECT * FROM molecule_history WHERE week_start=$1 AND gmp_status='gmp' ORDER BY rank`, [week])).rows.map(mhRow) : [];
    const cols = [
      { label: 'Rank', get: r => r.rank }, { label: 'Molecule', get: r => r.molecule_name },
      { label: 'CAS', get: r => r.cas_number }, { label: 'Therapeutic area', get: r => r.therapeutic_area },
      { label: 'GMP grade', get: r => r.details.gmp_grade }, { label: 'Purity', get: r => r.details.typical_purity },
      { label: 'USP/EP', get: r => r.details.usp_ep_compliant }, { label: 'Price/kg', get: r => r.details.typical_price_per_kg },
      { label: 'Market size $M', get: r => r.details.market_size_usd_millions }, { label: 'Patent status', get: r => r.details.patent_status },
      { label: 'Mfr region', get: r => r.details.primary_manufacturers_region }, { label: 'Compounding eligible', get: r => r.details.compounding_eligible },
      { label: 'In catalog', get: r => r.in_catalog ? 'yes' : 'no' }, { label: 'Sourcing status', get: r => r.sourcing_status },
    ];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="gmp-apis-${week || 'none'}.csv"`);
    res.send(toCsv(cols, rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ENTERPRISE SKU BULK UPLOAD — E-commerce format
// ============================================================
router.post('/skus/bulk-upload', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const crypto = require('crypto');
    const { products } = req.body;
    if (!products?.length) return res.status(400).json({ error: 'No products provided' });
    let uploaded = 0, skipped = 0, errors = [];
    for (const p of products) {
      try {
        const existing = await query(`SELECT id FROM skus WHERE name=$1`, [p.product_name]);
        if (existing.rows[0]) { skipped++; continue; }
        const salePrice = parseFloat(p.supplier_1kg_price) || 0;
        const costPrice = salePrice * 0.35;
        const margin = salePrice > 0 ? ((salePrice - costPrice) / salePrice) * 100 : 0;
        await query(`INSERT INTO skus (id,name,category,cost_price,sale_price,gross_margin,supplier,is_gmp,is_active,cas_number,purity,currency,sds_link,sds_status,coa_link,coa_status,lead_time_days) VALUES ($1,$2,'API',$3,$4,$5,$6,1,1,$7,$8,$9,$10,$11,$12,$13,14)`,
          [crypto.randomUUID(), p.product_name, costPrice, salePrice, margin, p.supplier||null, p.CAS_number||null, p.purity||null, p.supplier_currency||'USD', p.SDS_link||null, p.SDS_status||'pending', p.COA_link||null, p.COA_status||'pending']);
        uploaded++;
      } catch(e) { errors.push({ product: p.product_name, error: e.message }); }
    }
    res.json({ success: true, uploaded, skipped, errors, total: products.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/algolia/sync', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await syncPlaybookOSSkus();
    res.json({ success: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/algolia/sync-abiozen', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await syncAbiozenProducts();
    res.json({ success: true, ...result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/skus/export', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const result = await query(`SELECT name as product_name, cas_number, purity, supplier, currency, sale_price as supplier_1kg_price, sds_link, sds_status, coa_link, coa_status, gross_margin, is_gmp, units_in_stock FROM skus WHERE is_active=1 ORDER BY revenue_total DESC`);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Apollo find buyers
router.post('/apollo/find-buyers', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const { molecule_name, buyer_segment } = req.body;
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(400).json({ error: 'APOLLO_API_KEY not configured in Railway Variables' });
    const titles = { compounding_pharmacy: ['Chief Pharmacist','Purchasing Manager','Pharmacy Director'], research_lab: ['Lab Director','Research Scientist','Procurement Manager'], generic_manufacturer: ['VP Procurement','API Sourcing Manager'] };
    const response = await fetch('https://api.apollo.io/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify({ q_keywords: buyer_segment?.replace('_',' ') || 'compounding pharmacy', person_titles: titles[buyer_segment] || titles.compounding_pharmacy, person_locations: ['United States'], per_page: 25 })
    });
    const data = await response.json();
    const contacts = (data.people||[]).map(p => ({ name: p.name, email: p.email, title: p.title, company: p.organization?.name, phone: p.phone_numbers?.[0]?.raw_number })).filter(c => c.email);
    res.json({ contacts, total: contacts.length, molecule: molecule_name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/apollo/send-outreach', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const { contacts, molecule_name, discount_pct, price_per_kg, purity } = req.body;
    const { sendEmail } = require('../lib/mailer');
    const crypto = require('crypto');
    let sent = 0;
    for (const contact of (contacts||[]).slice(0,50)) {
      if (!contact.email) continue;
      sendEmail({ to: contact.email, subject: `${discount_pct}% off ${molecule_name} — Limited offer from Abiozen LLC`,
        html: `<div style="font-family:Arial;max-width:600px"><div style="background:#1B3A6B;padding:20px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0">Abiozen LLC</h2><p style="color:#9FE1CB;margin:4px 0 0">Premium Pharmaceutical APIs & Research Molecules</p></div><div style="padding:24px;border:1px solid #e2e8f0;border-radius:0 0 8px 8px"><p>Dear ${contact.name||'Purchasing Manager'},</p><p>We have <strong>${molecule_name}</strong> available at <strong>${discount_pct}% below market rate</strong> for a limited time.</p><div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px;margin:16px 0"><div style="font-size:20px;font-weight:700;color:#166534">${discount_pct}% Discount — This Week Only</div><div style="color:#15803d;margin-top:4px">$${price_per_kg}/kg · ${purity||'99%+'} purity · COA & SDS available</div></div><ul><li>Certificate of Analysis from accredited lab</li><li>Safety Data Sheet included</li><li>GMP-grade documentation</li><li>Fast US delivery 7-14 days</li><li>Minimum order: 1kg</li></ul><a href="https://abiozen.com" style="background:#0D7377;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Request Quote Now</a><p style="color:#666;font-size:11px;margin-top:16px">Abiozen LLC · 1333 Barclay Blvd Suite 1333, Buffalo Grove IL 60089 · To unsubscribe reply STOP</p></div></div>` });
      await query(`INSERT INTO activity_logs (id,user_id,log_date,metric,value,notes,source) VALUES ($1,$2,$3,'emails_sent',1,$4,'apollo')`,
        [crypto.randomUUID(), req.user.id, new Date().toISOString().slice(0,10), `Apollo outreach: ${contact.email} — ${molecule_name}`]);
      sent++;
    }
    res.json({ success: true, sent, molecule: molecule_name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/apollo/sequences', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(400).json({ error: 'APOLLO_API_KEY not configured' });
    const response = await fetch('https://api.apollo.io/v1/emailer_campaigns/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify({ per_page: 25 })
    });
    const data = await response.json();
    res.json({ sequences: data.emailer_campaigns || [], total: data.pagination?.total_entries || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/apollo/stats', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(400).json({ error: 'APOLLO_API_KEY not configured' });
    const response = await fetch('https://api.apollo.io/v1/emailer_campaigns/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify({ per_page: 25 })
    });
    const data = await response.json();
    const sequences = data.emailer_campaigns || [];
    console.log('Apollo raw:', JSON.stringify(sequences[0]||{}));
    console.log('Apollo fields:', Object.keys(sequences[0]||{}).filter(k=>k.includes('num')||k.includes('contact')||k.includes('active')||k.includes('paused')));
    const stats = sequences.map(s => ({
      id: s.id,
      name: s.name,
      status: s.active ? 'active' : (s.archived ? 'archived' : 'draft'),
      contacts: (s.num_active_in_sequence || 0) + (s.num_paused_in_sequence || 0) + (s.unique_delivered || 0),
      emails_sent: s.unique_delivered || 0,
      opens: s.unique_opened || 0,
      replies: s.unique_replied || 0,
      clicked: s.unique_clicked || 0,
      bounced: s.unique_bounced || 0,
      open_rate: Math.round((s.open_rate || 0) * 100),
      reply_rate: Math.round((s.reply_rate || 0) * 100),
      num_steps: s.num_steps || 0,
      last_used: s.last_used_at || null
    }));
    res.json({ stats, total_contacts: stats.reduce((a,b) => a + b.contacts, 0), total_sent: stats.reduce((a,b) => a + b.emails_sent, 0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/sequences/templates', authMiddleware, async (req, res) => {
  res.json({ sequences: [
    {
      id: 's2', name: 'S2 · Abiozen Research Lab Biotech', priority: 2,
      segment: 'Research Lab / Biotech', target_contacts: 500,
      apollo_filters: { titles: ['Lab Director','Director of Research','Principal Scientist','Research Procurement Manager','Head of Biology'], industry: ['Biotechnology','Life Sciences'], location: 'United States', company_size: '10-500' },
      emails: [
        { day: 1, subject: 'Research-grade APIs — 5,000+ molecules, 24hr quote', type: 'intro' },
        { day: 6, subject: 'Sample COA available — which molecule does your lab need?', type: 'followup' },
        { day: 15, subject: 'Re: Research molecule supply — final note', type: 'breakup' }
      ]
    },
    {
      id: 's3', name: 'S3 · Abiozen Generic Manufacturer API', priority: 3,
      segment: 'Generic Manufacturer', target_contacts: 500,
      apollo_filters: { titles: ['VP Procurement','API Sourcing Manager','Director Supply Chain','Head of Purchasing'], industry: ['Pharmaceutical Manufacturing','Generic Drugs'], location: 'United States', company_size: '50-5000' },
      emails: [
        { day: 1, subject: 'API supply partnership — Abiozen LLC · GMP certified', type: 'intro' },
        { day: 7, subject: 'USDMF molecules available — 40+ APIs for {{company_name}}', type: 'followup' },
        { day: 18, subject: 'Approved vendor dossier — Abiozen LLC', type: 'breakup' }
      ]
    },
    {
      id: 's4', name: 'S4 · Abiozen University Research Institute', priority: 4,
      segment: 'University / Research Institute', target_contacts: 500,
      apollo_filters: { titles: ['Principal Investigator','Research Director','Department Head','Lab Manager','Professor of Pharmacology'], industry: ['Higher Education','Academic Research'], keywords: 'pharmaceutical research', location: 'United States', company_size: '1000+' },
      emails: [
        { day: 1, subject: 'Research molecule supply — {{company_name}} · Academic pricing', type: 'intro' },
        { day: 6, subject: 'Academic pricing sheet — peptide and GLP-1 research molecules', type: 'followup' },
        { day: 15, subject: 'Re: Research molecule supply — {{company_name}}', type: 'breakup' }
      ]
    }
  ]});
});

router.get('/apollo/debug', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    const response = await fetch('https://api.apollo.io/v1/emailer_campaigns/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify({ per_page: 5 })
    });
    const data = await response.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AI Agent System ──────────────────────────────────────────────────────────

// Today's AI-assigned tasks for the logged-in user.
router.get('/agent/tasks/my', authMiddleware, async (req, res) => {
  try {
    const date = req.query.date || businessToday();
    const tasks = (await query(
      `SELECT * FROM daily_tasks WHERE user_id=$1 AND task_date=$2
       ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at`,
      [req.user.id, date]
    )).rows;
    // Attach per-task audit history (status changes + comments) in one query,
    // grouped by the task_id embedded in output_summary. Avoids an N+1.
    const events = (await query(
      `SELECT action_type, reasoning, output_summary, created_at
         FROM agent_activity_log
        WHERE user_id=$1 AND action_type IN ('task_status_change','task_comment_added','task_manual_assign','task_ai_assign')
        ORDER BY created_at DESC`,
      [req.user.id]
    )).rows;
    const byTask = {};
    for (const e of events) {
      const m = /task_id=([0-9a-f-]+)/.exec(e.output_summary || '');
      if (m) (byTask[m[1]] = byTask[m[1]] || []).push(e);
    }
    // Resolve assigner display names so the card can show "Assigned by <name>".
    // The assigner email lives in the assign audit's output_summary (by=…).
    const nameByEmail = {};
    for (const u of (await query('SELECT email, name FROM users')).rows) {
      nameByEmail[(u.email || '').toLowerCase()] = u.name || u.email;
    }
    tasks.forEach(t => {
      t.audit_history = byTask[t.id] || [];
      const assignEv = t.audit_history.find(e =>
        e.action_type === 'task_manual_assign' || e.action_type === 'task_ai_assign');
      if (assignEv) {
        const bm = /by=(\S+)/.exec(assignEv.output_summary || '');
        if (bm) t.assigned_by_name = nameByEmail[bm[1].toLowerCase()] || bm[1];
      }
    });
    const completed = tasks.filter(t => t.status === 'completed').length;
    res.json({ date, total: tasks.length, completed, tasks });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update a task's status. Users may only update their own tasks; admins any.
router.put('/agent/tasks/:id', authMiddleware, async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ error: 'status must be pending, in_progress or completed' });
    }
    // Optional task-level comment. Trim; cap at 500 chars; empty/whitespace is
    // treated as "no comment" so it preserves any existing one (COALESCE below).
    let comment = null;
    if (req.body?.comment != null) {
      if (typeof req.body.comment !== 'string') {
        return res.status(400).json({ error: 'comment must be a string' });
      }
      const t = req.body.comment.trim();
      if (t.length > 500) {
        return res.status(400).json({ error: 'comment must be 500 characters or fewer' });
      }
      comment = t.length ? t : null;
    }
    const task = (await query(`SELECT * FROM daily_tasks WHERE id=$1`, [req.params.id])).rows[0];
    if (!task) return res.status(404).json({ error: 'task not found' });
    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    const isOwner = task.user_id === req.user.id;
    // TEMPORARY capability flag (pending proper role design): can_run_standup lets a
    // non-admin update any user's task via the standup tool. Read fresh (not from the
    // JWT) so a grant takes effect immediately without re-login. This flag is honored
    // ONLY here — no other endpoint consults it.
    let canRunStandup = false;
    if (!isAdmin && !isOwner) {
      const r = (await query('SELECT can_run_standup FROM users WHERE id=$1', [req.user.id])).rows[0];
      canRunStandup = !!(r && r.can_run_standup);
    }
    if (!isAdmin && !isOwner && !canRunStandup) {
      return res.status(403).json({ error: 'not your task' });
    }
    const oldStatus = task.status;
    await query(
      `UPDATE daily_tasks SET status=$1, updated_at=NOW(), updated_by=$2,
         last_comment=COALESCE($3, last_comment) WHERE id=$4`,
      [status, req.user.id, comment, req.params.id]
    );
    // Fire-and-forget audit — never blocks the response. Logged on the assignee's
    // timeline (user_id = task owner); actor + old→new captured in the summary.
    const statusChanged = oldStatus !== status;
    const commentAdded = comment !== null;
    // KPI rollup — when a KPI-linked task's completion state changes, recompute the
    // linked weekly KPI's actual from the count of that user's completed tasks tagged
    // to the same KPI in the same ISO week. Recompute (not +/-1) is idempotent, so
    // toggling status can never double-count. Best-effort: a rollup failure must never
    // block task completion, so it's wrapped and logged like the audit below.
    if (statusChanged && task.source_kpi) {
      try {
        const kpiWeek = mondayOf(new Date(task.task_date)).toISOString().slice(0, 10);
        await query(
          `UPDATE weekly_kpis SET kpi_actual = (
             SELECT COUNT(*) FROM daily_tasks
             WHERE user_id=$1 AND source_kpi=$2 AND status='completed'
               AND date_trunc('week', task_date::date) = date_trunc('week', $3::date)
           ), last_updated_at = NOW()
           WHERE user_id=$1 AND kpi_name=$2 AND week_start=$4`,
          [task.user_id, task.source_kpi, task.task_date, kpiWeek]
        );
      } catch (e) { console.error('[tasks] KPI rollup failed:', e.message); }
    }
    if (statusChanged) {
      logAgentActivity({
        agent_name: 'user', action_type: 'task_status_change', user_id: task.user_id,
        reasoning: `${req.user.email} changed "${task.task_title}": ${oldStatus} → ${status}`
          + (commentAdded ? `: "${comment.slice(0, 200)}"` : ''),
        output_summary: `task_id=${req.params.id} ${oldStatus}->${status} by=${req.user.email}`
          + (commentAdded ? ' +comment' : ''),
      }).catch(e => console.error('[tasks] status-change audit failed:', e.message));
    } else if (commentAdded) {
      logAgentActivity({
        agent_name: 'user', action_type: 'task_comment_added', user_id: task.user_id,
        reasoning: `${req.user.email} commented on "${task.task_title}": "${comment.slice(0, 200)}"`,
        output_summary: `task_id=${req.params.id} comment by=${req.user.email}`,
      }).catch(e => console.error('[tasks] comment audit failed:', e.message));
    }
    // Live rescore — performance_scores is otherwise only written by the 18:00 UTC
    // cron, so before this the score a user saw after completing a task was the
    // previous day's stale number. Awaited (not fire-and-forget) so the score in this
    // response is guaranteed fresh; silent:true keeps it from writing weekly-summary
    // rows or an audit entry. Best-effort like the KPI rollup above: a scoring failure
    // must never fail the task update, it just omits `score` from the response.
    let score = null;
    if (statusChanged) {
      try {
        const r = await runPerformanceCheck({ userId: task.user_id, silent: true });
        const row = (r.scored || [])[0];
        if (row) score = { total: row.total_score, tasks_completed: row.tasks_completed,
                           tasks_assigned: row.tasks_assigned };
      } catch (e) { console.error('[tasks] live rescore failed:', e.message); }
    }
    res.json({ success: true, id: req.params.id, status, score });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All team tasks for a date (admin).
router.get('/agent/tasks/team', authMiddleware, adminOnly, async (req, res) => {
  try {
    const date = req.query.date || businessToday();
    const rows = (await query(
      `SELECT d.*, u.name AS user_name, u.role AS user_role
       FROM daily_tasks d JOIN users u ON u.id=d.user_id
       WHERE d.task_date=$1
       ORDER BY u.name, CASE d.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END`,
      [date]
    )).rows;
    res.json({ date, total: rows.length, tasks: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manually trigger agent task generation for a segment (admin).
router.post('/agent/tasks/generate', authMiddleware, adminOnly, async (req, res) => {
  try {
    const segment = req.body?.segment || 'all';
    const result = await runMorningBriefing({ segment });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manually assign a single task to a specific user (admin). Reuses
// createDailyTask so this stays in lockstep with the cron path. Logs to
// agent_activity_log with agent_name='admin' for audit trail.
router.post('/agent/tasks/assign', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { user_id, task_title, task_description, priority, task_date } = req.body || {};
    if (!user_id || typeof user_id !== 'string') return res.status(400).json({ error: 'user_id is required' });
    const title = (task_title || '').trim();
    if (!title) return res.status(400).json({ error: 'task_title is required' });
    if (task_date && !/^\d{4}-\d{2}-\d{2}$/.test(task_date)) {
      return res.status(400).json({ error: 'task_date must be YYYY-MM-DD' });
    }
    // Optional assignment comment for the assignee (same rules as task/KPI comments).
    let comment = null;
    if (req.body?.comment != null) {
      if (typeof req.body.comment !== 'string') {
        return res.status(400).json({ error: 'comment must be a string' });
      }
      const t = req.body.comment.trim();
      if (t.length > 500) {
        return res.status(400).json({ error: 'comment must be 500 characters or fewer' });
      }
      comment = t.length ? t : null;
    }
    const target = (await query(`SELECT id, email FROM users WHERE id=$1 AND is_active=1`, [user_id])).rows[0];
    if (!target) return res.status(400).json({ error: 'user not found or inactive' });
    const date = task_date || new Date().toISOString().slice(0, 10);
    const task_id = await createDailyTask({
      user_id: target.id,
      task_date: date,
      task_title: title,
      task_description: (task_description || '').trim(),
      priority,
      source_kpi: null,
      agent_name: null,
      reasoning: `Manually assigned by ${req.user.email}`,
      comment,
    });
    await logAgentActivity({
      agent_name: 'admin',
      action_type: 'task_manual_assign',
      user_id: target.id,
      reasoning: `${req.user.email} assigned "${title}" to ${target.email} for ${date}`
        + (comment ? `: "${comment.slice(0, 200)}"` : ''),
      source_kpi: 'manual',
      confidence_score: 100,
      output_summary: `task_id=${task_id} priority=${priority || 'MEDIUM'} by=${req.user.email}`
        + (comment ? ' +comment' : ''),
    });
    res.json({ success: true, task_id, assigned_to: target.id, task_date: date });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AI task command — natural-language → draft task batch → admin-approved commit
const AI_TASK_MAX_TASKS = 25;
const AI_TASK_MAX_USERS = 8;
const AI_TASK_MAX_PER_USER_PER_DATE = 5;
const AI_TASK_VALID_KPIS = ['commits','prs_merged','features_deployed','suppliers_approved','market_analyses','team_reviews','candidates_screened','interviews_scheduled','offers_made','calls_made','demos_completed','orders_closed','outreach_emails'];

// Generate DRAFT tasks from a natural-language instruction. Read-only: does NOT
// write to daily_tasks. Logs the generation attempt to agent_activity_log even
// if no commit follows. Frontend reviews/edits/removes drafts in memory and
// posts the approved set to /ai-commit for atomic persistence.
router.post('/agent/tasks/ai-generate', authMiddleware, adminOnly, async (req, res) => {
  try {
    const instruction = String(req.body?.instruction || '').trim();
    if (!instruction) return res.status(400).json({ error: 'instruction is required' });
    if (instruction.length > 500) return res.status(400).json({ error: 'instruction must be 500 chars or fewer' });
    const clarifications = Array.isArray(req.body?.clarifications) ? req.body.clarifications : [];

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.includes('REPLACE')) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const users = (await query(`SELECT id, name, email, role FROM users WHERE is_active=1 ORDER BY role, name`)).rows;
    const userById = new Map(users.map(u => [u.id, u]));

    const today = new Date();
    const todayISO = today.toISOString().slice(0, 10);
    const dow = today.getUTCDay();
    const monOffset = dow === 0 ? -6 : (1 - dow);
    const monday = new Date(today.getTime() + monOffset * 86400000);
    const friday = new Date(monday.getTime() + 4 * 86400000);
    const nextMonday = new Date(monday.getTime() + 7 * 86400000);
    const nextFriday = new Date(friday.getTime() + 7 * 86400000);
    const iso = d => d.toISOString().slice(0, 10);

    const userListBlock = users.map(u =>
      `- id=${u.id} name="${(u.name || '(no name)').replace(/"/g, '\\"')}" email="${u.email}" role="${u.role}"`
    ).join('\n');
    const clarBlock = clarifications.length
      ? `\n\nThe admin previously clarified: ${JSON.stringify(clarifications)}`
      : '';

    const prompt = `You are the AI task-assignment assistant for PlaybookOS at Abiozen LLC, a US-based pharmaceutical API distributor.

Today's date: ${todayISO}
Current ISO week: Mon ${iso(monday)} → Fri ${iso(friday)}
Next ISO week: Mon ${iso(nextMonday)} → Fri ${iso(nextFriday)}

## Active users (you may only assign to these IDs)
${userListBlock}

## Team aliases — map plain English to roles
- "sales team" / "sales" / "salespeople" → roles: sales_director, account_manager
- "procurement team" / "procurement" / "buying" → roles: procurement_director, procurement_team
- "dev team" / "developers" / "engineering" → role: dev_team
- "recruitment team" / "hiring" / "talent" → roles: recruitment_director, recruitment_team
- "everyone" / "all" / "the team" → all active users
- A bare first name → match users.name case-insensitively (substring); if multiple match, emit a clarifications_needed entry instead of guessing

## Valid KPI source values (pick ONE per task that fits, or null)
${AI_TASK_VALID_KPIS.join(', ')}
Do NOT invent new KPI values.

## Rules
- Maximum ${AI_TASK_MAX_TASKS} tasks total per command
- Maximum ${AI_TASK_MAX_USERS} distinct users assigned
- Priority must be exactly HIGH, MEDIUM, or LOW
- task_date must be today or a future date in YYYY-MM-DD format
- task_title: imperative, action-oriented, under 80 chars
- task_description: 1-3 sentences of context (optional but encouraged)
- rationale: one sentence explaining why YOU generated this task from the instruction
- If a team alias resolves to zero active users, add a warning and skip those assignments

## Output format — STRICT JSON, no markdown fences, no commentary
{
  "tasks": [
    {
      "user_id": "<one of the active user UUIDs>",
      "task_title": "...",
      "task_description": "...",
      "priority": "HIGH|MEDIUM|LOW",
      "task_date": "YYYY-MM-DD",
      "source_kpi": "<one of the valid KPIs or null>",
      "rationale": "..."
    }
  ],
  "warnings": [],
  "clarifications_needed": []
}

## Admin instruction
${instruction}${clarBlock}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!aiRes.ok) {
      const t = await aiRes.text().catch(() => '');
      return res.status(502).json({ error: `Claude API ${aiRes.status}: ${t.slice(0, 300)}` });
    }
    const aiData = await aiRes.json();
    const claudeText = aiData.content?.[0]?.text || '';
    const parsed = parseClaudeJSON(claudeText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return res.status(502).json({ error: 'Claude returned unparseable JSON', raw: claudeText.slice(0, 400) });
    }

    const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const errors = [];
    if (rawTasks.length > AI_TASK_MAX_TASKS) errors.push(`AI returned ${rawTasks.length} tasks, max ${AI_TASK_MAX_TASKS}`);

    const tasks = [];
    for (let i = 0; i < rawTasks.length; i++) {
      const t = rawTasks[i] || {};
      const fail = (msg) => errors.push(`task[${i}]: ${msg}`);
      if (!t.user_id || !userById.has(t.user_id)) { fail('user_id is not a known active user'); continue; }
      const title = String(t.task_title || '').trim();
      if (!title || title.length > 200) { fail('task_title required, max 200 chars'); continue; }
      const pri = ['HIGH','MEDIUM','LOW'].includes(String(t.priority).toUpperCase()) ? String(t.priority).toUpperCase() : null;
      if (!pri) { fail('priority must be HIGH/MEDIUM/LOW'); continue; }
      const date = String(t.task_date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { fail('task_date must be YYYY-MM-DD'); continue; }
      if (date < todayISO) { fail('task_date cannot be in the past'); continue; }
      const kpi = (t.source_kpi === null || t.source_kpi === undefined) ? null
        : (AI_TASK_VALID_KPIS.includes(t.source_kpi) ? t.source_kpi : null);
      const u = userById.get(t.user_id);
      tasks.push({
        draft_id: crypto.randomUUID(),
        user_id: t.user_id,
        user_label: u.email,
        user_role: u.role,
        task_title: title,
        task_description: String(t.task_description || '').slice(0, 2000),
        priority: pri,
        task_date: date,
        source_kpi: kpi,
        rationale: String(t.rationale || '').slice(0, 500),
      });
    }

    const distinctUsers = new Set(tasks.map(t => t.user_id));
    if (distinctUsers.size > AI_TASK_MAX_USERS) errors.push(`${distinctUsers.size} distinct users exceeds max ${AI_TASK_MAX_USERS}`);

    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : [];
    const perKey = {};
    for (const t of tasks) {
      const k = `${t.user_id}|${t.task_date}`;
      perKey[k] = (perKey[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(perKey)) {
      if (n > AI_TASK_MAX_PER_USER_PER_DATE) {
        const [uid, d] = k.split('|');
        warnings.push(`${userById.get(uid).email} would get ${n} tasks on ${d} (max ${AI_TASK_MAX_PER_USER_PER_DATE}); commit will be blocked`);
      }
    }

    await logAgentActivity({
      agent_name: 'admin',
      action_type: 'task_ai_generate',
      user_id: req.user.id,
      reasoning: `${req.user.email} ran AI generation: "${instruction.slice(0, 200)}"`,
      source_kpi: 'manual',
      confidence_score: 100,
      output_summary: `generated ${tasks.length} draft tasks for ${distinctUsers.size} user(s)`,
    });

    if (errors.length) {
      return res.status(422).json({
        error: 'AI output failed validation',
        validation_errors: errors,
        raw_text: claudeText.slice(0, 1000),
      });
    }

    res.json({
      instruction,
      tasks,
      warnings,
      clarifications_needed: Array.isArray(parsed.clarifications_needed) ? parsed.clarifications_needed : [],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Commit a reviewed batch of AI-drafted tasks. Atomic: all tasks land or none.
// Re-validates every field server-side (defense in depth — frontend may have edited).
router.post('/agent/tasks/ai-commit', authMiddleware, adminOnly, async (req, res) => {
  try {
    const instruction = String(req.body?.instruction || '').slice(0, 500);
    const tasksIn = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    if (!tasksIn.length) return res.status(400).json({ error: 'no tasks to commit' });
    if (tasksIn.length > AI_TASK_MAX_TASKS) return res.status(400).json({ error: `too many tasks (max ${AI_TASK_MAX_TASKS})` });

    const todayISO = new Date().toISOString().slice(0, 10);
    const users = (await query(`SELECT id, name, email, role FROM users WHERE is_active=1`)).rows;
    const userById = new Map(users.map(u => [u.id, u]));

    const errors = [];
    const validated = [];
    for (let i = 0; i < tasksIn.length; i++) {
      const t = tasksIn[i] || {};
      const fail = (msg) => errors.push({ index: i, message: msg });
      if (!t.user_id || !userById.has(t.user_id)) { fail('user_id is not a known active user'); continue; }
      const title = String(t.task_title || '').trim();
      if (!title || title.length > 200) { fail('task_title required, max 200 chars'); continue; }
      const pri = ['HIGH','MEDIUM','LOW'].includes(String(t.priority).toUpperCase()) ? String(t.priority).toUpperCase() : null;
      if (!pri) { fail('priority must be HIGH/MEDIUM/LOW'); continue; }
      const date = String(t.task_date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { fail('task_date must be YYYY-MM-DD'); continue; }
      if (date < todayISO) { fail('task_date cannot be in the past'); continue; }
      const kpi = (t.source_kpi === null || t.source_kpi === undefined) ? null
        : (AI_TASK_VALID_KPIS.includes(t.source_kpi) ? t.source_kpi : null);
      // Optional per-task assignment comment (admin-authored at review time).
      let comment = null;
      if (t.comment != null) {
        if (typeof t.comment !== 'string') { fail('comment must be a string'); continue; }
        const c = t.comment.trim();
        if (c.length > 500) { fail('comment must be 500 characters or fewer'); continue; }
        comment = c.length ? c : null;
      }
      validated.push({
        user_id: t.user_id,
        user_email: userById.get(t.user_id).email,
        task_title: title,
        task_description: String(t.task_description || '').slice(0, 2000).trim(),
        priority: pri,
        task_date: date,
        source_kpi: kpi,
        rationale: String(t.rationale || '').slice(0, 500),
        comment,
      });
    }
    const distinctUsers = new Set(validated.map(t => t.user_id));
    if (distinctUsers.size > AI_TASK_MAX_USERS) errors.push({ index: -1, message: `${distinctUsers.size} distinct users exceeds max ${AI_TASK_MAX_USERS}` });
    const perKey = {};
    for (const t of validated) {
      const k = `${t.user_id}|${t.task_date}`;
      perKey[k] = (perKey[k] || 0) + 1;
      if (perKey[k] > AI_TASK_MAX_PER_USER_PER_DATE) {
        errors.push({ index: -1, message: `${t.user_email} on ${t.task_date} would have ${perKey[k]} tasks (max ${AI_TASK_MAX_PER_USER_PER_DATE})` });
        break;
      }
    }
    if (errors.length) return res.status(400).json({ error: 'validation failed', errors });

    const ids = await withTransaction(async (client) => {
      const taskIds = [];
      for (const t of validated) {
        const taskId = await createDailyTask({
          user_id: t.user_id,
          task_date: t.task_date,
          task_title: t.task_title,
          task_description: t.task_description,
          priority: t.priority,
          source_kpi: t.source_kpi,
          agent_name: null,
          reasoning: `AI-assigned by ${req.user.email}: ${t.rationale || instruction.slice(0, 150)}`,
          comment: t.comment,
        }, client);
        taskIds.push(taskId);
        await logAgentActivity({
          agent_name: 'admin',
          action_type: 'task_ai_assign',
          user_id: t.user_id,
          reasoning: `${req.user.email} AI-assigned "${t.task_title}" to ${t.user_email} for ${t.task_date}`
            + (t.comment ? `: "${t.comment.slice(0, 200)}"` : ''),
          source_kpi: 'manual',
          confidence_score: 100,
          output_summary: `task_id=${taskId} priority=${t.priority} kpi=${t.source_kpi || 'null'} by=${req.user.email} from instruction="${instruction.slice(0, 100)}"`,
        }, client);
      }
      return taskIds;
    });

    res.json({ success: true, committed: ids.length, task_ids: ids });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Adoption telemetry — per-user activity summary for the admin dashboard.
// Window: 'today' (since 00:00 UTC), '7d' (rolling), or '30d' (rolling).
router.get('/admin/adoption', authMiddleware, adminOnly, async (req, res) => {
  try {
    const w = req.query.window || '7d';
    const windowSql = {
      'today': "NOW()::date::timestamptz",
      '7d':    "NOW() - INTERVAL '7 days'",
      '30d':   "NOW() - INTERVAL '30 days'",
    };
    if (!windowSql[w]) return res.status(400).json({ error: 'window must be today|7d|30d' });
    const cutoff = windowSql[w];
    // cutoff comes from the server-controlled windowSql map, never from user
    // input, so interpolating it directly into the SQL is safe.
    const rows = (await query(`
      SELECT
        u.id, u.name, u.email, u.role, u.last_login,
        COUNT(dt.id) FILTER (WHERE dt.status = 'completed' AND dt.task_date >= (${cutoff})::date::text)::int AS tasks_completed_in_window,
        COUNT(dt.id) FILTER (WHERE dt.task_date >= (${cutoff})::date::text)::int AS tasks_assigned_in_window,
        GREATEST(
          u.last_login,
          (SELECT MAX(al.created_at::timestamptz) FROM activity_logs al WHERE al.user_id = u.id)
        ) AS last_activity_at
      FROM users u
      LEFT JOIN daily_tasks dt ON dt.user_id = u.id
      WHERE u.is_active = 1
      GROUP BY u.id, u.name, u.email, u.role, u.last_login
      ORDER BY u.last_login DESC NULLS LAST, u.email
    `)).rows;
    res.json({ window: w, count: rows.length, users: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Approval queue — pending (or filtered by ?status=) actions awaiting review.
router.get('/agent/approvals', authMiddleware, adminOnly, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const rows = (await query(
      `SELECT * FROM approval_queue WHERE status=$1
       ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at DESC`,
      [status]
    )).rows.map(r => {
      let payload = {};
      try { payload = JSON.parse(r.action_payload || '{}'); } catch {}
      return { ...r, action_payload: payload };
    });
    res.json({ status, count: rows.length, approvals: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Approve or reject a queued action. Approving materializes it as a daily task.
router.put('/agent/approvals/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const decision = req.body?.decision;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
    }
    const appr = (await query(`SELECT * FROM approval_queue WHERE id=$1`, [req.params.id])).rows[0];
    if (!appr) return res.status(404).json({ error: 'approval not found' });
    if (appr.status !== 'pending') return res.status(409).json({ error: `already ${appr.status}` });

    await query(
      `UPDATE approval_queue SET status=$1, reviewed_by=$2, reviewed_at=NOW(), notes=$3 WHERE id=$4`,
      [decision, req.user.id, req.body?.notes || null, req.params.id]
    );

    let task_id = null;
    if (decision === 'approved') {
      let payload = {};
      try { payload = JSON.parse(appr.action_payload || '{}'); } catch {}
      const target = appr.requested_for_user_id || req.user.id;
      const owner = (await query(`SELECT id FROM users WHERE id=$1`, [target])).rows[0];
      task_id = crypto.randomUUID();
      await query(
        `INSERT INTO daily_tasks
           (id, user_id, task_date, task_title, task_description, priority, status,
            source_kpi, agent_name, reasoning, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,NOW())`,
        [task_id, owner ? owner.id : req.user.id, new Date().toISOString().slice(0, 10),
         payload.task || payload.molecule || appr.action_type,
         payload.rationale || payload.reasoning || '',
         appr.priority || 'MEDIUM', appr.action_type, appr.agent_name,
         'Approved from the agent approval queue.']
      );
    }
    res.json({ success: true, id: req.params.id, decision, task_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Agent activity log — every recorded agent action (admin).
router.get('/agent/activity', authMiddleware, adminOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const params = [];
    let where = '';
    if (req.query.agent) { params.push(req.query.agent); where = 'WHERE agent_name=$1'; }
    params.push(limit);
    const rows = (await query(
      `SELECT * FROM agent_activity_log ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    )).rows;
    res.json({ count: rows.length, activity: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cross-team dependency map (procurement -> sales -> marketplace -> SEO).
router.get('/agent/dependencies', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    res.json(await getCrossTeamDependencies());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mission Control overview — powers the Agent Control page sections 1 & 4.
router.get('/agent/overview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const today = businessToday();
    const hierarchy = await getKPIHierarchy();
    const bottlenecks = await getBottlenecks({ limit: 3 });
    const vision = hierarchy.vision || { current_value: 0, target_value: 10000000, pct: 0 };

    const members = (await query(
      `SELECT id, name, role FROM users WHERE is_active=1 ORDER BY name`
    )).rows;
    const team = [];
    for (const m of members) {
      const sc = await calculateKPIScore(m.id, today);
      const tc = (await query(
        `SELECT COUNT(*) FILTER (WHERE status='completed')::int done, COUNT(*)::int total
         FROM daily_tasks WHERE user_id=$1 AND task_date=$2`, [m.id, today]
      )).rows[0];
      team.push({
        id: m.id, name: m.name, role: m.role, score: sc.score,
        status: sc.score >= 75 ? 'green' : sc.score >= 60 ? 'amber' : 'red',
        tasks_completed: tc.done, tasks_total: tc.total,
      });
    }

    const pendingApprovals = parseInt((await query(
      `SELECT COUNT(*) c FROM approval_queue WHERE status='pending'`)).rows[0].c, 10);
    const runRate7d = parseFloat((await query(
      `SELECT COALESCE(SUM(amount),0)/7.0 v FROM orders WHERE order_date::date >= (NOW() - INTERVAL '7 days')::date`
    )).rows[0].v);

    const end = new Date('2026-12-31T23:59:59Z');
    const daysRemaining = Math.max(0, Math.ceil((end - new Date()) / 86400000));
    const remaining = Math.max(0, vision.target_value - vision.current_value);

    res.json({
      generated_at: new Date().toISOString(),
      vision: { current: vision.current_value, target: vision.target_value, pct: vision.pct },
      days_remaining: daysRemaining,
      daily_run_rate_needed: daysRemaining > 0 ? Math.round(remaining / daysRemaining) : remaining,
      daily_run_rate_actual: Math.round(runRate7d),
      risks: bottlenecks.bottlenecks,
      strategic_goals: hierarchy.strategic_goals,
      team,
      pending_approvals: pendingApprovals,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Mission Control — unified overview of all 9 scheduled agents ──────────────
// `crons` are the ACTUAL cron specs wired in server.js, each with the timezone
// it truly fires in. Agents defined below the CST block in server.js
// (procurement/meet/research/reorder/inquiry) fire in America/Chicago; CEO,
// market-intelligence, email-engine and sales are scheduled in the server's
// default UTC (see the "3 PM UTC (9 AM CST)" comments there). next_run is
// computed from these specs, so the countdown reflects reality even where the
// human `label` reads "CST". cron dow: 0/7=Sun … 6=Sat; h:null = hourly.
const MC_AGENTS = [
  { key:'ceo-agent',           name:'CEO Agent',           icon:'🧭', label:'Weekdays · 7:00 AM CST',
    crons:[{ m:0,  h:7,  dows:[1,2,3,4,5], tz:'America/Chicago' }] },
  { key:'market-intelligence', name:'Market Intelligence', icon:'🛰️', label:'Monday · 9:00 AM CST',
    crons:[{ m:0,  h:9,  dow:1,    tz:'America/Chicago' }] },
  { key:'email-engine',        name:'Email Engine',        icon:'✉️', label:'Monday · 9:30 AM CST',
    crons:[{ m:30, h:9,  dow:1,    tz:'America/Chicago' }] },
  { key:'sales-agent',         name:'Sales Agent',         icon:'📈', label:'Hourly · :17',
    crons:[{ m:17, h:null, dow:null, tz:'UTC' }] },
  { key:'procurement-agent',   name:'Procurement Agent',   icon:'📦', label:'Tuesday · 9:00 AM CST',
    crons:[{ m:0, h:9,  dow:2, tz:'America/Chicago' }] },
  { key:'meet-agent',          name:'Google Meet Agent',   icon:'🎥', label:'Mon 11:00 AM + Fri 4:00 PM CST',
    crons:[{ m:0, h:11, dow:1, tz:'America/Chicago' }, { m:0, h:16, dow:5, tz:'America/Chicago' }] },
  { key:'research-agent',      name:'Research Agent',      icon:'🔬', label:'Nightly · 11:00 PM CST',
    crons:[{ m:0, h:23, dow:null, tz:'America/Chicago' }] },
  { key:'reorder-agent',       name:'Reorder Agent',       icon:'🔁', label:'Wed 10:00 AM + Sun 8:00 PM CST',
    crons:[{ m:0, h:10, dow:3, tz:'America/Chicago' }, { m:0, h:20, dow:0, tz:'America/Chicago' }] },
  { key:'inquiry-agent',       name:'Inquiry Agent',       icon:'📨', label:'Daily · 9:00 AM CST',
    crons:[{ m:0, h:9, dow:null, tz:'America/Chicago' }] },
];

// Manual-trigger runners (lazy require to avoid circular deps at module load).
const MC_RUNNERS = {
  'ceo-agent':           () => require('../lib/agents/ceo-agent').runCEOBriefing(),
  'market-intelligence': () => require('../lib/agents/growth-agent').runMarketIntelligence(),
  'email-engine':        () => require('../lib/agents/email-engine').runEmailEngine({ topMolecules: 10 }),
  'sales-agent':         () => require('../lib/agents/sales-agent').processApolloReplies(),
  'procurement-agent':   () => require('../lib/agents/procurement-agent').runProcurementAgent(),
  'meet-agent':          () => require('../lib/agents/meet-agent').runMeetAgent({ lookbackDays: 3 }),
  'research-agent':      () => require('../lib/agents/research-agent').runResearchAgent(),
  'reorder-agent':       () => require('../lib/agents/reorder-agent').runReorderAgent({ topN: 20 }),
  'inquiry-agent':       () => require('../lib/agents/inquiry-agent').runInquiryAgent(),
};
const MC_RUNNING = new Set(); // keys of agents whose manual run is in-flight

const MC_WD = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };

// Calendar Y/M/D as seen in a tz.
function mcYmdInTz(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' })
    .formatToParts(date).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { y:+p.year, mon:(+p.month) - 1, d:+p.day };
}
function mcWeekdayNum(date, tz) {
  return MC_WD[new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday:'short' }).format(date)];
}
// Does `inst` fall on a day-of-week this cron spec allows? Supports a single
// `dow` (0/7=Sun), a `dows` array (e.g. [1..5] weekdays), or neither (any day).
function mcDowOk(spec, inst, tz) {
  const wd = mcWeekdayNum(inst, tz);
  if (spec.dows) return spec.dows.includes(wd);
  if (spec.dow != null) return wd === (spec.dow === 7 ? 0 : spec.dow);
  return true;
}
function mcHourFloatInTz(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour:'2-digit', minute:'2-digit', hour12:false })
    .formatToParts(date).reduce((o, x) => (o[x.type] = x.value, o), {});
  return (+p.hour % 24) + (+p.minute) / 60;
}
// Wall-clock (y,mon,d,hh,mm) in an IANA tz → the UTC Date instant (DST-safe via one correction pass).
function mcZonedToUtc(y, mon, d, hh, mm, tz) {
  if (tz === 'UTC') return new Date(Date.UTC(y, mon, d, hh, mm, 0));
  const wall = Date.UTC(y, mon, d, hh, mm, 0);
  const offsetAt = t => {
    const loc = new Date(new Date(t).toLocaleString('en-US', { timeZone: tz }));
    const utc = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'UTC' }));
    return loc - utc;
  };
  let inst = wall - offsetAt(wall);
  inst = wall - offsetAt(inst);
  return new Date(inst);
}
// Next fire (UTC Date) strictly after `from` for one cron spec.
function mcNextFire(spec, from) {
  const { m, h, tz } = spec;
  if (h === null) { // hourly at minute m
    const cand = new Date(from); cand.setUTCSeconds(0, 0); cand.setUTCMinutes(m);
    return cand > from ? cand : new Date(cand.getTime() + 3600000);
  }
  const anchor = mcYmdInTz(from, tz);
  const base = Date.UTC(anchor.y, anchor.mon, anchor.d);
  for (let i = 0; i < 16; i++) {
    const { y, mon, d } = mcYmdInTz(new Date(base + i * 86400000), tz);
    const inst = mcZonedToUtc(y, mon, d, h, m, tz);
    if (inst <= from) continue;
    if (!mcDowOk(spec, inst, tz)) continue;
    return inst;
  }
  return null;
}
function mcNextRun(agent, from) {
  let best = null;
  for (const c of agent.crons) { const n = mcNextFire(c, from); if (n && (!best || n < best)) best = n; }
  return best;
}
// Fires for one agent that land inside the [dayStart,dayEnd) Chicago business day.
function mcFiresToday(agent, dayStart, dayEnd, now) {
  const out = [], seen = new Set();
  for (const c of agent.crons) {
    if (c.h === null) continue; // hourly not marked on the timeline
    for (let i = -1; i <= 1; i++) {
      const { y, mon, d } = mcYmdInTz(new Date(dayStart + i * 86400000), c.tz);
      const inst = mcZonedToUtc(y, mon, d, c.h, c.m, c.tz);
      const t = inst.getTime();
      if (t < dayStart || t >= dayEnd) continue;
      if (!mcDowOk(c, inst, c.tz)) continue;
      const iso = inst.toISOString();
      if (seen.has(iso)) continue; seen.add(iso);
      out.push({ iso, hour: mcHourFloatInTz(inst, 'America/Chicago'), fired: t <= now.getTime() });
    }
  }
  return out;
}

// Unified status for all agents: summary cards, per-agent state, today's timeline.
router.get('/agent/mission-control', authMiddleware, adminOnly, async (req, res) => {
  try {
    const now = new Date();
    const keys = MC_AGENTS.map(a => a.key);

    const recentRows = (await query(
      `SELECT agent_name, created_at, action_type, output_summary FROM (
         SELECT agent_name, created_at, action_type, output_summary,
                ROW_NUMBER() OVER (PARTITION BY agent_name ORDER BY created_at DESC) rn
         FROM agent_activity_log WHERE agent_name = ANY($1)
       ) t WHERE rn <= 3 ORDER BY agent_name, created_at DESC`,
      [keys]
    )).rows;
    const countRows = (await query(
      `SELECT agent_name,
         COUNT(*) FILTER (WHERE created_at::timestamptz >= date_trunc('day', now()))::int AS actions_today,
         COUNT(*) FILTER (WHERE created_at::timestamptz >= date_trunc('day', now())
           AND (lower(action_type) LIKE '%error%' OR lower(action_type) LIKE '%fail%'
             OR lower(coalesce(output_summary,'')) LIKE '%error%'))::int AS errors_today
       FROM agent_activity_log WHERE agent_name = ANY($1) GROUP BY agent_name`,
      [keys]
    )).rows;

    const recentBy = {}, countBy = {};
    for (const r of recentRows) (recentBy[r.agent_name] = recentBy[r.agent_name] || []).push(r);
    for (const r of countRows) countBy[r.agent_name] = r;

    const bt = businessToday();
    const [by, bm, bd] = bt.split('-').map(Number);
    const dayStart = mcZonedToUtc(by, bm - 1, bd, 0, 0, 'America/Chicago').getTime();
    const dayEnd = dayStart + 24 * 3600000;

    let runningCount = 0, errorsToday = 0, actionsToday = 0;
    const timeline = [];
    const agents = MC_AGENTS.map(a => {
      const recent = recentBy[a.key] || [];
      const counts = countBy[a.key] || { actions_today: 0, errors_today: 0 };
      actionsToday += counts.actions_today; errorsToday += counts.errors_today;
      const lastRun = recent[0] ? recent[0].created_at : null;
      const hourly = a.crons.some(c => c.h === null);
      // "running": a manual trigger is in-flight, or a scheduled fire landed in the last 2 min.
      const recentlyFired = a.crons.some(c => { const f = mcNextFire(c, new Date(now.getTime() - 120000)); return f && f <= now; });
      const running = MC_RUNNING.has(a.key) || recentlyFired;
      if (running) runningCount++;
      const status = counts.errors_today > 0 ? 'red' : (lastRun ? 'green' : 'amber');
      const nextRun = mcNextRun(a, now);
      if (!hourly) for (const f of mcFiresToday(a, dayStart, dayEnd, now)) timeline.push({ key: a.key, name: a.name, icon: a.icon, ...f });
      return {
        key: a.key, name: a.name, icon: a.icon, schedule_label: a.label, hourly,
        last_run: lastRun, last_result: recent[0] ? recent[0].output_summary : null,
        actions_today: counts.actions_today, errors_today: counts.errors_today,
        next_run: nextRun ? nextRun.toISOString() : null, running, status, recent,
      };
    });

    res.json({
      generated_at: now.toISOString(),
      summary: { total: MC_AGENTS.length, running: runningCount, errors_today: errorsToday, actions_today: actionsToday },
      agents,
      timeline: timeline.sort((x, y) => x.hour - y.hour),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manually fire an agent now. Fire-and-forget: responds 202 immediately and runs
// the agent in the background; failures are logged as a 'manual_run_error' row so
// the card flips red.
router.post('/agent/mission-control/:key/run', authMiddleware, adminOnly, async (req, res) => {
  const key = req.params.key;
  const runner = MC_RUNNERS[key];
  if (!runner) return res.status(404).json({ error: `Unknown agent: ${key}` });
  if (MC_RUNNING.has(key)) return res.status(409).json({ error: 'Agent is already running', key });
  MC_RUNNING.add(key);
  Promise.resolve()
    .then(() => runner())
    .then(r => { try { console.log(`[mission-control] ${key} manual run (by ${req.user.email}) done:`, JSON.stringify(r).slice(0, 200)); } catch (_) { console.log(`[mission-control] ${key} manual run done`); } })
    .catch(async e => {
      console.error(`[mission-control] ${key} manual run failed:`, e.message);
      try {
        await logAgentActivity({
          agent_name: key, action_type: 'manual_run_error', user_id: null,
          reasoning: String(e.message).slice(0, 500),
          output_summary: `Manual trigger failed: ${e.message}`.slice(0, 300),
        });
      } catch (_) {}
    })
    .finally(() => MC_RUNNING.delete(key));
  res.status(202).json({ started: true, key, started_at: new Date().toISOString(), by: req.user.email });
});

// ── LinkedIn AI Content Engine ───────────────────────────────────────────────

// Generate a LinkedIn post for a specific molecule or for one of the weekly
// templates (market_intelligence / company_update). Stored as a draft.
router.post('/linkedin/generate-post', authMiddleware, adminOnly, async (req, res) => {
  try {
    const type = (req.body?.post_type || 'product').toLowerCase();
    let post;
    if (type === 'product') {
      const molecule = req.body?.molecule || { name: req.body?.molecule_name, cas: req.body?.cas_number, purity: req.body?.purity };
      if (!molecule?.name) return res.status(400).json({ error: 'molecule.name (or molecule_name) is required for a product post' });
      post = await generateProductPost(molecule);
    } else if (type === 'market_intelligence') {
      post = await generateMarketIntelligencePost(req.body?.analysisData);
    } else if (type === 'company_update') {
      post = await generateCompanyUpdate(req.body?.metrics);
    } else {
      return res.status(400).json({ error: "post_type must be one of: product, market_intelligence, company_update" });
    }
    const id = crypto.randomUUID();
    const scheduledFor = req.body?.scheduled_for || new Date().toISOString().slice(0, 10);
    await query(
      `INSERT INTO linkedin_content_queue
         (id, post_type, headline, body, hashtags, full_post, status, scheduled_for, source_molecule, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,NOW())`,
      [id, post.post_type, post.headline, post.body, post.hashtags, post.full_post, scheduledFor, post.source_molecule || null]
    );
    res.json({ success: true, id, status: 'draft', ...post, scheduled_for: scheduledFor });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All queued LinkedIn posts. Filter with ?status=draft|approved|published|rejected.
router.get('/linkedin/content-queue', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.status) { params.push(req.query.status); where = 'WHERE status=$1'; }
    const rows = (await query(
      `SELECT * FROM linkedin_content_queue ${where} ORDER BY scheduled_for DESC, created_at DESC`,
      params
    )).rows;
    res.json({ count: rows.length, queue: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Approve / reject / edit a draft. Body: { action: 'approve'|'reject'|'edit', ...fields, notes? }
router.put('/linkedin/content-queue/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const action = (req.body?.action || '').toLowerCase();
    const row = (await query(`SELECT * FROM linkedin_content_queue WHERE id=$1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'post not found' });

    if (action === 'approve') {
      if (row.status !== 'draft') return res.status(409).json({ error: `already ${row.status}` });
      await query(
        `UPDATE linkedin_content_queue SET status='approved', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2`,
        [req.user.id, req.params.id]
      );
      // Auto-publish to LinkedIn on approve (Part 2 step 7). On skip/error the
      // row stays at 'approved' and can be retried via POST /linkedin/publish/:id.
      const approved = (await query(`SELECT * FROM linkedin_content_queue WHERE id=$1`, [req.params.id])).rows[0];
      const pub = await publishLinkedInPost(approved);
      if (pub && pub.success) {
        await query(
          `UPDATE linkedin_content_queue SET status='published', published_at=NOW(), linkedin_post_id=$1 WHERE id=$2`,
          [pub.post_id || null, req.params.id]
        );
      }
    } else if (action === 'reject') {
      await query(
        `UPDATE linkedin_content_queue SET status='rejected', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2`,
        [req.user.id, req.params.id]
      );
    } else if (action === 'edit') {
      const fields = ['headline', 'body', 'hashtags', 'full_post', 'scheduled_for'];
      const sets = [], vals = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) { vals.push(req.body[f]); sets.push(`${f}=$${vals.length}`); }
      }
      if (!sets.length) return res.status(400).json({ error: 'no editable fields provided' });
      vals.push(req.params.id);
      await query(`UPDATE linkedin_content_queue SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    } else {
      return res.status(400).json({ error: "action must be 'approve', 'reject', or 'edit'" });
    }
    const updated = (await query(`SELECT * FROM linkedin_content_queue WHERE id=$1`, [req.params.id])).rows[0];
    res.json({ success: true, post: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Publish an approved post to LinkedIn via the UGC API.
router.post('/linkedin/publish/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const row = (await query(`SELECT * FROM linkedin_content_queue WHERE id=$1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'post not found' });
    if (row.status !== 'approved') return res.status(409).json({ error: `post is ${row.status}; must be 'approved' to publish` });

    const result = await publishLinkedInPost(row);
    if (result.skipped) return res.status(503).json({ error: result.reason });
    if (result.error) return res.status(502).json({ error: result.error });

    await query(
      `UPDATE linkedin_content_queue
         SET status='published', published_at=NOW(), linkedin_post_id=$1
       WHERE id=$2`,
      [result.post_id || null, req.params.id]
    );
    res.json({ success: true, id: req.params.id, linkedin_post_id: result.post_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manually trigger the weekly LinkedIn campaign — Steps 1-6 of the Monday flow.
router.post('/linkedin/run-campaign', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await runWeeklyLinkedInCampaign({ dryRun: !!req.body?.dryRun });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// /generate-weekly — calls runWeeklyLinkedInCampaign directly (Steps 1-6 of
// the Monday flow). Sits alongside /run-campaign so external integrations can
// hit either route.
router.post('/linkedin/generate-weekly', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await runWeeklyLinkedInCampaign({ dryRun: !!req.body?.dryRun });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PubChem 2D structure URL for a CAS number or chemical name — no external
// API key required (PubChem PUG REST is public). Intelligence-tier read.
router.post('/linkedin/get-structure/:cas_number', authMiddleware, requireTier('intelligence'), async (req, res) => {
  const url = getMoleculeStructureImage(req.params.cas_number);
  if (!url) return res.status(400).json({ error: 'cas_number is required' });
  res.json({ cas_number: req.params.cas_number, structure_image_url: url });
});

// Regenerate the DALL-E background image for a queued post. Admin-only because
// it costs ~$0.04 per call against the OpenAI account.
router.post('/linkedin/regenerate-image/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const row = (await query(`SELECT * FROM linkedin_content_queue WHERE id=$1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'post not found' });
    const result = await generatePostImage(row.source_molecule, row.post_type);
    if (result.skipped) return res.status(503).json({ error: result.reason });
    if (result.error) return res.status(502).json({ error: result.error });
    await query(
      `UPDATE linkedin_content_queue SET generated_image_url=$1, linkedin_image_asset_urn=$2 WHERE id=$3`,
      [result.url, result.asset_urn || null, req.params.id]
    );
    res.json({ success: true, id: req.params.id, generated_image_url: result.url, linkedin_image_asset_urn: result.asset_urn || null, prompt: result.prompt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Combined demand intelligence — market analysis + GSC + Algolia, deduped and
// catalog-enriched. Powers the demand panel on the LinkedIn Content page.
router.get('/linkedin/demand-molecules', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const demand = await getCombinedDemandMolecules();
    const enriched = await enrichWithCatalog(demand);
    res.json({ count: enriched.length, molecules: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Engagement totals + per-post breakdown for the published feed.
router.get('/linkedin/analytics', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const totals = (await query(`
      SELECT COUNT(*) FILTER (WHERE status='published')::int posts_published,
             COUNT(*) FILTER (WHERE status='draft')::int drafts,
             COUNT(*) FILTER (WHERE status='approved')::int approved,
             COALESCE(SUM(engagement_clicks),0)::int total_clicks,
             COALESCE(SUM(engagement_likes),0)::int total_likes,
             COALESCE(SUM(engagement_comments),0)::int total_comments
      FROM linkedin_content_queue
    `)).rows[0];
    const recent = (await query(`
      SELECT id, post_type, headline, scheduled_for, published_at,
             engagement_clicks, engagement_likes, engagement_comments, linkedin_post_id
      FROM linkedin_content_queue WHERE status='published'
      ORDER BY published_at DESC NULLS LAST LIMIT 30
    `)).rows;
    res.json({ totals, recent });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
