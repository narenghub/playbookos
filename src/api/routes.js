const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { signToken, authMiddleware, adminOnly, requireTier, syncGitHubForUser, analyzeTeamProgress, runClaudeAnalysis } = require('../lib/core');
const { query } = require('../lib/db');
const { sendEmail } = require('../lib/mailer');
const { checkMilestoneTriggers } = require('../lib/jobs');
const { cascadeGoals, assignWeeklyKPIs, assignWeeklyKPIsForAll, mondayOf } = require('../lib/agents/goal-engine');
const { getWarmLeads, generateOutreachRecommendations } = require('../lib/agents/customer-agent');
const { takeMetricsSnapshot } = require('../lib/agents/metrics-snapshot');
const { getAllRoles, isBuiltIn, getRolePages } = require('../lib/roles');
const { identifyContentGaps, trackAlgoliaNoResults, trackKeywordRankings } = require('../lib/agents/seo-agent');
const { syncAlgoliaSearchData, generateSEORecommendations } = require('../lib/agents/growth-agent');
const { getKPIHierarchy, getBottlenecks, getCrossTeamDependencies, calculateKPIScore } = require('../lib/kpi-engine');
const { runMorningBriefing } = require('../lib/agents/orchestrator');
const { generateProductPost, generateMarketIntelligencePost, generateCompanyUpdate, runWeeklyLinkedInCampaign, scheduleLinkedInContent, getCombinedDemandMolecules, enrichWithCatalog, publishPost: publishLinkedInPost } = require('../lib/agents/linkedin-agent');
const { syncPlaybookOSSkus, syncAbiozenProducts } = require('../lib/algolia-sync');

