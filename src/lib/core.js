const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('./db');
const { sendEmail } = require('./mailer');
const { getRoleTier, isExternalRole } = require('./roles');
const { callClaude } = require('./llm');

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

// THE ROLE IS READ FROM THE DATABASE, NOT THE TOKEN.
//
// It used to be `req.user = payload`, so every gate downstream — adminOnly, superAdminOnly,
// requireTier, and every handler that looks at req.user.role — trusted a claim baked into a JWT with a
// SEVEN DAY life. That meant a promotion, a demotion and a deactivation all waited for the token to
// expire.
//
// It was not hypothetical. naren@abiozen.com was promoted to super_admin on 2026-09-28 and had two live
// sessions: product_shadow_log shows 178 requests on 2026-09-29 carrying `role: admin` and 25 carrying
// `role: super_admin`. Once user management moved to superAdminOnly, the stale session got
// "Super admin only" 403s on Edit while the fresh one worked — the same button, working or not depending
// on which tab it was clicked in.
//
// This is the same mistake as putting products in the token, which is why the product boundary reads
// user_products per request and resolve.js reads the role fresh (its own header says permissions are
// NEVER read from the JWT). The gates now get the same guarantee: a role change takes effect on the next
// request.
//
// The token remains the AUTHENTICATION (who you are, signed by us). The database is the AUTHORIZATION
// (what you currently are). Only `id` and `email` are taken from the token now.
async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });

  let row = null;
  try {
    row = (await query('SELECT role, is_active FROM users WHERE id = $1', [payload.id])).rows[0];
  } catch (e) {
    // DB UNREACHABLE. Fall back to the token's claims and say so loudly.
    //
    // This is the one place in today's work that deliberately fails OPEN, so the reasoning is written
    // down. Failing closed here logs every user out during a database blip — and during a DB outage no
    // route can read data anyway, so the exposure is a role change made within the token's remaining
    // life, during an outage, which is close to nil. Turning a transient blip into a forced re-login for
    // the whole company is the larger harm.
    console.error(`[auth] role lookup FAILED for ${payload.id} — falling back to the token's claims: ${e.message}`);
    req.user = payload;
    return next();
  }

  // The row is gone: the account was deleted while this token was still valid.
  if (!row) {
    console.warn(`[auth] token for a user that no longer exists: ${payload.id} (${payload.email})`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Deactivated. Login already refuses is_active=0, but an EXISTING token used to keep working for up to
  // seven days — so "Set Inactive" did not actually end anyone's session. Now it does.
  if (!(row.is_active === true || Number(row.is_active) === 1)) {
    console.warn(`[auth] rejected a deactivated account: ${payload.email}`);
    return res.status(401).json({ error: 'Account is inactive' });
  }

  req.user = { id: payload.id, email: payload.email, role: row.role };
  if (row.role !== payload.role) {
    // Worth a line: it means somebody is holding a token from before a role change, and the answer they
    // get now differs from the answer they got an hour ago.
    console.log(`[auth] role refreshed for ${payload.email}: token said '${payload.role}', database says '${row.role}'`);
  }

  // Fire-and-forget last_login write-through. Throttle baked into the WHERE
  // clause: only writes if last_login is NULL or older than 5 minutes.
  query(
    `UPDATE users SET last_login = NOW()
     WHERE id = $1 AND (last_login IS NULL OR last_login < NOW() - INTERVAL '5 minutes')`,
    [payload.id]
  ).catch(e => console.error('[auth] last_login write failed:', e.message));
  next();
}

// admin-tier gate — super_admin and admin both pass.
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// STAFF ONLY — every external role is refused, by ROLE and not by a list somebody maintains.
//
// For routes that are safe for anyone who works here but have no business being reachable by an outside
// account. The product boundary cannot express this: a route classified 'shared' is admitted to everyone
// with a login, and a route classified 'sitenex' is admitted to a partner BECAUSE they hold sitenex.
// Neither answers "is this person one of ours".
//
// Not left to the permissions resolver: enforce.js consults a template only for roles named in
// PERMISSIONS_ENFORCE_ROLES, so a template that grants a partner nothing decides nothing until that env
// var is set. This holds either way.
function staffOnly(req, res, next) {
  if (isExternalRole(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Not available to external accounts', code: 'external_role' });
  }
  next();
}

// super_admin ONLY — admin does NOT pass.
// Used where the action decides what another account can reach: inviting a user and choosing their
// products. admin is a broad internal role held by several people; granting products is the one
// decision that must stay with the person accountable for the boundary.
function superAdminOnly(req, res, next) {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin only' });
  }
  next();
}

// Tier permission middleware. Read/write mode is inferred from the HTTP method
// (GET/HEAD = read, anything else = write). On success it sets req.tierAccess
// to the role's grant ('rw'|'r'|'w'|'own') so handlers can apply row-level
// 'own' filtering. See src/lib/roles.js for the role→tier grid.
function requireTier(tier) {
  return (req, res, next) => {
    const access = getRoleTier(req.user.role, tier);
    if (!access) return res.status(403).json({ error: `Role "${req.user.role}" has no ${tier} access` });
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    const canWrite = access === 'rw' || access === 'w' || access === 'own';
    const canRead = access === 'rw' || access === 'r' || access === 'own';
    if (isWrite && !canWrite) return res.status(403).json({ error: `Role "${req.user.role}" lacks write access to ${tier}` });
    if (!isWrite && !canRead) return res.status(403).json({ error: `Role "${req.user.role}" lacks read access to ${tier}` });
    req.tierAccess = access;
    next();
  };
}

// Grants access if ANY of the listed tiers provides the needed read/write access.
// For endpoints several departments should reach (e.g. market intel readable by
// both procurement and intelligence roles). Single-tier callers keep using requireTier.
function requireAnyTier(...tiers) {
  return (req, res, next) => {
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    for (const tier of tiers) {
      const access = getRoleTier(req.user.role, tier);
      if (!access) continue;
      const canWrite = access === 'rw' || access === 'w' || access === 'own';
      const canRead = access === 'rw' || access === 'r' || access === 'own';
      if (isWrite ? canWrite : canRead) { req.tierAccess = access; return next(); }
    }
    return res.status(403).json({ error: `Role "${req.user.role}" lacks ${isWrite ? 'write' : 'read'} access to any of: ${tiers.join(', ')}` });
  };
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

// Existing signature preserved: (prompt) -> string. Callers (LinkedIn, SEO tasks, CEO,
// sales) run parseClaudeJSON on the returned string and treat a non-JSON string as
// "unavailable", so returning an error STRING on failure keeps their behaviour identical.
// Now built on the shared callClaude wrapper (same model, same max_tokens, same request).
async function runClaudeAnalysis(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.includes('REPLACE')) return 'Claude API key not configured.';
  const r = await callClaude({ model: 'claude-haiku-4-5-20251001', prompt, maxTokens: 1500, apiKey: key });
  if (r.error) return 'Claude API error: ' + r.error;
  return r.text || 'Claude error: no text';
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

const { getBaselineSync } = require('./roles');

function sumActivity(map) {
  return Object.values(map).reduce((s, v) => s + (Number(v) || 0), 0);
}

function computeScoreForRole(role, activityMap, github, roleDef = null) {
  const blockers = [];
  const activitySum = sumActivity(activityMap);
  const effort = role === 'dev'
    ? activitySum + (github.commits || 0) + (github.prsMerged || 0) * 5
    : activitySum;
  const baseline = roleDef?.baseline ?? getBaselineSync(role);

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
      // Flag retained so the escalated_to_admin column stays populated (briefing-agent
      // reads it). The legacy per-user "Performance escalation: <name>" email — which
      // had a nondeterministic admin recipient and ignored ramp-up grace — was retired
      // in favor of the consolidated runEscalationCheck digest.
      escalated = true;
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

module.exports = { signToken, verifyToken, authMiddleware, adminOnly, superAdminOnly, staffOnly, requireTier, requireAnyTier, sendEmail, fetchGitHubStats, syncGitHubForUser, runClaudeAnalysis, analyzeTeamProgress, scoreTeamMember, computeScoreForRole, crypto };
