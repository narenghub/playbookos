const crypto = require('crypto');
const { query } = require('../db');
const { runClaudeAnalysis } = require('../core');
const { sendEmail } = require('../mailer');

const DAY_MS = 86400000;
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = n => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

function fmtMoney(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function classifyVelocity(deltaPct) {
  if (deltaPct > 5) return 'accelerating';
  if (deltaPct < -5) return 'decelerating';
  return 'flat';
}

async function gatherRevenueData() {
  const today = todayISO();
  const d30 = daysAgoISO(30);
  const d14 = daysAgoISO(14);
  const d7 = daysAgoISO(7);
  const thisMonth = today.slice(0, 7);

  const byCategory = (await query(
    `SELECT product_category, COUNT(*)::int as orders, COALESCE(SUM(amount),0)::float as revenue
     FROM orders WHERE order_date::text >= $1 AND order_date::text <= $2
     GROUP BY product_category ORDER BY revenue DESC NULLS LAST`,
    [d30, today]
  )).rows;

  const byBuyer = (await query(
    `SELECT buyer_type, COUNT(*)::int as orders, COALESCE(SUM(amount),0)::float as revenue,
            CASE WHEN COUNT(*)>0 THEN COALESCE(SUM(amount),0)/COUNT(*) ELSE 0 END::float as avg_order
     FROM orders WHERE order_date::text >= $1 AND order_date::text <= $2
     GROUP BY buyer_type ORDER BY revenue DESC NULLS LAST`,
    [d30, today]
  )).rows;

  const byWeek = (await query(
    `SELECT to_char(date_trunc('week', order_date::date), 'YYYY-MM-DD') as week_start,
            COUNT(*)::int as orders, COALESCE(SUM(amount),0)::float as revenue
     FROM orders WHERE order_date::text >= $1
     GROUP BY week_start ORDER BY week_start`,
    [d30]
  )).rows;

  const last7 = parseFloat((await query(
    `SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text >= $1 AND order_date::text <= $2`,
    [d7, today]
  )).rows[0].v);
  const prev7 = parseFloat((await query(
    `SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text >= $1 AND order_date::text < $2`,
    [d14, d7]
  )).rows[0].v);
  const deltaPct = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : (last7 > 0 ? 100 : 0);

  const monthlyTarget = parseFloat((await query(
    `SELECT target_value FROM targets WHERE period_type='monthly' AND period_key=$1 AND metric='revenue'`,
    [thisMonth]
  )).rows[0]?.target_value || 0);
  const monthlyActual = parseFloat((await query(
    `SELECT COALESCE(SUM(amount),0) as v FROM orders WHERE order_date::text LIKE $1`,
    [thisMonth + '%']
  )).rows[0].v);

  // Best-effort molecule extraction from order notes ("product: NAME")
  const noted = (await query(
    `SELECT notes, amount FROM orders WHERE order_date::text >= $1 AND notes ILIKE '%product:%'`,
    [d30]
  )).rows;
  const skuMap = new Map();
  for (const r of noted) {
    const m = r.notes.match(/product:\s*([^·\n]+)/i);
    if (m) {
      const name = m[1].trim();
      skuMap.set(name, (skuMap.get(name) || 0) + parseFloat(r.amount || 0));
    }
  }
  const topSkus = Array.from(skuMap.entries())
    .map(([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 3);

  const linkedinStats = (await query(
    `SELECT
       COUNT(*) FILTER (WHERE sent_at >= $1)::int as sent_week,
       COUNT(*) FILTER (WHERE connection_accepted = 1 AND sent_at >= $1)::int as connected_week,
       COUNT(*) FILTER (WHERE replied = 1 AND sent_at >= $1)::int as replied_week,
       COUNT(*)::int as total_outreach
     FROM linkedin_outreach`,
    [d7]
  )).rows[0];

  return {
    period: { from: d30, to: today, this_month: thisMonth },
    by_category: byCategory,
    by_buyer_type: byBuyer,
    by_week: byWeek,
    top_skus: topSkus,
    velocity: { last7, prev7, delta_pct: deltaPct, trend: classifyVelocity(deltaPct) },
    monthly: { target: monthlyTarget, actual: monthlyActual, pct: monthlyTarget > 0 ? Math.round(monthlyActual / monthlyTarget * 100) : 0 },
    linkedin: linkedinStats,
  };
}

function buildPrompt(data) {
  const totalOrders = data.by_category.reduce((s, r) => s + r.orders, 0);
  const totalRev = data.by_category.reduce((s, r) => s + r.revenue, 0);
  return `You are the Revenue Intelligence agent for Abiozen LLC — a life-sciences API distribution company targeting $10M revenue by Dec 2026. Naresh (CEO) reads this every Monday morning.

PERIOD: last 30 days (${data.period.from} through ${data.period.to})
Total orders: ${totalOrders} · Total revenue: ${fmtMoney(totalRev)}

By product category:
${data.by_category.length ? data.by_category.map(r => `  ${r.product_category || '(uncategorized)'}: ${r.orders} orders, ${fmtMoney(r.revenue)}`).join('\n') : '  (no orders in window)'}

By buyer segment (sorted by revenue):
${data.by_buyer_type.length ? data.by_buyer_type.map(r => `  ${r.buyer_type || '(unknown)'}: ${r.orders} orders, ${fmtMoney(r.revenue)}, avg ${fmtMoney(r.avg_order)}`).join('\n') : '  (no orders in window)'}

Top 3 molecules by revenue (parsed from order notes):
${data.top_skus.length ? data.top_skus.map((s, i) => `  ${i + 1}. ${s.name}: ${fmtMoney(s.revenue)}`).join('\n') : '  (no molecule-level data available — orders lack product names in notes)'}

Weekly trend:
${data.by_week.length ? data.by_week.map(w => `  Week of ${w.week_start}: ${fmtMoney(w.revenue)} (${w.orders} orders)`).join('\n') : '  (no weekly data)'}

Velocity: last 7 days ${fmtMoney(data.velocity.last7)} vs prior 7 days ${fmtMoney(data.velocity.prev7)} → ${data.velocity.delta_pct >= 0 ? '+' : ''}${data.velocity.delta_pct.toFixed(1)}% (${data.velocity.trend})

This month: ${fmtMoney(data.monthly.actual)} of ${fmtMoney(data.monthly.target)} target (${data.monthly.pct}%)

LinkedIn pipeline (last 7 days): ${data.linkedin?.sent_week || 0} sent, ${data.linkedin?.connected_week || 0} connected, ${data.linkedin?.replied_week || 0} replied (total roster: ${data.linkedin?.total_outreach || 0})

Write EXACTLY 5 numbered actionable recommendations covering:
1. Which buyer segment to double down on this week (be specific to the data above).
2. Which product category to scale procurement on, with one supplier action.
3. The single biggest revenue risk to address now.
4. One revenue acceleration move (new buyer segment, channel, pricing, etc.).
5. One concrete experiment to run this week (define success metric).

Be concrete. Reference actual numbers from the data above. No fluff, no hedging, no "consider" — give a direct recommendation. Format as a numbered list, one sentence per item plus a brief why.`;
}

function renderRevenueReport(data, recommendations) {
  const trendColor = data.velocity.trend === 'accelerating' ? '#1D9E75' : data.velocity.trend === 'decelerating' ? '#E24B4A' : '#666';
  const trendArrow = data.velocity.trend === 'accelerating' ? '▲' : data.velocity.trend === 'decelerating' ? '▼' : '◆';
  const recHtml = recommendations.replace(/\n/g, '<br>');
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">
  <div style="background:#1B3A6B;padding:20px;border-radius:8px 8px 0 0;color:#fff">
    <h2 style="margin:0;font-size:20px">Revenue Intelligence — ${data.period.this_month}</h2>
    <p style="margin:6px 0 0;color:#9FE1CB;font-size:13px">Last 30 days · ${data.period.from} through ${data.period.to}</p>
  </div>
  <div style="border:1px solid #e0e0e0;border-top:none;padding:20px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <tr>
        <td style="padding:12px;background:#f5f5f5;border-radius:6px;text-align:center;width:33%">
          <div style="font-size:12px;color:#666">This month</div>
          <div style="font-size:22px;font-weight:700;color:#1B3A6B">${fmtMoney(data.monthly.actual)}</div>
          <div style="font-size:11px;color:#0D7377">${data.monthly.pct}% of ${fmtMoney(data.monthly.target)}</div>
        </td>
        <td style="width:8px"></td>
        <td style="padding:12px;background:#f5f5f5;border-radius:6px;text-align:center;width:33%">
          <div style="font-size:12px;color:#666">Last 7 days</div>
          <div style="font-size:22px;font-weight:700;color:#1B3A6B">${fmtMoney(data.velocity.last7)}</div>
          <div style="font-size:11px;color:#666">prev 7: ${fmtMoney(data.velocity.prev7)}</div>
        </td>
        <td style="width:8px"></td>
        <td style="padding:12px;background:#f5f5f5;border-radius:6px;text-align:center;width:33%">
          <div style="font-size:12px;color:#666">Velocity</div>
          <div style="font-size:22px;font-weight:700;color:${trendColor}">${trendArrow} ${data.velocity.delta_pct >= 0 ? '+' : ''}${data.velocity.delta_pct.toFixed(1)}%</div>
          <div style="font-size:11px;color:${trendColor};text-transform:capitalize">${data.velocity.trend}</div>
        </td>
      </tr>
    </table>

    <h3 style="margin:0 0 8px;font-size:14px;color:#0D7377">By product category</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px">
      <tr style="background:#1B3A6B;color:#fff"><th style="padding:8px;text-align:left">Category</th><th style="padding:8px;text-align:right">Orders</th><th style="padding:8px;text-align:right">Revenue</th></tr>
      ${data.by_category.map((r, i) => `<tr style="background:${i % 2 ? '#fff' : '#f8fafc'}"><td style="padding:6px 8px">${r.product_category || '(uncategorized)'}</td><td style="padding:6px 8px;text-align:right">${r.orders}</td><td style="padding:6px 8px;text-align:right;font-weight:600">${fmtMoney(r.revenue)}</td></tr>`).join('') || '<tr><td colspan="3" style="padding:12px;text-align:center;color:#888">No orders in window</td></tr>'}
    </table>

    <h3 style="margin:0 0 8px;font-size:14px;color:#0D7377">By buyer segment</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px">
      <tr style="background:#1B3A6B;color:#fff"><th style="padding:8px;text-align:left">Buyer</th><th style="padding:8px;text-align:right">Orders</th><th style="padding:8px;text-align:right">Avg order</th><th style="padding:8px;text-align:right">Revenue</th></tr>
      ${data.by_buyer_type.map((r, i) => `<tr style="background:${i % 2 ? '#fff' : '#f8fafc'}"><td style="padding:6px 8px">${r.buyer_type || '(unknown)'}</td><td style="padding:6px 8px;text-align:right">${r.orders}</td><td style="padding:6px 8px;text-align:right">${fmtMoney(r.avg_order)}</td><td style="padding:6px 8px;text-align:right;font-weight:600">${fmtMoney(r.revenue)}</td></tr>`).join('') || '<tr><td colspan="4" style="padding:12px;text-align:center;color:#888">No orders in window</td></tr>'}
    </table>

    ${data.top_skus.length ? `<h3 style="margin:0 0 8px;font-size:14px;color:#0D7377">Top molecules (from order notes)</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px">
      <tr style="background:#1B3A6B;color:#fff"><th style="padding:8px;text-align:left">Rank</th><th style="padding:8px;text-align:left">Molecule</th><th style="padding:8px;text-align:right">Revenue</th></tr>
      ${data.top_skus.map((s, i) => `<tr style="background:${i % 2 ? '#fff' : '#f8fafc'}"><td style="padding:6px 8px;font-weight:700;color:#1B3A6B">${i + 1}</td><td style="padding:6px 8px">${s.name}</td><td style="padding:6px 8px;text-align:right;font-weight:600">${fmtMoney(s.revenue)}</td></tr>`).join('')}
    </table>` : ''}

    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:12px;margin-bottom:16px;font-size:13px">
      <div style="font-weight:700;color:#166534;margin-bottom:4px">LinkedIn pipeline (last 7 days)</div>
      <div style="color:#15803d">${data.linkedin?.sent_week || 0} sent · ${data.linkedin?.connected_week || 0} connected · ${data.linkedin?.replied_week || 0} replied · ${data.linkedin?.total_outreach || 0} total contacts in roster</div>
    </div>

    <h3 style="margin:20px 0 8px;font-size:14px;color:#0D7377">5 actionable recommendations (Claude)</h3>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px;line-height:1.7;font-size:13px;white-space:pre-wrap">${recHtml}</div>

    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
    <p style="font-size:11px;color:#888;margin:0">View full dashboard: ${process.env.BASE_URL || 'http://localhost:3000'}</p>
  </div>
</div>`;
}

async function analyzeRevenueTrends({ dryRun = false } = {}) {
  const data = await gatherRevenueData();
  const recommendations = dryRun
    ? '[dry run] Claude recommendations skipped'
    : await runClaudeAnalysis(buildPrompt(data));

  const result = { ...data, recommendations, generated_at: new Date().toISOString() };

  if (!dryRun) {
    await query(
      `INSERT INTO ai_analyses (id, analysis_type, period_key, content) VALUES ($1, 'revenue_intelligence', $2, $3)`,
      [crypto.randomUUID(), data.period.this_month, JSON.stringify(result)]
    );
    const admin = (await query("SELECT email FROM users WHERE role='admin' AND is_active=1 LIMIT 1")).rows[0];
    if (admin?.email) {
      await sendEmail({
        to: admin.email,
        subject: `Revenue Intelligence — ${data.period.this_month} (${data.velocity.trend}, ${data.monthly.pct}% of target)`,
        html: renderRevenueReport(data, recommendations)
      });
    }
  }

  return result;
}

function renderProcurementList(items, context) {
  return `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#1a1a2e">
  <div style="background:#0D7377;padding:20px;border-radius:8px 8px 0 0;color:#fff">
    <h2 style="margin:0;font-size:20px">This week — source these ${items.length} molecules first</h2>
    <p style="margin:6px 0 0;color:#9FE1CB;font-size:13px">Ranked by revenue impact, based on last 30-day demand and current stock levels</p>
  </div>
  <div style="border:1px solid #e0e0e0;border-top:none;padding:20px">
    <p style="margin:0 0 12px;font-size:13px;color:#444">${context}</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="background:#1B3A6B;color:#fff">
        <th style="padding:8px;text-align:left">Rank</th>
        <th style="padding:8px;text-align:left">Molecule</th>
        <th style="padding:8px;text-align:left">Category</th>
        <th style="padding:8px;text-align:left">Supplier</th>
        <th style="padding:8px;text-align:right">In stock</th>
        <th style="padding:8px;text-align:right">Sale price</th>
        <th style="padding:8px;text-align:right">Impact</th>
      </tr>
      ${items.map((s, i) => `<tr style="background:${i % 2 ? '#fff' : '#f8fafc'}">
        <td style="padding:6px 8px;font-weight:700;color:#1B3A6B">${i + 1}</td>
        <td style="padding:6px 8px;font-weight:600">${s.name}</td>
        <td style="padding:6px 8px;color:#666">${s.category || '—'}</td>
        <td style="padding:6px 8px;color:#666">${s.supplier || '—'}</td>
        <td style="padding:6px 8px;text-align:right;color:${(s.units_in_stock || 0) < 3 ? '#E24B4A' : '#666'};font-weight:${(s.units_in_stock || 0) < 3 ? 700 : 400}">${s.units_in_stock || 0}</td>
        <td style="padding:6px 8px;text-align:right">${fmtMoney(s.sale_price)}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:700;color:#0D7377">${fmtMoney(s.impact_score)}</td>
      </tr>`).join('')}
    </table>
    <div style="margin-top:16px;padding:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:13px;color:#92400e">
      <strong>Action:</strong> Confirm supplier quotes by end of week. Upload COA + SDS to PlaybookOS SKU Economics for each restocked item.
    </div>
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
    <p style="font-size:11px;color:#888;margin:0">View SKU Economics dashboard: ${process.env.BASE_URL || 'http://localhost:3000'}</p>
  </div>
</div>`;
}

async function getProcurementPriorities({ dryRun = false } = {}) {
  const latest = (await query(
    `SELECT content, created_at FROM ai_analyses WHERE analysis_type='revenue_intelligence' ORDER BY created_at DESC LIMIT 1`
  )).rows[0];
  if (!latest) return { skipped: true, reason: 'no revenue_intelligence report yet — run analyzeRevenueTrends first' };

  let intel;
  try { intel = JSON.parse(latest.content); }
  catch { return { skipped: true, reason: 'latest revenue_intelligence content is not JSON' }; }

  const topCategories = (intel.by_category || []).slice(0, 5).map(c => c.product_category).filter(Boolean);
  const topMolecules = (intel.top_skus || []).slice(0, 5).map(s => s.name);

  const lowStock = (await query(
    `SELECT id, name, category, supplier, units_in_stock, sale_price, is_gmp
     FROM skus
     WHERE is_active=1 AND (units_in_stock IS NULL OR units_in_stock < 10)`
  )).rows;

  let matched = lowStock.filter(s =>
    (s.category && topCategories.includes(s.category)) ||
    topMolecules.some(m => s.name?.toLowerCase().includes(m.toLowerCase()))
  );
  const usingFallback = matched.length === 0;
  if (usingFallback) matched = lowStock;

  const ranked = matched
    .map(s => ({
      ...s,
      impact_score: (parseFloat(s.sale_price) || 0) * Math.max(1, 10 - parseInt(s.units_in_stock || 0))
    }))
    .sort((a, b) => b.impact_score - a.impact_score)
    .slice(0, 10);

  if (ranked.length === 0) return { skipped: true, reason: 'no low-stock active SKUs in catalog' };

  const procUsers = (await query(
    `SELECT email, name FROM users WHERE role='procurement' AND is_active=1 AND email IS NOT NULL`
  )).rows;

  const context = usingFallback
    ? `Couldn't match low-stock SKUs to the top revenue categories (${topCategories.join(', ') || 'none'}) or top molecules — showing all low-stock active SKUs ranked by potential revenue impact.`
    : `Top revenue categories last 30 days: ${topCategories.join(', ')}. ${topMolecules.length ? `Top molecules mentioned in orders: ${topMolecules.join(', ')}.` : ''}`;

  let emailedCount = 0;
  if (!dryRun) {
    const html = renderProcurementList(ranked, context);
    for (const u of procUsers) {
      const ok = await sendEmail({
        to: u.email,
        subject: `This week — source these ${ranked.length} molecules first (revenue-impact ranked)`,
        html
      });
      if (ok) emailedCount++;
    }
  }

  return {
    items: ranked,
    top_categories: topCategories,
    top_molecules: topMolecules,
    used_fallback: usingFallback,
    recipients: procUsers.map(u => u.email),
    emailed: emailedCount,
    dryRun
  };
}

module.exports = { analyzeRevenueTrends, getProcurementPriorities };
