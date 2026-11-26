// Measure the worker client's actual idle footprint: RSS and CPU over a real polling window,
// against a real server. Nothing is estimated.
const crypto = require('node:crypto'); const http = require('node:http');
const { spawn } = require('node:child_process'); const fs = require('node:fs');
const DISPOSABLE = require('/tmp/claude-0/integration/scripts/lib/pg-disposable');
const c = DISPOSABLE.create({ label: 'cost' });
process.env.DATABASE_URL = c.url;
process.env.ADMIN_EMAIL='cost@x.invalid'; process.env.ADMIN_PASSWORD='c'+crypto.randomBytes(12).toString('hex');
const SEAL = { WORKER_SECRET_SEAL_KEY: crypto.randomBytes(32).toString('hex') };
(async () => {
  const { Pool } = require('pg');
  const P = new Pool({ connectionString: c.url, ssl: false, max: 8 });
  const query = (t,p)=>P.query(t,p);
  const withTransaction = async (fn)=>{const cl=await P.connect();try{await cl.query('BEGIN');const r=await fn(cl);await cl.query('COMMIT');return r;}catch(e){await cl.query('ROLLBACK').catch(()=>{});throw e;}finally{cl.release();}};
  const deps={query,withTransaction,env:SEAL};
  const DB=require('/tmp/claude-0/integration/src/lib/db'); await DB.initDB();
  await require('/tmp/claude-0/integration/src/lib/runs').migrateRuns(query);
  await require('/tmp/claude-0/integration/src/lib/worker/identity').migrateWorkerIdentity(query);
  await require('/tmp/claude-0/integration/src/lib/worker/leases').migrateWorkerTasks(query);
  await require('/tmp/claude-0/integration/src/lib/worker/audit').migrateWorkerAudit(query);
  await require('/tmp/claude-0/integration/src/lib/autonomy').migrateAutonomy(query);
  const express=require('express'); const WR=require('/tmp/claude-0/integration/src/api/worker.routes');
  const app=express(); app.use(express.json({verify:(q,s,b)=>{q.rawBody=b;}}));
  let reqs=0, bytesIn=0, bytesOut=0;
  app.use((q,s,n)=>{reqs++; bytesIn += (q.rawBody?q.rawBody.length:0); const w=s.write.bind(s), e=s.end.bind(s);
    s.write=(ch,...a)=>{if(ch)bytesOut+=Buffer.byteLength(ch);return w(ch,...a);};
    s.end=(ch,...a)=>{if(ch)bytesOut+=Buffer.byteLength(ch);return e(ch,...a);}; n();});
  app.use('/api', WR.createWorkerRouter({enable:true,query,withTransaction,env:SEAL}));
  const srv=http.createServer(app); await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${srv.address().port}`;
  const ID=require('/tmp/claude-0/integration/src/lib/worker/identity');
  const tok=await ID.createEnrollmentToken({label:'cost-probe'},deps);
  const en=await (await fetch(`${base}/api/worker/enroll`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({token:tok.token,hostFingerprint:'cost'})})).json();
  if(!en.ok) throw new Error('enroll failed '+JSON.stringify(en));
  const t0=Date.now(); reqs=0; bytesIn=0; bytesOut=0;
  const child=spawn(process.execPath,['/tmp/claude-0/integration/src/worker-client/run.js'],
    {env:{...process.env, WORKER_API_BASE_URL:base, WORKER_ID:en.workerId,
      PLAYNEXA_WORKER_ENV:'development', PLAYNEXA_DEV_WORKER_SECRET:en.secret,
      PLAYNEXA_ALLOW_HTTP_FOR_TESTS:'1'}, stdio:['ignore','pipe','pipe']});
  let out=''; child.stdout.on('data',d=>{out+=d;}); child.stderr.on('data',d=>{out+=d;});
  const samples=[];
  const sample=()=>{ try{
    const st=fs.readFileSync(`/proc/${child.pid}/status`,'utf8');
    const rss=+(/VmRSS:\s+(\d+) kB/.exec(st)||[0,0])[1];
    const stat=fs.readFileSync(`/proc/${child.pid}/stat`,'utf8').split(' ');
    samples.push({rssKb:rss, utime:+stat[13], stime:+stat[14]});
  }catch(_){}};
  for(let i=0;i<24;i++){ await new Promise(r=>setTimeout(r,2500)); sample(); }
  const secs=(Date.now()-t0)/1000;
  child.kill('SIGTERM'); await new Promise(r=>setTimeout(r,800)); try{child.kill('SIGKILL');}catch(_){}
  const last=samples[samples.length-1], first=samples[0];
  const HZ=100;
  const cpuSec=((last.utime+last.stime)-(first.utime+first.stime))/HZ;
  const span=(samples.length-1)*2.5;
  console.log(JSON.stringify({
    windowSeconds:+secs.toFixed(1),
    rssPeakMiB:+(Math.max(...samples.map(s=>s.rssKb))/1024).toFixed(1),
    rssMedianMiB:+(samples.map(s=>s.rssKb).sort((a,b)=>a-b)[Math.floor(samples.length/2)]/1024).toFixed(1),
    cpuSecondsOverSpan:+cpuSec.toFixed(2), spanSeconds:span,
    cpuFraction:+(cpuSec/span).toFixed(5),
    httpRequests:reqs, requestsPerMinute:+(reqs/(secs/60)).toFixed(1),
    bytesIn, bytesOut, bytesTotal:bytesIn+bytesOut,
    bytesPerRequest:+((bytesIn+bytesOut)/Math.max(1,reqs)).toFixed(1),
    started:/\"at\":\"started\"/.test(out),
  },null,2));
  try{srv.close();}catch(_){}; try{await P.end();}catch(_){}; try{c.destroy();}catch(_){}
  process.exit(0);
})().catch(e=>{console.error(e.stack);try{c.destroy();}catch(_){};process.exit(1);});
