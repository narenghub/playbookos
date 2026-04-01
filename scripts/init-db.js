const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'playbookos.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, github_username TEXT, invite_token TEXT,
  invited_at TEXT, joined_at TEXT, password_hash TEXT, is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY, period_type TEXT NOT NULL, period_key TEXT NOT NULL,
  user_id TEXT, team TEXT, metric TEXT NOT NULL, target_value REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, log_date TEXT NOT NULL,
  metric TEXT NOT NULL, value REAL NOT NULL, notes TEXT,
  source TEXT DEFAULT 'manual', created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, order_date TEXT NOT NULL, amount REAL NOT NULL,
  buyer_type TEXT, product_category TEXT, status TEXT DEFAULT 'confirmed',
  notes TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS github_stats (
  id TEXT PRIMARY KEY, github_username TEXT NOT NULL, stat_date TEXT NOT NULL,
  commits INTEGER DEFAULT 0, prs_opened INTEGER DEFAULT 0, prs_merged INTEGER DEFAULT 0,
  lines_added INTEGER DEFAULT 0, lines_removed INTEGER DEFAULT 0,
  synced_at TEXT DEFAULT (datetime('now')), UNIQUE(github_username, stat_date)
);
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, target_date TEXT NOT NULL,
  actual_date TEXT, status TEXT DEFAULT 'pending', description TEXT, owner_id TEXT
);
CREATE TABLE IF NOT EXISTS ai_analyses (
  id TEXT PRIMARY KEY, analysis_type TEXT NOT NULL, period_key TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL,
  trigger_type TEXT, sent_at TEXT DEFAULT (datetime('now'))
);
`);

const adminEmail = process.env.ADMIN_EMAIL || 'naren@abiozen.com';
const adminPass = process.env.ADMIN_PASSWORD || 'Abiozen@2026';
const hash = bcrypt.hashSync(adminPass, 10);
const adminId = crypto.randomUUID();

db.prepare(`INSERT OR IGNORE INTO users (id,email,name,role,password_hash,joined_at) VALUES (?,?,?,?,?,datetime('now'))`).run(adminId, adminEmail, 'Naresh (Admin)', 'admin', hash);

const milestones = [
  ['Release 1 — Research molecules + Non-GMP QC','2026-05-31','E-commerce platform go-live'],
  ['Hire: Procurement Specialist','2026-05-31','Trigger: go-live'],
  ['Hire: Account Manager','2026-06-15','Trigger: first $100K revenue'],
  ['Chase Bank Loan 1 ($175K)','2026-06-30','Trigger: first $100K revenue'],
  ['Release 2 — GMP APIs + GMP QC','2026-08-01','GMP API catalog'],
  ['Hire: Sales Rep (Compounding)','2026-08-01','Trigger: $500K monthly'],
  ['Release 3 — R&D Services + RFQ Engine','2026-10-01','CRO service booking'],
  ['$10M Annual Revenue','2026-12-31','Primary company target'],
];
const msStmt = db.prepare(`INSERT OR IGNORE INTO milestones (id,name,target_date,description,status) VALUES (?,?,?,?,'pending')`);
milestones.forEach(m => msStmt.run(crypto.randomUUID(), m[0], m[1], m[2]));

const tStmt = db.prepare(`INSERT OR IGNORE INTO targets (id,period_type,period_key,metric,target_value) VALUES (?,?,?,?,?)`);
[['annual','2026','revenue',10000000],['annual','2026','orders',16800]].forEach(t => tStmt.run(crypto.randomUUID(),...t));
[['2026-05',300000],['2026-06',600000],['2026-07',900000],['2026-08',1200000],['2026-09',1500000],['2026-10',1800000],['2026-11',2000000],['2026-12',1700000]].forEach(t => tStmt.run(crypto.randomUUID(),'monthly',t[0],'revenue',t[1]));

console.log('✅ Database ready. Admin:', adminEmail);
db.close();
