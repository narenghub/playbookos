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

async function initPhase2() {
  const crypto = require('crypto');
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS decision_rules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, condition_metric TEXT NOT NULL,
        condition_operator TEXT NOT NULL, condition_value REAL NOT NULL,
        action_type TEXT NOT NULL, action_target TEXT, action_message TEXT,
        is_active INTEGER DEFAULT 1, last_fired TEXT, fire_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS skus (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT,
        cost_price REAL DEFAULT 0, sale_price REAL DEFAULT 0, gross_margin REAL DEFAULT 0,
        units_in_stock INTEGER DEFAULT 0, units_sold INTEGER DEFAULT 0,
        revenue_total REAL DEFAULT 0, demand_trend TEXT DEFAULT 'stable',
        lead_time_days INTEGER DEFAULT 14, supplier TEXT,
        is_gmp INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS integrations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT DEFAULT 'pending', last_sync TEXT, created_at TEXT DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS execution_steps (
        id TEXT PRIMARY KEY, step_name TEXT NOT NULL, step_order INTEGER,
        completion_pct INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
        owner TEXT, due_date TEXT, updated_at TEXT DEFAULT NOW()
      );
    `);

    const rules = [
      ['Revenue 20% behind monthly target','monthly_revenue_pct','<',80,'email_admin','naren@abiozen.com','URGENT: Revenue behind target. Consider hiring 1 more sales rep immediately.'],
      ['Sales rep emails below target','daily_emails_sent','<',20,'email_employee','sales','You sent fewer than 20 emails today. Target is 20+. Reach your top 5 contacts now.'],
      ['Dev velocity dropped','weekly_prs_merged','<',3,'email_admin','naren@abiozen.com','Developer velocity low this week. Consider adding a backend engineer.'],
      ['Procurement behind on SKUs','weekly_skus_priced','<',250,'email_employee','procurement','SKU pricing behind target. You need 250 SKUs priced per week.'],
      ['Revenue hit $100K milestone','cumulative_revenue','>=',100000,'hire_trigger','account_manager','Milestone: $100K revenue. Start Account Manager hiring NOW.'],
      ['Revenue hit $500K monthly','monthly_revenue','>=',500000,'hire_trigger','sales_rep_marketing','Milestone: $500K/month. Hire Sales Rep + Marketing Manager simultaneously.'],
      ['Top 10 SKUs = 60% revenue','top10_sku_revenue_pct','>=',60,'email_admin','naren@abiozen.com','Top 10 SKUs driving 60%+ revenue. Double inventory on these immediately.'],
      ['Invoice overdue 7 days','invoice_overdue_days','>=',7,'email_employee','accounting','Invoice overdue. Follow-up email drafted for account manager approval.'],
    ];

    for (const r of rules) {
      await query(`INSERT INTO decision_rules (id,name,condition_metric,condition_operator,condition_value,action_type,action_target,action_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [crypto.randomUUID(),...r]);
    }

    const steps = [
      ['Target set',1,100,'complete','Naresh','2026-04-01'],
      ['SKU catalog',2,60,'in_progress','Palash','2026-05-25'],
      ['Sales outreach loaded',3,40,'in_progress','Palash','2026-05-28'],
      ['Orders live',4,0,'pending','Dev team','2026-05-31'],
      ['India fulfillment',5,20,'at_risk','Naresh','2026-05-15'],
      ['QC reports ready',6,50,'in_progress','Utkarsh','2026-05-31'],
      ['Invoice system',7,5,'pending','Dev team','2026-06-30'],
    ];

    for (const s of steps) {
      await query(`INSERT INTO execution_steps (id,step_name,step_order,completion_pct,status,owner,due_date) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [crypto.randomUUID(),...s]);
    }

    const integrations = [
      ['GitHub API','dev','connected'],
      ['Stripe','payments','pending'],
      ['Claude (Anthropic)','ai','connected'],
      ['Resend Email','email','connected'],
      ['PostgreSQL','database','connected'],
      ['Apollo.io','sales','connected'],
      ['HubSpot CRM','crm','pending'],
      ['Google Search Console','seo','pending'],
      ['FedEx API','fulfillment','pending'],
      ['AWS S3','storage','pending'],
    ];

    for (const i of integrations) {
      await query(`INSERT INTO integrations (id,name,type,status) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [crypto.randomUUID(),...i]);
    }

    await query(`UPDATE integrations SET status='connected' WHERE name='Apollo.io'`);
    await query(`UPDATE integrations SET status='pending' WHERE name='Stripe'`);

    console.log('✅ Phase 2 tables ready');
  } catch(e) { console.error('Phase 2 init error:', e.message); }
}

