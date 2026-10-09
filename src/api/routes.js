const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { signToken, authMiddleware, adminOnly, superAdminOnly, requireTier, requireAnyTier, syncGitHubForUser, analyzeTeamProgress, runClaudeAnalysis, staffOnly } = require('../lib/core');
const { query, withTransaction } = require('../lib/db');
const { sendEmail } = require('../lib/mailer');
const { checkMilestoneTriggers } = require('../lib/jobs');
const { cascadeGoals, assignWeeklyKPIs, assignWeeklyKPIsForAll, mondayOf } = require('../lib/agents/goal-engine');
const { getWarmLeads, generateOutreachRecommendations } = require('../lib/agents/customer-agent');
const { takeMetricsSnapshot } = require('../lib/agents/metrics-snapshot');
const { getAllRoles, isBuiltIn, getRolePages, isExternalRole, excludeExternalSql, roleTiers } = require('../lib/roles');
const { identifyContentGaps, trackAlgoliaNoResults, trackKeywordRankings, generateCatalogSeoPages, pushSeoContentToAbiozen } = require('../lib/agents/seo-agent');
const { syncAlgoliaSearchData, generateSEORecommendations, runMarketIntelligence } = require('../lib/agents/growth-agent');
const { runEmailEngine, SEGMENTS, sanitizeHtml, publishSequenceToApollo, addSequenceContacts } = require('../lib/agents/email-engine');
const { processApolloReplies, generateFollowUp, getLeadPipeline } = require('../lib/agents/sales-agent');
const { runProcurementAgent, scoreAndRankSuppliers } = require('../lib/agents/procurement-agent');
const { runMeetAgent, analyzeAndStore, runStandup, detectStandups, syncWorkspaceMeetings, pollGeminiMeetingNotes } = require('../lib/agents/meet-agent');
const workspaceActivity = require('../lib/agents/workspace-activity');
const { runResearchAgent } = require('../lib/agents/research-agent');
const { runResearchIntelIngest } = require('../lib/agents/research-intelligence');
const { runContentPipeline } = require('../lib/agents/content');
const { runProspecting, runQualifyProspects } = require('../lib/agents/prospecting');
const { getConfig: getProspectingConfig } = require('../lib/agents/prospecting/config');
// effectiveProducts, NOT heldProducts: a handler that reads the raw table gives the super admin [] now
// that his 7 explicit rows are gone and the bypass lives in the role. Every data scope in this file
// must use the same definition the product boundary uses, or the two disagree — which is exactly what
// happened: outreach writes 403'd and the notification feed went empty for the one account that is
// supposed to see everything.
const { effectiveProducts, productScopeSql } = require('../lib/products/held');
const { partnerScopeSql } = require('../lib/products/partner-scope');
const { territoryScopeSql } = require('../lib/products/territory-scope');
const outreach = require('../lib/outreach');
const { STATUS_DEFS: OUTREACH_STATUS_DEFS, CHANNELS: OUTREACH_CHANNELS, CHANNEL_LABEL: OUTREACH_CHANNEL_LABEL,
        ENTITIES: OUTREACH_ENTITIES, isEntityType } = require('../lib/outreach/registry');
const { PRODUCTS: PRODUCT_KEYS, GRANTABLE } = require('../lib/products/route-map');
const { checkGrantChange, routeCountsByProduct, describeChange } = require('../lib/products/grants');
const riResolve = require('../lib/agents/research-intelligence/resolve');
const riOutreach = require('../lib/agents/research-intelligence/outreach');
const { runReorderAgent, syncBuyersFromOrders, identifyReorderCandidates } = require('../lib/agents/reorder-agent');
const { receiveInquiry, processInboundReply, generateQuote, escalateToHuman, runInquiryAgent, pollSalesEmailbox, handleAcceptance, markPaymentReceived, getPipeline, handleStripeEvent } = require('../lib/agents/inquiry-agent');
const { getKPIHierarchy, getBottlenecks, getCrossTeamDependencies, calculateKPIScore } = require('../lib/kpi-engine');
const { runMorningBriefing, runPerformanceCheck, runEscalationCheck } = require('../lib/agents/orchestrator');
const { sendWhatsApp } = require('../lib/whatsapp');
const { generateProductPost, generateMarketIntelligencePost, generateCompanyUpdate, runWeeklyLinkedInCampaign, scheduleLinkedInContent, getCombinedDemandMolecules, enrichWithCatalog, getMoleculeStructureImage, generatePostImage, selectImagePrompt, publishPost: publishLinkedInPost } = require('../lib/agents/linkedin-agent');
const { syncPlaybookOSSkus, syncAbiozenProducts } = require('../lib/algolia-sync');
const { createDailyTask, logAgentActivity, parseClaudeJSON, businessToday, enqueueApproval, extractClaudeText } = require('../lib/agent-core');

const router = express.Router();

// Issue 4c — in-memory multipart handling for the LinkedIn reference-image upload.
// memoryStorage keeps the file in req.file.buffer (no temp file → nothing to clean
// up on Railway's ephemeral disk); it's forwarded straight to OpenAI and discarded.
const multer = require('multer');
const uploadRefImageMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10 MB, single file
  fileFilter: (req, file, cb) => cb(
    /^image\/(png|jpe?g|webp)$/i.test(file.mimetype) ? null : new Error('Only PNG, JPG, or WebP images are allowed'),
    /^image\/(png|jpe?g|webp)$/i.test(file.mimetype)
  ),
}).single('image');
// Wrap multer so its errors (size/type) return clean JSON instead of an HTML 500.
// On a non-multipart (JSON) request it is a no-op, so the Issue 4b text-only path
// is unchanged. req.file is set only when an image part is present.
function uploadReferenceImage(req, res, next) {
  uploadRefImageMw(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'image upload failed' });
    next();
  });
}

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

// A failed login used to leave NO trace at all — same opaque 401 for "no such user", "user has
// no password set" and "wrong password", and nothing written anywhere. Diagnosing one meant
// querying the users table by hand. These logs name the branch that actually failed.
//
// The RESPONSE stays deliberately uniform ("Invalid credentials" for every failure) — telling a
// caller which branch failed is a user-enumeration oracle. The distinction goes to the log,
// which only we read. The password is never logged, in any form.
function logLoginFailure(req, branch, email) {
  // trust proxy is set (server.js:42), so req.ip is the client, not Railway's edge.
  console.warn(`[auth] login FAILED (${branch}) email=${String(email || '').toLowerCase().trim() || '(none)'} ip=${req.ip}`);
}

