// scripts/setup-db.js — run once: node scripts/setup-db.js
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config();

const db = new Database(path.join(__dirname, '..', 'playbookos.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('admin','dev','procurement','sales','marketing','qc')),
  github_username TEXT,
  invite_token TEXT,
  invited_at  TEXT,
  joined_at   TEXT,
  password_hash TEXT,
  is_active   INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Targets (cascade from annual) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targets (
  id          TEXT PRIMARY KEY,
  period_type TEXT NOT NULL CHECK(period_type IN ('annual','quarterly','monthly','weekly','daily')),
  period_key  TEXT NOT NULL,   -- e.g. '2026', '2026-Q3', '2026-07', '2026-W28', '2026-07-14'
  user_id     TEXT,            -- NULL = company-wide
  team        TEXT,            -- NULL = company-wide
  metric      TEXT NOT NULL,   -- e.g. 'revenue','orders','skus_added','prs_merged','demos'
  target_value REAL NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ── Daily activity logs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_logs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  log_date    TEXT NOT NULL,   -- YYYY-MM-DD
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  notes       TEXT,
  source      TEXT DEFAULT 'manual', -- 'manual' | 'github' | 'hubspot'
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ── Orders / Revenue ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  order_date  TEXT NOT NULL,
  amount      REAL NOT NULL,
  buyer_type  TEXT,  -- 'compounding_pharmacy','research_lab','cro','generic_manuf','biotech'
  product_category TEXT,  -- 'research_molecule','gmp_api','qc_service','cro_service'
  status      TEXT DEFAULT 'confirmed',
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── GitHub sync cache ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS github_stats (
  id          TEXT PRIMARY KEY,
  github_username TEXT NOT NULL,
  stat_date   TEXT NOT NULL,
  commits     INTEGER DEFAULT 0,
  prs_opened  INTEGER DEFAULT 0,
  prs_merged  INTEGER DEFAULT 0,
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  synced_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(github_username, stat_date)
);

-- ── Releases / Milestones ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS milestones (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  target_date TEXT NOT NULL,
  actual_date TEXT,
  status      TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','complete','at_risk')),
  description TEXT,
  owner_id    TEXT,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

-- ── AI analysis cache ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_analyses (
  id          TEXT PRIMARY KEY,
  analysis_type TEXT NOT NULL,
  period_key  TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ── Email trigger log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_log (
  id          TEXT PRIMARY KEY,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  trigger_type TEXT,
  sent_at     TEXT DEFAULT (datetime('now'))
);
`);

// Seed admin user
const adminId = require('crypto').randomUUID();
const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
const stmt = db.prepare(`
  INSERT OR IGNORE INTO users (id, email, name, role, password_hash, joined_at)
  VALUES (?, ?, ?, 'admin', ?, datetime('now'))
`);
stmt.run(adminId, process.env.ADMIN_EMAIL || 'naresh@abiozen.com', 'Naresh (Admin)', hash);

// Seed milestones
const milestones = [
  { name: 'Release 1 — Research molecules + Non-GMP QC', date: '2026-05-31', desc: 'E-commerce platform go-live. 500+ SKUs, Stripe, FedEx, COA delivery.' },
  { name: 'Release 2 — GMP APIs + GMP QC', date: '2026-08-01', desc: 'GMP API catalog (300+ SKUs), GMP certificate upload, HPLC/FTIR reports.' },
  { name: 'Release 3 — R&D Services + RFQ Engine', date: '2026-10-01', desc: 'CRO service booking, stability study intake, RFQ engine, PO automation.' },
  { name: 'Hire: Account Manager', date: '2026-06-15', desc: 'Trigger: first $100K revenue. 20 calls/day, $150K/mo target.' },
  { name: 'Hire: Procurement Specialist', date: '2026-05-31', desc: 'Trigger: go-live. 3 supplier contacts/day, 8 new vendors/month.' },
  { name: 'Hire: Sales Rep (Compounding)', date: '2026-08-01', desc: 'Trigger: $500K monthly run rate.' },
  { name: 'Chase Bank Loan 1 ($175K)', date: '2026-06-30', desc: 'Trigger: first $100K revenue. Phase 1 equipment financing.' },
  { name: '$10M Annual Revenue', date: '2026-12-31', desc: 'Primary company target. Requires all 3 releases live and full team operational.' },
];

const msStmt = db.prepare(`
  INSERT OR IGNORE INTO milestones (id, name, target_date, description, status)
  VALUES (?, ?, ?, ?, 'pending')
`);
milestones.forEach(m => msStmt.run(require('crypto').randomUUID(), m.name, m.date, m.desc));

// Seed annual + quarterly + monthly targets
const targetStmt = db.prepare(`
  INSERT OR IGNORE INTO targets (id, period_type, period_key, metric, target_value)
  VALUES (?, ?, ?, ?, ?)
`);

const annualTargets = [
  ['annual','2026','revenue', 10000000],
  ['annual','2026','orders', 16800],
  ['annual','2026','new_accounts', 840],
  ['annual','2026','skus_live', 5000],
];
annualTargets.forEach(([pt,pk,m,v]) => targetStmt.run(require('crypto').randomUUID(), pt, pk, m, v));

const monthlyRevTargets = [
  ['2026-05', 300000], ['2026-06', 600000], ['2026-07', 900000],
  ['2026-08', 1200000], ['2026-09', 1500000], ['2026-10', 1800000],
  ['2026-11', 2000000], ['2026-12', 1700000],
];
monthlyRevTargets.forEach(([pk,v]) => targetStmt.run(require('crypto').randomUUID(), 'monthly', pk, 'revenue', v));

console.log('✅ PlaybookOS database initialized at playbookos.db');
console.log(`✅ Admin user: ${process.env.ADMIN_EMAIL || 'naresh@abiozen.com'}`);
db.close();
