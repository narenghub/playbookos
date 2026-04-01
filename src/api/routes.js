// src/api/routes.js — all REST endpoints
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb, signToken, authMiddleware, adminOnly, sendEmail, syncGitHubForUser,
        analyzeTeamProgress, getRevenueSummary, getTarget, getUserActivities, runClaudeAnalysis } = require('../lib/core');

const router = express.Router();

// ── AUTH ──────────────────────────────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email.toLowerCase().trim());
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role, github_username: user.github_username } });
});

router.post('/auth/accept-invite', (req, res) => {
  const { token, password, name } = req.body;
  if (!token || !password || !name) return res.status(400).json({ error: 'Token, name, and password required' });
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE invite_token=?').get(token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired invite token' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash=?, name=?, invite_token=NULL, joined_at=datetime("now") WHERE id=?').run(hash, name, user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  res.json({ token: signToken(updated), user: { id: updated.id, name: updated.name, email: updated.email, role: updated.role } });
});

router.get('/auth/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id,name,email,role,github_username FROM users WHERE id=?').get(req.user.id);
  res.json(user);
});

// ── USERS / TEAM ──────────────────────────────────────────────────────────────
router.get('/users', authMiddleware, (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id,name,email,role,github_username,joined_at,is_active FROM users ORDER BY role,name').all();
  res.json(users);
});