router.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      logLoginFailure(req, 'missing_field', email);
      return res.status(400).json({ error: 'Email and password required' });
    }
    const result = await query('SELECT * FROM users WHERE email=$1 AND is_active=1', [email.toLowerCase().trim()]);
    const user = result.rows[0];
    // Split from the no-hash case: "no active row" and "row exists but never set a password"
    // are different problems — the first is a typo or a deactivated account, the second is a
    // half-finished invite.
    if (!user) {
      logLoginFailure(req, 'no_active_user', email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.password_hash) {
      logLoginFailure(req, 'no_password_set', email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // .trim() to match the email on line 113. That asymmetry was a real outage: a temporary
    // password handed over in a text file carries the file's trailing newline, the paste brings
    // it along, and bcrypt correctly rejects a string one character longer than the one that was
    // hashed — logged as password_mismatch, which reads like the wrong password entirely.
    // Trailing whitespace in a password is never intentional, and trimming costs no entropy:
    // we never hash a password with edge whitespace, so no stored hash can require it.
    if (!bcrypt.compareSync(password.trim(), user.password_hash)) {
      logLoginFailure(req, 'password_mismatch', email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    console.log(`[auth] login ok email=${user.email} role=${user.role} ip=${req.ip}`);
    res.json({ token: signToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role, github_username: user.github_username, can_run_standup: !!user.can_run_standup, tiers: roleTiers(user.role), products: await effectiveProducts(user) } });
  } catch(e) {
    console.error(`[auth] login ERROR ip=${req.ip}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

router.post('/auth/accept-invite', authLimiter, async (req, res) => {
  try {
    const { token, password, name } = req.body;
    if (!token || !password || !name) return res.status(400).json({ error: 'Token, name, and password required' });
    const result = await query('SELECT * FROM users WHERE invite_token=$1', [token]);
    const user = result.rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid or expired invite token' });
    // Trimmed to match the login comparison. Both sides must agree: login trims, so hashing an
    // untrimmed value here would store a hash that login can never satisfy.
    const hash = bcrypt.hashSync(password.trim(), 10);
    // The product grants are written HERE, not when the invite was sent. An invite that is never
    // accepted must leave no row in user_products, because that row is what the product boundary
    // reads — a grant should exist only for an account somebody actually holds.
    //
    // One transaction with the password: an account that can log in but holds no products would look
    // like a boundary bug and be debugged as one, and a half-applied accept is exactly the state
    // nobody would think to check. ON CONFLICT DO NOTHING makes a replayed token harmless.
    const chosen = Array.isArray(user.invited_products) ? user.invited_products : [];
    await withTransaction(async (c) => {
      await c.query('UPDATE users SET password_hash=$1, name=$2, invite_token=NULL, joined_at=$3, invited_products=NULL WHERE id=$4',
        [hash, name, new Date().toISOString(), user.id]);
      for (const product of chosen) {
        // granted_by is the super_admin who sent the invite, carried through from the row — so the
        // grant records who decided it, not the account that happened to accept.
        await c.query(`INSERT INTO user_products (user_id, product, granted_by) VALUES ($1, $2, $3)
                       ON CONFLICT (user_id, product) DO NOTHING`, [user.id, product, user.invited_by || null]);
        // And the audit log, so EVERY way a grant comes into being is in one place. A log that only
        // covers the admin screen would answer "who changed this" with silence for every account that
        // got its products at signup — which is all of them, to begin with.
        await c.query(
          `INSERT INTO user_product_grants_log (user_id, user_email, product, action, actor_id, source)
           VALUES ($1,$2,$3,'grant',$4,'invite_accept')`,
          [user.id, user.email, product, user.invited_by || null]);
      }
    });
    console.log(`[invite] ACCEPTED ${user.email} — granted products [${chosen.join(', ') || 'NONE'}]`);
    const updated = (await query('SELECT * FROM users WHERE id=$1', [user.id])).rows[0];
    res.json({ token: signToken(updated), user: { id: updated.id, name: updated.name, email: updated.email, role: updated.role, tiers: roleTiers(updated.role), products: await effectiveProducts(updated) }, products: chosen });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// `tiers` is returned WITH IDENTITY, and that is the point.
//
// The client nav filters pages by the caller's tiers (NAV_PAGE_REQS). It used to get them from
// GET /api/roles, fetched separately in buildNav inside a try/catch that swallowed the error — so a
// 403 or a blip on THAT call left tiers unknown, and passesPageReads() fell back to showing every page
// in a visible section. A tighter server gate produced a looser client UI.
//
// Tiers now arrive on the same call that establishes who you are. That call cannot degrade open,
// because a failure logs you out (checkAuth in index.html). Read fresh from the users row, like the
// role, so a role change takes effect on the next request rather than the next login.
router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await query('SELECT id,name,email,role,github_username,can_run_standup FROM users WHERE id=$1', [req.user.id]);
    const u = result.rows[0];
    if (!u) return res.status(404).json({ error: 'Not found' });
    // PRODUCTS ARRIVE WITH IDENTITY, for the same reason tiers do. The sidebar is built from what the
    // caller holds, and a separate fetch for it could fail — and a nav computed from a failed fetch is a
    // nav that guesses. This call cannot degrade open: its failure logs you out.
    //
    // effectiveProducts, so super_admin sees every product without holding a row for each.
    res.json({ ...u, tiers: roleTiers(u.role), products: await effectiveProducts(u) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Self-service password change. Until now every reset meant a hand-written UPDATE against
// production, which is how a temporary credential ends up living in a text file and being
// retyped — the failure mode this route exists to end.
//
// authMiddleware ONLY, deliberately no requireTier: the tiers describe business domains
// (revenue, intelligence, technical) and any one of them would exclude some role from changing
// its own password. The identity comes from the token, never the body, so a caller can only
// ever change their own — there is no user_id parameter to tamper with.
const MIN_PASSWORD_LEN = 12;
router.put('/auth/password', authMiddleware, async (req, res) => {
  try {
    const currentPassword = String((req.body || {}).currentPassword || '').trim();
    const newPassword = String((req.body || {}).newPassword || '').trim();
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    // Length is checked on the TRIMMED value, so 12 spaces and a character is not a password.
    if (newPassword.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LEN} characters` });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must be different from the current one' });
    }
    const result = await query('SELECT id, email, password_hash FROM users WHERE id=$1 AND is_active=1', [req.user.id]);
    const user = result.rows[0];
    if (!user || !user.password_hash) {
      console.warn(`[auth] password change FAILED (no_active_user) user=${req.user.id} ip=${req.ip}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // .trim() on both sides matches the login route; a hash we store can never require edge
    // whitespace, so trimming costs no entropy and spares the paste-a-trailing-newline bug.
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      console.warn(`[auth] password change FAILED (password_mismatch) user=${user.email} ip=${req.ip}`);
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    // Cost 10 — the same factor every existing hash in the table uses ($2a$10$).
    const hash = bcrypt.hashSync(newPassword, 10);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2 AND is_active=1', [hash, user.id]);
    // The change is logged; neither password appears, in any form.
    console.log(`[auth] password CHANGED user=${user.email} ip=${req.ip}`);
    res.json({ ok: true });
  } catch(e) {
    console.error(`[auth] password change ERROR ip=${req.ip}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
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

// `products` is included so the team page can show what each account actually holds. A grant you
// cannot see is a grant nobody audits, and until now the only way to know was to query the table.
// invited_products is surfaced separately for accounts that have not accepted yet — those are chosen,
// not granted, and showing them as the same thing would misrepresent the boundary.
router.get('/users', authMiddleware, async (req, res) => {
  try {
    const result = await query(`
      SELECT u.id, u.name, u.email, u.role, u.github_username, u.joined_at, u.is_active,
             u.invited_products,
             COALESCE(ARRAY(SELECT p.product FROM user_products p WHERE p.user_id = u.id ORDER BY p.product), '{}') AS products
        FROM users u ORDER BY u.role, u.name`);
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Grantable products, for the invite form ───────────────────────────────────
// The list comes from the ROUTE MAP, not a second hand-kept list in the client: the products a user
// can be granted are exactly the products routes are classified under, and a form offering anything
// else would grant something the boundary never checks. 'internal' is returned SEPARATELY because it
// is not a product — it is the staff flag, and the form must not present it as one more checkbox in
// the row.
router.get('/products/grantable', authMiddleware, superAdminOnly, async (req, res) => {
  const LABELS = { abiozen: 'Abiozen', golfnex: 'GolfNex', favly: 'Favly', linkabl: 'Linkabl', aros: 'AROS', sitenex: 'SiteNex' };
  res.json({
    products: PRODUCT_KEYS.map(key => ({ key, label: LABELS[key] || key })),
    internal: {
      key: 'internal',
      label: 'Internal staff',
      warning: 'Platform-wide access: team, settings, agent control, and every alert not attributable to a product. Never grant this to an outside account.',
    },
  });
});

// Every route this router has mounted, for the "how many routes does this cost them" arithmetic.
// Computed on FIRST CALL, not at require time: routes are registered throughout this file (and some
// after module.exports), so reading router.stack while the file is still loading would undercount.
// Cached after that — the route table cannot change at runtime.
let _mounted = null;
function mountedRoutes() {
  if (_mounted) return _mounted;
  const out = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) {
      if (layer.route.methods[m]) out.push({ method: m.toUpperCase(), path: `/api${layer.route.path}` });
    }
  }
  out.push({ method: 'GET', path: '/health' }, { method: 'GET', path: '/sitemap.xml' });
  _mounted = out;
  return out;
}

// ── PRODUCT ASSIGNMENT FOR AN EXISTING USER ───────────────────────────────────
//
// PUT /api/users/:id/products  { products: ['abiozen', 'internal'] }  — super_admin only.
//
// The body is the COMPLETE desired set, not a delta. A delta API ("add these, remove those") makes a
// lost request indistinguishable from a partial apply; a full set makes the write idempotent, so a
// retry cannot double-apply and two admins editing at once end at one of the two states rather than a
// blend of both.
//
// TAKES EFFECT IMMEDIATELY. Products are not in the JWT — boundary.js reads user_products on every
// evaluated request, with no cache — so a revoke is live on the target's very next request, not when
// their 7-day token expires. That is the whole point of having this screen.
router.put('/users/:id/products', authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { products } = req.body || {};
    if (!Array.isArray(products)) return res.status(400).json({ error: 'products must be an array' });
    const next = [...new Set(products.map(p => String(p).trim()).filter(Boolean))];

    const target = (await query('SELECT id, name, email, role, is_active FROM users WHERE id=$1', [req.params.id])).rows[0];
    if (!target) return res.status(404).json({ error: 'Not found' });

    const current = (await query('SELECT product FROM user_products WHERE user_id=$1 ORDER BY product', [target.id]))
      .rows.map(r => r.product);
    const supers = (await query(
      `SELECT COUNT(*)::int n FROM users WHERE role='super_admin' AND is_active=1`)).rows[0].n;

    const verdict = checkGrantChange({
      actor: req.user, target, current, next, activeSuperAdmins: supers,
    });
    if (!verdict.ok) {
      console.warn(`[products] REFUSED ${verdict.code}: ${req.user.email} → ${target.email} [${current.join(',')}] → [${next.join(',')}]`);
      return res.status(403).json({ error: verdict.error, code: verdict.code, products: current });
    }
    const { added, removed } = verdict;

    // One transaction for the rows AND the log. A grant that applied without a log entry is the exact
    // gap this route was asked to close, so it must not be possible to get one without the other.
    if (added.length || removed.length) {
      await withTransaction(async (c) => {
        for (const product of added) {
          await c.query(
            `INSERT INTO user_products (user_id, product, granted_by) VALUES ($1,$2,$3)
             ON CONFLICT (user_id, product) DO NOTHING`, [target.id, product, req.user.id]);
        }
        if (removed.length) {
          await c.query(`DELETE FROM user_products WHERE user_id=$1 AND product = ANY($2)`, [target.id, removed]);
        }
        for (const [action, list] of [['grant', added], ['revoke', removed]]) {
          for (const product of list) {
            await c.query(
              `INSERT INTO user_product_grants_log
                 (user_id, user_email, product, action, actor_id, actor_email, source)
               VALUES ($1,$2,$3,$4,$5,$6,'admin_edit')`,
              [target.id, target.email, product, action, req.user.id, req.user.email]);
          }
        }
      });
    }

    const counts = routeCountsByProduct(mountedRoutes());
    const summary = describeChange({ target, added, removed, counts });
    console.log(`[products] ${req.user.email} → ${summary}`);
    res.json({
      success: true, user: { id: target.id, name: target.name, email: target.email, role: target.role },
      before: current, after: next, added, removed, summary,
      route_counts: counts,
      takes_effect: 'immediately — the boundary reads user_products on every request, nothing is cached in the token',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/users/:id/products — current grants plus the full history, so a revoke is answerable.
router.get('/users/:id/products', authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const held = (await query('SELECT product, granted_at, granted_by FROM user_products WHERE user_id=$1 ORDER BY product', [req.params.id])).rows;
    const history = (await query(
      `SELECT l.created_at, l.product, l.action, l.source, l.actor_email,
              COALESCE(l.actor_email, a.email) AS actor
         FROM user_product_grants_log l LEFT JOIN users a ON a.id = l.actor_id
        WHERE l.user_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 200`, [req.params.id])).rows;
    res.json({ products: held.map(h => h.product), held, history,
      route_counts: routeCountsByProduct(mountedRoutes()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// INVITE — super_admin ONLY, and the products are chosen here.
// This was adminOnly. It is not any more: inviting a user now decides which products that account can
// reach, and that decision stays with the person accountable for the boundary. admin keeps everything
// else on the team page (rename, activate, reset password); it can no longer create an account.
//
// The chosen products are PARKED on the row (users.invited_products) and written to user_products on
// ACCEPT. An invite that is never accepted, or is revoked, therefore leaves no grant behind.
router.post('/users/invite', authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { email, role, github_username, whatsapp_number, products } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'Email and role required' });
    const catalog = await getAllRoles();
    if (!catalog[role]) {
      return res.status(400).json({ error: `Unknown role "${role}". Valid roles: ${Object.keys(catalog).join(', ')}` });
    }
    // Products: validated against the map's own list. An unknown value is rejected rather than
    // dropped — silently ignoring it would produce an account that looks granted and is not.
    if (products !== undefined && !Array.isArray(products)) {
      return res.status(400).json({ error: 'products must be an array' });
    }
    const chosen = [...new Set((products || []).map(p => String(p).trim()).filter(Boolean))];
    const unknown = chosen.filter(p => !GRANTABLE.includes(p));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown product(s): ${unknown.join(', ')}. Grantable: ${GRANTABLE.join(', ')}` });
    }
    const existing = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows[0]) return res.status(400).json({ error: 'User already exists' });
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomUUID();
    const wa = whatsapp_number ? String(whatsapp_number).trim() : null;
    // An EXTERNAL role sets excluded_from_scoring on the row as well. The role property is what the
    // agents actually check (src/lib/roles.js excludeExternalSql), so this is redundant by design: it
    // keeps the column truthful for the handful of older queries that filter on it, and it makes the
    // exclusion visible to anyone reading the row instead of only to anyone reading roles.js.
    const external = isExternalRole(role);
    await query('INSERT INTO users (id,email,name,role,github_username,whatsapp_number,invite_token,invited_at,invited_products,invited_by,excluded_from_scoring) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, email.toLowerCase(), email.split('@')[0], role, github_username || null, wa, inviteToken, new Date().toISOString(), chosen, req.user.id, external]);
    // Logged plainly, because granting 'internal' to an outside account is the one mistake here that
    // does not announce itself.
    console.log(`[invite] ${req.user.email} invited ${email.toLowerCase()} as ${role} with products [${chosen.join(', ') || 'NONE'}]${chosen.includes('internal') ? ' ⚠ INCLUDES internal' : ''}`);
    const baseUrl = process.env.BASE_URL || 'https://playbookos-production.up.railway.app';
    const inviteUrl = `${baseUrl}/#/accept-invite?token=${inviteToken}`;
    sendEmail({ to: email, subject: `You've been invited to PlayNexa`, triggerType: 'invite',
      html: `<div style="font-family:Arial;max-width:600px"><h2 style="color:#232f3e;font-weight:400">Play<strong style="font-weight:700">Nexa</strong></h2><p>You've been invited as <strong>${role}</strong>.</p><a href="${inviteUrl}" style="background:#0D7377;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">Accept Invite</a><p style="color:#666;font-size:13px">Or copy: ${inviteUrl}</p></div>` });

    // Fire-and-forget WhatsApp welcome if a number was provided. Skips
    // gracefully when Twilio env vars are unset (sendWhatsApp returns
    // { skipped, reason }). Failures must not break the invite response.
    let whatsapp_status = null;
    // WhatsApp is our team's escalation channel. An external account has no business in it, so the
    // number is ignored rather than messaged even if one was typed in.
    if (wa && external) whatsapp_status = 'skipped:external_role';
    else if (wa) {
      const welcome = `Welcome to PlayNexa! 🚀 You've been invited as ${role}. Login at ${baseUrl} with your email. You'll receive daily task assignments and KPI updates here on WhatsApp.`;
      try {
        const r = await sendWhatsApp(wa, welcome, { user_id: id, message_type: 'welcome' });
        whatsapp_status = r.success ? 'sent' : (r.skipped ? 'skipped:' + r.reason : 'error:' + r.error);
      } catch(e) { whatsapp_status = 'error:' + e.message; }
    }

    res.json({ success: true, message: `Invite sent to ${email}`, inviteUrl, whatsapp_status, products: chosen });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Self-service profile edit — open to everyone, for their OWN row.
//
// The `user_id` override is a different capability wearing the same clothes: it edits ANOTHER account's
// name, github_username and whatsapp_number. It used to accept admin, which made it a back door around
// the lock on PUT /api/users/:id — same capability, different path. Editing other people is now
// super_admin only; editing yourself is unchanged for every role.
router.put('/users/profile', authMiddleware, async (req, res) => {
  try {
    const { github_username, name, whatsapp_number, user_id } = req.body;
    if (user_id && user_id !== req.user.id && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Super admin only — editing another user\'s profile is user management' });
    }
    const targetId = user_id || req.user.id;
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

// PUT /users/:id — EDIT ANOTHER ACCOUNT. super_admin only.
//
// This route had no middleware at all. Its guard was an inline `req.user.role !== 'admin'`, which was
// wrong in both directions: every one of the 13 roles held admin.users.update in its template (the
// resolver permitted the call, and only that inline string comparison stopped it), and the comparison
// EXCLUDED super_admin — so the one account that is supposed to manage users could not change anyone's
// role, while every admin could.
//
// The SPA never calls this route; self-service profile edits go to PUT /api/users/profile, which stays
// open to everyone. So locking it whole costs nothing and closes both halves of the bug.
router.put('/users/:id', authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { github_username, name, role, user_id } = req.body;
    const targetId = user_id || id;

    let validatedRole = null;
    if (role !== undefined && role !== null && role !== '') {
      const catalog = await getAllRoles();
      if (!catalog[role]) return res.status(400).json({ error: `Unknown role "${role}". Valid roles: ${Object.keys(catalog).join(', ')}` });
      // NO SELF-DEMOTION. The same failure as removing your own 'internal' product: a super_admin who
      // sets their own role to 'admin' takes away the only account that can set it back, and the fix is
      // a hand-written UPDATE against production.
      if (targetId === req.user.id && role !== 'super_admin') {
        return res.status(403).json({ error: `You cannot change your own role to "${role}". That would `
          + `remove your own access to user management, and the only way back is a manual database `
          + `change. Ask another super admin.`, code: 'self_demote' });
      }
      // And the last super_admin cannot be demoted by anyone, for the same reason the last one's
      // products cannot be revoked — there would be nobody left able to undo it.
      const target = (await query('SELECT id, role, email FROM users WHERE id=$1', [targetId])).rows[0];
      if (!target) return res.status(404).json({ error: 'User not found' });
      if (target.role === 'super_admin' && role !== 'super_admin') {
        const supers = (await query(`SELECT COUNT(*)::int n FROM users WHERE role='super_admin' AND is_active=1`)).rows[0].n;
        if (supers <= 1) {
          return res.status(403).json({ error: `${target.email} is the only active super admin and cannot `
            + `be demoted — nobody would be able to manage users afterwards. Promote a second super admin `
            + `first.`, code: 'last_super_admin' });
        }
      }
      validatedRole = role;
      console.warn(`[users] ROLE CHANGE by ${req.user.email}: ${targetId} → ${role}`);
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
//
// THIS USED TO RECORD NOTHING. No console line, no activity_log row, and user_products cascades — so a
// hard delete removed the account AND every trace of what it had been granted, leaving no way to answer
// "who had access to what, and when did that stop". Seven accounts were deleted on 2026-09-29 and there
// is no record of who did it or when; that is what this block exists to prevent happening again.
//
// A deleted user is the largest possible permission removal, so it goes in the same audit log as a
// revoke — written BEFORE the delete, because afterwards the grants are gone and there is nothing left
// to describe. The log table has no foreign key precisely so these rows survive the cascade.
router.delete('/users/:id', authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' });
    const target = (await query('SELECT id, role, email, name FROM users WHERE id=$1', [id])).rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'super_admin') return res.status(403).json({ error: 'A super_admin account cannot be removed' });
    const held = (await query('SELECT product FROM user_products WHERE user_id=$1', [id])).rows.map(r => r.product);
    if (req.query.permanent === 'true') {
      await withTransaction(async (c) => {
        for (const product of held) {
          await c.query(
            `INSERT INTO user_product_grants_log (user_id, user_email, product, action, actor_id, actor_email, source)
             VALUES ($1,$2,$3,'revoke',$4,$5,'user_deleted')`,
            [target.id, target.email, product, req.user.id, req.user.email]);
        }
        await c.query('DELETE FROM users WHERE id=$1', [id]);
      });
      console.warn(`[users] PERMANENT DELETE by ${req.user.email}: ${target.email} (${target.role}) `
        + `— products lost: [${held.join(', ') || 'none'}]`);
      return res.json({ success: true, id, deleted: 'permanent', email: target.email, products_lost: held });
    }
    await query('UPDATE users SET is_active=0 WHERE id=$1', [id]);
    // A soft delete keeps the grants, which is right — reactivating restores the account as it was — so
    // there is nothing to log against the products. The action itself is still worth a line.
    console.log(`[users] deactivated by ${req.user.email}: ${target.email} (${target.role})`);
    res.json({ success: true, id, is_active: 0, deleted: 'soft', email: target.email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /users/:id/toggle-status — if the body carries is_active (0|1) the
// status is set explicitly; otherwise the current value is flipped.
router.put('/users/:id/toggle-status', authMiddleware, superAdminOnly, async (req, res) => {
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
router.post('/admin/users/:user_id/reset-password', authMiddleware, superAdminOnly, async (req, res) => {
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
router.post('/admin/users/:user_id/edit-name', authMiddleware, superAdminOnly, async (req, res) => {
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
        AND COALESCE(u.excluded_from_scoring, false) = false${excludeExternalSql('u')}
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
        AND COALESCE(u.excluded_from_scoring, false) = false${excludeExternalSql('u')}
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

// ── Multi-product event ingestion (E0) ────────────────────────────────────────
// Additive, never-throws, per-product Bearer secret (NOT the shared Abiozen secret),
// flag-gated by EVENT_INGEST_ENABLED (default OFF). Thin wrapper — all logic + idempotency
// + quarantine live in src/lib/events/ingest.js. Touches no existing route or table.
router.post('/events/ingest', async (req, res) => {
  try {
    const { ingestEvent } = require('../lib/events/ingest');
    const result = await ingestEvent({ authorization: req.headers['authorization'], body: req.body });
    res.status(result.status).json(result.body);
  } catch (e) {
    // ingestEvent is never-throws; this is belt-and-suspenders so one product's event
    // can never crash the request or affect the Abiozen webhooks above.
    try { console.error('[events/ingest] route error:', e && e.message); } catch (_) {}
    res.status(500).json({ error: 'internal error' });
  }
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
    const raw = extractClaudeText(adata).trim();
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
// Publish an approved campaign to Apollo — the 4-call sequence flow. Shared by the
// approval auto-publish (PUT) and the manual retry (POST /:id/publish). Overrides
// the sequence name to the standard "[Molecule] — [Segment] — Week of [date] —
// Test A/B" format, records the sequence id + status, and best-effort enrolls the
// segment's Apollo contacts (S1–S4). Never throws — returns a plain result.
//
// NOTE: Apollo's sequence-creation endpoint needs a MASTER API key and a plan that
// exposes it; on failure the stored payload is returned so the sequence can be
// recreated by hand.
async function publishCampaignRow(c, userEmail) {
  const apolloKey = process.env.APOLLO_API_KEY;
  if (!apolloKey) return { ok: false, error: 'APOLLO_API_KEY not configured' };
  if (c.apollo_sequence_id) return { ok: false, error: `Already published as Apollo sequence ${c.apollo_sequence_id}`, apollo_sequence_id: c.apollo_sequence_id };
  let payload;
  try { payload = JSON.parse(c.apollo_payload || 'null'); } catch { payload = null; }
  if (!payload) return { ok: false, error: 'Stored Apollo payload is missing or unparseable — re-run the engine for this week' };
  const seg = SEGMENTS.find(s => s.key === c.segment);
  payload.name = `${c.molecule_name} — ${seg?.label || c.segment} — Week of ${c.week_start} — Test A/B`;
  // Defense-in-depth (Issue 1): rebuild the step cadence + labels from the CURRENT
  // campaign row so any draft — including pre-fix ones whose stored payload still
  // has the old 0/3/7 / "Variant A/B" shape — publishes with the corrected
  // Welcome → Follow-up 1 → Follow-up 2 flow at 0/4/8. Content comes from the row's
  // variant fields (source of truth, so a re-generated variant_b is picked up); the
  // step-3 nudge HTML is reused from the stored payload because the mol fields
  // buildApolloPayload needs to regenerate it (in_catalog, purity, …) aren't stored
  // on the row. NOTE: this fixes cadence/labels only — stale variant_b CONTENT still
  // requires regeneration (Step B).
  const _sorted = [...(payload.emailer_steps || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
  const _nudgeHtml = (_sorted[2] && _sorted[2].body_html) || (_sorted.length && _sorted[_sorted.length - 1].body_html) || c.variant_a_html;
  payload.emailer_steps = [
    { position: 1, wait_days: 0, type: 'auto_email', label: 'Welcome', subject: c.variant_a_subject, body_html: c.variant_a_html },
    { position: 2, wait_days: 4, type: 'auto_email', label: 'Follow-up 1', subject: c.variant_b_subject, body_html: c.variant_b_html },
    { position: 3, wait_days: 8, type: 'auto_email', label: 'Follow-up 2 (nudge)', subject: `Re: ${c.variant_a_subject}`, body_html: _nudgeHtml },
  ];

  const result = await publishSequenceToApollo(payload, apolloKey);
  if (!result.ok) {
    // Record any partial sequence id so a retry doesn't create a duplicate.
    if (result.sequenceId) await query(`UPDATE email_campaigns SET apollo_sequence_id=$1 WHERE id=$2`, [result.sequenceId, c.id]);
    return {
      ok: false,
      error: `Apollo publish failed at ${result.stage} (HTTP ${result.status})`,
      apollo_response: result.detail, apollo_sequence_id: result.sequenceId || null,
      steps_created: result.stepsDone || [],
      hint: result.sequenceId
        ? `A partial sequence was created in Apollo (${result.sequenceId}) with steps ${JSON.stringify(result.stepsDone || [])}. Finish or delete it in Apollo before retrying — retrying would create a duplicate.`
        : 'Sequence creation needs an Apollo master API key and a plan that exposes the endpoint. The payload below can be recreated manually.',
      payload,
    };
  }
  await query(`UPDATE email_campaigns SET status='sent', apollo_sequence_id=$1 WHERE id=$2`, [result.sequenceId, c.id]);
  // FIX 4 — best-effort: enroll the segment's Apollo contacts (S1–S4).
  let contacts = null;
  try { contacts = await addSequenceContacts(result.sequenceId, c.segment, apolloKey); } catch (e) { contacts = { error: e.message }; }
  logAgentActivity({
    agent_name: 'email-engine', action_type: 'email_campaign_published',
    reasoning: `${userEmail} published "${c.molecule_name} / ${c.segment}" to Apollo as sequence ${result.sequenceId} with ${result.stepsDone.length} steps${contacts && contacts.added ? `; enrolled ${contacts.added} ${contacts.label} contacts` : ''}${contacts && contacts.dropped ? ` (${contacts.dropped} dropped by per-company cap)` : ''}`,
    output_summary: `campaign_id=${c.id} apollo_sequence_id=${result.sequenceId} steps=${result.stepsDone.length}`,
  }).catch(e => console.error('[email-engine] publish audit failed:', e.message));
  return { ok: true, apollo_sequence_id: result.sequenceId, steps_created: result.stepsDone.length, contacts, status: 'sent' };
}

router.put('/email-engine/campaigns/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "status must be 'approved' or 'rejected'" });
    }
    const c = (await query('SELECT * FROM email_campaigns WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (c.status !== 'draft') {
      return res.status(409).json({ error: `Campaign is already '${c.status}' — only draft campaigns can be approved or rejected` });
    }

    if (status === 'rejected') {
      await query(`UPDATE email_campaigns SET status='rejected', approved_at=NOW(), approved_by=$1 WHERE id=$2`, [req.user.email, req.params.id]);
      logAgentActivity({ agent_name: 'email-engine', action_type: 'email_campaign_review', reasoning: `${req.user.email} rejected campaign ${req.params.id}`, output_summary: `campaign_id=${req.params.id} -> rejected` }).catch(() => {});
      return res.json({ success: true, id: req.params.id, status: 'rejected', published: false });
    }

    // Approved → mark approved, then immediately auto-publish to Apollo.
    await query(`UPDATE email_campaigns SET status='approved', approved_at=NOW(), approved_by=$1 WHERE id=$2`, [req.user.email, req.params.id]);
    const pub = await publishCampaignRow({ ...c, status: 'approved' }, req.user.email);
    if (!pub.ok) {
      // Approval stands; publish failed → status stays 'approved' so the UI can retry.
      logAgentActivity({ agent_name: 'email-engine', action_type: 'email_campaign_review', reasoning: `${req.user.email} approved campaign ${req.params.id}; Apollo auto-publish failed: ${pub.error}`, output_summary: `campaign_id=${req.params.id} -> approved (publish failed)` }).catch(() => {});
      return res.json({ success: true, id: req.params.id, status: 'approved', published: false, error: pub.error, apollo_sequence_id: pub.apollo_sequence_id || null, apollo_response: pub.apollo_response, hint: pub.hint, payload: pub.payload });
    }
    return res.json({ success: true, id: req.params.id, status: 'sent', published: true, apollo_sequence_id: pub.apollo_sequence_id, steps_created: pub.steps_created, contacts: pub.contacts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual retry — publish an approved campaign whose auto-publish failed.
router.post('/email-engine/campaigns/:id/publish', authMiddleware, adminOnly, async (req, res) => {
  try {
    const c = (await query('SELECT * FROM email_campaigns WHERE id=$1', [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    if (c.status !== 'approved') return res.status(409).json({ error: `Campaign is '${c.status}' — approve it before publishing to Apollo` });
    const pub = await publishCampaignRow(c, req.user.email);
    if (!pub.ok) {
      return res.status(502).json({ error: pub.error, apollo_response: pub.apollo_response, apollo_sequence_id: pub.apollo_sequence_id || null, steps_created: pub.steps_created || [], hint: pub.hint, payload: pub.payload });
    }
    res.json({ success: true, id: req.params.id, apollo_sequence_id: pub.apollo_sequence_id, steps_created: pub.steps_created, contacts: pub.contacts, status: 'sent' });
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
  const secret = process.env.PLAYBOOKOS_WEBHOOK_SECRET;
  const provided = req.headers['x-playbookos-secret'];
  if (!secret) return res.status(503).json({ error: 'PLAYBOOKOS_WEBHOOK_SECRET not configured' });
  if (!provided || provided !== secret) return res.status(401).json({ error: 'Invalid or missing X-PlaybookOS-Secret header' });
  const b = req.body || {};
  if (!b.buyer_email || !b.molecule_name) return res.status(400).json({ error: 'buyer_email and molecule_name required' });
  // Respond immediately, then create the inquiry + send the AI first-response in
  // the background. receiveInquiry does a synchronous Claude call (~10s), so
  // blocking on it would time out fast callers (e.g. the storefront forward).
  res.status(202).json({ status: 'accepted' });
  receiveInquiry({
    molecule_name: b.molecule_name, cas_number: b.cas_number, buyer_name: b.buyer_name,
    buyer_email: b.buyer_email, buyer_company: b.buyer_company, country: b.country,
    quantity: b.quantity, quantity_unit: b.quantity_unit, intended_use: b.intended_use,
    message: b.message, source: b.source || 'abiozen_form',
  }).catch(e => console.error('[inquiry/receive] receiveInquiry failed:', e.message));
});

// Stripe webhook — verifies the signature against the RAW body (captured in
// server.js via express.json's verify hook). No JWT; the Stripe signature is auth.
// On a completed payment it confirms the order → production. Responds 200 fast.
router.post('/inquiry/stripe-webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];
  if (!secret) return res.status(503).json({ error: 'STRIPE_WEBHOOK_SECRET not configured' });
  const raw = req.rawBody;
  const reject = (reason) => { console.warn(`[stripe-webhook] signature rejected (${reason}) from ${req.ip}`); return res.status(400).json({ error: reason }); };
  if (!raw || !sig) return reject('missing signature or raw body');
  const parts = Object.fromEntries(String(sig).split(',').map(p => p.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return reject('malformed Stripe-Signature header');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`, 'utf8').digest('hex');
  let valid = false;
  try { valid = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch (_) { valid = false; }
  if (!valid) return reject('signature verification failed');
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return reject('timestamp outside tolerance');
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'invalid JSON' }); }
  // Ack fast, process in the background (Stripe expects a prompt 200).
  res.status(200).json({ received: true });
  handleStripeEvent(event).then(r => console.log('[stripe-webhook]', event.type, JSON.stringify(r).slice(0, 200))).catch(e => console.error('[stripe-webhook] failed:', e.message));
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

// Sales pipeline (kanban columns + weighted revenue forecast). Literal path, so it
// must sit before /inquiry/:id.
router.get('/inquiry/pipeline', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try { res.json(await getPipeline()); } catch (e) { res.status(500).json({ error: e.message }); }
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

// Manually mark an inquiry accepted — sends payment instructions, WhatsApps Naresh,
// emails Palash, and opens an order (Stage 6).
router.post('/inquiry/:id/accept', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try { const r = await handleAcceptance(req.params.id); if (r.error) return res.status(404).json(r); res.json({ success: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark the advance payment received — moves to production and notifies sourcing.
router.post('/inquiry/:id/payment-received', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try { const r = await markPaymentReceived(req.params.id); if (r.error) return res.status(404).json(r); res.json({ success: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/inquiry/:id', authMiddleware, requireAnyTier('sales', 'revenue'), async (req, res) => {
  try {
    const b = req.body || {}, sets = [], params = [];
    const push = (c, v) => { params.push(v); sets.push(`${c}=$${params.length}`); };
    if (b.status !== undefined && ['new', 'in_conversation', 'kyb_pending', 'kyb_passed', 'quote_sent', 'negotiating', 'accepted', 'payment_pending', 'payment_received', 'in_production', 'shipped', 'completed', 'order_placed', 'human_requested', 'closed'].includes(b.status)) push('status', b.status);
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

// Daily standup — the primary workflow. Body: {date, attendees[], notes}.
// dryRun=true previews the extracted tasks for review before assigning; a second
// call with dryRun=false (or omitted) creates the tasks + emails Naresh the brief.
router.post('/meetings/standup', authMiddleware, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.notes || !String(b.notes).trim()) return res.status(400).json({ error: 'notes (standup transcript/notes) required' });
    const result = await runStandup({
      date: b.date,
      attendees: b.attendees || [],
      notes: b.notes,
      dryRun: b.dryRun === true,
    });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Auto-capture: poll Gmail for Gemini meeting-notes emails and process them
// (parse summary/decisions/next-steps, read the full Google Doc, assign tasks,
// email the brief). The primary, no-transcript-paste path.
router.post('/meetings/poll-gemini', authMiddleware, adminOnly, async (req, res) => {
  try {
    const lookbackDays = Math.min(30, Math.max(1, parseInt(req.body?.lookbackDays, 10) || 7));
    // dryRun previews synchronously. A real run can face a multi-email backlog
    // (each email = Doc fetch + Claude), which would exceed the HTTP timeout, so
    // fire it in the background and return 202 — the page reloads to show results.
    if (req.body?.dryRun === true) {
      const result = await pollGeminiMeetingNotes({ dryRun: true, lookbackDays });
      return res.json({ success: true, ...result });
    }
    pollGeminiMeetingNotes({ lookbackDays })
      .then(r => console.log(`[meet] gemini poll — ${r.processed}/${r.found} processed, ${r.tasks_created} tasks${r.warning ? ' | ' + r.warning : ''}`))
      .catch(e => console.error('[meet] gemini poll failed:', e.message));
    res.status(202).json({ started: true, message: 'Gemini sync started — processing notes in the background. Meetings will appear shortly.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync org-wide Meet sessions (Reports API) into meeting_recordings: detect
// standups, auto-process any with a fetchable transcript, store the rest as
// 'needs_transcript' for manual paste. Bridges Workspace Activity → the page.
router.post('/meetings/sync-workspace', authMiddleware, adminOnly, async (req, res) => {
  try {
    const lookbackDays = Math.min(30, Math.max(1, parseInt(req.body?.lookbackDays, 10) || 7));
    const result = await syncWorkspaceMeetings({ lookbackDays });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Attach a transcript to an existing (typically 'needs_transcript') meeting row
// and run the full analysis against the SAME meeting_id. dryRun previews first.
router.post('/meetings/:id/transcript', authMiddleware, adminOnly, async (req, res) => {
  try {
    const text = req.body?.transcript_text;
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'transcript_text required' });
    const c = (await query(`SELECT * FROM meeting_recordings WHERE meeting_id=$1 OR id=$1`, [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'meeting not found' });
    const meeting = {
      meeting_id: c.meeting_id, meeting_title: c.meeting_title, meeting_date: c.meeting_date,
      duration_seconds: c.duration_seconds, attendees: parseJson(c.attendees),
      transcript_text: String(text), recording_url: c.recording_url, is_standup: c.is_standup,
    };
    const dryRun = req.body?.dryRun === true;
    const result = await analyzeAndStore(meeting, { dryRun });
    res.json({ success: true, meeting_id: c.meeting_id, dryRun, ...result });
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

// PART 8 — org-wide Workspace Activity via the Admin SDK Reports API. Returns
// Meet sessions, unique recordings, active participants, detected standups, a
// day×hour heatmap, and the workspace user count. Degrades gracefully (with a
// `warning`) when the admin scopes/super-admin aren't configured yet.
router.get('/meetings/workspace-activity', authMiddleware, adminOnly, async (req, res) => {
  try {
    const lookbackDays = Math.min(30, Math.max(1, parseInt(req.query?.lookbackDays, 10) || 7));
    const [meet, drive, users] = await Promise.all([
      workspaceActivity.getWorkspaceMeetActivity({ lookbackDays }),
      workspaceActivity.getWorkspaceDriveActivity({ lookbackDays }).catch(() => ({ recordings: [] })),
      workspaceActivity.getAllWorkspaceUsers().catch(() => ({ users: [] })),
    ]);
    const sessions = meet.sessions || [];
    const standups = await detectStandups(sessions).catch(() => []);
    const participants = new Set();
    sessions.forEach(s => (s.participants || []).forEach(p => participants.add(p)));
    const heatmap = workspaceActivity.meetHeatmap(sessions);
    res.json({
      lookbackDays,
      domains: workspaceActivity.workspaceDomains(),
      workspace_users: (users.users || []).length,
      total_sessions: sessions.length,
      active_participants: participants.size,
      recordings_available: (drive.recordings || []).length,
      standups_detected: standups.length,
      sessions: sessions.slice(0, 100),
      recordings: (drive.recordings || []).slice(0, 50),
      standups: standups.slice(0, 30),
      heatmap: heatmap.grid,
      heatmap_max: heatmap.maxCount,
      warning: meet.warning || drive.warning || users.warning || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/meetings', authMiddleware, requireAnyTier('intelligence', 'goals'), async (req, res) => {
  try {
    const rows = (await query(`
      SELECT r.id, r.meeting_id, r.meeting_title, r.meeting_date, r.duration_seconds, r.attendees, r.summary, r.processed,
        COALESCE(r.status, CASE WHEN r.processed=1 THEN 'processed' ELSE 'needs_transcript' END) AS status,
        r.is_standup, r.recording_url, r.created_at,
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
    const claudeText = extractClaudeText(aiData);
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

// Regenerate the background image for a queued post. Admin-only (OpenAI cost).
// Two paths on ONE route (uploadReferenceImage is a no-op for JSON requests):
//   • JSON            → text-to-image via /v1/images/generations (Issue 4b)
//   • multipart+image → reference-image transform via /v1/images/edits (Issue 4c)
router.post('/linkedin/regenerate-image/:id', authMiddleware, adminOnly, uploadReferenceImage, async (req, res) => {
  try {
    const row = (await query(`SELECT * FROM linkedin_content_queue WHERE id=$1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'post not found' });
    // Issue 4b — editable prompt: if the admin supplied a custom prompt, use it
    // verbatim (they own the entire prompt — no brand suffix appended). Otherwise
    // fall back to the varied, day-themed auto-selected prompt (BUG 1 fix) so a
    // plain regenerate still doesn't reproduce the same image. Either way it is
    // stored back into image_prompt below.
    const custom = typeof req.body?.prompt === 'string' ? req.body.prompt.trim().slice(0, 1000) : '';
    const prompt = custom || selectImagePrompt(row.source_molecule, row.full_post, row.scheduled_for);
    // Issue 4c — a reference image (multipart) routes to the /v1/images/edits path.
    const referenceImage = req.file ? { buffer: req.file.buffer, mimetype: req.file.mimetype } : null;
    const result = await generatePostImage(row.source_molecule, row.post_type, prompt, referenceImage);
    if (result.skipped) return res.status(503).json({ error: result.reason });
    if (result.error) return res.status(502).json({ error: result.error });
    await query(
      `UPDATE linkedin_content_queue SET generated_image_url=$1, linkedin_image_asset_urn=$2, image_prompt=$3 WHERE id=$4`,
      [result.url, result.asset_urn || null, result.prompt || prompt, req.params.id]
    );
    res.json({ success: true, id: req.params.id, generated_image_url: result.url, linkedin_image_asset_urn: result.asset_urn || null, prompt: result.prompt, used_reference: !!referenceImage, model: result.model || null });
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

// ── Clinical Demand Intelligence (Step 7) ─────────────────────────────────────
// Additive, isolated block. GET endpoints are tier-gated (intelligence) AND
// feature-flag-gated (503 when RESEARCH_INTEL_ENABLED != 'true'). The admin /run
// endpoint is admin-only and intentionally NOT flag-gated — admins can invoke the
// orchestrator for testing even while the flag (and thus the nightly cron) is off.
// api_version is stamped on every response so a future v2 can change shapes without
// breaking existing clients.
const RESEARCH_INTEL_API_VERSION = 'research-intel-v1';
function researchIntelEnabled() {
  return String(process.env.RESEARCH_INTEL_ENABLED).toLowerCase() === 'true';
}
// clinical_studies stores array/object columns as JSON.stringify'd TEXT; parse them
// back for the client, falling back to a safe default on any malformed value.
function riSafeParse(str, fallback) { try { return JSON.parse(str); } catch { return fallback; } }
function riParseStudyArrays(row) {
  return {
    ...row,
    conditions: riSafeParse(row.conditions, []),
    interventions: riSafeParse(row.interventions, []),
    molecules_mentioned: riSafeParse(row.molecules_mentioned, []),
    collaborators: riSafeParse(row.collaborators, []),
    locations_countries: riSafeParse(row.locations_countries, []),
    biomarkers: riSafeParse(row.biomarkers, []),
  };
}

// GET /studies — paginated list. Molecule COUNTS only (full molecules in detail).
router.get('/research-intelligence/studies', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    if (!researchIntelEnabled()) return res.status(503).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Clinical Demand Intelligence is not enabled (RESEARCH_INTEL_ENABLED)' });
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);

    const where = [];
    const params = [];
    if (req.query.phase) { params.push(req.query.phase); where.push(`cs.phase = $${params.length}`); }
    if (req.query.therapeutic_area) { params.push(req.query.therapeutic_area); where.push(`cs.therapeutic_area = $${params.length}`); }
    if (req.query.catalog_match_status) {
      params.push(req.query.catalog_match_status);
      where.push(`EXISTS (SELECT 1 FROM study_molecules sm WHERE sm.study_id = cs.id AND sm.catalog_match_status = $${params.length})`);
    }
    // ── WHO IS STUDYING THIS MOLECULE ─────────────────────────────────────────
    // The question a supplier asks across a booth: "who actually uses leuprorelin?" Same EXISTS
    // shape as catalog_match_status above, so there is one way to ask about a study's molecules
    // rather than two.
    //
    // This comment used to end "substring, because the register writes 'Leuprolide Acetate' where a
    // person says 'leuprorelin'" — naming the exact failure and then not fixing it. A substring
    // cannot cross a name change; `leuprorelin` is not inside `leuprolide acetate`. So the term is
    // expanded to every legal name for the substance first, and the LIKE runs against all of them.
    if (req.query.molecule && String(req.query.molecule).trim().length >= 2) {
      const mexp = expandMolecule(req.query.molecule);
      params.push(likePatterns(mexp.terms));
      where.push(`EXISTS (SELECT 1 FROM study_molecules sm
                           WHERE sm.study_id = cs.id
                             AND ${moleculeLikeSql('LOWER(sm.molecule_name)', params.length)})`);
    }
    // ── THE BUYING-INTENT FILTER ──────────────────────────────────────────────
    // The single most useful column on this table for a commercial question, and the reason the
    // raw study count misleads. An INDUSTRY sponsor is a company DEVELOPING something, so it buys
    // API. A university or hospital running a Phase 4 of an approved drug buys commercial product
    // from a pharmacy and will never be a customer. Metformin has thousands of studies and almost
    // no API demand for exactly this reason; leuprorelin has far fewer and several real buyers.
    if (req.query.sponsor_type) {
      params.push(req.query.sponsor_type);
      where.push(`cs.sponsor_type = $${params.length}`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const total = Number((await query(`SELECT COUNT(*)::int AS c FROM clinical_studies cs ${whereSql}`, params)).rows[0].c);

    const pageParams = params.slice();
    pageParams.push(limit); const limIdx = pageParams.length;
    pageParams.push(offset); const offIdx = pageParams.length;
    // raw_json is deliberately NOT selected here (large; detail endpoint opt-in only).
    const rows = (await query(`
      SELECT cs.id, cs.nct_id, cs.brief_title, cs.official_title, cs.overall_status, cs.phase, cs.study_type,
             cs.conditions, cs.interventions, cs.molecules_mentioned, cs.lead_sponsor_name, cs.sponsor_type,
             cs.collaborators, cs.institution, cs.enrollment_count, cs.locations_countries, cs.start_date,
             cs.first_posted_date, cs.last_update_post_date, cs.expected_completion, cs.therapeutic_area, cs.disease,
             cs.biomarkers, cs.classification_summary, cs.classification_confidence, cs.classify_prompt_version,
             cs.ingested_at, cs.classified_at, cs.created_at,
             (SELECT COUNT(*)::int FROM study_molecules sm WHERE sm.study_id = cs.id) AS molecule_count,
             (SELECT COUNT(*)::int FROM study_molecules sm WHERE sm.study_id = cs.id AND sm.catalog_match_status = 'sourcing_opportunity') AS sourcing_opportunity_count
      FROM clinical_studies cs
      ${whereSql}
      -- Tiebreaker on cs.id ensures deterministic pagination when many studies share
      -- last_update_post_date (common — CT.gov updates in batches by date)
      ORDER BY cs.last_update_post_date DESC NULLS LAST, cs.id
      LIMIT $${limIdx} OFFSET $${offIdx}`, pageParams)).rows;

    const studies = rows.map(riParseStudyArrays);
    res.json({
      api_version: RESEARCH_INTEL_API_VERSION,
      studies, total_count: total, has_more: offset + rows.length < total, limit, offset,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /studies/:id — single study (by id OR nct_id) + all its molecules. raw_json
// excluded unless ?include_raw=true.
router.get('/research-intelligence/studies/:id', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    if (!researchIntelEnabled()) return res.status(503).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Clinical Demand Intelligence is not enabled (RESEARCH_INTEL_ENABLED)' });
    const includeRaw = String(req.query.include_raw).toLowerCase() === 'true';
    const row = (await query(`SELECT * FROM clinical_studies cs WHERE cs.id = $1 OR cs.nct_id = $1 LIMIT 1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Study not found' });

    const study = riParseStudyArrays(row);
    // JSON.stringify drops undefined keys, so raw_json simply won't appear unless requested.
    study.raw_json = includeRaw ? riSafeParse(row.raw_json, null) : undefined;

    const molecules = (await query(
      `SELECT * FROM study_molecules WHERE study_id = $1 ORDER BY inference_confidence DESC NULLS LAST`,
      [row.id]
    )).rows;
    res.json({ api_version: RESEARCH_INTEL_API_VERSION, study, molecules });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /run — admin-only manual orchestrator invocation. Synchronous. Defaults to a
// small, safe dry run. maxStudies clamped 1-20 (cron does the nightly 50); dryRun
// defaults TRUE and only an explicit false runs live. Runs even when the flag is off.
router.post('/research-intelligence/run', authMiddleware, adminOnly, async (req, res) => {
  try {
    // Number.isFinite guard so maxStudies=0 clamps to the floor of 1 (not the
    // default 10 — `0 || 10` is the classic falsy-value gotcha); NaN/undefined → 10.
    const rawMax = parseInt(req.body?.maxStudies);
    const maxStudies = Math.min(20, Math.max(1, Number.isFinite(rawMax) ? rawMax : 10));
    const dryRun = !(req.body?.dryRun === false || req.body?.dryRun === 'false'); // default true; explicit false → live
    const flagOn = researchIntelEnabled();
    const summary = await runResearchIntelIngest({ maxStudies, dryRun });
    res.json({
      api_version: RESEARCH_INTEL_API_VERSION,
      flag_enabled: flagOn,
      note: flagOn ? undefined : 'RESEARCH_INTEL_ENABLED is off; ran via admin override (nightly cron remains disabled).',
      ...summary,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Clinical Demand Intelligence — Phase 3 (contact enrichment + outreach) ────
// find-contacts (discovery, no persist) / resolve-org (persist + enrich + generate,
// force-gated) / contacts (read). requireTier('intelligence') naturally makes the
// two POSTs admin-effective (write access = rw = admin/super_admin only) while GET
// is readable by any intelligence-tier role. All flag-gated (503 when off).

// opus-4-8 standard pricing ($5 in / $25 out per 1M) for outreach LLM cost.
function outreachCostUsd(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) * 5 / 1e6 + (usage.output_tokens || 0) * 25 / 1e6;
}
// Load persisted org + contacts + outreach for a study (shared by GET /contacts and
// the resolve-org 409 "already resolved" response). Parses JSON-TEXT fields.
async function riLoadStudyContacts(study) {
  if (!study || !study.resolved_organization_id) return { organization: null, contacts: [], outreach: [] };
  const org = (await query('SELECT * FROM research_organizations WHERE id=$1', [study.resolved_organization_id])).rows[0] || null;
  if (org && org.resolution_metadata) org.resolution_metadata = riSafeParse(org.resolution_metadata, null);
  const contacts = org ? (await query('SELECT * FROM research_contacts WHERE organization_id=$1 ORDER BY role_category, full_name', [org.id])).rows : [];
  const outreach = (await query('SELECT * FROM research_outreach WHERE study_id=$1', [study.id])).rows
    .map(o => ({ ...o, referenced_molecules: riSafeParse(o.referenced_molecules, []) }));
  return { organization: org, contacts, outreach };
}

// POST /studies/:id/find-contacts — Tier A (name) or Tier B (body.domain). No persist,
// no LLM. Returns disambiguation candidates for the UI picker.
router.post('/research-intelligence/studies/:id/find-contacts', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    if (!researchIntelEnabled()) return res.status(503).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Clinical Demand Intelligence is not enabled (RESEARCH_INTEL_ENABLED)' });
    const study = (await query('SELECT * FROM clinical_studies cs WHERE cs.id=$1 OR cs.nct_id=$1 LIMIT 1', [req.params.id])).rows[0];
    if (!study) return res.status(404).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Study not found' });

    const domain = (req.body && typeof req.body.domain === 'string') ? req.body.domain.trim() : '';
    if (domain) {
      const r = await riResolve.resolveByDomain(domain);
      return res.json({ api_version: RESEARCH_INTEL_API_VERSION, mode: 'domain', candidates: r.organization ? [r.organization] : [], resolution: r.resolution, credits_used: r.credits_used, error: r.error });
    }
    const r = await riResolve.findOrgCandidates(study.lead_sponsor_name);
    res.json({ api_version: RESEARCH_INTEL_API_VERSION, mode: 'name', candidates: r.candidates, resolution: r.resolution, credits_used: r.credits_used, error: r.error });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /studies/:id/resolve-org — persist the picked org + enrich contacts (2+2 cap)
// + generate & persist outreach per contact. force:true required to re-resolve.
router.post('/research-intelligence/studies/:id/resolve-org', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    if (!researchIntelEnabled()) return res.status(503).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Clinical Demand Intelligence is not enabled (RESEARCH_INTEL_ENABLED)' });
    const study = (await query('SELECT * FROM clinical_studies cs WHERE cs.id=$1 OR cs.nct_id=$1 LIMIT 1', [req.params.id])).rows[0];
    if (!study) return res.status(404).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Study not found' });

    const org = req.body && req.body.org;
    if (!org || !org.apollo_org_id) return res.status(400).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'body.org with apollo_org_id required' });
    const force = req.body.force === true || req.body.force === 'true';

    // Safety: already resolved + not force → 409 with the existing data (no double-spend).
    if (study.resolved_organization_id && !force) {
      const existing = await riLoadStudyContacts(study);
      return res.status(409).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Study already resolved. Pass force:true to refresh contacts and outreach.', existing });
    }

    const pr = await riResolve.persistResolvedOrg({ studyId: study.id, org, resolution: req.body.resolution_metadata || null, userSelectedIndex: (req.body.user_selected_index ?? null) });
    if (pr.error) return res.status(500).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'persist failed: ' + pr.error });

    const fe = await riResolve.findAndEnrichContacts({ organizationId: pr.organization_id, apolloOrgId: org.apollo_org_id });
    const molecules = (await query('SELECT molecule_name, molecule_type, cas_number, catalog_match_status, inference_confidence FROM study_molecules WHERE study_id=$1', [study.id])).rows;

    let outreach_generated = 0, cost_usd = 0;
    const outErrors = [];
    for (const c of fe.contacts) {   // fe.contacts is capped at 2+2 — outreach spend is bounded
      const gen = await riOutreach.generateOutreach(study, { ...c, organization_name: org.name || org.display_name }, molecules);
      if (gen.usage) cost_usd += outreachCostUsd(gen.usage);
      if (gen.error) { outErrors.push('outreach ' + (c.full_name || c.apollo_contact_id) + ': ' + gen.error); continue; }
      if (gen.skipped) continue; // no actionable molecules — nothing to persist
      const row = (await query('SELECT id FROM research_contacts WHERE apollo_contact_id=$1', [c.apollo_contact_id])).rows[0];
      if (!row) { outErrors.push('outreach: contact row missing for ' + c.apollo_contact_id); continue; }
      await query(
        `INSERT INTO research_outreach (id, study_id, contact_id, subject, body, referenced_molecules, generation_prompt_version, model, generated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (study_id, contact_id) DO UPDATE SET
           subject=EXCLUDED.subject, body=EXCLUDED.body, referenced_molecules=EXCLUDED.referenced_molecules,
           generation_prompt_version=EXCLUDED.generation_prompt_version, model=EXCLUDED.model, generated_at=NOW()`,
        [crypto.randomUUID(), study.id, row.id, gen.subject, gen.body, JSON.stringify(gen.referenced_molecules || []), gen.prompt_version, gen.model]
      );
      outreach_generated++;
    }

    const data = await riLoadStudyContacts({ id: study.id, resolved_organization_id: pr.organization_id });
    res.json({
      api_version: RESEARCH_INTEL_API_VERSION,
      organization: data.organization,
      contacts: data.contacts,
      outreach: data.outreach,
      outreach_generated,
      credits_used: fe.credits_used,          // Apollo credits
      cost_usd: Number(cost_usd.toFixed(4)),  // LLM (opus-4-8)
      errors: [...(fe.errors || []), ...outErrors],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /studies/:id/contacts — persisted org + contacts + outreach. Read-only, no spend.
router.get('/research-intelligence/studies/:id/contacts', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    if (!researchIntelEnabled()) return res.status(503).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Clinical Demand Intelligence is not enabled (RESEARCH_INTEL_ENABLED)' });
    const study = (await query('SELECT id, resolved_organization_id FROM clinical_studies cs WHERE cs.id=$1 OR cs.nct_id=$1 LIMIT 1', [req.params.id])).rows[0];
    if (!study) return res.status(404).json({ api_version: RESEARCH_INTEL_API_VERSION, error: 'Study not found' });
    const data = await riLoadStudyContacts(study);
    res.json({ api_version: RESEARCH_INTEL_API_VERSION, ...data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Content Studio — multi-product content review (GolfNex first) ─────────────
// Drafts generated by the content pipeline (src/lib/agents/content) land in content_queue.
// A reviewer edits/approves/rejects and copies the text out MANUALLY — NO auto-publishing,
// same discipline as Apollo outreach. Reads/writes gated requireTier('intelligence')
// (write = rw = admin/super_admin/business_dev); the run route is adminOnly.

// GET /content — list drafts, filterable by ?product= and ?status=. Newest first.
router.get('/content', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const clauses = [], params = [];
    if (req.query.product) { params.push(req.query.product); clauses.push(`product = $${params.length}`); }
    if (req.query.status)  { params.push(req.query.status);  clauses.push(`status = $${params.length}`); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const rows = (await query(`SELECT * FROM content_queue ${where} ORDER BY created_at DESC LIMIT 200`, params)).rows;
    res.json({ items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /content/run — admin-only manual pipeline trigger. Never-throws: the orchestrator
// collects its own errors into the summary and returns it, so we just relay that summary
// (the request never hangs on a failing source/LLM/DB).
router.post('/content/run', authMiddleware, adminOnly, async (req, res) => {
  try {
    const product = (req.body && req.body.product) || 'golfnex';
    const summary = await runContentPipeline(product);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /content/:id — one item.
router.get('/content/:id', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const row = (await query('SELECT * FROM content_queue WHERE id = $1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /content/:id — approve | reject | edit. approve/reject set STATUS ONLY (no publish).
// edit sets edited=true and PRESERVES the original headline/body — original_* is captured
// exactly once, on the first edit, via COALESCE (never silently overwritten).
router.put('/content/:id', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const action = req.body && req.body.action;
    const reviewer = (req.user && (req.user.email || req.user.id)) || null;

    if (action === 'approve' || action === 'reject') {
      const status = action === 'approve' ? 'approved' : 'rejected';
      const upd = await query(
        `UPDATE content_queue SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3 RETURNING *`,
        [status, reviewer, req.params.id]);
      if (!upd.rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json(upd.rows[0]);
    }

    if (action === 'edit') {
      const rawH = req.body.headline, rawB = req.body.body;
      const headline = (rawH != null && String(rawH).trim() !== '') ? String(rawH) : null;
      const body = (rawB != null && String(rawB).trim() !== '') ? String(rawB) : null;
      if (!headline && !body) return res.status(400).json({ error: 'edit requires a headline and/or body' });
      const upd = await query(
        `UPDATE content_queue
            SET original_headline = COALESCE(original_headline, headline),
                original_body     = COALESCE(original_body, body),
                headline = COALESCE($1, headline),
                body     = COALESCE($2, body),
                edited = TRUE
          WHERE id = $3 RETURNING *`,
        [headline, body, req.params.id]);
      if (!upd.rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json(upd.rows[0]);
    }

    return res.status(400).json({ error: "action must be 'approve', 'reject', or 'edit'" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Prospects — product-scoped facility prospecting (GolfNex, Favly) ───────────
// The first product-aware page. reads/writes requireTier('sales'); the two run routes
// adminOnly. Paginated; sorted by review count (best proxy for a real business).
const PROSPECT_STATUSES = ['new', 'qualified', 'enriched', 'contacted', 'rejected'];

// GET /prospects — filterable (product/status/subtype/booking_platform/has_website), paginated.
router.get('/prospects', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const product = String(req.query.product || 'golfnex').trim();
    // Default to the historical reading for an unconfigured product, so a new product added to
    // the table but not to config.js behaves as before rather than inverting silently.
    const primeSignal = ((getProspectingConfig(product) || {}).primeSignal) === 'platform' ? 'platform' : 'no-platform';
    const clauses = ['product = $1'], params = [product];
    if (req.query.status)  { params.push(req.query.status);  clauses.push(`status = $${params.length}`); }
    if (req.query.subtype) { params.push(req.query.subtype); clauses.push(`subtype = $${params.length}`); }
    // 'prime' is SEMANTIC, resolved per product from prospecting config rather than by the
    // caller: for golf/beauty a platform means they already solved booking (prime = none), for
    // linkabl an ATS means real requisition volume (prime = has one). Sending the polarity from
    // the client would mean two copies of the rule; this keeps config.js the only place it lives.
    if (req.query.booking_platform === 'prime') {
      clauses.push(primeSignal === 'platform' ? 'booking_platform IS NOT NULL' : 'booking_platform IS NULL');
    }
    else if (req.query.booking_platform === 'none') clauses.push('booking_platform IS NULL');
    else if (req.query.booking_platform === 'any-platform') clauses.push('booking_platform IS NOT NULL');
    else if (req.query.booking_platform) { params.push(req.query.booking_platform); clauses.push(`booking_platform = $${params.length}`); }
    if (req.query.has_website === 'true') clauses.push('website IS NOT NULL');
    else if (req.query.has_website === 'false') clauses.push('website IS NULL');
    // reachable filter: 'true' = the true prime pool (site actually fetched); 'false' = the
    // unreachable pool (dead/403/timeout — still findable, they need a phone call not a visit).
    if (req.query.reachable === 'true') clauses.push('reachable = true');
    else if (req.query.reachable === 'false') clauses.push('reachable = false');
    const where = 'WHERE ' + clauses.join(' AND ');

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const total = (await query(`SELECT COUNT(*)::int n FROM prospects ${where}`, params)).rows[0].n;
    const items = (await query(
      `SELECT id, product, name, address, phone, website, subtype, region, state, rating, rating_count,
              booking_platform, reachable, unreachable_reason, status, notes, qualified_at, created_at
         FROM prospects ${where}
         ORDER BY rating_count DESC NULLS LAST, id
         LIMIT ${pageSize} OFFSET ${offset}`, params)).rows;

    // product-wide summary (independent of the table filters). no_platform is split: the true
    // prime pool (reachable) vs the unreachable pool (dead but still worth a phone call).
    const summary = (await query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE status='qualified')::int qualified,
              COUNT(*) FILTER (WHERE status='qualified' AND booking_platform IS NULL)::int no_platform,
              COUNT(*) FILTER (WHERE status='qualified' AND booking_platform IS NULL AND reachable = true)::int no_platform_reachable,
              COUNT(*) FILTER (WHERE status='qualified' AND booking_platform IS NULL AND reachable = false)::int no_platform_unreachable,
              COUNT(*) FILTER (WHERE status='qualified' AND booking_platform IS NOT NULL)::int on_platform,
              COUNT(*) FILTER (WHERE status='rejected')::int rejected,
              COUNT(*) FILTER (WHERE status='qualified' AND booking_platform IS NOT NULL AND reachable = true)::int on_platform_reachable
         FROM prospects WHERE product = $1`, [product])).rows[0];

    // The one number that means "worth contacting", computed on the product's own polarity so
    // the page never has to decide.
    summary.prime_pool = primeSignal === 'platform' ? summary.on_platform_reachable : summary.no_platform_reachable;

    res.json({ product, page, pageSize, total, items, summary, prime_signal: primeSignal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /prospects/run — admin-only Places enumeration. Never-throws (relays the summary).
router.post('/prospects/run', authMiddleware, adminOnly, async (req, res) => {
  try {
    const product = (req.body && req.body.product) || 'golfnex';
    const summary = await runProspecting(product);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /prospects/qualify — admin-only booking-signature qualifier. Never-throws (relays summary).
router.post('/prospects/qualify', authMiddleware, adminOnly, async (req, res) => {
  try {
    const product = (req.body && req.body.product) || 'golfnex';
    const summary = await runQualifyProspects(product);
    res.json(summary);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /prospects/:id — one prospect (full record).
router.get('/prospects/:id', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const row = (await query('SELECT * FROM prospects WHERE id = $1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /prospects/:id — update status and/or notes.
router.put('/prospects/:id', authMiddleware, requireTier('sales'), async (req, res) => {
  try {
    const { status, notes } = req.body || {};
    if (status !== undefined && !PROSPECT_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${PROSPECT_STATUSES.join(', ')}` });
    }
    if (status === undefined && notes === undefined) {
      return res.status(400).json({ error: 'nothing to update (status and/or notes required)' });
    }
    const upd = await query(
      `UPDATE prospects
          SET status = COALESCE($1, status),
              notes  = COALESCE($2, notes)
        WHERE id = $3 RETURNING *`,
      [status !== undefined ? status : null, notes !== undefined ? notes : null, req.params.id]);
    if (!upd.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(upd.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SiteNex (sold through referral partners) read-only screens ─────────────────────────────────
// Prospects, Deals and Packages. All three are now requireTier('sitenex') — a tier held by super_admin,
// admin and partner — with the ROWS scoped per caller: deals by partner_id (partnerScopeSql) and prospects
// by granted territory (territoryScopeSql). Packages are a catalogue and identical for everyone, which is
// the whole model: ONE PRODUCT, MANY PARTNERS, differing only in territory and achieved volume.
//
// Findings are rendered to PLAIN SENTENCES HERE, server-side, by the same findings-text.js the
// call-sheet generator uses. The browser cannot require that module, so formatting in the client
// would mean a second copy of the wording — and then the sheet a rep reads and the screen a
// manager reads would describe the same site differently.
//
// NOTE: these deliberately do NOT use ?booking_platform=prime. That filter is resolved from
// primeSignal, which sitenex does not set (it declares primeBy:'site_score'), so 'prime' would fall
// back to "no booking platform" — near the opposite of what SiteNex wants. Filtering is on site_score.
const SITENEX_DEAL_STATUSES = ['new', 'contacted', 'proposal_sent', 'signed', 'intake', 'building', 'live', 'lost'];
const SITENEX_BUCKETS = ['scored', 'no_website', 'dead_site', 'unscannable'];
// The subtypes SiteNex actually ships, read from the prospecting config so this cannot drift from
// what the enumerator runs. The screen DEFAULTS to these three but still lists all nine in the
// facet: the other six are the dropped experiment categories (auto_repair, daycare, dental, hvac,
// legal, plumbing) and their ~608 rows are still in the table. Defaulting stops anyone working the
// wrong list by accident; keeping them visible stops anyone rediscovering orphan rows in six
// months and wondering what they are. Hiding them is the version that causes the confusion later.
const sitenexShippingSubtypes = () => ((getProspectingConfig('sitenex') || {}).subtypes || []).map(s => s.key);

// ── SCOPED TO TERRITORY, from 2026-10-01. This REPLACES "staff only, and it stays that way". ──
//
// It said that because, with no notion of a partner's patch, the only two answers available were "all of
// our scored leads" or "none", and none was correct. Territories make the third answer expressible — a
// partner sees the prospects in the patch we granted them — and that is what a referral partner is for.
//
// THE REFUSAL IS REPLACED, NOT RELAXED. adminOnly becomes requireTier('sitenex'), a tier held by
// super_admin, admin and partner and nobody else, and then territoryScopeSql decides the ROWS. It fails
// CLOSED: a partner with no partner_territories rows gets `FALSE` and sees nothing at all, as does one
// whose lookup throws. "Nobody has decided what this partner may see" reads as "nothing", never as
// "everything".
//
// Still more than one gate: the resolver must find sitenex.prospects.list in the caller's template, the
// product boundary must find 'sitenex' in their user_products, and now the territory must match.
router.get('/sitenex/prospects', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const { findingSentences, agencyNote, pageSpeedNote, bucketOf, BUCKET_LABEL, packageLabel } =
      require('../lib/agents/prospecting/findings-text');
    const clauses = [`product = 'sitenex'`], params = [];
    // subtype accepts a comma-separated list so the screen can default to the shipping three.
    if (req.query.subtype) {
      const list = String(req.query.subtype).split(',').map(x => x.trim()).filter(Boolean);
      if (list.length) { params.push(list); clauses.push(`subtype = ANY($${params.length})`); }
    }
    if (req.query.region)  { params.push(req.query.region);  clauses.push(`region = $${params.length}`); }
    // Name search, for the deal picker. Added here rather than in a second lightweight endpoint: a
    // separate "list sitenex prospects" query would be a second thing to keep in step with the bucket
    // definitions and with the agency tiebreak in the sort below, and those are exactly the parts that
    // would drift apart.
    if (req.query.q) {
      params.push('%' + String(req.query.q).trim() + '%');
      clauses.push(`name ILIKE $${params.length}`);
    }
    // status is the QUALIFIER's verdict (new | qualified | rejected), not an outreach state — see the note
    // in src/lib/outreach/registry.js. The picker asks for 'qualified' so a rejected row cannot be turned
    // into a deal by accident.
    if (req.query.status) { params.push(String(req.query.status)); clauses.push(`status = $${params.length}`); }
    if (req.query.package === 'none') clauses.push(`recommended_package IS NULL`);
    else if (req.query.package) { params.push(req.query.package); clauses.push(`recommended_package = $${params.length}`); }
    // Bucket is derived, not stored — express each one as the condition the scorer writes.
    const bucket = req.query.bucket;
    if (bucket === 'no_website') clauses.push(`website IS NULL`);
    else if (bucket === 'unscannable') clauses.push(`site_findings->>'unscannable' = 'true'`);
    else if (bucket === 'dead_site') clauses.push(`site_findings->>'reachable' = 'false' AND site_findings->>'unscannable' IS NULL`);
    else if (bucket === 'scored') clauses.push(`site_score IS NOT NULL AND site_findings->>'unscannable' IS NULL`);
    // ── TERRITORY. The last clause, and the one that can empty the result entirely. ──
    //
    // Scoped on the prospects columns the territory dimensions name. Worth knowing: `region` is the
    // ENUMERATOR'S TILE LABEL and migrate-prospects.js calls it "NOT authoritative geography", while
    // `state` is derived from the address and is. A territory granted on a region therefore follows the
    // tile that found the business, not necessarily where it is — fine for 'Rockford', which is both, and
    // a thing to know before granting a region that is not a real place name.
    const terr = await territoryScopeSql(req.user, '', params.length + 1);
    clauses.push(terr.sql);
    params.push(...terr.params);
    const where = clauses.join(' AND ');
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));

    const total = parseInt((await query(`SELECT COUNT(*)::int n FROM prospects WHERE ${where}`, params)).rows[0].n);
    const rows = (await query(
      `SELECT id, name, subtype, address, region, phone, website, site_url, site_score, rating_count,
              recommended_package, site_findings, status, reject_reason, owner_email, owner_source
         FROM prospects WHERE ${where}
        -- THE AGENCY SIGNAL IS A TIEBREAK, NOT A SELECTOR.
        --
        -- It appears here in the ORDER BY and nowhere in the WHERE, and that placement is the decision:
        -- the segment is defined by what the SITE says — no website, or a site that scores badly — because
        -- those are measured directly from the site and mean the same thing in Rockford and in Phoenix.
        -- "Somebody may already be paid to look after this" is a reason to call it LAST, not a reason to
        -- exclude it or to include it.
        --
        -- It is also deliberately the WEAKEST term, after site_score and before review count: a badly
        -- scoring agency-tracked site still outranks a decent unmanaged one, because the site is the thing
        -- we are selling against.
        --
        -- NOT to be strengthened by broadening the duda detector. 77 of 114 current signals are duda, so
        -- "agency-tracked" is largely one reseller platform — chasing more platforms is investing in a
        -- proxy when site_score and website-absence are the real measurement.
        ORDER BY site_score DESC NULLS LAST,
                 (jsonb_array_length(COALESCE(site_findings->'agency_signals','[]'::jsonb)) > 0) ASC,
                 rating_count ASC NULLS FIRST, id
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params)).rows;

    const cityOf = (address, region) => {
      const m = /,\s*([^,]+),\s*[A-Z]{2}\s+\d{5}/.exec(address || '');
      return (m && m[1].trim()) || String(region || '').replace(/,\s*(IL|Illinois)$/, '') || null;
    };
    const items = rows.map(r => {
      const f = r.site_findings || {};
      const b = bucketOf(r);
      return {
        id: r.id, name: r.name, subtype: r.subtype, city: cityOf(r.address, r.region), region: r.region,
        phone: r.phone, website: r.website, site_url: r.site_url,
        site_score: r.site_score, rating_count: r.rating_count,
        owner_email: r.owner_email, owner_source: r.owner_source,
        // WHY there is no email, so the column can say so instead of looking empty by accident.
        // A blank cell and "we could not look" are different facts and a rep needs to know which.
        email_absence: r.owner_email ? null
          : (!r.website ? 'no website to scan'
            : (f.unscannable ? 'site blocked our scan'
              : (f.reachable === false ? "site doesn't load"
                : (f.emails ? 'none published on the site' : 'not scanned for email yet')))),
        recommended_package: r.recommended_package, package_label: packageLabel(r.recommended_package),
        bucket: b, bucket_label: BUCKET_LABEL[b],
        agency_flag: (f.agency_signals || []).length > 0,
        builder: f.builder || null,
        status: r.status, reject_reason: r.reject_reason,
        // the expanded row — the same sentences the call sheet prints
        findings: findingSentences(f), agency_note: agencyNote(f), pagespeed_note: pageSpeedNote(f),
      };
    });

    const summary = (await query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE website IS NULL)::int no_website,
              COUNT(*) FILTER (WHERE site_findings->>'unscannable' = 'true')::int unscannable,
              COUNT(*) FILTER (WHERE site_findings->>'reachable' = 'false' AND site_findings->>'unscannable' IS NULL)::int dead_site,
              COUNT(*) FILTER (WHERE recommended_package = 'P2')::int p2,
              COUNT(*) FILTER (WHERE recommended_package = 'P1')::int p1,
              COUNT(*) FILTER (WHERE status = 'rejected')::int rejected,
              COUNT(owner_email)::int with_email,
              COUNT(*) FILTER (WHERE owner_email IS NULL AND website IS NOT NULL
                               AND site_findings->>'unscannable' IS NULL
                               AND COALESCE(site_findings->>'reachable','') <> 'false')::int scannable_without_email
         FROM prospects WHERE product = 'sitenex'`)).rows[0];
    const facets = {
      subtypes: (await query(`SELECT DISTINCT subtype FROM prospects WHERE product='sitenex' AND subtype IS NOT NULL ORDER BY 1`)).rows.map(x => x.subtype),
      regions: (await query(`SELECT DISTINCT region FROM prospects WHERE product='sitenex' AND region IS NOT NULL ORDER BY 1`)).rows.map(x => x.region),
      buckets: SITENEX_BUCKETS, packages: ['P1', 'P2'],
      // What the screen should preselect, and which of the nine are retired. Sent rather than
      // duplicated client-side so config.js stays the single source of truth.
      shipping_subtypes: sitenexShippingSubtypes(),
    };
    res.json({ page, pageSize, total, items, summary, facets,
      // WHAT SCOPED THIS, so an empty screen can explain itself instead of looking broken. A partner with
      // no territory is the commonest cause of "there are no prospects" and is not a bug.
      scope: terr.isStaff ? 'all prospects' : (terr.failed ? 'none' : 'own territory only'),
      territories: terr.territories.map(t => `${t.dimension}=${t.value}`),
      scope_note: terr.isStaff ? null
        : (terr.failed
          ? 'You have no territory yet, so no prospects are shown. Ask us to grant one.'
          : (terr.territories.length
            // Their own book is ALWAYS included, so the sentence says so — otherwise a partner seeing a
            // business outside their patch would reasonably think the scoping had failed.
            ? `Showing the prospects in your territory (${terr.territories.map(t => t.value).join(', ')}), `
              + 'plus every business you registered yourself.'
            : 'You have no territory yet, so this shows only the businesses you registered yourself.')),
      // TRUE for everyone now (2026-10-01). Outreach was staffOnly while a note could only be ours; a partner
      // working their own territory records their own calls, and outreach.partner_id keeps A's out of B's
      // sight. The flag STAYS, rather than being deleted as always-true: it is the server's answer to "may
      // this caller use outreach", and the day that stops being yes for somebody, the screen already asks.
      can_track_outreach: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /sitenex/deals MOVED to src/api/sitenex-phase3.routes.js, where the write path lives.
//
// Not copied — MOVED. It was the same path declared twice, and since routes.js mounts first the new
// one would have been unreachable dead code while this one kept serving a payload missing every
// client column the contract generator needs. Two implementations of one path is the drift this
// codebase has already paid for once.
//
// The move is payload-safe: the new handler returns a strict SUPERSET of these columns in the same
// envelope ({ total, statuses, columns, scope, partner_id }), so the existing board page is unaffected.
// The path is unchanged, so the permissions registry entry (sitenex.deals.list, ref
// "GET /api/sitenex/deals") and the /api/sitenex/* product-boundary wildcard both still match.
//
// The reasoning that belongs with it, kept here because it is about the GATE and not the query:
// Deals and Packages are the COMMERCIAL relationship, so the referral partner sees them —
// requireTier('sitenex') rather than adminOnly, a tier held by super_admin, admin and partner and
// nobody else. That is a widening of exactly one role, and it is not the only gate: the resolver still
// has to find the feature in the caller's template, and the product boundary still has to find
// 'sitenex' in their user_products. Three independent refusals for an outside account.

router.get('/sitenex/packages', authMiddleware, requireTier('sitenex'), async (req, res) => {
  try {
    const rows = (await query(
      `SELECT code, name, summary, included, not_included, setup_fee_cents, monthly_cents,
              typical_weeks, active
         FROM sitenex_packages ORDER BY code`)).rows;
    // PRICES ARE DELIBERATELY NULL until they are decided. The contract is that a consumer must
    // REFUSE to render a null price rather than printing $0, so the API hands the client an
    // explicit `priced: false` and no numbers at all — there is nothing for a template to
    // accidentally coerce to zero.
    res.json({
      packages: rows.map(r => ({
        code: r.code, name: r.name, summary: r.summary, active: r.active,
        typical_weeks: r.typical_weeks,
        included: r.included || [], not_included: r.not_included || [],
        priced: r.setup_fee_cents != null || r.monthly_cents != null,
        setup_fee_usd: r.setup_fee_cents == null ? null : r.setup_fee_cents / 100,
        monthly_usd: r.monthly_cents == null ? null : r.monthly_cents / 100,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Event Agent: CPHI Milan 2026 ──────────────────────────────────────────────
// Sourcing intelligence for the show floor: which API manufacturers holding an active US
// Type II DMF for a molecule our trial pipeline needs are actually exhibiting, and where.
// All three routes are requireTier('intelligence') and FREE — they read tables the offline
// scripts populate (scripts/ingest-dmf.js -> match-dmf-molecules.js -> lookup-cphi-exhibitors.js).
// Nothing here calls FDA, CPHI or an LLM, so no route can spend.
const CPHI_EVENT = 'cphi-milan-2026';
// MUST MATCH scripts/lookup-cphi-exhibitors.js --top. `molecules_covered` on each row is a count of
// how many of the TOP-N molecules by clinical demand that holder covers, so a drawer listing every
// molecule tied to the holder shows a different number of rows than the number you tapped. The
// first version did exactly that: Dr Reddy's showed 23 on the row and a far longer list inside, and
// the big Indian generics all looked alike because the unrestricted list carries the same long
// oncology tail. A guard test pins the two together.
const CPHI_TOP_N = 100;
// supplier = we buy from them · platform_partner = it sells our platform to its own clients, the EU
// repeat of the ACBM Partners model · qc_lab = we recruit it into LabConnect · buyer = we sell testing to it.
// Must match the CHECK constraint in scripts/migrate-cphi-roles.js.
const CPHI_ROLES = ['supplier', 'platform_partner', 'qc_lab', 'buyer'];
// The partner and buyer lists run on both sides of the Atlantic. src/lib/cphi/markets.js owns what
// each value means and says where the underlying register is blunt.
const { isMarket: cphiIsMarket } = require('../lib/cphi/markets');
const { DEMAND_SQL } = require('../lib/dmf/demand');
// The SAME fold the exhibitor matcher uses. A contact typed on the floor has to collide with the
// one the seed imported, or the same company ends up in the list twice under two spellings.
const { normalizeCompany: cphiNormalizeCompany } = require('../lib/cphi/match-company');
// One substance, several legal names. A customer at CPHI Milan asked for LEUPRORELIN (the INN) and
// got nothing, because every holder is filed under LEUPROLIDE (the USAN). src/lib/molecules/synonyms.js
// owns the equivalence table and the salt-stripping, and says why each is needed.
const { expandMolecule, moleculeLikeSql, likePatterns } = require('../lib/molecules/synonyms');
// And one substance must come back as ONE row. The register files Leuprolide, Leuprolide Acetate and
// Leuprorelin separately, which splits the holders three ways and makes the page print "SOLE holder
// worldwide" over a substance three companies hold. src/lib/molecules/merge.js recounts.
const { mergeMoleculeRows } = require('../lib/molecules/merge');
const CPHI_REVIEW_STATUSES =['unreviewed', 'auto_confirmed', 'entity_review', 'confirmed', 'rejected'];

// ── Event Agent: THE SECOND EVENT ─────────────────────────────────────────────
// src/lib/events/registry.js owns what an event and a role are. These routes are additive: the
// /events/cphi/* routes below are untouched, because CPHI is a live page being used and a
// generalisation that breaks it to look tidier is a bad trade four days before another show.
const eventRegistry = require('../lib/events/registry');
const { sponsorRankSql, attachExhibitors, onlyBuyers } = require('../lib/events/sponsor-rank');

// GET /events — what events exist, their roles and which one a page should open on.
// Free: a read of a constant. No DB, no LLM.
router.get('/events', authMiddleware, requireAnyTier('intelligence', 'procurement'), async (req, res) => {
  res.json({
    events: eventRegistry.publicEvents(),
    default_slug: eventRegistry.defaultEventSlug(new Date()),
  });
});

// GET /events/:slug/exhibitors?role=linkable — the worked list for a role with no ranking signal.
//
// Separate from /sponsors because the two answer different questions. /sponsors ranks OUR OWN trial
// data and uses the floor as a bonus; this returns the published exhibitor list itself, which for
// the AROS and LinkAble tabs IS the list. Alphabetical, because there is no signal to rank by, and
// inventing an order would imply one. Free: one indexed read.
//
// `next()` on an unknown slug, NOT 404. This pattern shadows the literal /events/cphi/* routes
// below — Express matches in registration order and `:slug` happily captures "cphi" — so a 404 here
// meant GET /events/cphi/exhibitors returned "Unknown event: cphi" and the live CPHI page went
// blank. Falling through lets the specific route answer, and leaves Express to 404 a slug nothing
// claims. Caught by src/api/cphi-routes.test.js, which is the only reason it is not in production.
router.get('/events/:slug/exhibitors', authMiddleware, requireAnyTier('intelligence', 'procurement'), async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '');
    const ev = eventRegistry.getEvent(slug);
    if (!ev) return next();
    const role = eventRegistry.isRoleOf(slug, req.query.role) ? req.query.role : eventRegistry.rolesFor(slug)[0];
    const def = eventRegistry.roleDef(slug, role);

    const items = (await query(
      `SELECT id, holder, exhibitor_name, exhibiting, booth, hall, match_tier, review_status,
              entity_note, role, role_note, market, checked_at, met_in_person, linkedin_connected
         FROM cphi_exhibitor_matches
        WHERE event_slug = $1 AND role = $2
        ORDER BY holder`, [slug, role])).rows;

    res.json({
      event: { slug: ev.slug, name: ev.name, city: ev.city, starts: ev.starts, ends: ev.ends },
      role, role_label: def ? def.label : role, role_note: def ? def.note : null,
      basis: def ? def.basis : null,
      ranked: false,
      count: items.length,
      on_floor: items.filter((r) => r.exhibiting).length,
      items,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /events/:slug/sponsors?role=abiozen — the SCOPE Europe target list.
//
// This is the route the CPHI `buyer` tab should have been. That tab asked the FDA establishment
// register "who is registered to make something", got dairies, poultry and hand sanitizer, and
// returned 13 on-floor out of 60 with zero exact matches. This asks clinical_studies "who is
// developing a drug", which is what `sponsor_type = 'INDUSTRY'` means by definition.
//
// Ranking, exclusions and the show-floor tie-in all live in src/lib/events/sponsor-rank.js, which
// explains why the score weights what it does. Free: reads our own tables only.
// Same next()-on-unknown-slug rule as /exhibitors above, for the same reason.
router.get('/events/:slug/sponsors', authMiddleware, requireAnyTier('intelligence', 'procurement'), async (req, res, next) => {
  try {
    const slug = String(req.params.slug || '');
    const ev = eventRegistry.getEvent(slug);
    if (!ev) return next();

    const role = eventRegistry.isRoleOf(slug, req.query.role) ? req.query.role : eventRegistry.rolesFor(slug)[0];
    const def = eventRegistry.roleDef(slug, role);
    // A role whose basis is not 'demand' has no sponsor ranking to give. Say so explicitly rather
    // than returning an empty list, which reads identically to "nobody qualifies".
    if (!def || def.basis !== 'demand') {
      return res.json({
        event: { slug: ev.slug, name: ev.name, city: ev.city, starts: ev.starts, ends: ev.ends },
        role, role_label: def ? def.label : role, role_note: def ? def.note : null,
        basis: def ? def.basis : null, ranked: false, count: 0, items: [],
        hint: 'This role has no ranking signal in our data yet — it is worked from the exhibitor list, not computed.',
      });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
    const minStudies = Math.max(parseInt(req.query.min_studies, 10) || 1, 1);

    const ranked = (await query(sponsorRankSql({ limit, minStudies }))).rows;
    // Drop government institutes and consortia that ClinicalTrials.gov classes INDUSTRY, THEN tie
    // to the floor. Order matters: filtering after the match would leave a booth attached to a row
    // that is about to be discarded.
    const buyers = onlyBuyers(ranked);

    const exhibitors = (await query(
      `SELECT id, holder, holder_normalized, exhibitor_name, booth, hall, exhibiting
         FROM cphi_exhibitor_matches WHERE event_slug = $1 AND role = $2`, [slug, role])).rows;

    const items = attachExhibitors(buyers, exhibitors);
    const onFloor = items.filter((r) => r.exhibiting).length;

    res.json({
      event: { slug: ev.slug, name: ev.name, city: ev.city, starts: ev.starts, ends: ev.ends },
      role, role_label: def.label, role_note: def.note, basis: def.basis,
      ranked: true,
      count: items.length,
      on_floor: onFloor,
      // Stated plainly so the page can say it: an empty exhibitor table is not an empty floor.
      exhibitor_list_loaded: exhibitors.length > 0,
      items,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /events/cphi/exhibitors — the priority table, ranked by molecules covered.
// Defaults to exhibiting-only because that is what the page opens on; pass exhibiting=false
// for the "not on the floor" view or exhibiting=any for everything.
router.get('/events/cphi/exhibitors', authMiddleware, requireAnyTier('intelligence', 'procurement'), async (req, res) => {
  try {
    const clauses = ['event_slug = $1'], params = [CPHI_EVENT];
    // Defaults to 'supplier' so every existing caller keeps the list it has always had. The floor
    // carries three different conversations — see scripts/migrate-cphi-roles.js.
    const role = CPHI_ROLES.includes(req.query.role) ? req.query.role : 'supplier';
    params.push(role); clauses.push(`role = $${params.length}`);
    // 'all' and anything unrecognised mean no market clause. A hand-typed value must widen the list,
    // never silently empty it — an empty table reads as "nobody from the EU is here", which is a
    // different and much more damaging statement than "that filter does not exist".
    const market = cphiIsMarket(req.query.market) && req.query.market !== 'all' ? req.query.market : null;
    if (market) { params.push(market); clauses.push(`market = $${params.length}`); }
    if (req.query.exhibiting === 'false') clauses.push('exhibiting = false');
    else if (req.query.exhibiting !== 'any') clauses.push('exhibiting = true');
    if (req.query.tier) { params.push(req.query.tier); clauses.push(`match_tier = $${params.length}`); }
    if (req.query.review_status) { params.push(req.query.review_status); clauses.push(`review_status = $${params.length}`); }
    const where = 'WHERE ' + clauses.join(' AND ');

    const items = (await query(
      `SELECT id, holder, exhibitor_name, exhibiting, booth, hall, match_tier, review_status,
              entity_note, molecules_covered, checked_at, role, role_note, market,
              met_in_person, linkedin_connected
         FROM cphi_exhibitor_matches ${where}
        ORDER BY molecules_covered DESC, holder`, params)).rows;

    // Event-wide summary, independent of the filters above — the header row must not move
    // when someone filters the table.
    // Per-role totals for the tabs. Event-wide and independent of the filters, like the summary.
    const roles = (await query(
      `SELECT role, COUNT(*) FILTER (WHERE exhibiting)::int on_floor, COUNT(*)::int checked
         FROM cphi_exhibitor_matches WHERE event_slug = $1 GROUP BY role`, [CPHI_EVENT])).rows;

    // Which markets this role actually has rows for, so the filter offers US/EU only where one
    // exists rather than offering an option that can only ever return nothing.
    const markets = (await query(
      `SELECT market, COUNT(*) FILTER (WHERE exhibiting)::int on_floor, COUNT(*)::int checked
         FROM cphi_exhibitor_matches
        WHERE event_slug = $1 AND role = $2 AND market IS NOT NULL
        GROUP BY market ORDER BY 2 DESC`, [CPHI_EVENT, role])).rows;

    const summary = (await query(
      `SELECT COUNT(*) FILTER (WHERE exhibiting)::int exhibiting,
              COUNT(*)::int checked,
              COUNT(DISTINCT booth) FILTER (WHERE exhibiting)::int booths,
              COALESCE(SUM(molecules_covered) FILTER (WHERE exhibiting AND review_status IN ('auto_confirmed','entity_review','confirmed')), 0)::int molecule_links,
              COUNT(*) FILTER (WHERE review_status = 'entity_review')::int entity_review,
              COUNT(*) FILTER (WHERE review_status = 'unreviewed' AND match_tier = 'token')::int unverified
         FROM cphi_exhibitor_matches WHERE event_slug = $1 AND role = $2`, [CPHI_EVENT, role])).rows[0];

    // The DMF file the whole page rests on. Surfaced so staleness is visible: the list is
    // quarterly, so by the October show this data is roughly ten weeks old.
    const src = (await query(
      `SELECT source_file, MAX(ingested_at) ingested_at, COUNT(*)::int rows
         FROM dmf_holders GROUP BY source_file ORDER BY MAX(ingested_at) DESC LIMIT 1`)).rows[0] || null;

    res.json({ event: CPHI_EVENT, role, roles, market: market || 'all', markets, items, summary, dmf_source: src });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CPHI's two READ routes are requireAnyTier('intelligence','procurement'): sourcing suppliers
// for the marketplace is procurement work, and Market Intelligence already uses the OR form for
// the same kind of data. The single-tier gate was an oversight when this was written. The
// review WRITE (PUT below) deliberately keeps the narrow gate — a verdict on a match is not a
// read, and nothing about widening access to the list implies widening who may record one.

// ── Abiozen sourcing: research institutions (trial SITES, not sponsors) ───────
// The customer side: universities, hospitals, cancer centres and institutes that buy research
// chemicals. Parsed from clinical_studies.raw_json — no external source, no enrichment step.
const RI_US_EU = ['United States', 'United Kingdom', 'Switzerland', 'Norway', 'Iceland',
  'Austria', 'Belgium', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia', 'Czech Republic', 'Denmark',
  'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Ireland', 'Italy', 'Latvia',
  'Lithuania', 'Luxembourg', 'Malta', 'Netherlands', 'Poland', 'Portugal', 'Romania', 'Slovakia',
  'Slovenia', 'Spain', 'Sweden'];

router.get('/institutions', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const clauses = [];
    const params = [];
    // DEFAULT is the contactable US/EU cut, not everything: 10,493 institutions exist but the
    // ones you can act on today are the US/EU rows carrying a published contact. scope=all opts out.
    const scoped = req.query.scope !== 'all';
    if (scoped) {
      params.push(RI_US_EU);
      clauses.push(`country = ANY($${params.length})`);
      clauses.push('contact_email IS NOT NULL');
    }
    if (req.query.country) { params.push(req.query.country); clauses.push(`country = $${params.length}`); }
    if (req.query.type) { params.push(req.query.type); clauses.push(`facility_type = $${params.length}`); }
    if (req.query.has_email === 'true') clauses.push('contact_email IS NOT NULL');
    else if (req.query.has_email === 'false') clauses.push('contact_email IS NULL');
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    const items = (await query(
      `SELECT id, name, facility_type, city, state, country, study_count,
              contact_name, contact_email, first_seen, last_seen
         FROM research_institutions ${where}
        ORDER BY study_count DESC, name
        LIMIT 500`, params)).rows;

    // Census-wide and fixed: the header describes the dataset, not the current view.
    const summary = (await query(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE contact_email IS NOT NULL)::int with_email,
              COUNT(*) FILTER (WHERE country = ANY($1))::int us_eu,
              COUNT(*) FILTER (WHERE country = ANY($1) AND contact_email IS NOT NULL)::int contactable,
              COUNT(DISTINCT country)::int countries
         FROM research_institutions`, [RI_US_EU])).rows[0];

    const countries = (await query(
      `SELECT country, COUNT(*)::int n FROM research_institutions
        WHERE country IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const types = (await query(
      `SELECT facility_type, COUNT(*)::int n FROM research_institutions GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const src = (await query(
      `SELECT MAX(refreshed_at) refreshed_at, COUNT(*)::int rows FROM research_institutions`)).rows[0];

    res.json({ items, summary, countries, types, source: src, scope: scoped ? 'contactable' : 'all' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AROS sourcing: DMF holders joined to FDA establishment registrations ───────
// The seed for an AROS target list. Every field here is regulator-published — firm name,
// registered address, what the site is licensed to do, and a named contact — which is why
// this route exists at all: the routes we measured that inferred those from a company NAME
// (Places, Apollo) were wrong often enough to be unusable.
const AROS_US_EU = ['USA', 'GBR', 'CHE', 'NOR', 'ISL', 'LIE',
  'AUT', 'BEL', 'BGR', 'HRV', 'CYP', 'CZE', 'DNK', 'EST', 'FIN', 'FRA', 'DEU', 'GRC',
  'HUN', 'IRL', 'ITA', 'LVA', 'LTU', 'LUX', 'MLT', 'NLD', 'POL', 'PRT', 'ROU', 'SVK',
  'SVN', 'ESP', 'SWE'];

router.get('/aros/establishments', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    // A join is always required: a holder with no establishment has nothing to show on a
    // page whose every column comes from the register.
    const clauses = ['m.establishment_id IS NOT NULL'];
    const params = [];

    // The DEFAULT is the ICP slice, not everything. 946 holders joined, but the ones worth
    // contacting are API manufacturers in the market AROS sells into that are small enough to
    // lack an in-house compliance platform. `scope=all` opts out.
    const icp = req.query.scope !== 'all';
    if (icp) {
      clauses.push('e.is_api_manufacturer = true');
      params.push(AROS_US_EU);
      clauses.push(`e.country = ANY($${params.length})`);
      clauses.push('m.dmf_count BETWEEN 1 AND 3');
    }
    if (req.query.country) { params.push(req.query.country); clauses.push(`e.country = $${params.length}`); }
    if (req.query.api === 'true') clauses.push('e.is_api_manufacturer = true');
    else if (req.query.api === 'false') clauses.push('e.is_api_manufacturer = false');
    if (req.query.tier) { params.push(req.query.tier); clauses.push(`m.match_tier = $${params.length}`); }
    // Filing band: the size proxy. 1-3 is a company with one or two products.
    const BANDS = { '1': [1, 1], '2-3': [2, 3], '4-10': [4, 10], '11-30': [11, 30], '31+': [31, 100000] };
    if (BANDS[req.query.band]) {
      params.push(BANDS[req.query.band][0], BANDS[req.query.band][1]);
      clauses.push(`m.dmf_count BETWEEN $${params.length - 1} AND $${params.length}`);
    }
    const where = 'WHERE ' + clauses.join(' AND ');

    const items = (await query(
      `SELECT m.id, m.holder, m.dmf_count, m.match_tier, m.review_status,
              e.firm_name, e.fei_number, e.address, e.country, e.operations,
              e.is_api_manufacturer, e.is_us_agent,
              e.establishment_contact_name, e.establishment_contact_email,
              e.registrant_name, e.registrant_contact_email
         FROM dmf_establishment_matches m
         JOIN fda_establishments e ON e.id = m.establishment_id
         ${where}
        ORDER BY m.dmf_count ASC, e.country, m.holder
        LIMIT 1000`, params)).rows;

    // Summary is CENSUS-WIDE and does NOT move with the filters — the header must describe
    // the dataset, not the current view, or a filtered table silently redefines "how many".
    const summary = (await query(
      `SELECT COUNT(*)::int holders,
              COUNT(*) FILTER (WHERE m.establishment_id IS NOT NULL)::int joined,
              COUNT(*) FILTER (WHERE m.match_tier = 'exact')::int exact,
              COUNT(*) FILTER (WHERE m.match_tier = 'core')::int core,
              COUNT(*) FILTER (WHERE m.match_tier = 'not_found')::int not_found,
              COUNT(*) FILTER (WHERE e.is_api_manufacturer)::int api,
              COUNT(*) FILTER (WHERE e.is_api_manufacturer AND e.country = ANY($1)
                               AND m.dmf_count BETWEEN 1 AND 3)::int icp,
              COUNT(*) FILTER (WHERE e.is_us_agent)::int us_agent
         FROM dmf_establishment_matches m
         LEFT JOIN fda_establishments e ON e.id = m.establishment_id`, [AROS_US_EU])).rows[0];

    // The publication this page rests on. The register is refreshed on FDA's schedule, so
    // staleness has to be visible rather than assumed.
    const src = (await query(
      `SELECT source_last_modified, MAX(ingested_at) ingested_at, COUNT(*)::int sites
         FROM fda_establishments GROUP BY source_last_modified
         ORDER BY MAX(ingested_at) DESC LIMIT 1`)).rows[0] || null;

    const countries = (await query(
      `SELECT e.country, COUNT(*)::int n FROM dmf_establishment_matches m
         JOIN fda_establishments e ON e.id = m.establishment_id
        WHERE e.country IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)).rows;

    res.json({ items, summary, source: src, countries, scope: icp ? 'icp' : 'all' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /events/cphi/thin-supply — high clinical demand against a thin DMF bench.
// The sharper commercial list: a molecule many trials need and few companies can legally
// supply is where an intermediary has leverage. Threshold is a query param, default 3.
router.get('/events/cphi/thin-supply', authMiddleware, requireAnyTier('intelligence', 'procurement'), async (req, res) => {
  try {
    const maxHolders = Math.min(10, Math.max(1, parseInt(req.query.max_holders) || 3));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 40));
    const items = (await query(
      `WITH demand AS (
         SELECT LOWER(sm.molecule_name) k, MIN(sm.molecule_name) molecule,
                COUNT(DISTINCT sm.study_id) studies,
                SUM(COALESCE(cs.enrollment_count,0)) patients,
                COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase='Phase 3') ph3,
                COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase='Phase 2') ph2
           FROM study_molecules sm JOIN clinical_studies cs ON cs.id = sm.study_id
          GROUP BY 1),
       holders AS (
         SELECT LOWER(m.molecule_name) k, d.holder_normalized, MIN(d.holder) holder
           FROM molecule_dmf_matches m JOIN dmf_holders d ON d.dmf_number = m.dmf_number
          WHERE m.review_status = 'auto_confirmed'
          GROUP BY 1, 2),
       counted AS (SELECT k, COUNT(*)::int n FROM holders GROUP BY 1)
       SELECT dm.molecule, dm.studies::int, dm.ph3::int, dm.ph2::int, dm.patients::int,
              c.n::int AS holder_count,
              ROUND((dm.studies*3 + dm.ph3*5 + dm.ph2*2 + LEAST(dm.patients/500.0, 20))::numeric, 1) AS score,
              COALESCE(json_agg(json_build_object('holder', h.holder, 'booth', x.booth, 'hall', x.hall,
                                                  'exhibiting', COALESCE(x.exhibiting, false))
                                ORDER BY x.booth NULLS LAST) FILTER (WHERE h.holder IS NOT NULL), '[]') AS holders
         FROM demand dm
         JOIN counted c ON c.k = dm.k
         JOIN holders h ON h.k = dm.k
         LEFT JOIN cphi_exhibitor_matches x
                ON x.holder_normalized = h.holder_normalized AND x.event_slug = $1
        WHERE c.n <= $2
        GROUP BY dm.molecule, dm.studies, dm.ph3, dm.ph2, dm.patients, c.n
        ORDER BY score DESC
        LIMIT ${limit}`, [CPHI_EVENT, maxHolders])).rows;
    res.json({ event: CPHI_EVENT, max_holders: maxHolders, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /events/cphi/molecule-search?q= — THE BOOTH QUESTION, ANSWERED IN THREE SECONDS.
//
// A supplier says "we make cabazitaxel". The useful reply is either "only two companies in the
// world hold a DMF for that — what is your lead time?" or nothing at all, and which one it is has
// to be known before the sentence ends. Everything else on this page is a ranked list you browse;
// this is the one place you arrive already knowing the word.
//
// ── WHY IT IS A FULL OUTER MATCH, NOT THE THIN-SUPPLY QUERY WITH A FILTER ────
//
// thin-supply starts at `demand` and inner-joins holders, so it can only ever return a molecule
// that has BOTH trials and a DMF holder. At a booth that is the wrong shape three ways:
//
//   • A molecule with holders and no trials must come back saying "nobody is studying this",
//     which is a real answer and a reason to move the conversation on.
//   • A molecule with trials and no holder is the most interesting row on the page — demand with
//     no legal supply — and an inner join hides it.
//   • A name we hold nothing for at all has to say so, rather than return an empty list that reads
//     the same as a network failure.
//
// So the two sides are unioned on the molecule key and joined back as LEFT, and every count can be
// null. The UI renders each of those three cases as its own sentence.
router.get('/events/cphi/molecule-search', authMiddleware, requireAnyTier('intelligence', 'procurement'), async (req, res) => {
  try {
    const term = String(req.query.q || '').trim().toLowerCase();
    // Two characters is the floor: one would scan every molecule in the register to tell you
    // nothing, and at a venue that is several seconds of nothing.
    if (term.length < 2) return res.json({ q: term, items: [], hint: 'Type at least two letters.' });

    // EVERY name for this substance, not just the one that was typed. The register is American and
    // half the floor is European, so the typed name is often not the filed name.
    const expansion = expandMolecule(term);
    const terms = expansion.terms;

    const items = (await query(
      `WITH demand AS (
         SELECT LOWER(sm.molecule_name) k, MIN(sm.molecule_name) molecule,
                COUNT(DISTINCT sm.study_id) studies,
                SUM(COALESCE(cs.enrollment_count,0)) patients,
                COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase='Phase 3') ph3,
                COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase='Phase 2') ph2
           FROM study_molecules sm JOIN clinical_studies cs ON cs.id = sm.study_id
          GROUP BY 1),
       holders AS (
         SELECT LOWER(m.molecule_name) k, MIN(m.molecule_name) molecule,
                d.holder_normalized, MIN(d.holder) holder
           FROM molecule_dmf_matches m JOIN dmf_holders d ON d.dmf_number = m.dmf_number
          WHERE m.review_status = 'auto_confirmed'
          GROUP BY 1, 3),
       counted AS (SELECT k, COUNT(*)::int n FROM holders GROUP BY 1),
       -- $2 is EVERY name for the substance, as LIKE patterns — the typed one plus its INN/USAN
       -- counterpart and its de-salted base. One array parameter rather than per-term placeholders,
       -- so the same set matches in all three branches without index arithmetic.
       keys AS (
         SELECT k, molecule FROM demand  WHERE ${moleculeLikeSql('k', 2)}
         UNION
         SELECT k, molecule FROM holders WHERE ${moleculeLikeSql('k', 2)}
         UNION
         -- A molecule we have PRICED but that has neither a trial nor a US DMF holder still has to
         -- be findable: that is exactly the research-grade catalogue.
         SELECT LOWER(molecule_name), molecule_name FROM molecule_pricing
          WHERE active = 1 AND ${moleculeLikeSql('LOWER(molecule_name)', 2)})
       SELECT kk.molecule,
              dm.studies::int, dm.ph3::int, dm.ph2::int, dm.patients::int,
              COALESCE(c.n, 0)::int AS holder_count,
              COALESCE(json_agg(DISTINCT jsonb_build_object(
                         'holder', h.holder, 'booth', x.booth, 'hall', x.hall,
                         'exhibiting', COALESCE(x.exhibiting, false)))
                       FILTER (WHERE h.holder IS NOT NULL), '[]') AS holders,
              COUNT(*) FILTER (WHERE x.exhibiting)::int AS on_floor,
              -- From molecule_pricing, which is where a supplier's price list lands. Every field is
              -- nullable because most molecules have no price row yet; the UI says "no price on file"
              -- rather than implying a zero.
              MIN(pr.gmp_grade) AS gmp_grade,
              BOOL_OR(pr.gmp_certified = 1) AS gmp_certified,
              MIN(pr.cas_number) AS cas_number,
              MIN(pr.purity) AS purity,
              MIN(pr.price_per_kg_usd) AS price_per_kg_usd,
              MIN(pr.min_quantity_g) AS min_quantity_g,
              MIN(pr.lead_time_days) AS lead_time_days,
              BOOL_OR(pr.sample_available = 1) AS sample_available,
              MIN(pr.sample_price_usd) AS sample_price_usd,
              MIN(pr.regulatory_status) AS regulatory_status,
              BOOL_OR(pr.controlled_substance = 1) AS controlled_substance
         FROM (SELECT k, MIN(molecule) molecule FROM keys GROUP BY k) kk
         LEFT JOIN demand  dm ON dm.k = kk.k
         LEFT JOIN counted c  ON c.k  = kk.k
         LEFT JOIN holders h  ON h.k  = kk.k
         LEFT JOIN cphi_exhibitor_matches x
                ON x.holder_normalized = h.holder_normalized
               AND x.event_slug = $1 AND x.role = 'supplier'
         LEFT JOIN molecule_pricing pr ON LOWER(pr.molecule_name) = kk.k AND pr.active = 1
        GROUP BY kk.k, kk.molecule, dm.studies, dm.ph3, dm.ph2, dm.patients, c.n
        -- Exact name first, then whoever is actually standing on this floor, then thin benches,
        -- then demand. At a booth the first row is the only one usually read.
        -- $3 is the same names UNPATTERNED: an exact hit on any of them sorts first, so typing the
        -- INN still puts the substance itself above every molecule that merely contains the string.
        ORDER BY (kk.k = ANY($3)) DESC,
                 COUNT(*) FILTER (WHERE x.exhibiting) DESC,
                 COALESCE(c.n, 999) ASC,
                 COALESCE(dm.studies, 0) DESC,
                 kk.molecule
        LIMIT 25`, [CPHI_EVENT, likePatterns(terms), terms])).rows;

    // Collapse the alias rows and RECOUNT the holders. Done after the LIMIT, so the merged list can
    // be shorter than 25 — which is correct: 25 substances would have needed a larger LIMIT, and
    // merging first would need the synonym table inside the query.
    const merged = mergeMoleculeRows(items);

    // searched_as lets the page say "also searched leuprolide" when the INN was typed. Without it a
    // correct result looks like the wrong molecule and gets distrusted at the exact moment it matters.
    res.json({
      q: term,
      count: merged.length,
      searched_as: expansion.expanded ? terms : null,
      items: merged,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /events/cphi/exhibitors/:id — a human verdict on a match. This is the whole point of
// the review gate: the token tier is roughly half wrong, so nothing acts on it until someone
// says so here. Writes are the same tier as reads and cost nothing.
router.put('/events/cphi/exhibitors/:id', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const { review_status, entity_note } = req.body || {};
    if (review_status !== undefined && !CPHI_REVIEW_STATUSES.includes(review_status)) {
      return res.status(400).json({ error: `review_status must be one of: ${CPHI_REVIEW_STATUSES.join(', ')}` });
    }
    if (review_status === undefined && entity_note === undefined) {
      return res.status(400).json({ error: 'nothing to update (review_status and/or entity_note required)' });
    }
    const upd = await query(
      `UPDATE cphi_exhibitor_matches
          SET review_status = COALESCE($1, review_status),
              entity_note   = COALESCE($2, entity_note)
        WHERE id = $3 RETURNING *`,
      [review_status !== undefined ? review_status : null,
       entity_note !== undefined ? entity_note : null,
       req.params.id]);
    if (!upd.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(upd.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CPHI: THE MOLECULE NAMES BEHIND THE NUMBER ────────────────────────────────
//
// THE QUESTION EVERY SUPPLIER ASKED ON THE FLOOR, which the page could not answer: "which
// molecules do you want from us?" The priority table carries `molecules_covered`, a COUNT, so
// standing at a booth the honest answer was "eleven" and not which eleven.
//
// A SEPARATE ENDPOINT, not extra columns on the list. The list is the first thing that loads on
// a venue network and it already carries 300-odd rows; attaching every molecule name to every row
// would multiply that payload for data nobody reads until they tap one company. This fires on the
// tap instead.
router.get('/events/cphi/exhibitors/:id/molecules', authMiddleware, requireAnyTier('intelligence', 'procurement'), async (req, res) => {
  try {
    const m = (await query(
      `SELECT id, holder, holder_normalized, booth, hall, molecules_covered
         FROM cphi_exhibitor_matches WHERE id = $1`, [req.params.id])).rows[0];
    if (!m) return res.status(404).json({ error: 'Not found' });

    // The SAME demand set the count is computed from — see CPHI_TOP_N. Only auto_confirmed
    // molecule-to-DMF links: a molecule read aloud at a booth is a claim we have to be able to back.
    const items = (await query(
      `WITH demand AS (
         SELECT LOWER(sm.molecule_name) AS k, MIN(sm.molecule_name) AS molecule,
                COUNT(DISTINCT sm.study_id) AS studies,
                SUM(COALESCE(cs.enrollment_count, 0)) AS patients,
                COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase = 'Phase 3') AS ph3,
                COUNT(DISTINCT sm.study_id) FILTER (WHERE cs.phase = 'Phase 2') AS ph2
           FROM study_molecules sm
           JOIN clinical_studies cs ON cs.id = sm.study_id
          GROUP BY 1),
       sourceable AS (
         SELECT d.* FROM demand d WHERE EXISTS (
           SELECT 1 FROM molecule_dmf_matches m
            WHERE LOWER(m.molecule_name) = d.k AND m.review_status = 'auto_confirmed')),
       top AS (
         SELECT k, molecule, studies, ph3 FROM sourceable
          ORDER BY ${DEMAND_SQL} DESC, studies DESC LIMIT $2),
       holders AS (
         SELECT LOWER(m2.molecule_name) AS k, COUNT(DISTINCT d2.holder_normalized)::int AS n
           FROM molecule_dmf_matches m2
           JOIN dmf_holders d2 ON d2.dmf_number = m2.dmf_number
          WHERE m2.review_status = 'auto_confirmed'
          GROUP BY 1)
       SELECT t.molecule, t.studies::int AS studies, t.ph3::int AS ph3,
              COALESCE(h.n, 0)::int AS holder_count
         FROM top t
         JOIN molecule_dmf_matches m ON LOWER(m.molecule_name) = t.k AND m.review_status = 'auto_confirmed'
         JOIN dmf_holders d ON d.dmf_number = m.dmf_number
         LEFT JOIN holders h ON h.k = t.k
        WHERE d.holder_normalized = $1
        GROUP BY t.molecule, t.studies, t.ph3, h.n
        ORDER BY t.studies DESC, t.molecule`, [m.holder_normalized, CPHI_TOP_N])).rows;

    res.json({ exhibitor: m, count: items.length, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CPHI: THE PEOPLE YOU MET ──────────────────────────────────────────────────
// Contacts hang off the EVENT and link to a match when one exists — a CDMO or an intermediate
// maker holds no DMF and would otherwise be dropped. See scripts/migrate-cphi-contacts.js.
router.get('/events/cphi/contacts', authMiddleware, requireAnyTier('intelligence', 'procurement'), async (req, res) => {
  try {
    const params = [CPHI_EVENT];
    let where = 'c.event_slug = $1';
    if (req.query.exhibitor_id) { params.push(req.query.exhibitor_id); where += ` AND c.exhibitor_match_id = $${params.length}`; }
    const items = (await query(
      `SELECT c.*, x.holder, x.booth, x.hall, x.molecules_covered
         FROM cphi_exhibitor_contacts c
         LEFT JOIN cphi_exhibitor_matches x ON x.id = c.exhibitor_match_id
        WHERE ${where}
        ORDER BY c.company, c.name`, params)).rows;
    res.json({ event: CPHI_EVENT, count: items.length, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a contact met on the floor. Typed on a phone between booths, so only name + company are
// required — everything else can be filled in later, and a half-captured card beats a lost one.
router.post('/events/cphi/contacts', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.company) return res.status(400).json({ error: 'name and company are required' });
    const norm = cphiNormalizeCompany(b.company);
    const row = (await query(
      `INSERT INTO cphi_exhibitor_contacts
         (event_slug, exhibitor_match_id, company, company_normalized, name, title, email,
          phone_mobile, phone_office, website, address, source, note, linkedin_connected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (event_slug, company_normalized, lower(name)) DO UPDATE
          SET exhibitor_match_id = COALESCE(EXCLUDED.exhibitor_match_id, cphi_exhibitor_contacts.exhibitor_match_id),
              title = COALESCE(EXCLUDED.title, cphi_exhibitor_contacts.title),
              email = COALESCE(EXCLUDED.email, cphi_exhibitor_contacts.email),
              phone_mobile = COALESCE(EXCLUDED.phone_mobile, cphi_exhibitor_contacts.phone_mobile),
              phone_office = COALESCE(EXCLUDED.phone_office, cphi_exhibitor_contacts.phone_office),
              website = COALESCE(EXCLUDED.website, cphi_exhibitor_contacts.website),
              address = COALESCE(EXCLUDED.address, cphi_exhibitor_contacts.address),
              note = COALESCE(EXCLUDED.note, cphi_exhibitor_contacts.note),
              linkedin_connected = EXCLUDED.linkedin_connected,
              updated_at = NOW()
       RETURNING *`,
      [CPHI_EVENT, b.exhibitor_match_id || null, b.company, norm, b.name, b.title || null,
       b.email || null, b.phone_mobile || null, b.phone_office || null, b.website || null,
       b.address || null, b.source || 'typed', b.note || null, !!b.linkedin_connected])).rows[0];

    if (b.exhibitor_match_id) {
      await query(
        `UPDATE cphi_exhibitor_matches
            SET met_in_person = TRUE, met_at = COALESCE(met_at, NOW())
          WHERE id = $1`, [b.exhibitor_match_id]);
    }
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Meeting state for a booth — what day 2 and day 3 filter on.
router.put('/events/cphi/exhibitors/:id/meeting', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const { met_in_person, linkedin_connected, meeting_note } = req.body || {};
    if (met_in_person === undefined && linkedin_connected === undefined && meeting_note === undefined) {
      return res.status(400).json({ error: 'nothing to update' });
    }
    const upd = await query(
      `UPDATE cphi_exhibitor_matches
          SET met_in_person = COALESCE($1, met_in_person),
              met_at = CASE WHEN $1 IS TRUE AND met_at IS NULL THEN NOW() ELSE met_at END,
              linkedin_connected = COALESCE($2, linkedin_connected),
              meeting_note = COALESCE($3, meeting_note)
        WHERE id = $4 RETURNING *`,
      [met_in_person === undefined ? null : !!met_in_person,
       linkedin_connected === undefined ? null : !!linkedin_connected,
       meeting_note === undefined ? null : meeting_note, req.params.id]);
    if (!upd.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(upd.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CPHI: SEND THE FOLLOW-UP ──────────────────────────────────────────────────
//
// adminOnly, and the BODY IS REQUIRED. This route sends mail from the company domain to a named
// person at a supplier, and the platform's rule is that nothing outbound leaves without a human
// releasing it. A person typing the body and pressing send IS that release; an endpoint that would
// compose and send in one call would not be, however convenient, so there is no path here that
// invents the words.
router.post('/events/cphi/contacts/:id/email', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { subject, html, attach_overview } = req.body || {};
    if (!subject || !html) return res.status(400).json({ error: 'subject and html are required' });

    const c = (await query(
      `SELECT * FROM cphi_exhibitor_contacts WHERE id = $1`, [req.params.id])).rows[0];
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (!c.email) return res.status(400).json({ error: 'this contact has no email address' });

    // The supplier overview, attached on request. Read from disk per send rather than held in
    // memory: it is 74 KB, it changes when the file in the repo changes, and a cached copy would
    // keep sending last month's version after somebody updated it. A MISSING file REFUSES the
    // send — an email promising an attached overview that arrives without one is worse than an
    // error on this screen, because the supplier sees the first and nobody sees the second.
    let attachments;
    if (attach_overview) {
      const fs = require('fs'), path = require('path');
      const p = path.join(__dirname, '../../public/docs/abiozen-supplier-overview.pdf');
      if (!fs.existsSync(p)) return res.status(500).json({ error: 'the supplier overview PDF is missing from this deploy' });
      attachments = [{ filename: 'Abiozen-supplier-overview.pdf', content: fs.readFileSync(p) }];
    }

    const { sendEmailDetailed } = require('../lib/mailer');
    const out = await sendEmailDetailed({
      to: c.email,
      subject,
      html: sanitizeHtml(html),
      from: process.env.RESEND_FROM || undefined,
      replyTo: req.user && req.user.email ? req.user.email : undefined,
      attachments,
    });
    if (!out.ok) return res.status(502).json({ error: out.error || 'send failed' });

    await query(`UPDATE cphi_exhibitor_contacts SET last_emailed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [c.id]);
    res.json({ ok: true, id: out.id, to: c.email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OUTREACH STATUS — one system, every list ───────────────────────────────────
//
// Classified 'shared' in the route map, for the same reason the notifications routes are: the ROUTE is
// safe for anyone with a login, and the TABLE is product-bearing, so the DATA is scoped
// (productScopeSql, via src/lib/outreach). Visibility follows the product boundary and nothing new is
// invented here — which was the instruction and is also the only way it stays correct.
//
// The WRITE additionally checks the product of the ROW being annotated, not of the route: a caller who
// holds golfnex must not be able to file outreach against a sitenex prospect just because the route
// admitted them.

// GET /outreach?entity_type=prospect&ids=1,2,3 — status for the rows a list is already showing.
// ── PARTNER-SCOPED, from 2026-10-01. This REPLACES staffOnly on every outreach route. ──
//
// staffOnly was added a day earlier with the reasoning: "outreach rows have no partner_id, and giving them one
// would mean deciding that an outreach note belongs to a partner rather than to us, which is the opposite of
// true." That was right while a partner could not work a prospect.
//
// They can now — a partner holds a territory and sees the prospects in it — and a partner who rings a business
// and cannot record the call keeps that record somewhere we never see. So an outreach note CAN belong to a
// partner, outreach.partner_id says whose it is, and the question became keeping A's out of B's sight.
//
// THREE LAYERS, all still in force:
//   product   productScopeSql — is this row's product one they hold
//   PARTNER   partnerScopeSql → the module's partnerFragment — is this row THEIRS
//   row       the WRITE still reads the annotated entity's own product, never the request's
//
// The partner scope FAILS CLOSED and the module THROWS if a caller omits it, because the two softer shapes —
// an optional parameter defaulting to no filter, or defaulting to staff — both hand a partner everybody's
// notes when somebody forgets. A 500 is visible; a missing WHERE clause is not.
router.get('/outreach', authMiddleware, async (req, res) => {
  try {
    const entityType = String(req.query.entity_type || '');
    const ids = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 500);
    if (!isEntityType(entityType)) return res.status(400).json({ error: `Unknown entity_type '${entityType}'` });
    const held = await effectiveProducts(req.user);
    res.json({ entity_type: entityType,
      statuses: await outreach.statusFor(entityType, ids, held, await partnerScopeSql(req.user)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /outreach — record an outcome. One control, one call, no form.
router.put('/outreach', authMiddleware, async (req, res) => {
  try {
    const { entity_type, entity_id, status, channel, note, next_action_at } = req.body || {};
    if (!entity_type || entity_id == null || !status) {
      return res.status(400).json({ error: 'entity_type, entity_id and status are required' });
    }
    const held = await effectiveProducts(req.user);
    // channel is optional and validated in setStatus — a status change is not always a touch.
    const r = await outreach.setStatus({
      entityType: entity_type, entityId: entity_id, status, channel, note,
      nextActionAt: next_action_at || null, user: req.user, held,
    });
    if (!r.ok) {
      const code = r.code === 'product_not_held' ? 403 : (r.code === 'entity_not_found' ? 404 : 400);
      return res.status(code).json({ error: r.error, code: r.code });
    }
    console.log(`[outreach] ${req.user.email} ${entity_type}#${entity_id} ${r.from} → ${r.to}`
      + (r.channel ? ` via ${r.channel}` : '')
      + (r.deal ? ` (deal #${r.deal.id} ${r.deal.created ? 'created' : 'linked'})` : ''));
    // `deal` has to be passed through: setStatus returns it, and the cell says "deal #N created" from it.
    // It was omitted here, so the whole won → sitenex_deals link worked server-side and was invisible —
    // the deal appeared on the board with nothing on screen to say it had been made.
    res.json({ success: true, from: r.from, to: r.to, channel: r.channel, changed: r.changed,
      row: r.row, deal: r.deal || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /outreach/summary?entity_type=prospect&total=1524 — the status bar above a list.
// `total` is how many rows the list has; without it 'new' is reported as 0 rather than invented, because
// the absence of an outreach row IS 'new' and only the caller knows the denominator.
router.get('/outreach/summary', authMiddleware, async (req, res) => {
  try {
    const entityType = String(req.query.entity_type || '');
    if (!isEntityType(entityType)) return res.status(400).json({ error: `Unknown entity_type '${entityType}'` });
    const total = req.query.total != null && req.query.total !== '' ? Math.max(0, parseInt(req.query.total, 10) || 0) : null;
    const held = await effectiveProducts(req.user);
    res.json(await outreach.summary(entityType, { held, partner: await partnerScopeSql(req.user),
      totalEntities: total, product: req.query.product || null }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /outreach/activity?days=7 — who changed what. The question current status cannot answer.
router.get('/outreach/activity', authMiddleware, async (req, res) => {
  try {
    const held = await effectiveProducts(req.user);
    res.json(await outreach.activity({
      held, partner: await partnerScopeSql(req.user), sinceDays: req.query.days || 7,
      entityType: req.query.entity_type || null, userId: req.query.user_id || null,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /outreach/overview?days=7 — the Outreach PAGE. Four views in one call, because they are one glance:
// by person, by list, by status moved to, and the SILENCE.
//
// "Who is reaching out and who is not" spans every list, so it cannot be assembled from per-list bars.
router.get('/outreach/overview', authMiddleware, async (req, res) => {
  try {
    const held = await effectiveProducts(req.user);
    res.json(await outreach.overview({ held, partner: await partnerScopeSql(req.user),
      sinceDays: req.query.days || 7 }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /outreach/history?entity_type=&entity_id= — one entity's trail, for the inline control.
router.get('/outreach/history', authMiddleware, async (req, res) => {
  try {
    const entityType = String(req.query.entity_type || '');
    if (!isEntityType(entityType)) return res.status(400).json({ error: `Unknown entity_type '${entityType}'` });
    const held = await effectiveProducts(req.user);
    res.json({ events: await outreach.history(entityType, req.query.entity_id, held,
      await partnerScopeSql(req.user)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /outreach/vocabulary — the 10 statuses WITH their sort_order, and the channels, so neither dropdown
// is a second copy of the list and the funnel bar does not re-derive its own order.
// GET /outreach/vocabulary — the two field definitions, so no client keeps a second copy of either list.
// Statuses carry their sort_order, label and next action: the bar sorts on the order, and the dropdown can
// say what a stage MEANS rather than just naming it.
// GET /outreach/tasks — MY TASKS, derived from outreach rather than from daily_tasks.
//
// daily_tasks comes from weekly_kpis via the 8am agent, and a partner has no KPIs — deliberately, because
// scoring an outside account is meaningless. So My Tasks was an empty page for a partner, and the fix is not to
// invent KPIs for somebody we do not manage: it is to derive the list from what they actually do, which is
// outreach, and which has been partner-scoped since this morning.
//
// Nothing is stored. Computed on read, so marking a prospect 'following_up' makes its chase task disappear —
// because the task WAS the absence of that status. A daily_tasks row could not have that property.
router.get('/outreach/tasks', authMiddleware, async (req, res) => {
  try {
    const held = await effectiveProducts(req.user);
    const { outreachTasks } = require('../lib/outreach/tasks');
    res.json(await outreachTasks({
      held, partner: await partnerScopeSql(req.user), staleDays: req.query.stale_days,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOT staffOnly: this returns the vocabulary CONSTANTS — ten status keys, five channels, the entity
// types. No row, no count, nothing about anybody's data. Gating it would only mean a partner's page
// cannot label its own dropdowns.
router.get('/outreach/vocabulary', authMiddleware, async (req, res) => {
  res.json({
    statuses: OUTREACH_STATUS_DEFS,
    status_keys: OUTREACH_STATUS_DEFS.map(s => s.key),
    channels: OUTREACH_CHANNELS.map(key => ({ key, label: OUTREACH_CHANNEL_LABEL[key] || key })),
    entity_types: Object.fromEntries(
      Object.entries(OUTREACH_ENTITIES).map(([k, v]) => [k, { label: v.label, pages: v.pages }])),
  });
});

// ── Notifications — the pnav top-bar bell feed ────────────────────────────────
// reads + writes requireTier('intelligence') (GET needs intelligence read; PUT/POST need
// intelligence write). All free, no spend.
// PRODUCT-SCOPED. The ROUTE is shared — everyone needs their own alerts — but the TABLE carries a
// product column and no user_id, so an unscoped read handed every logged-in user every other
// product's agent failures (molecule names, sequence errors, inquiry detail). Scoping the DATA is the
// fix; reclassifying the route would have hidden a product's own alerts from the people running it.
// A NULL product is platform-wide and needs 'internal'. The unread COUNT is scoped too — an
// unreachable badge count is still a leak, and a number nobody can explain.
router.get('/notifications', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    const held = await effectiveProducts(req.user);
    const scope = productScopeSql(held, '', 1);
    const unreadOnly = req.query.unread === 'true' ? ' AND read_at IS NULL' : '';
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const items = (await query(
      `SELECT id, product, kind, severity, title, body, link_page, read_at, created_at
         FROM notifications WHERE ${scope.sql}${unreadOnly}
         ORDER BY created_at DESC LIMIT ${limit}`, scope.params)).rows;
    const unread = (await query(
      `SELECT COUNT(*)::int n FROM notifications WHERE ${scope.sql} AND read_at IS NULL`, scope.params)).rows[0].n;
    res.json({ items, unread });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /notifications/:id/read — mark one read (idempotent; keeps the original read_at).
router.put('/notifications/:id/read', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    // Scoped in the WHERE rather than fetched-then-checked: a row whose product the caller does not
    // hold simply does not match, so it reads as 404 — the same answer as a row that does not exist,
    // which is also the right answer to give (it tells a prober nothing).
    const held = await effectiveProducts(req.user);
    const scope = productScopeSql(held, '', 2);
    const upd = await query(
      `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
        WHERE id = $1 AND ${scope.sql} RETURNING *`, [req.params.id, ...scope.params]);
    if (!upd.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(upd.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /notifications/read-all — mark every unread notification read.
router.post('/notifications/read-all', authMiddleware, requireTier('intelligence'), async (req, res) => {
  try {
    // Was org-wide state wearing per-user clothes: one person clicking "mark all read" cleared
    // everybody's notifications, which is a correctness bug even among staff. Now it marks only the
    // products the caller holds — identical behaviour for the 17 people who hold everything, and
    // automatically contained for anyone who does not.
    const held = await effectiveProducts(req.user);
    const scope = productScopeSql(held, '', 1);
    const upd = await query(
      `UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL AND ${scope.sql}`, scope.params);
    res.json({ marked: upd.rowCount || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
