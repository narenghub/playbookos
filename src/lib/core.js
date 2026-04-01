// src/lib/core.js — shared utilities
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');

// ── Database ─────────────────────────────────────────────────────────────────
let _db;
function getDb() {
  if (!_db) {
    _db = new Database(path.join(__dirname, '../../playbookos.db'));
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, 'abiozen2026playbookos10millionrevenuenaresh', { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, 'abiozen2026playbookos10millionrevenuenaresh'); }
  catch { return null; }
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  req.user = payload;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Email ────────────────────────────────────────────────────────────────────
function getMailer() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendEmail({ to, subject, html, triggerType }) {
  try {
    const mailer = getMailer();
    await mailer.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
    const db = getDb();
    db.prepare(`INSERT INTO email_log (id,to_email,subject,trigger_type) VALUES (?,?,?,?)`)
      .run(crypto.randomUUID(), to, subject, triggerType || null);
    return true;
  } catch (e) {
    console.error('Email error:', e.message);
    return false;
  }
}

// ── GitHub ────────────────────────────────────────────────────────────────────
async function fetchGitHubStats(username, dateStr) {
  const token = process.env.GITHUB_TOKEN;
  if (!token || token.includes('REPLACE')) return null;

  const since = new Date(dateStr + 'T00:00:00Z').toISOString();
  const until = new Date(dateStr + 'T23:59:59Z').toISOString();

  try {
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'PlaybookOS' };

    // Search commits by author on the given date
    const commitRes = await fetch(
      `https://api.github.com/search/commits?q=author:${username}+author-date:${dateStr}&per_page=100`,
      { headers: { ...headers, Accept: 'application/vnd.github.cloak-preview+json' } }
    );
    const commitData = await commitRes.json();
    const commits = commitData.total_count || 0;

    // Search PRs
    const prRes = await fetch(
      `https://api.github.com/search/issues?q=author:${username}+type:pr+created:${dateStr}&per_page=100`,
      { headers }
    );
    const prData = await prRes.json();
    const prsOpened = prData.total_count || 0;

    const mergedRes = await fetch(
      `https://api.github.com/search/issues?q=author:${username}+type:pr+merged:${dateStr}&per_page=100`,
      { headers }
    );
    const mergedData = await mergedRes.json();
    const prsMerged = mergedData.total_count || 0;

    return { commits, prs_opened: prsOpened, prs_merged: prsMerged, lines_added: 0, lines_removed: 0 };
  } catch (e) {
    console.error('GitHub fetch error:', e.message);
    return null;
  }
}

async function syncGitHubForUser(user, dateStr) {
  if (!user.github_username) return;
  const stats = await fetchGitHubStats(user.github_username, dateStr);
  if (!stats) return;

  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO github_stats (id, github_username, stat_date, commits, prs_opened, prs_merged, lines_added, lines_removed, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(crypto.randomUUID(), user.github_username, dateStr, stats.commits, stats.prs_opened, stats.prs_merged, stats.lines_added, stats.lines_removed);

  // Also write to activity_logs
  const existing = db.prepare(`SELECT id FROM activity_logs WHERE user_id=? AND log_date=? AND metric='prs_merged' AND source='github'`).get(user.id, dateStr);
  if (!existing) {
    db.prepare(`INSERT INTO activity_logs (id,user_id,log_date,metric,value,source) VALUES (?,?,?,'prs_merged',?,'github')`)
      .run(crypto.randomUUID(), user.id, dateStr, stats.prs_merged);
    db.prepare(`INSERT INTO activity_logs (id,user_id,log_date,metric,value,source) VALUES (?,?,?,'commits',?,'github')`)
      .run(crypto.randomUUID(), user.id, dateStr, stats.commits);
  }
}

// ── Claude AI analysis ────────────────────────────────────────────────────────
async function runClaudeAnalysis(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes('REPLACE')) return 'Claude API key not configured. Add ANTHROPIC_API_KEY to .env file.';

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text || 'No response from Claude.';
  } catch (e) {
    return 'Claude API error: ' + e.message;
  }
}

async function analyzeTeamProgress(context) {
  const { period, revenue, revenueTarget, teamActivity, behindMetrics } = context;
  const prompt = `You are the AI advisor for Abiozen LLC, a life sciences API distribution company targeting $10M revenue by December 2026.

Current period: ${period}
Revenue achieved: $${(revenue || 0).toLocaleString()} vs target $${(revenueTarget || 0).toLocaleString()} (${revenueTarget > 0 ? Math.round((revenue / revenueTarget) * 100) : 0}% of target)

Team activity this week:
${teamActivity}

Metrics behind target: ${behindMetrics || 'none identified'}

In 3-4 sentences, give a direct, specific assessment of:
1. Whether the team is on track to hit the annual $10M target
2. The single most critical action needed this week
3. One specific risk to address

Be concrete and action-oriented. No generic advice.`;

  return runClaudeAnalysis(prompt);
}

// ── Target helpers ────────────────────────────────────────────────────────────
function getRevenueSummary(periodKey) {
  const db = getDb();
  const total = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM orders WHERE order_date LIKE ?`).get(periodKey + '%');
  return total.total;
}

function getTarget(periodType, periodKey, metric) {
  const db = getDb();
  const t = db.prepare(`SELECT target_value FROM targets WHERE period_type=? AND period_key=? AND metric=? AND user_id IS NULL`).get(periodType, periodKey, metric);
  return t ? t.target_value : null;
}

function getUserActivities(userId, dateFrom, dateTo) {
  const db = getDb();
  return db.prepare(`SELECT * FROM activity_logs WHERE user_id=? AND log_date BETWEEN ? AND ? ORDER BY log_date DESC`).all(userId, dateFrom, dateTo);
}

module.exports = {
  getDb, signToken, verifyToken, authMiddleware, adminOnly,
  sendEmail, fetchGitHubStats, syncGitHubForUser,
  runClaudeAnalysis, analyzeTeamProgress,
  getRevenueSummary, getTarget, getUserActivities, crypto
};