router.post('/users/invite', authMiddleware, adminOnly, async (req, res) => {
  const { email, role, github_username } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'Email and role required' });
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
  if (existing) return res.status(400).json({ error: 'User already exists' });

  const inviteToken = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id,email,name,role,github_username,invite_token,invited_at) VALUES (?,?,?,?,?,?,datetime("now"))')
    .run(id, email.toLowerCase(), email.split('@')[0], role, github_username || null, inviteToken);

  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const inviteUrl = `${baseUrl}/#/accept-invite?token=${inviteToken}`;

  await sendEmail({
    to: email,
    subject: `You've been invited to Abiozen PlaybookOS`,
    triggerType: 'invite',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#1B3A6B;padding:24px;border-radius:8px 8px 0 0">
          <h1 style="color:#fff;margin:0;font-size:22px">Abiozen PlaybookOS</h1>
          <p style="color:#9FE1CB;margin:4px 0 0">Team Performance Platform</p>
        </div>
        <div style="padding:24px;border:1px solid #eee;border-radius:0 0 8px 8px">
          <p style="font-size:16px">You've been invited to join Abiozen's PlaybookOS as <strong>${role}</strong>.</p>
          <p>Click below to set your password and access your personal dashboard:</p>
          <a href="${inviteUrl}" style="display:inline-block;background:#0D7377;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin:16px 0">Accept Invite & Set Password</a>
          <p style="color:#666;font-size:13px">Or copy this link: ${inviteUrl}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="color:#888;font-size:12px">Abiozen LLC · 1333 Barclay Blvd, Buffalo Grove, IL 60089</p>
        </div>
      </div>
    `
  });

  res.json({ success: true, message: `Invite sent to ${email}` });
});

router.put('/users/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  if (req.user.id !== id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const { github_username, name } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET github_username=COALESCE(?,github_username), name=COALESCE(?,name) WHERE id=?')
    .run(github_username || null, name || null, id);
  res.json({ success: true });
});

// ── ACTIVITY LOGS ─────────────────────────────────────────────────────────────
router.post('/activity', authMiddleware, (req, res) => {
  const { log_date, metric, value, notes } = req.body;
  if (!log_date || !metric || value === undefined) return res.status(400).json({ error: 'log_date, metric, value required' });
  const db = getDb();
  // Upsert: replace existing manual entry for same user/date/metric
  const existing = db.prepare(`SELECT id FROM activity_logs WHERE user_id=? AND log_date=? AND metric=? AND source='manual'`).get(req.user.id, log_date, metric);
  if (existing) {
    db.prepare(`UPDATE activity_logs SET value=?, notes=? WHERE id=?`).run(value, notes || null, existing.id);
  } else {
    db.prepare(`INSERT INTO activity_logs (id,user_id,log_date,metric,value,notes,source) VALUES (?,?,?,?,?,?,'manual')`)
      .run(crypto.randomUUID(), req.user.id, log_date, metric, value, notes || null);
  }
  res.json({ success: true });
});

router.get('/activity/my', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const dateFrom = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const dateTo = to || new Date().toISOString().slice(0, 10);
  const activities = getUserActivities(req.user.id, dateFrom, dateTo);
  res.json(activities);
});

router.get('/activity/team', authMiddleware, adminOnly, (req, res) => {
  const { from, to, user_id } = req.query;
  const dateFrom = from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const dateTo = to || new Date().toISOString().slice(0, 10);
  const db = getDb();
  const where = user_id ? 'AND a.user_id=?' : '';
  const args = user_id ? [dateFrom, dateTo, user_id] : [dateFrom, dateTo];
  const rows = db.prepare(`
    SELECT a.*, u.name, u.role, u.email FROM activity_logs a
    JOIN users u ON u.id=a.user_id
    WHERE a.log_date BETWEEN ? AND ? ${where}
    ORDER BY a.log_date DESC, u.role
  `).all(...args);
  res.json(rows);
});

// ── ORDERS / REVENUE ──────────────────────────────────────────────────────────
router.post('/orders', authMiddleware, adminOnly, (req, res) => {
  const { order_date, amount, buyer_type, product_category, notes } = req.body;
  if (!order_date || !amount) return res.status(400).json({ error: 'order_date and amount required' });
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO orders (id,order_date,amount,buyer_type,product_category,notes) VALUES (?,?,?,?,?,?)')
    .run(id, order_date, amount, buyer_type || null, product_category || null, notes || null);
  res.json({ success: true, id });
});

router.get('/orders', authMiddleware, (req, res) => {
  const { from, to } = req.query;
  const db = getDb();
  let query = 'SELECT * FROM orders';
  const args = [];
  if (from && to) { query += ' WHERE order_date BETWEEN ? AND ?'; args.push(from, to); }
  query += ' ORDER BY order_date DESC LIMIT 200';
  res.json(db.prepare(query).all(...args));
});

// ── DASHBOARD DATA ────────────────────────────────────────────────────────────
router.get('/dashboard/summary', authMiddleware, (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const thisYear = today.slice(0, 4);

  const monthRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date LIKE ?`).get(thisMonth + '%').v;
  const yearRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date LIKE ?`).get(thisYear + '%').v;
  const monthTarget = getTarget('monthly', thisMonth, 'revenue') || 0;
  const annualTarget = getTarget('annual', thisYear, 'revenue') || 10000000;

  const recentOrders = db.prepare(`SELECT * FROM orders ORDER BY order_date DESC LIMIT 5`).all();
  const teamActivity = db.prepare(`
    SELECT u.name, u.role, a.metric, SUM(a.value) as total
    FROM activity_logs a JOIN users u ON u.id=a.user_id
    WHERE a.log_date BETWEEN date('now','-7 days') AND date('now')
    GROUP BY u.id, a.metric ORDER BY u.role
  `).all();

  const milestones = db.prepare(`SELECT * FROM milestones ORDER BY target_date`).all();
  const githubStats = db.prepare(`
    SELECT g.*, u.name FROM github_stats g
    JOIN users u ON u.github_username=g.github_username
    WHERE g.stat_date BETWEEN date('now','-7 days') AND date('now')
    ORDER BY g.stat_date DESC
  `).all();

  // Pacing: if we stay on current run rate, will we hit $10M?
  const dayOfYear = Math.ceil((new Date() - new Date(thisYear + '-01-01')) / 86400000);
  const launchDay = Math.ceil((new Date() - new Date('2026-05-01')) / 86400000);
  const activeDays = Math.max(1, launchDay);
  const dailyRunRate = yearRevenue / activeDays;
  const remainingDays = Math.ceil((new Date('2026-12-31') - new Date()) / 86400000);
  const projectedTotal = yearRevenue + (dailyRunRate * remainingDays);

  res.json({
    revenue: { month: monthRevenue, year: yearRevenue, monthTarget, annualTarget, projectedTotal, dailyRunRate },
    recentOrders,
    teamActivity,
    milestones,
    githubStats,
    onTrack: projectedTotal >= annualTarget
  });
});

router.get('/dashboard/my', authMiddleware, (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const myActivity = db.prepare(`
    SELECT metric, SUM(value) as total, MAX(log_date) as last_logged
    FROM activity_logs WHERE user_id=? AND log_date BETWEEN ? AND ?
    GROUP BY metric
  `).all(req.user.id, weekAgo, today);

  const githubStats = db.prepare(`
    SELECT * FROM github_stats WHERE github_username=(
      SELECT github_username FROM users WHERE id=?
    ) AND stat_date BETWEEN ? AND ? ORDER BY stat_date DESC
  `).all(req.user.id, weekAgo, today);

  const myTargets = db.prepare(`SELECT * FROM targets WHERE user_id=?`).all(req.user.id);

  res.json({ activity: myActivity, github: githubStats, targets: myTargets });
});

// ── GITHUB SYNC ───────────────────────────────────────────────────────────────
router.post('/github/sync', authMiddleware, async (req, res) => {
  const db = getDb();
  const { date } = req.body;
  const syncDate = date || new Date().toISOString().slice(0, 10);

  // If admin: sync all devs. Otherwise: sync self only.
  let users;
  if (req.user.role === 'admin') {
    users = db.prepare(`SELECT * FROM users WHERE github_username IS NOT NULL AND is_active=1`).all();
  } else {
    users = db.prepare(`SELECT * FROM users WHERE id=? AND github_username IS NOT NULL`).all(req.user.id);
  }

  for (const u of users) {
    await syncGitHubForUser(u, syncDate);
  }
  res.json({ success: true, synced: users.length, date: syncDate });
});

// ── MILESTONES ────────────────────────────────────────────────────────────────
router.get('/milestones', authMiddleware, (req, res) => {
  res.json(getDb().prepare('SELECT * FROM milestones ORDER BY target_date').all());
});

router.put('/milestones/:id', authMiddleware, adminOnly, (req, res) => {
  const { status, actual_date } = req.body;
  getDb().prepare('UPDATE milestones SET status=COALESCE(?,status), actual_date=COALESCE(?,actual_date) WHERE id=?')
    .run(status || null, actual_date || null, req.params.id);
  res.json({ success: true });
});

// ── AI ANALYSIS ───────────────────────────────────────────────────────────────
router.post('/ai/analyze', authMiddleware, adminOnly, async (req, res) => {
  const db = getDb();
  const thisMonth = new Date().toISOString().slice(0, 7);
  const monthRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date LIKE ?`).get(thisMonth + '%').v;
  const monthTarget = getTarget('monthly', thisMonth, 'revenue') || 1200000;

  const teamRows = db.prepare(`
    SELECT u.name, u.role, a.metric, SUM(a.value) as total
    FROM activity_logs a JOIN users u ON u.id=a.user_id
    WHERE a.log_date BETWEEN date('now','-7 days') AND date('now')
    GROUP BY u.id, a.metric ORDER BY u.role
  `).all();

  const teamText = teamRows.map(r => `${r.name} (${r.role}): ${r.metric} = ${r.total}`).join('\n') || 'No activity logged this week.';

  const behind = [];
  if (monthRevenue < monthTarget * 0.8) behind.push(`Revenue ${Math.round((monthRevenue / monthTarget) * 100)}% of monthly target`);

  const analysis = await analyzeTeamProgress({
    period: thisMonth,
    revenue: monthRevenue,
    revenueTarget: monthTarget,
    teamActivity: teamText,
    behindMetrics: behind.join(', ')
  });

  // Cache
  db.prepare(`INSERT INTO ai_analyses (id,analysis_type,period_key,content) VALUES (?,?,?,?)`)
    .run(crypto.randomUUID(), 'weekly_review', thisMonth, analysis);

  res.json({ analysis, period: thisMonth, revenue: monthRevenue, target: monthTarget });
});

