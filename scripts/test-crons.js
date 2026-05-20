// scripts/test-crons.js — manually invoke each cron job to verify it runs without errors
// Usage: railway run --service playbookos sh -c 'DATABASE_URL=$DATABASE_PUBLIC_URL_FROM_PG node scripts/test-crons.js'
// All jobs default to dryRun mode (skips outbound email + ai_analyses insert + milestone update).
// Pass --live as first arg to run for real.
if (require('fs').existsSync(require('path').join(__dirname, '..', '.env'))) {
  try { require('dotenv').config(); } catch {}
}

const live = process.argv.includes('--live');
const opts = { dryRun: !live };

const { syncGitHubAllDevs, runWeeklyAnalysis, checkMilestoneTriggers, scoreAllAndCoach } = require('../src/lib/jobs');
const { analyzeRevenueTrends, getProcurementPriorities } = require('../src/lib/agents/revenue-agent');
const { generateDailyBriefing } = require('../src/lib/agents/briefing-agent');
const { syncAlgoliaSearchData, generateSEORecommendations } = require('../src/lib/agents/growth-agent');
const { cascadeGoals, assignWeeklyKPIsForAll } = require('../src/lib/agents/goal-engine');

async function step(name, fn) {
  process.stdout.write(`\n▶ ${name} ... `);
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    console.log(`OK (${ms}ms)`);
    console.log('   result:', JSON.stringify(result));
    return { ok: true, result, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`FAIL (${ms}ms)`);
    console.log('   error:', e.message);
    console.log('   stack:', e.stack?.split('\n').slice(0, 4).join('\n          '));
    return { ok: false, error: e.message, ms };
  }
}

async function main() {
  console.log(`Mode: ${live ? 'LIVE (real sends, real writes)' : 'DRY RUN (safe — no email, no inserts)'}`);
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL not set');
    process.exit(1);
  }
  console.log(`DB: ${process.env.DATABASE_URL.replace(/:\/\/[^@]+@/, '://[REDACTED]@')}`);

  const r1 = await step('syncGitHubAllDevs (8am cron)',           () => syncGitHubAllDevs());
  const r2 = await step('runWeeklyAnalysis (9am Mon cron)',       () => runWeeklyAnalysis(opts));
  const r3 = await step('checkMilestoneTriggers (6pm cron)',      () => checkMilestoneTriggers(opts));
  const r4 = await step('scoreAllAndCoach (6pm cron)',            () => scoreAllAndCoach(opts));
  const r5 = await step('analyzeRevenueTrends (9am Mon cron)',    () => analyzeRevenueTrends(opts));
  const r6 = await step('getProcurementPriorities (9am Mon)',     () => getProcurementPriorities(opts));
  const r7 = await step('generateDailyBriefing (7am cron)',       () => generateDailyBriefing(opts));
  const r8 = await step('syncAlgoliaSearchData (8am Mon)',        () => syncAlgoliaSearchData());
  const r9 = await step('generateSEORecommendations (8am Mon)',   () => generateSEORecommendations(opts));
  const r10 = await step('cascadeGoals (8am Mon)',                () => cascadeGoals(opts));
  const r11 = await step('assignWeeklyKPIsForAll (8am Mon)',      () => assignWeeklyKPIsForAll(opts));

  const failures = [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11].filter(r => !r.ok);
  console.log(`\n${failures.length === 0 ? '✅ All 11 cron jobs ran successfully' : `❌ ${failures.length} failure(s)`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('Test harness error:', e); process.exit(1); });