const router = express.Router();

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
    res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role, github_username: user.github_username } });
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
    const result = await query('SELECT id,name,email,role,github_username FROM users WHERE id=$1', [req.user.id]);
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
    const { email, role, github_username } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'Email and role required' });
    const catalog = await getAllRoles();
    if (!catalog[role]) {
      return res.status(400).json({ error: `Unknown role "${role}". Valid roles: ${Object.keys(catalog).join(', ')}` });
    }
    const existing = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(400).json({ error: 'User already exists' });
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID();
    await query('INSERT INTO users (id,email,name,role,github_username,invite_token,invited_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, email.toLowerCase(), email.split('@')[0], role, github_username || null, inviteToken, new Date().toISOString()]);
    const baseUrl = process.env.BASE_URL || 'https://playbookos-production.up.railway.app';
    const inviteUrl = `${baseUrl}/#/accept-invite?token=${inviteToken}`;
    sendEmail({ to: email, subject: `You've been invited to Abiozen PlaybookOS`, triggerType: 'invite',
      html: `<div style="font-family:Arial;max-width:600px"><h2 style="color:#1B3A6B">Abiozen PlaybookOS</h2><p>You've been invited as <strong>${role}</strong>.</p><a href="${inviteUrl}" style="background:#0D7377;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">Accept Invite</a><p style="color:#666;font-size:13px">Or copy: ${inviteUrl}</p></div>` });
    res.json({ success: true, message: `Invite sent to ${email}`, inviteUrl });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/users/profile', authMiddleware, async (req, res) => {
  try {
    const { github_username, name, user_id } = req.body;
    const targetId = (req.user.role === 'admin' && user_id) ? user_id : req.user.id;
    await query('UPDATE users SET github_username=COALESCE($1,github_username), name=COALESCE($2,name) WHERE id=$3', [github_username || null, name || null, targetId]);
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
      `SELECT * FROM weekly_kpis WHERE user_id=$1 AND week_start=$2 ORDER BY kpi_name`,
      [req.user.id, weekStart]
    )).rows;
    // If no KPIs exist yet for this week, assign them on demand from the cascade
    if (kpis.length === 0) {
      const assigned = await assignWeeklyKPIs(req.user.id, weekStart);
      if (!assigned.skipped) {
        kpis = (await query(
          `SELECT * FROM weekly_kpis WHERE user_id=$1 AND week_start=$2 ORDER BY kpi_name`,
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
      `SELECT k.*, u.name, u.role
       FROM weekly_kpis k JOIN users u ON u.id = k.user_id
       WHERE k.week_start=$1
       ORDER BY u.role, u.name, k.kpi_name`,
      [weekStart]
    )).rows;
    res.json({ week_start: weekStart, kpis: rows });
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

router.get('/performance/my', authMiddleware, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = (await query(
      `SELECT p.*, u.name, u.role
       FROM performance_scores p
       JOIN users u ON u.id = p.user_id
       WHERE p.user_id=$1 AND p.score_date >= $2
       ORDER BY p.score_date DESC`,
      [req.user.id, thirtyDaysAgo]
    )).rows;
    res.json(rows.map(formatScoreRow));
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
router.post('/market/analyze', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const crypto = require('crypto');
    const prompt = `You are a pharmaceutical market intelligence analyst for Abiozen LLC, a US-based API distribution company. Analyze the current US pharmaceutical market and identify the TOP 20 fast-moving molecules. Focus on: GLP-1 peptides (Semaglutide, Tirzepatide), hormone therapy APIs, shortage list molecules, high-demand research chemicals, and generic APIs with growing demand. For each molecule return ONLY a JSON array: [{"name":"","cas":"","category":"","demand":"Critical/High/Medium","monthly_demand_kg":0,"buyer_segment":"","price_min":0,"price_max":0,"priority":0,"reason":""}]`;
    const key = process.env.ANTHROPIC_API_KEY;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    let molecules = [];
    try { const m = text.match(/\[[\s\S]*\]/); if (m) molecules = JSON.parse(m[0]); } catch(e) {}
    const analysisId = crypto.randomUUID();
    await query(`INSERT INTO ai_analyses (id,analysis_type,period_key,content) VALUES ($1,'market_intelligence',$2,$3)`,
      [analysisId, new Date().toISOString().slice(0,10), JSON.stringify(molecules)]);
    const procTeam = (await query(`SELECT * FROM users WHERE role='procurement' AND is_active=1`)).rows;
    if (procTeam.length > 0) {
      const { sendEmail } = require('../lib/mailer');
      const rows = molecules.slice(0,20).map((m,i) => `<tr style="background:${i%2===0?'#f8fafc':'#fff'}"><td style="padding:8px;border:1px solid #e2e8f0">${i+1}</td><td style="padding:8px;border:1px solid #e2e8f0"><strong>${m.name}</strong></td><td style="padding:8px;border:1px solid #e2e8f0">${m.cas||'—'}</td><td style="padding:8px;border:1px solid #e2e8f0">${m.category}</td><td style="padding:8px;border:1px solid #e2e8f0;color:${m.demand==='Critical'?'#dc2626':m.demand==='High'?'#d97706':'#059669'}">${m.demand}</td><td style="padding:8px;border:1px solid #e2e8f0">$${m.price_min}-$${m.price_max}/kg</td><td style="padding:8px;border:1px solid #e2e8f0;font-weight:700;color:#1B3A6B">${m.priority}/100</td></tr>`).join('');
      for (const member of procTeam) {
        sendEmail({ to: member.email, subject: `🎯 This Week Top 20 Fast-Moving Molecules — Source These First`, html: `<div style="font-family:Arial;max-width:700px"><div style="background:#1B3A6B;padding:20px;border-radius:8px 8px 0 0"><h2 style="color:#fff;margin:0">Abiozen Market Intelligence</h2><p style="color:#9FE1CB;margin:4px 0 0">Weekly procurement list — ${new Date().toLocaleDateString()}</p></div><div style="padding:20px;border:1px solid #e2e8f0"><p>Hi ${member.name}, source suppliers for these molecules this week — sorted by priority.</p><table style="width:100%;border-collapse:collapse;font-size:12px"><tr style="background:#1B3A6B;color:#fff"><th style="padding:8px">Rank</th><th>Molecule</th><th>CAS</th><th>Category</th><th>Demand</th><th>Price Range</th><th>Priority</th></tr>${rows}</table><div style="margin-top:16px;padding:12px;background:#0D7377;border-radius:6px;color:#fff;font-size:13px"><strong>Action:</strong> Source top 10 by Friday. Upload COAs to PlaybookOS SKU Economics.</div></div></div>` });
      }
    }
    res.json({ success: true, molecules, assigned_to: procTeam.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/market/latest', authMiddleware, requireTier('procurement'), async (req, res) => {
  try {
    const result = await query(`SELECT * FROM ai_analyses WHERE analysis_type='market_intelligence' ORDER BY created_at DESC LIMIT 1`);
    if (!result.rows[0]) return res.json({ molecules: [] });
    res.json({ molecules: JSON.parse(result.rows[0].content), created_at: result.rows[0].created_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const tasks = (await query(
      `SELECT * FROM daily_tasks WHERE user_id=$1 AND task_date=$2
       ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, created_at`,
      [req.user.id, date]
    )).rows;
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
    const task = (await query(`SELECT * FROM daily_tasks WHERE id=$1`, [req.params.id])).rows[0];
    if (!task) return res.status(404).json({ error: 'task not found' });
    const isAdmin = ['super_admin', 'admin'].includes(req.user.role);
    if (task.user_id !== req.user.id && !isAdmin) {
      return res.status(403).json({ error: 'not your task' });
    }
    await query(`UPDATE daily_tasks SET status=$1 WHERE id=$2`, [status, req.params.id]);
    res.json({ success: true, id: req.params.id, status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// All team tasks for a date (admin).
router.get('/agent/tasks/team', authMiddleware, adminOnly, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
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
    const today = new Date().toISOString().slice(0, 10);
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

// Alias — calls scheduleLinkedInContent (back-compat name for the same flow)
// so external integrations can hit either /run-campaign or /generate-weekly.
router.post('/linkedin/generate-weekly', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await scheduleLinkedInContent({ dryRun: !!req.body?.dryRun });
    res.json(result);
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