router.get('/ai/latest', authMiddleware, (req, res) => {
  const row = getDb().prepare(`SELECT * FROM ai_analyses ORDER BY created_at DESC LIMIT 1`).get();
  res.json(row || { content: 'No analysis yet. Click "Run AI Analysis" on the admin dashboard.' });
});

// ── TARGETS CRUD ──────────────────────────────────────────────────────────────
router.get('/targets', authMiddleware, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM targets ORDER BY period_type, period_key`).all();
  res.json(rows);
});

router.post('/targets', authMiddleware, adminOnly, (req, res) => {
  const { period_type, period_key, user_id, team, metric, target_value } = req.body;
  if (!period_type || !period_key || !metric || target_value === undefined) return res.status(400).json({ error: 'Missing fields' });
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM targets WHERE period_type=? AND period_key=? AND metric=? AND user_id IS ?`).get(period_type, period_key, metric, user_id || null);
  if (existing) {
    db.prepare(`UPDATE targets SET target_value=? WHERE id=?`).run(target_value, existing.id);
  } else {
    db.prepare(`INSERT INTO targets (id,period_type,period_key,user_id,team,metric,target_value) VALUES (?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), period_type, period_key, user_id || null, team || null, metric, target_value);
  }
  res.json({ success: true });
});

// ── EMAIL TRIGGERS ────────────────────────────────────────────────────────────
router.post('/triggers/check', authMiddleware, adminOnly, async (req, res) => {
  const db = getDb();
  const yearRevenue = db.prepare(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date LIKE '2026%'`).get().v;
  const triggered = [];

  // Trigger: $100K
  if (yearRevenue >= 100000) {
    const acctMgrHire = db.prepare(`SELECT * FROM milestones WHERE name LIKE '%Account Manager%'`).get();
    if (acctMgrHire && acctMgrHire.status === 'pending') {
      db.prepare(`UPDATE milestones SET status='in_progress' WHERE id=?`).run(acctMgrHire.id);
      const adminUser = db.prepare(`SELECT * FROM users WHERE role='admin' LIMIT 1`).get();
      if (adminUser) {
        await sendEmail({
          to: adminUser.email, triggerType: 'milestone_trigger',
          subject: '🎯 Trigger fired: $100K revenue reached — Hire Account Manager now',
          html: `<div style="font-family:Arial;padding:24px"><h2 style="color:#1B3A6B">Milestone Trigger Fired</h2><p>Abiozen has reached <strong>$${yearRevenue.toLocaleString()}</strong> in revenue — the $100K trigger threshold.</p><h3>Action required:</h3><ul><li>Begin account manager hiring immediately (30-day timeline)</li><li>Submit Chase Bank Loan 1 application ($175K)</li><li>Double Hyderabad inventory for top 30 SKUs</li></ul></div>`
        });
      }
      triggered.push('$100K milestone — Account Manager hire trigger fired');
    }
  }

  res.json({ yearRevenue, triggered, checked: true });
});

module.exports = router;
