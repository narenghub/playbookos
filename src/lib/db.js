const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL, github_username TEXT, invite_token TEXT,
      invited_at TEXT, joined_at TEXT, password_hash TEXT,
      is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY, period_type TEXT NOT NULL, period_key TEXT NOT NULL,
      user_id TEXT, team TEXT, metric TEXT NOT NULL, target_value REAL NOT NULL,
      created_at TEXT DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, log_date TEXT NOT NULL,
      metric TEXT NOT NULL, value REAL NOT NULL, notes TEXT,
      source TEXT DEFAULT 'manual', created_at TEXT DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, order_date TEXT NOT NULL, amount REAL NOT NULL,
      buyer_type TEXT, product_category TEXT, status TEXT DEFAULT 'confirmed',
      notes TEXT, created_at TEXT DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS github_stats (
      id TEXT PRIMARY KEY, github_username TEXT NOT NULL, stat_date TEXT NOT NULL,
      commits INTEGER DEFAULT 0, prs_opened INTEGER DEFAULT 0,
      prs_merged INTEGER DEFAULT 0, lines_added INTEGER DEFAULT 0,
      lines_removed INTEGER DEFAULT 0, synced_at TEXT DEFAULT NOW(),
      UNIQUE(github_username, stat_date)
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, target_date TEXT NOT NULL,
      actual_date TEXT, status TEXT DEFAULT 'pending', description TEXT, owner_id TEXT
    );
    CREATE TABLE IF NOT EXISTS ai_analyses (
      id TEXT PRIMARY KEY, analysis_type TEXT NOT NULL, period_key TEXT NOT NULL,
      content TEXT NOT NULL, created_at TEXT DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL,
      trigger_type TEXT, sent_at TEXT DEFAULT NOW()
    );
  `);

  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  const adminEmail = process.env.ADMIN_EMAIL || 'naren@abiozen.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'Abiozen@2026';
  const hash = bcrypt.hashSync(adminPass, 10);
  const adminId = crypto.randomUUID();
  const now = new Date().toISOString();

  await query(`INSERT INTO users (id,email,name,role,password_hash,joined_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO NOTHING`,
    [adminId, adminEmail, 'Naresh (Admin)', 'admin', hash, now]);

  const milestones = [
    ['Release 1 — Research molecules + Non-GMP QC','2026-05-31','E-commerce go-live'],
    ['Hire: Procurement Specialist','2026-05-31','Trigger: go-live'],
    ['Hire: Account Manager','2026-06-15','Trigger: $100K revenue'],
    ['Chase Bank Loan 1 ($175K)','2026-06-30','Trigger: $100K revenue'],
    ['Release 2 — GMP APIs + GMP QC','2026-08-01','GMP API catalog'],
    ['Hire: Sales Rep (Compounding)','2026-08-01','Trigger: $500K/month'],
    ['Release 3 — R&D Services + RFQ Engine','2026-10-01','CRO service booking'],
    ['$10M Annual Revenue','2026-12-31','Primary target'],
  ];
  for (const m of milestones) {
    await query(`INSERT INTO milestones (id,name,target_date,description,status) VALUES ($1,$2,$3,$4,'pending') ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), m[0], m[1], m[2]]);
  }

  const monthlyTargets = [
    ['2026-05',300000],['2026-06',600000],['2026-07',900000],
    ['2026-08',1200000],['2026-09',1500000],['2026-10',1800000],
    ['2026-11',2000000],['2026-12',1700000]
  ];
  for (const t of monthlyTargets) {
    await query(`INSERT INTO targets (id,period_type,period_key,metric,target_value) VALUES ($1,'monthly',$2,'revenue',$3) ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), t[0], t[1]]);
  }

  await query(`INSERT INTO targets (id,period_type,period_key,metric,target_value) VALUES ($1,'annual','2026','revenue',10000000) ON CONFLICT DO NOTHING`,
    [crypto.randomUUID()]);

  console.log('✅ PostgreSQL database ready. Admin:', adminEmail);
}

module.exports = { query, initDB };
