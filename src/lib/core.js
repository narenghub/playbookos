const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('./db');
const { sendEmail } = require('./mailer');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

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
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const claudeText = data.content?.[0]?.text; console.error("Claude raw response:", JSON.stringify(data)); return claudeText || "Claude error: " + JSON.stringify(data?.error);
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

// ── Performance scoring ────────────────────────────────────────────────────

const ROLE_BASELINES = {
  dev: 8,
  procurement: 50,
  sales: 20,
  marketing: 5,
  qc: 10,
  admin: 3,
};

function sumActivity(map) {
  return Object.values(map).reduce((s, v) => s + (Number(v) || 0), 0);
}

function computeScoreForRole(role, activityMap, github) {
  const blockers = [];
  const activitySum = sumActivity(activityMap);
  const effort = role === 'dev'
    ? activitySum + (github.commits || 0) + (github.prsMerged || 0) * 5
    : activitySum;
  const baseline = ROLE_BASELINES[role] || ROLE_BASELINES.admin;

  // 70 at baseline, 100 at ~1.43x baseline, capped
  let score = Math.round((effort / baseline) * 70);
  if (score > 100) score = 100;
  if (score < 0) score = 0;

  if (effort === 0) blockers.push('No activity logged today');
  if (role === 'dev') {
    if ((github.commits || 0) === 0) blockers.push('Zero GitHub commits');
    if ((github.prsMerged || 0) === 0 && (github.prsOpened || 0) === 0) blockers.push('No PR activity');
  }
  if (effort > 0 && effort < baseline * 0.5) blockers.push(`Activity at ${Math.round((effort / baseline) * 100)}% of daily baseline`);

  return { score, blockers, effort, baseline };
}

async function getCoachingNote(user, metrics, blockers, score) {
  const firstName = user.name?.split(' ')[0] || 'team';
  const guidance = score >= 70
    ? 'reinforce one positive habit they showed today'
    : score >= 40
    ? 'suggest one concrete action for tomorrow'
    : 'ask what support they need';
  const prompt = `You are a supportive performance coach for ${firstName}, a ${user.role} at Abiozen LLC.

Their score today is ${score}/100.

Metrics:
${JSON.stringify(metrics, null, 2)}

Identified blockers:
${blockers.length ? blockers.join('; ') : 'none specific'}

Write EXACTLY 3 sentences:
- Sentence 1: acknowledge what they did today, referencing actual numbers.
- Sentence 2: ${guidance}.
- Sentence 3: one short word of encouragement to sign off.

No criticism. No bullet points. No headers. Plain prose. Return ONLY the 3 sentences.`;
  return runClaudeAnalysis(prompt);
}

async function scoreTeamMember(userId, date) {
  const userRow = (await query('SELECT id, name, email, role, github_username, is_active FROM users WHERE id=$1', [userId])).rows[0];
  if (!userRow || !userRow.is_active) return { skipped: true, reason: 'user inactive or not found', user_id: userId };

  const activityRows = (await query(
    'SELECT metric, SUM(value) as total FROM activity_logs WHERE user_id=$1 AND log_date=$2 GROUP BY metric',
    [userId, date]
  )).rows;
  const activityMap = Object.fromEntries(activityRows.map(a => [a.metric, parseFloat(a.total)]));

  const ghRow = userRow.github_username
    ? (await query('SELECT commits, prs_opened, prs_merged FROM github_stats WHERE github_username=$1 AND stat_date=$2', [userRow.github_username, date])).rows[0]
    : null;
  const github = {
    commits: ghRow ? parseInt(ghRow.commits) : 0,
    prsOpened: ghRow ? parseInt(ghRow.prs_opened) : 0,
    prsMerged: ghRow ? parseInt(ghRow.prs_merged) : 0,
  };

  const { score, blockers, effort, baseline } = computeScoreForRole(userRow.role, activityMap, github);
  const metrics = { activity: activityMap, github, effort, baseline };
  const note = await getCoachingNote(userRow, metrics, blockers, score);

  let escalated = false;
  if (score < 60) {
    const prev = (await query(
      `SELECT score_0_to_100 FROM performance_scores WHERE user_id=$1 AND score_date < $2 ORDER BY score_date DESC LIMIT 2`,
      [userId, date]
    )).rows;
    if (prev.length >= 2 && prev[0].score_0_to_100 < 60 && prev[1].score_0_to_100 < 60) {
      escalated = true;
      const admin = (await query("SELECT email FROM users WHERE role='admin' LIMIT 1")).rows[0];
      if (admin?.email) {
        await sendEmail({
          to: admin.email,
          subject: `Performance escalation: ${userRow.name} — 3 days below 60`,
          html: `<div style="font-family:Arial;max-width:600px"><h2 style="color:#1B3A6B">Performance escalation</h2><p><strong>${userRow.name}</strong> (${userRow.role}) has scored below 60 for 3 consecutive days. Today: <strong>${score}/100</strong>.</p><p><strong>Blockers identified today:</strong></p><ul>${blockers.map(b => `<li>${b}</li>`).join('') || '<li>none specific</li>'}</ul><p><strong>Coaching note sent to them:</strong></p><blockquote style="border-left:3px solid #0D7377;padding-left:12px;margin:8px 0;color:#444">${note}</blockquote><p style="margin-top:16px">Recommended action: schedule a 1-on-1 check-in.</p></div>`
        });
      }
    }
  }

  await query(
    `INSERT INTO performance_scores (id, user_id, score_date, score_0_to_100, metrics_json, blockers_json, claude_coaching_note, escalated_to_admin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, score_date) DO UPDATE
     SET score_0_to_100=$4, metrics_json=$5, blockers_json=$6, claude_coaching_note=$7, escalated_to_admin=$8`,
    [crypto.randomUUID(), userId, date, score, JSON.stringify(metrics), JSON.stringify(blockers), note, escalated ? 1 : 0]
  );

  return { user_id: userId, email: userRow.email, name: userRow.name, role: userRow.role, date, score, blockers, escalated, note };
}

module.exports = { signToken, verifyToken, authMiddleware, adminOnly, sendEmail, fetchGitHubStats, syncGitHubForUser, runClaudeAnalysis, analyzeTeamProgress, scoreTeamMember, computeScoreForRole, crypto };
