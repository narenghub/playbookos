const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { signToken, authMiddleware, adminOnly, syncGitHubForUser, analyzeTeamProgress, runClaudeAnalysis } = require('../lib/core');
const { query } = require('../lib/db');
const { sendEmail } = require('../lib/mailer');

const router = express.Router();

router.post('/auth/login', async (req, res) => {
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

router.post('/auth/accept-invite', async (req, res) => {
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

router.put('/users/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (req.user.id !== id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { github_username, name } = req.body;
    await query('UPDATE users SET github_username=COALESCE($1,github_username), name=COALESCE($2,name) WHERE id=$3', [github_username || null, name || null, id]);
    res.json({ success: true });
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

router.post('/orders', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { order_date, amount, buyer_type, product_category, notes } = req.body;
    if (!order_date || !amount) return res.status(400).json({ error: 'order_date and amount required' });
    const id = crypto.randomUUID();
    await query('INSERT INTO orders (id,order_date,amount,buyer_type,product_category,notes) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, order_date, amount, buyer_type || null, product_category || null, notes || null]);
    res.json({ success: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/orders', authMiddleware, async (req, res) => {
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

router.post('/github/sync', authMiddleware, async (req, res) => {
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

router.post('/ai/analyze', authMiddleware, adminOnly, async (req, res) => {
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

router.get('/ai/latest', authMiddleware, async (req, res) => {
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
    const yearRev = parseFloat((await query(`SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date LIKE '2026%'`)).rows[0].v);
    const triggered = [];
    if (yearRev >= 100000) {
      const ms = (await query(`SELECT * FROM milestones WHERE name LIKE '%Account Manager%'`)).rows[0];
      if (ms && ms.status === 'pending') {
        await query(`UPDATE milestones SET status='in_progress' WHERE id=$1`, [ms.id]);
        const admin = (await query(`SELECT * FROM users WHERE role='admin' LIMIT 1`)).rows[0];
        if (admin) await sendEmail({ to: admin.email, triggerType: 'milestone_trigger', subject: 'Trigger: $100K revenue — Hire Account Manager now', html: `<div style="font-family:Arial;padding:24px"><h2>Milestone Trigger</h2><p>Revenue: $${yearRev.toLocaleString()}</p><p>Action: Begin account manager hiring immediately.</p></div>` });
        triggered.push('$100K milestone triggered');
      }
    }
    res.json({ yearRev, triggered, checked: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

router.get('/decision-rules', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT * FROM decision_rules ORDER BY created_at');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/decision-rules/evaluate', authMiddleware, adminOnly, async (req, res) => {
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

router.get('/skus', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT * FROM skus WHERE is_active=1 ORDER BY revenue_total DESC');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/skus', authMiddleware, adminOnly, async (req, res) => {
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

router.get('/execution-steps', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT * FROM execution_steps ORDER BY step_order');
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/execution-steps/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { completion_pct, status } = req.body;
    await query(`UPDATE execution_steps SET completion_pct=COALESCE($1,completion_pct), status=COALESCE($2,status), updated_at=$3 WHERE id=$4`,
      [completion_pct, status||null, new Date().toISOString(), req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/integrations', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT * FROM integrations ORDER BY status DESC, name');
    res.json(result.rows);
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
router.post('/market/analyze', authMiddleware, adminOnly, async (req, res) => {
  try {
    const crypto = require('crypto');
    const prompt = `You are a pharmaceutical market intelligence analyst for Abiozen LLC, a US-based API distribution company. Analyze the current US pharmaceutical market and identify the TOP 20 fast-moving molecules. Focus on: GLP-1 peptides (Semaglutide, Tirzepatide), hormone therapy APIs, shortage list molecules, high-demand research chemicals, and generic APIs with growing demand. For each molecule return ONLY a JSON array: [{"name":"","cas":"","category":"","demand":"Critical/High/Medium","monthly_demand_kg":0,"buyer_segment":"","price_min":0,"price_max":0,"priority":0,"reason":""}]`;
    const key = process.env.ANTHROPIC_API_KEY;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] })
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

router.get('/market/latest', authMiddleware, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM ai_analyses WHERE analysis_type='market_intelligence' ORDER BY created_at DESC LIMIT 1`);
    if (!result.rows[0]) return res.json({ molecules: [] });
    res.json({ molecules: JSON.parse(result.rows[0].content), created_at: result.rows[0].created_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ENTERPRISE SKU BULK UPLOAD — E-commerce format
// ============================================================
router.post('/skus/bulk-upload', authMiddleware, adminOnly, async (req, res) => {
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

router.get('/skus/export', authMiddleware, async (req, res) => {
  try {
    const result = await query(`SELECT name as product_name, cas_number, purity, supplier, currency, sale_price as supplier_1kg_price, sds_link, sds_status, coa_link, coa_status, gross_margin, is_gmp, units_in_stock FROM skus WHERE is_active=1 ORDER BY revenue_total DESC`);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Apollo find buyers
router.post('/apollo/find-buyers', authMiddleware, adminOnly, async (req, res) => {
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

router.post('/apollo/send-outreach', authMiddleware, adminOnly, async (req, res) => {
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

router.get('/apollo/sequences', authMiddleware, adminOnly, async (req, res) => {
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

router.get('/apollo/stats', authMiddleware, adminOnly, async (req, res) => {
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
    const stats = sequences.map(s => ({
      id: s.id,
      name: s.name,
      status: s.active ? 'active' : (s.archived ? 'archived' : 'draft'),
      contacts: s.num_contacts_email_status_extrapolated || 0,
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

router.get('/apollo/debug', authMiddleware, adminOnly, async (req, res) => {
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
