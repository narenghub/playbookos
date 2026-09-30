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
let fail=0, made=[];
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
  check('no events',o0.body.total_events,0);
  check('all six lists silent',o0.body.silent.length,6);
  console.log('     silent: '+o0.body.silent.map(l=>l.entity_type).join(', '));

  console.log('\n2. record some outreach on a real SiteNex prospect');
  const sx=(await query(`SELECT id FROM prospects WHERE product='sitenex' ORDER BY id LIMIT 2`)).rows;
  const r1=await hit('PUT','/api/outreach',{entity_type:'prospect',entity_id:sx[0].id,status:'contacted',note:'live check'});
  check('contacted',[r1.status,r1.body.to],[200,'contacted']); made.push(['prospect',String(sx[0].id)]);
  const inst=(await query(`SELECT id FROM research_institutions ORDER BY id LIMIT 1`)).rows[0];
  const r2=await hit('PUT','/api/outreach',{entity_type:'institution',entity_id:inst.id,status:'interested'});
  check('an institution too',r2.status,200); made.push(['institution',String(inst.id)]);

  console.log('\n3. won → a SiteNex deal, created then linked');
  const dealsBefore=(await query(`SELECT COUNT(*)::int n FROM sitenex_deals`)).rows[0].n;
  const w1=await hit('PUT','/api/outreach',{entity_type:'prospect',entity_id:sx[1].id,status:'won'});
  made.push(['prospect',String(sx[1].id)]);
  check('deal created',[w1.status,w1.body.deal&&w1.body.deal.created],[200,true]);
  console.log(`     deal #${w1.body.deal&&w1.body.deal.id} status=${w1.body.deal&&w1.body.deal.status}`);
  const w2=await hit('PUT','/api/outreach',{entity_type:'prospect',entity_id:sx[1].id,status:'won'});
  check('re-marking LINKS, does not duplicate',w2.body.deal.created,false);
  check('exactly one new deal',(await query(`SELECT COUNT(*)::int n FROM sitenex_deals`)).rows[0].n-dealsBefore,1);
  check('and it shows on the deals board',(await hit('GET','/api/sitenex/deals')).body.total,1);

  console.log('\n4. THE OVERVIEW again — silence shrinks, people appear');
  const o1=await hit('GET','/api/outreach/overview?days=7');
  check('events counted',o1.body.total_events,4);
  check('one person',o1.body.people.length,1);
  console.log(`     ${o1.body.people[0].person}: ${o1.body.people[0].total} — ${JSON.stringify(o1.body.people[0].by_status)}`);
  const byList=Object.fromEntries(o1.body.by_list.map(l=>[l.entity_type,l.events]));
  check('prospect list has 3',byList.prospect,3);
  check('institution list has 1',byList.institution,1);
  check('four lists still silent',o1.body.silent.map(l=>l.entity_type).sort(),['establishment','exhibitor','lead','study']);

  console.log('\n5. the status bar over a real list');
  const total=(await query(`SELECT COUNT(*)::int n FROM prospects WHERE product='sitenex'`)).rows[0].n;
  const bar=await hit('GET',`/api/outreach/summary?entity_type=prospect&total=${total}&product=sitenex`);
  check('contacted 1',bar.body.counts.contacted,1);
  check('won 1',bar.body.counts.won,1);
  check(`new = ${total} - 2`,bar.body.counts.new,total-2);
 }catch(e){fail++;console.error('ERR',e.message);}
 finally{
  for(const [ty,id] of made) await query(`DELETE FROM outreach WHERE entity_type=$1 AND entity_id=$2`,[ty,id]).catch(()=>{});
  await query(`DELETE FROM sitenex_deals WHERE created_at > NOW() - INTERVAL '10 minutes'`).catch(()=>{});
  const o=(await query(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
  const d=(await query(`SELECT COUNT(*)::int n FROM sitenex_deals`)).rows[0].n;
  console.log(`\ncleanup: outreach ${o}, sitenex_deals ${d}`);
  if(o||d) fail++;
  console.log(fail===0?'\n✅ ALL CHECKS PASSED':`\n❌ ${fail} FAILED`);
  process.exit(fail===0?0:1);
 }
})();
