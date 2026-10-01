// ── OUTREACH, through the HTTP ROUTES, live and self-cleaning ──
//
// Separate from verify-outreach-live.js, which calls the module directly. Both are needed, and the
// difference is not academic: the module returned the created deal correctly while the ROUTE dropped it from
// the JSON, so the won → sitenex_deals link worked and was invisible. Only a check that crosses the route
// could see that.
//
// Also covers the silence with an empty table (every list silent) and the status bar's implicit 'new'.
//
// Run:  railway ssh 'node scripts/verify-outreach-ui-live.js'

const jwt=require('jsonwebtoken');
const {query}=require('../src/lib/db');
const P=process.env.PORT||3000;
let fail=0, made=[], dealIds=[];
const check=(l,a,e)=>{const ok=JSON.stringify(a)===JSON.stringify(e);if(!ok)fail++;
  console.log(`  ${ok?'✅':'❌'} ${l}${ok?'':`  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`);};
(async()=>{
 try{
  const sup=(await query(`SELECT id,email,role FROM users WHERE role='super_admin' LIMIT 1`)).rows[0];
  const t=jwt.sign({id:sup.id,email:sup.email,role:sup.role},process.env.JWT_SECRET,{expiresIn:'5m'});
  const hit=async(m,p,b)=>{const r=await fetch(`http://127.0.0.1:${P}${p}`,{method:m,headers:{Authorization:'Bearer '+t,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});
    const x=await r.text();let j={};try{j=JSON.parse(x)}catch(_){ }
    return {status:r.status,body:j,raw:x.slice(0,140)};};

  console.log('1. THE OVERVIEW with nothing recorded — every list silent');
  const o0=await hit('GET','/api/outreach/overview?days=7');
  check('200',o0.status,200);
  // A BASELINE, not zero. This asserted an empty table, which was true the day it was written and stopped being
  // true the moment somebody used the feature — a real user wrote 10 events today. CLAUDE.md's rule: never
  // assert a table is empty; compare a delta against what was already there.
  const base={ events:o0.body.total_events, people:o0.body.people.length, silent:o0.body.silent.length };
  console.log(`     baseline: ${base.events} event(s), ${base.people} person(s), ${base.silent} silent list(s)`);
  check('the overview reads',typeof o0.body.total_events,'number');
  console.log('     silent: '+o0.body.silent.map(l=>l.entity_type).join(', '));

  console.log('\n2. record some outreach on a real SiteNex prospect');
  const sx=(await query(`SELECT id FROM prospects WHERE product='sitenex' ORDER BY id LIMIT 2`)).rows;
  const r1=await hit('PUT','/api/outreach',{entity_type:'prospect',entity_id:sx[0].id,status:'contacted',note:'live check'});
  check('contacted',[r1.status,r1.body.to],[200,'contacted']); made.push(['prospect',String(sx[0].id)]);
  const inst=(await query(`SELECT id FROM research_institutions ORDER BY id LIMIT 1`)).rows[0];
  const r2=await hit('PUT','/api/outreach',{entity_type:'institution',entity_id:inst.id,status:'following_up',channel:'linkedin'});
  check('an institution too',[r2.status,r2.body.to,r2.body.channel],[200,'following_up','linkedin']);
  made.push(['institution',String(inst.id)]);

  console.log('\n3. won → a SiteNex deal, created then linked');
  const dealsBefore=(await query(`SELECT COUNT(*)::int n FROM sitenex_deals`)).rows[0].n;
  const boardBefore=(await hit('GET','/api/sitenex/deals')).body.total;
  const w1=await hit('PUT','/api/outreach',{entity_type:'prospect',entity_id:sx[1].id,status:'won'});
  made.push(['prospect',String(sx[1].id)]);
  check('deal created',[w1.status,w1.body.deal&&w1.body.deal.created],[200,true]);
  console.log(`     deal #${w1.body.deal&&w1.body.deal.id} status=${w1.body.deal&&w1.body.deal.status}`);
  const w2=await hit('PUT','/api/outreach',{entity_type:'prospect',entity_id:sx[1].id,status:'won'});
  check('re-marking LINKS, does not duplicate',w2.body.deal.created,false);
  check('exactly one new deal',(await query(`SELECT COUNT(*)::int n FROM sitenex_deals`)).rows[0].n-dealsBefore,1);
  if(w1.body.deal&&w1.body.deal.id) dealIds.push(w1.body.deal.id);
  // Measured as a DELTA against what the board already held. Asserting the absolute number 1 meant the
  // check passed only while production had no real deals, and read as a failure the moment one existed.
  check('and it shows on the deals board',(await hit('GET','/api/sitenex/deals')).body.total-boardBefore,1);

  console.log('\n4. THE OVERVIEW again — silence shrinks, people appear');
  const o1=await hit('GET','/api/outreach/overview?days=7');
  check('four more events than the baseline',o1.body.total_events-base.events,4);
  check('  and one more person',o1.body.people.length-base.people,1);
  const me=o1.body.people.find(x=>/super|admin|naren/i.test(x.person||''))||o1.body.people[0];
  console.log(`     ${me.person}: ${me.total} — ${JSON.stringify(me.by_status)}`);
  const byList=Object.fromEntries(o1.body.by_list.map(l=>[l.entity_type,l.events]));
  check('prospect list has 3',byList.prospect,3);
  check('institution list has 1',byList.institution,1);
  // Two lists gained activity (prospect and institution), so the silence shrinks by exactly two — a delta,
  // because which lists are ALREADY silent depends on what everybody else has been doing.
  check('the silence shrinks by exactly two',base.silent-o1.body.silent.length,2);
  check('  and the two that gained activity are no longer silent',
        o1.body.silent.map(l=>l.entity_type).filter(t=>t==='prospect'||t==='institution'),[]);

  console.log('\n5. the status bar over a real list');
  const total=(await query(`SELECT COUNT(*)::int n FROM prospects WHERE product='sitenex'`)).rows[0].n;
  const bar=await hit('GET',`/api/outreach/summary?entity_type=prospect&total=${total}&product=sitenex`);
  check('contacted 1',bar.body.counts.contacted,1);
  check('won 1',bar.body.counts.won,1);
  check(`not_contacted = ${total} - 2`,bar.body.counts.not_contacted,total-2);
  // The ORDER is contract: the bar has to read as a funnel over the wire, not be re-sorted by the client.
  check('the bar arrives in funnel order',bar.body.order.slice(0,3),['not_contacted','contacted','following_up']);
 }catch(e){fail++;console.error('ERR',e.message);}
 finally{
  for(const [ty,id] of made) await query(`DELETE FROM outreach WHERE entity_type=$1 AND entity_id=$2`,[ty,id]).catch(()=>{});
  // BY ID. This used to delete every deal created in the last ten minutes, which against production would
  // have taken out a deal somebody had just closed — a cleanup with a blast radius wider than what it made.
  for(const id of dealIds) await query(`DELETE FROM sitenex_deals WHERE id=$1`,[id]).catch(()=>{});
  let mine=0;
  for(const [ty,id] of made) mine+=(await query(
    `SELECT COUNT(*)::int n FROM outreach WHERE entity_type=$1 AND entity_id=$2`,[ty,id])).rows[0].n;
  const leftD=dealIds.length?(await query(
    `SELECT COUNT(*)::int n FROM sitenex_deals WHERE id=ANY($1)`,[dealIds])).rows[0].n:0;
  const o=(await query(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
  const d=(await query(`SELECT COUNT(*)::int n FROM sitenex_deals`)).rows[0].n;
  console.log(`\ncleanup: ${mine} of my ${made.length} outreach row(s) and ${leftD} of my ${dealIds.length} deal(s) remain`);
  console.log(`         tables now hold outreach ${o}, sitenex_deals ${d}`);
  // Only MY rows. "the table is empty" is a fact about today, not a property of this script.
  if(mine||leftD) fail++;
  console.log(fail===0?'\n✅ ALL CHECKS PASSED':`\n❌ ${fail} FAILED`);
  process.exit(fail===0?0:1);
 }
})();
