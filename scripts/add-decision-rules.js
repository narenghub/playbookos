const { initDB, query } = require('../src/lib/db');

async function addTables() {
  await initDB();
  
  await query(`
    CREATE TABLE IF NOT EXISTS decision_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      condition_metric TEXT NOT NULL,
      condition_operator TEXT NOT NULL,
      condition_value REAL NOT NULL,
      action_type TEXT NOT NULL,
      action_target TEXT,
      action_message TEXT,
      is_active INTEGER DEFAULT 1,
      last_fired TEXT,
      fire_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT NOW()
    );
    
    CREATE TABLE IF NOT EXISTS skus (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      cost_price REAL DEFAULT 0,
      sale_price REAL DEFAULT 0,
      gross_margin REAL DEFAULT 0,
      units_in_stock INTEGER DEFAULT 0,
      units_sold INTEGER DEFAULT 0,
      revenue_total REAL DEFAULT 0,
      demand_trend TEXT DEFAULT 'stable',
      lead_time_days INTEGER DEFAULT 14,
      supplier TEXT,
      is_gmp INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT NOW()
    );
    
    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      config JSONB,
      last_sync TEXT,
      created_at TEXT DEFAULT NOW()
    );
    
    CREATE TABLE IF NOT EXISTS execution_steps (
      id TEXT PRIMARY KEY,
      step_name TEXT NOT NULL,
      step_order INTEGER,
      completion_pct INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      owner TEXT,
      due_date TEXT,
      updated_at TEXT DEFAULT NOW()
    );
  `);

  const crypto = require('crypto');

  const rules = [
    ['Revenue 20% behind monthly target', 'monthly_revenue_pct', '<', 80, 'email_admin', 'naren@abiozen.com', 'URGENT: Revenue is behind target. Consider hiring 1 more sales rep immediately.'],
    ['Sales rep emails below target', 'daily_emails_sent', '<', 20, 'email_employee', 'sales', 'You sent fewer than 20 emails today. Target is 20+. Here are your top 5 contacts to reach today.'],
    ['Dev velocity dropped', 'weekly_prs_merged', '<', 3, 'email_admin', 'naren@abiozen.com', 'Developer velocity is low this week. Consider adding a backend engineer.'],
    ['Procurement behind on SKUs', 'weekly_skus_priced', '<', 250, 'email_employee', 'procurement', 'SKU pricing is behind target this week. You need 250 SKUs priced per week.'],
    ['Revenue hit $100K milestone', 'cumulative_revenue', '>=', 100000, 'hire_trigger', 'account_manager', 'Milestone reached: $100K revenue. Start Account Manager hiring process NOW.'],
    ['Revenue hit $500K monthly', 'monthly_revenue', '>=', 500000, 'hire_trigger', 'sales_rep_marketing', 'Milestone: $500K/month. Hire Sales Rep + Marketing Manager simultaneously.'],
    ['Top 10 SKUs = 60% revenue', 'top10_sku_revenue_pct', '>=', 60, 'email_admin', 'naren@abiozen.com', 'Top 10 SKUs driving 60%+ of revenue. Double inventory on these immediately.'],
    ['Invoice overdue 7 days', 'invoice_overdue_days', '>=', 7, 'email_employee', 'accounting', 'Invoice overdue. Draft follow-up email sent to account manager for approval.'],
  ];

  for (const r of rules) {
    await query(
      `INSERT INTO decision_rules (id,name,condition_metric,condition_operator,condition_value,action_type,action_target,action_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), ...r]
    );
  }

  const steps = [
    ['Target set', 1, 100, 'complete', 'Naresh', '2026-04-01'],
    ['SKU catalog', 2, 60, 'in_progress', 'Palash', '2026-05-25'],
    ['Sales outreach loaded', 3, 40, 'in_progress', 'Palash', '2026-05-28'],
    ['Orders live', 4, 0, 'pending', 'Dev team', '2026-05-31'],
    ['India fulfillment', 5, 20, 'at_risk', 'Naresh', '2026-05-15'],
    ['QC reports ready', 6, 50, 'in_progress', 'Utkarsh', '2026-05-31'],
    ['Invoice system', 7, 5, 'pending', 'Dev team', '2026-06-30'],
  ];

  for (const s of steps) {
    await query(
      `INSERT INTO execution_steps (id,step_name,step_order,completion_pct,status,owner,due_date) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [require('crypto').randomUUID(), ...s]
    );
  }

  const integrations = [
    ['GitHub API', 'dev', 'connected'],
    ['Stripe', 'payments', 'connected'],
    ['Claude (Anthropic)', 'ai', 'connected'],
    ['Resend Email', 'email', 'connected'],
    ['PostgreSQL', 'database', 'connected'],
    ['Apollo.io', 'sales', 'pending'],
    ['HubSpot CRM', 'crm', 'pending'],
    ['Google Search Console', 'seo', 'pending'],
    ['FedEx API', 'fulfillment', 'pending'],
    ['AWS S3', 'storage', 'pending'],
  ];

  for (const i of integrations) {
    await query(
      `INSERT INTO integrations (id,name,type,status) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [require('crypto').randomUUID(), ...i]
    );
  }

  console.log('✅ Decision rules, SKUs, integrations, execution steps tables created');
  process.exit(0);
}

addTables().catch(e => { console.error(e); process.exit(1); });
