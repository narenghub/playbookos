const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { query } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'abiozen2026playbookos10millionrevenuenaresh';

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
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

async function sendEmail({ to, subject, html, triggerType }) {
  try {
    const key = process.env.RESEND_API_KEY;
    if (!key || key.includes('REPLACE')) { console.log('Email skipped - no key'); return false; }
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'PlaybookOS <onboarding@resend.dev>', to, subject, html })
    });
    return true;
  } catch(e) { console.error('Email error:', e.message); return false; }
}

async function fetchGitHubStats(username, dateStr) {
  const token = process.env.GITHUB_TOKEN;
  if (!token || token.includes('REPLACE')) return null;
  try {
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'PlaybookOS' };
    const commitRes = await fetch(`https://api.github.com/search/commits?q=author:${username}+author-date:${dateStr}&per_page=100`, { headers: { ...headers, Accept: 'application/vnd.github.cloak-preview+json' } });
    const commitData = await commitRes.json();
    const prRes = await fetch(`https://api.github.com/search/issues?q=author:${username}+type:pr+created:${dateStr}&per_page=100`, { headers });
    const prData = await prRes.json();
    const mergedRes = await fetch(`https://api.github.com/search/issues?q=author:${username}+type:pr+merged:${dateStr}&per_page=100`, { headers });
    const mergedData = await mergedRes.json();
    return { commits: commitData.total_count || 0, prs_opened: prData.total_count || 0, prs_merged: mergedData.total_count || 0 };
  } catch(e) { console.error('GitHub error:', e.message); return null; }
}

async function syncGitHubForUser(user, dateStr) {
  if (!user.github_username) return;
  const stats = await fetchGitHubStats(user.github_username, dateStr);
  if (!stats) return;
  try {
    await query(`INSERT INTO github_stats (id,github_username,stat_date,commits,prs_opened,prs_merged) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (github_username,stat_date) DO UPDATE SET commits=$4,prs_opened=$5,prs_merged=$6`,
      [crypto.randomUUID(), user.github_username, dateStr, stats.commits, stats.prs_opened, stats.prs_merged]);
  } catch(e) { console.error('Sync error:', e.message); }
}

async function runClaudeAnalysis(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes('REPLACE')) return 'Claude API key not configured.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    return data.content?.[0]?.text || 'No response from Claude.';
  } catch(e) { return 'Claude API error: ' + e.message; }
}

async function analyzeTeamProgress({ period, revenue, revenueTarget, teamActivity, behindMetrics }) {
  const prompt = `You are the AI advisor for Abiozen LLC, a life sciences API distribution company targeting $10M revenue by December 2026.

Current period: ${period}
Revenue achieved: $${(revenue || 0).toLocaleString()} vs target $${(revenueTarget || 0).toLocaleString()} (${revenueTarget > 0 ? Math.round((revenue / revenueTarget) * 100) : 0}% of target)

Team activity this week:
${teamActivity}

Metrics behind target: ${behindMetrics || 'none identified'}

In 3-4 sentences, give a direct assessment of: 1) Whether on track for $10M, 2) The single most critical action needed, 3) One specific risk to address. Be concrete and action-oriented.`;
  return runClaudeAnalysis(prompt);
}

module.exports = { signToken, verifyToken, authMiddleware, adminOnly, sendEmail, fetchGitHubStats, syncGitHubForUser, runClaudeAnalysis, analyzeTeamProgress, crypto };