async function migrateSchemas() {
  try {
    await query(`
      ALTER TABLE skus ADD COLUMN IF NOT EXISTS cas_number TEXT;
      ALTER TABLE skus ADD COLUMN IF NOT EXISTS purity TEXT;
      ALTER TABLE skus ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
      ALTER TABLE skus ADD COLUMN IF NOT EXISTS sds_link TEXT;
      ALTER TABLE skus ADD COLUMN IF NOT EXISTS sds_status TEXT DEFAULT 'pending';
      ALTER TABLE skus ADD COLUMN IF NOT EXISTS coa_link TEXT;
      ALTER TABLE skus ADD COLUMN IF NOT EXISTS coa_status TEXT DEFAULT 'pending';
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS status TEXT;
      ALTER TABLE email_log ADD COLUMN IF NOT EXISTS error_message TEXT;
      CREATE TABLE IF NOT EXISTS seo_rankings (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        page TEXT,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        position REAL DEFAULT 0,
        ctr REAL DEFAULT 0,
        recorded_date TEXT NOT NULL,
        created_at TEXT DEFAULT NOW(),
        UNIQUE(query, recorded_date)
      );
      CREATE INDEX IF NOT EXISTS idx_seo_rankings_query ON seo_rankings (query, recorded_date DESC);
      CREATE TABLE IF NOT EXISTS seo_content (
        id TEXT PRIMARY KEY,
        molecule_name TEXT NOT NULL,
        cas_number TEXT NOT NULL DEFAULT '',
        title TEXT,
        meta_desc TEXT,
        content_html TEXT,
        schema_json TEXT,
        generated_at TEXT DEFAULT NOW(),
        UNIQUE(molecule_name, cas_number)
      );
      CREATE INDEX IF NOT EXISTS idx_seo_content_generated ON seo_content (generated_at DESC);
      CREATE TABLE IF NOT EXISTS custom_roles (
        id TEXT PRIMARY KEY,
        role_name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS buyer_engagement (
        id TEXT PRIMARY KEY,
        contact_email TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('sent','opened','clicked','replied','bounced')),
        event_at TEXT NOT NULL,
        sequence_id TEXT,
        metadata_json TEXT,
        created_at TEXT DEFAULT NOW()
      );
      ALTER TABLE buyer_engagement ADD COLUMN IF NOT EXISTS molecule_interest TEXT;
      CREATE INDEX IF NOT EXISTS idx_buyer_engagement_email ON buyer_engagement (contact_email, event_at DESC);
      CREATE TABLE IF NOT EXISTS linkedin_outreach (
        id TEXT PRIMARY KEY,
        contact_name TEXT NOT NULL,
        contact_title TEXT,
        company TEXT,
        linkedin_url TEXT,
        message_sent TEXT,
        sent_at TEXT,
        connection_accepted INTEGER DEFAULT 0,
        replied INTEGER DEFAULT 0,
        reply_content TEXT,
        buyer_segment TEXT,
        molecule_interest TEXT,
        created_at TEXT DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_linkedin_outreach_sent_at ON linkedin_outreach (sent_at DESC);
      CREATE TABLE IF NOT EXISTS metrics_snapshots (
        id TEXT PRIMARY KEY,
        snapshot_date TEXT NOT NULL UNIQUE,
        revenue_actual REAL DEFAULT 0,
        revenue_target REAL DEFAULT 0,
        revenue_pct INTEGER DEFAULT 0,
        team_avg_score INTEGER DEFAULT 0,
        top_sku TEXT,
        top_buyer_segment TEXT,
        apollo_emails_sent INTEGER DEFAULT 0,
        apollo_reply_rate REAL DEFAULT 0,
        linkedin_pipeline_count INTEGER DEFAULT 0,
        warm_leads_count INTEGER DEFAULT 0,
        skus_added_this_week INTEGER DEFAULT 0,
        github_commits_this_week INTEGER DEFAULT 0,
        created_at TEXT DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS goal_cascades (
        id TEXT PRIMARY KEY,
        parent_goal_id TEXT,
        level TEXT NOT NULL CHECK (level IN ('annual','quarterly','monthly','weekly','daily')),
        metric TEXT NOT NULL,
        target_value REAL NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        assigned_to_role TEXT,
        assigned_to_user_id TEXT,
        auto_generated INTEGER DEFAULT 1,
        created_at TEXT DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_goal_cascades_period ON goal_cascades (level, period_start);
      CREATE INDEX IF NOT EXISTS idx_goal_cascades_role ON goal_cascades (assigned_to_role, level, period_start);
      CREATE TABLE IF NOT EXISTS weekly_kpis (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        week_start TEXT NOT NULL,
        kpi_name TEXT NOT NULL,
        kpi_target REAL NOT NULL,
        kpi_actual REAL DEFAULT 0,
        kpi_unit TEXT,
        status TEXT DEFAULT 'in_progress' CHECK (status IN ('in_progress','met','missed')),
        created_at TEXT DEFAULT NOW(),
        UNIQUE (user_id, week_start, kpi_name)
      );
      CREATE TABLE IF NOT EXISTS performance_scores (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        score_date TEXT NOT NULL,
        score_0_to_100 INTEGER NOT NULL,
        metrics_json TEXT,
        blockers_json TEXT,
        claude_coaching_note TEXT,
        escalated_to_admin INTEGER DEFAULT 0,
        created_at TEXT DEFAULT NOW(),
        UNIQUE(user_id, score_date)
      );
      CREATE TABLE IF NOT EXISTS buyer_contacts (
        id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, title TEXT,
        company TEXT, phone TEXT, segment TEXT, source TEXT DEFAULT 'apollo',
        status TEXT DEFAULT 'prospect', last_contacted TEXT, created_at TEXT DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS apollo_sequences (
        id TEXT PRIMARY KEY, molecule_name TEXT, sku_id TEXT, buyer_segment TEXT,
        emails_sent INTEGER DEFAULT 0, replies INTEGER DEFAULT 0,
        orders_generated INTEGER DEFAULT 0, discount_pct INTEGER,
        status TEXT DEFAULT 'active', created_at TEXT DEFAULT NOW()
      );
      -- Row-level ownership for the enterprise role system. 'own'-scoped roles
      -- (sales_team, procurement_team) see only rows where owner_user_id = them.
      ALTER TABLE buyer_contacts   ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
      ALTER TABLE linkedin_outreach ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
      ALTER TABLE apollo_sequences ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
      ALTER TABLE skus             ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
      -- AI Agent System — Layer 1 foundation + Layer 3 task/message tables.
      ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/Chicago';
      CREATE TABLE IF NOT EXISTS kpi_hierarchy (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        metric TEXT,
        target_value REAL DEFAULT 0,
        current_value REAL DEFAULT 0,
        owner_role TEXT,
        period TEXT,
        created_at TEXT DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_activity_log (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        user_id TEXT,
        reasoning TEXT,
        source_kpi TEXT,
        confidence_score INTEGER,
        output_summary TEXT,
        requires_approval INTEGER DEFAULT 0,
        approved_by TEXT,
        approved_at TEXT,
        created_at TEXT DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON agent_activity_log (created_at DESC);
      CREATE TABLE IF NOT EXISTS approval_queue (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        action_payload TEXT,
        requested_for_user_id TEXT,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        priority TEXT DEFAULT 'MEDIUM',
        created_at TEXT DEFAULT NOW(),
        reviewed_by TEXT,
        reviewed_at TEXT,
        notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue (status, created_at DESC);
      CREATE TABLE IF NOT EXISTS daily_tasks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_date TEXT NOT NULL,
        task_title TEXT NOT NULL,
        task_description TEXT,
        priority TEXT DEFAULT 'MEDIUM' CHECK (priority IN ('HIGH','MEDIUM','LOW')),
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed')),
        source_kpi TEXT,
        agent_name TEXT,
        reasoning TEXT,
        created_at TEXT DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_daily_tasks_user_date ON daily_tasks (user_id, task_date);
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        message_type TEXT,
        content TEXT,
        channel TEXT DEFAULT 'email',
        sent_at TEXT DEFAULT NOW(),
        opened_at TEXT
      );
      CREATE TABLE IF NOT EXISTS linkedin_content_queue (
        id TEXT PRIMARY KEY,
        post_type TEXT NOT NULL CHECK (post_type IN ('product','market_intelligence','company_update','custom')),
        headline TEXT,
        body TEXT,
        hashtags TEXT,
        full_post TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','published','rejected')),
        scheduled_for TEXT,
        published_at TEXT,
        linkedin_post_id TEXT,
        engagement_clicks INTEGER DEFAULT 0,
        engagement_likes INTEGER DEFAULT 0,
        engagement_comments INTEGER DEFAULT 0,
        source_molecule TEXT,
        reviewed_by TEXT,
        reviewed_at TEXT,
        created_at TEXT DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_linkedin_queue_status ON linkedin_content_queue (status, scheduled_for);
      ALTER TABLE linkedin_content_queue ADD COLUMN IF NOT EXISTS image_prompt TEXT;
      ALTER TABLE linkedin_content_queue ADD COLUMN IF NOT EXISTS structure_image_url TEXT;
      ALTER TABLE linkedin_content_queue ADD COLUMN IF NOT EXISTS generated_image_url TEXT;
      INSERT INTO kpi_hierarchy (id, level, parent_id, name, metric, target_value, owner_role, period) VALUES
        ('kpi-vision','vision',NULL,'$10M Revenue by Dec 31, 2026','revenue',10000000,'super_admin','2026'),
        ('kpi-sg-sales','strategic','kpi-vision','Sales — close $10M in confirmed orders','revenue',10000000,'sales_director','2026'),
        ('kpi-sg-procurement','strategic','kpi-vision','Procurement — 3,500 active SKUs sourced','skus_sourced',3500,'procurement_director','2026'),
        ('kpi-sg-marketing','strategic','kpi-vision','Marketing & SEO — organic demand engine','organic_sessions',50000,'seo_specialist','2026'),
        ('kpi-sg-product','strategic','kpi-vision','Product — marketplace & RFQ platform','features_deployed',40,'dev_team','2026')
      ON CONFLICT (id) DO NOTHING;
      -- Legacy role migration — remap the pre-enterprise taxonomy onto the new
      -- roles. Idempotent: after the first run no rows match the old names.
      UPDATE users SET role='dev_team'        WHERE role='dev';
      UPDATE users SET role='procurement_team' WHERE role='procurement' OR role='procurement_lead';
      UPDATE users SET role='sales_team'      WHERE role='sales';
      UPDATE users SET role='support_team'    WHERE role='qc' OR role='marketing';
    `);
    console.log('✅ Schema migrations applied (owner columns + legacy role remap)');
  } catch(e) { console.error('Migration error:', e.message); }
}

module.exports = { query, initDB, initPhase2, migrateSchemas };
