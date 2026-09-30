// ── CDI + CPHI outreach, through the routes, live and self-cleaning ──
//
// The two lists wired last. Kept because the failure they exposed was invisible to the unit tests:
// clinical_studies.id is a uuid, the registry said bigint, and every study write returned 400 with the
// control sitting on the page looking fine.
//
// Also asserts `lead` is still listed by the overview (the API supports it) while having no control on the
// page — the deliberate gap, so "unwired" cannot silently become "unsupported".
//
// Run:  railway ssh 'node scripts/verify-outreach-newlists-live.js'

const jwt=require('jsonwebtoken');
const {query}=require('../src/lib/db');
const P=process.env.PORT||3000;
let fail=0,made=[];
const check=(l,a,e)=>{const ok=JSON.stringify(a)===JSON.stringify(e);if(!ok)fail++;
  console.log(`  ${ok?'✅':'❌'} ${l}${ok?'':`  → expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`}`);};
(async()=>{
 try{
  const sup=(await query(`SELECT id,email,role FROM users WHERE role='super_admin' LIMIT 1`)).rows[0];
  const t=jwt.sign({id:sup.id,email:sup.email,role:sup.role},process.env.JWT_SECRET,{expiresIn:'5m'});
  const hit=async(m,p,b)=>{const r=await fetch(`http://127.0.0.1:${P}${p}`,{method:m,headers:{Authorization:'Bearer '+t,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});
    const x=await r.text();let j={};try{j=JSON.parse(x)}catch(_){}
    return {status:r.status,body:j,raw:x.slice(0,120)};};

  console.log('the two newly wired entity types, end to end');
  const study=(await query(`SELECT id FROM clinical_studies ORDER BY id LIMIT 1`)).rows[0];
  const exh=(await query(`SELECT id FROM cphi_exhibitor_matches WHERE match_tier <> 'token' ORDER BY id LIMIT 1`)).rows[0];
  const r1=await hit('PUT','/api/outreach',{entity_type:'study',entity_id:study.id,status:'contacted',note:'sponsor emailed'});
  check('a study records',[r1.status,r1.body.to],[200,'contacted']); if(r1.status===200) made.push(['study',String(study.id)]);
  const r2=await hit('PUT','/api/outreach',{entity_type:'exhibitor',entity_id:exh.id,status:'in_progress'});
  check('an exhibitor records',[r2.status,r2.body.to],[200,'in_progress']); if(r2.status===200) made.push(['exhibitor',String(exh.id)]);

  console.log('\nthe bars over the real lists');
  const st=(await query(`SELECT COUNT(*)::int n FROM clinical_studies`)).rows[0].n;
  const sb=await hit('GET',`/api/outreach/summary?entity_type=study&total=${st}`);
  check(`study: 1 contacted, ${st-1} new`,[sb.body.counts.contacted,sb.body.counts.new],[1,st-1]);
  const eb=await hit('GET','/api/outreach/summary?entity_type=exhibitor&total=286');
  check('exhibitor: 1 in_progress, 285 new',[eb.body.counts.in_progress,eb.body.counts.new],[1,285]);

  console.log('\nthe overview: five lists reachable, lead still silent');
  const o=await hit('GET','/api/outreach/overview?days=7');
  check('2 events',o.body.total_events,2);
  const bl=Object.fromEntries(o.body.by_list.map(l=>[l.entity_type,l.events]));
  check('study 1',bl.study,1); check('exhibitor 1',bl.exhibitor,1);
  check('silent now',o.body.silent.map(l=>l.entity_type).sort(),['establishment','institution','lead','prospect']);
  console.log(`     by status: ${JSON.stringify(o.body.by_status)}`);
  console.log('     lead is in by_list (the API supports it) but has no control on the page — by decision');
  check('lead IS listed as a visible list',Object.keys(bl).includes('lead'),true);
 }catch(e){fail++;console.error('ERR',e.message);}
 finally{
  for(const [ty,id] of made) await query(`DELETE FROM outreach WHERE entity_type=$1 AND entity_id=$2`,[ty,id]).catch(()=>{});
  const n=(await query(`SELECT COUNT(*)::int n FROM outreach`)).rows[0].n;
  console.log(`\ncleanup: outreach ${n} rows`);
  if(n) fail++;
  console.log(fail===0?'\n✅ ALL CHECKS PASSED':`\n❌ ${fail} FAILED`);
  process.exit(fail===0?0:1);
 }
})();
