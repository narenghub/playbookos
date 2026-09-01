// Content pipeline ORCHESTRATOR — runContentPipeline(product). Modelled directly on
// research-intelligence/index.js: never-throws, per-item error collection, a daily USD cost
// fuse, ON CONFLICT dedup, rate limiting, an item cap, and logAgentActivity on completion.
//
// Flag-gated by CONTENT_PIPELINE_ENABLED (default OFF). No cron is wired — this is a manual
// trigger only for now. With the flag off, runContentPipeline is a no-op (no fetch, no LLM,
// no DB). All I/O collaborators are injectable via `deps` for hermetic tests.

const { query } = require('../../db');
const { logAgentActivity } = require('../../agent-core');
const { notify } = require('../../notify');
const { getConfig } = require('./config');
const news = require('./news-source');
const { classifyItem } = require('./classify');
const { generateContent } = require('./generate');

const AGENT_NAME = 'content-pipeline';

function envNum(env, name, def) { const n = Number(env[name]); return Number.isFinite(n) ? n : def; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Public entry point. Never throws — returns a summary object.
async function runContentPipeline(product, { dryRun = false, deps = {} } = {}) {
  const env = deps.env || process.env;
  const summary = {
    product,
    enabled: true,
    items_fetched: 0,
    items_processed: 0,
    drafts_created: 0,
    dropped_irrelevant: 0,
    duplicates: 0,
    cost_usd: 0,
    tokens: { input: 0, output: 0 },
    dry_run: !!dryRun,
    errors: [],
  };

  // Master flag — OFF by default. No-op means no fetch, no LLM, no DB.
  if (String(env.CONTENT_PIPELINE_ENABLED) !== 'true') {
    summary.enabled = false;
    return summary;
  }

  const getCfg = deps.getConfig || getConfig;
  const config = getCfg(product);
  if (!config) { summary.errors.push({ stage: 'config', error: `no content config for product '${product}'` }); return summary; }

  const cap = envNum(env, 'CONTENT_PIPELINE_DAILY_USD_CAP', 1.00);
  const rateMs = envNum(env, 'CONTENT_PIPELINE_RATE_MS', 200);
  const maxItems = envNum(env, 'CONTENT_PIPELINE_MAX_ITEMS', 20);

  const q = deps.query || query;
  const source = deps.source || news;
  const classify = deps.classify || classifyItem;
  const generate = deps.generate || generateContent;
  const logActivity = deps.logAgentActivity || logAgentActivity;

  // Accumulate token/cost from any stage result carrying { usage, costUsd }.
  const track = (r) => {
    if (!r) return;
    if (r.usage) { summary.tokens.input += r.usage.input_tokens || 0; summary.tokens.output += r.usage.output_tokens || 0; }
    summary.cost_usd += (r.costUsd || 0);
  };

  try {
    const fetched = await source.fetchItems(config.query, null);
    if (fetched.error) summary.errors.push({ stage: 'fetch', error: fetched.error });
    const rawItems = (fetched.items || []).slice(0, maxItems);
    summary.items_fetched = rawItems.length;

    for (const raw of rawItems) {
      // Cost fuse: stop BEFORE spending anything more once the cap is reached.
      if (summary.cost_usd >= cap) {
        summary.errors.push({ stage: 'cost_cap', error: `cost cap $${cap} reached (spent $${summary.cost_usd.toFixed(4)})` });
        break;
      }

      const item = source.parseItem(raw);
      if (!item.source_ref || !item.title) { summary.errors.push({ stage: 'parse', error: 'missing source_ref/title' }); continue; }
      summary.items_processed++;

      try {
        // 1. Classify (cheap). Drop irrelevant items BEFORE generation — cost control early.
        const c = await classify(item, config);
        track(c);
        if (c.error) { summary.errors.push({ stage: 'classify', source_ref: item.source_ref, error: c.error }); continue; }
        if (!c.relevant) { summary.dropped_irrelevant++; continue; }
        await sleep(rateMs);

        // 2. Cost fuse again before the expensive generate call.
        if (summary.cost_usd >= cap) {
          summary.errors.push({ stage: 'cost_cap', error: `cost cap $${cap} reached (spent $${summary.cost_usd.toFixed(4)})` });
          break;
        }

        // 3. Generate.
        const g = await generate(item, c, config);
        track(g);
        if (g.error) { summary.errors.push({ stage: 'generate', source_ref: item.source_ref, error: g.error }); continue; }
        await sleep(rateMs);

        // 4. Persist as a draft, deduped by (product, source_ref). Nothing returned = dup.
        if (dryRun) { summary.drafts_created++; continue; }
        const cost = Number(((c.costUsd || 0) + (g.costUsd || 0)).toFixed(4));
        const ins = await q(
          `INSERT INTO content_queue (product, source_ref, topic, segment, headline, body, status, cost_usd, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,NOW())
           ON CONFLICT (product, source_ref) DO NOTHING
           RETURNING id`,
          [product, item.source_ref, c.topic, c.segment, g.headline, g.body, cost]
        );
        if (ins && ins.rows && ins.rows.length) summary.drafts_created++;
        else summary.duplicates++;
      } catch (e) {
        summary.errors.push({ stage: 'item', source_ref: item.source_ref, error: e && e.message ? e.message : String(e) });
      }
    }
  } catch (e) {
    summary.errors.push({ stage: 'run', error: e && e.message ? e.message : String(e) });
  }

  summary.cost_usd = Number(summary.cost_usd.toFixed(4));

  if (!dryRun) {
    try {
      await logActivity({
        agent_name: AGENT_NAME,
        action_type: 'generate',
        reasoning: `Content pipeline run for ${product}`,
        output_summary: `fetched=${summary.items_fetched} drafts=${summary.drafts_created} `
          + `dropped=${summary.dropped_irrelevant} dups=${summary.duplicates} `
          + `cost=$${summary.cost_usd} errors=${summary.errors.length}`,
      });
    } catch { /* logging must never break the run */ }
    // Notifications (never-throws; must not affect the run). New drafts → approval_pending;
    // a run that collected errors → agent_failed.
    if (summary.drafts_created > 0) {
      await notify({ product, kind: 'approval_pending', severity: 'info',
        title: `${summary.drafts_created} content draft${summary.drafts_created === 1 ? '' : 's'} awaiting approval`,
        body: `${product}: review and approve in Content Studio.`, link_page: 'content-studio' }, { query: q });
    }
    if (summary.errors.length > 0) {
      await notify({ product, kind: 'agent_failed', severity: 'error',
        title: `Content pipeline: ${summary.errors.length} error${summary.errors.length === 1 ? '' : 's'} for ${product}`,
        body: summary.errors.slice(0, 3).map(e => `${e.stage}: ${e.error}`).join(' · '), link_page: 'content-studio' }, { query: q });
    }
  }
  return summary;
}

module.exports = { runContentPipeline, AGENT_NAME };
