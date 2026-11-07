// ── DOES CERTIFICATE VERIFICATION ACTUALLY REFUSE THE WRONG CERTIFICATE? ──────────────────────────
//
//   node scripts/check-db-tls-verification.js ; echo $?
//
// Ruling 49 items 1 and 2. src/lib/db.js can now verify the server's certificate against a pinned
// copy instead of accepting any certificate. The only claim worth making about that is the negative
// one: a connection presenting the WRONG certificate must FAIL. "It connected with the right one"
// proves nothing on its own — `rejectUnauthorized: false` also connects with the right one, and
// with every wrong one too.
//
// So this builds a Postgres with TLS on and a self-signed certificate, then connects four ways:
//
//   1. no pin                  — connects, encrypted, certificate not verified (the unchanged default)
//   2. the right certificate   — connects, and pg_stat_ssl confirms TLS
//   3. a DIFFERENT certificate — MUST FAIL
//   4. right certificate, wrong fingerprint — MUST FAIL
//
// 3 and 4 are the assertions that matter. 4 exists because a pinned file on disk is a claim about
// what the operator fetched; the fingerprint check is the same claim verified at the point of use.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pgBinCandidates, EXIT_NOT_EXECUTED } = require('./lib/pg-cluster');

const PGPORT = process.env.TLSCHECK_PGPORT || '55491';

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ok    ${m}`); };
const bad = (m, d) => { fail += 1; console.log(`  FAIL  ${m}${d ? `\n          ${d}` : ''}`); };
const h = (t) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`);

let temp = null;
function stop() {
  if (!temp) return;
  try {
    execFileSync('sh', ['-c', temp.asPostgres
      ? `su postgres -c "PATH=${temp.dir}:\\$PATH pg_ctl -D ${temp.base}/data -m immediate stop"`
      : `PATH=${temp.dir}:$PATH pg_ctl -D ${temp.base}/data -m immediate stop`], { stdio: 'pipe' });
  } catch { /* going away */ }
  try { fs.rmSync(temp.base, { recursive: true, force: true }); } catch { /* temp */ }
}

function main() {
  h('DATABASE TLS — DOES VERIFICATION REFUSE THE WRONG CERTIFICATE');

  const dir = pgBinCandidates()[0];
  if (!dir) {
    console.log('\nSKIP  no PostgreSQL server toolchain. This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }
  try { execFileSync('sh', ['-c', 'command -v openssl'], { stdio: 'pipe' }); } catch {
    console.log('\nSKIP  openssl not available — cannot make certificates. This proved NOTHING.\n');
    process.exit(EXIT_NOT_EXECUTED);
  }

  const base = fs.mkdtempSync('/var/tmp/tlscheck-');
  const asPostgres = process.getuid && process.getuid() === 0;
  temp = { base, dir, asPostgres };
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const run = (cmd) => execFileSync('sh', ['-c', asPostgres ? `su postgres -c ${JSON.stringify(cmd)}` : cmd],
    { env, encoding: 'utf8', stdio: 'pipe' });

  // Two independent self-signed certificates: one the server will use, one that is simply a
  // different valid certificate — the stand-in for an interceptor's.
  execFileSync('sh', ['-c',
    `cd ${base} && openssl req -new -x509 -days 2 -nodes -text -subj "/CN=localhost" `
    + `-out server.crt -keyout server.key 2>/dev/null && chmod 600 server.key && `
    + `openssl req -new -x509 -days 2 -nodes -text -subj "/CN=localhost" `
    + `-out other.crt -keyout other.key 2>/dev/null`], { stdio: 'pipe' });

  if (!fs.existsSync(path.join(base, 'server.crt')) || !fs.existsSync(path.join(base, 'other.crt'))) {
    bad('could not generate test certificates');
    stop();
    process.exit(1);
  }
  if (asPostgres) execFileSync('chown', ['-R', 'postgres', base]);

  try {
    run(`PATH=${dir}:$PATH initdb -D ${base}/data -U postgres --auth=trust`);
    run(`PATH=${dir}:$PATH pg_ctl -D ${base}/data -l ${base}/pg.log `
      + `-o '-k ${base} -p ${PGPORT} -c listen_addresses=127.0.0.1 -c ssl=on `
      + `-c ssl_cert_file=${base}/server.crt -c ssl_key_file=${base}/server.key' start -w`);
  } catch (e) {
    bad('could not start a TLS-enabled cluster', String(e.message).split('\n').slice(-2).join(' '));
    try { console.log(fs.readFileSync(path.join(base, 'pg.log'), 'utf8').slice(-600)); } catch { /* no log */ }
    stop();
    process.exit(1);
  }

  const url = `postgresql://postgres@127.0.0.1:${PGPORT}/postgres`;

  // Each attempt runs in a CHILD process, because src/lib/db.js reads its TLS configuration once at
  // require time — the same property the readiness harness depends on, and the reason a single
  // process cannot test four configurations.
  const attempt = (label, extraEnv) => {
    const code = `
      process.env.DATABASE_URL = ${JSON.stringify(url)};
      const { query } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'lib', 'db'))});
      query("SELECT ssl, COALESCE(version,'') v FROM pg_stat_ssl WHERE pid = pg_backend_pid()")
        .then((r) => { console.log("OK " + JSON.stringify(r.rows[0])); process.exit(0); })
        .catch((e) => { console.log("ERR " + e.message); process.exit(3); });`;
    try {
      const out = execFileSync(process.execPath, ['-e', code],
        { env: { ...process.env, ...extraEnv }, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
      return { code: 0, out: out.trim() };
    } catch (e) {
      return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}`.trim() };
    }
  };

  // 1 — the unchanged default.
  const a1 = attempt('default', { DATABASE_CA_CERT_FILE: '', DATABASE_CA_CERT: '', DATABASE_SSL_FINGERPRINT: '' });
  if (a1.code === 0 && /"ssl":true/.test(a1.out)) {
    ok('with no pin: connects, and pg_stat_ssl reports TLS — the unchanged application default');
  } else bad(`the default path did not connect over TLS (exit ${a1.code})`, a1.out.slice(0, 200));

  // The fingerprint of the certificate the server is actually using.
  const fp = execFileSync('sh', ['-c',
    `openssl x509 -in ${base}/server.crt -noout -fingerprint -sha256 | sed 's/^.*=//'`],
  { encoding: 'utf8' }).trim();

  // 2 — the right certificate, pinned.
  const a2 = attempt('pinned', {
    DATABASE_CA_CERT_FILE: path.join(base, 'server.crt'),
    DATABASE_SSL_FINGERPRINT: fp,
  });
  if (a2.code === 0 && /"ssl":true/.test(a2.out)) ok('with the correct certificate pinned: connects over verified TLS');
  else bad(`pinning the correct certificate broke the connection (exit ${a2.code})`, a2.out.slice(0, 300));

  // 3 — THE ASSERTION THAT MATTERS. A different certificate must be refused.
  const a3 = attempt('wrong cert', {
    DATABASE_CA_CERT_FILE: path.join(base, 'other.crt'),
    DATABASE_SSL_FINGERPRINT: '',
  });
  if (a3.code !== 0 && /self.signed|self signed|unable to verify|certificate/i.test(a3.out)) {
    ok(`a DIFFERENT certificate is refused: ${(a3.out.match(/ERR (.*)/) || [, ''])[1].slice(0, 80)}`);
  } else {
    bad(`a different certificate was ACCEPTED (exit ${a3.code})`,
      `${a3.out.slice(0, 200)} — verification is not actually happening`);
  }

  // 4 — right certificate, wrong fingerprint: the pin is checked at the point of use.
  const a4 = attempt('wrong fingerprint', {
    DATABASE_CA_CERT_FILE: path.join(base, 'server.crt'),
    DATABASE_SSL_FINGERPRINT: '00'.repeat(32),
  });
  if (a4.code !== 0 && /fingerprint mismatch/i.test(a4.out)) {
    ok('the right certificate with a WRONG fingerprint is refused — the pin is checked, not assumed');
  } else {
    bad(`a fingerprint mismatch was accepted (exit ${a4.code})`, a4.out.slice(0, 200));
  }

  // 5 — item 2: the default is reached by the same code path, unchanged, when nothing is set.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'db.js'), 'utf8');
  if (/if \(!pem\) return \{ rejectUnauthorized: false \};/.test(src)) {
    ok('with no certificate supplied, sslConfig() returns the original { rejectUnauthorized: false }');
  } else bad('the unchanged default is no longer identifiable in src/lib/db.js');
  if (/if \(!process\.env\.DATABASE_URL\) return false;/.test(src)) {
    ok('…and with no DATABASE_URL at all it still returns false, as before');
  } else bad('the no-URL case changed');

  h(`  ${pass} assertion(s) passed · ${fail} failed`);
  stop();
  if (fail) {
    console.log('\nFAIL  certificate verification does not refuse what it must refuse.\n');
    process.exit(1);
  }
  console.log('\nPASS  a wrong certificate and a wrong fingerprint are both refused; the correct pin\n'
    + '      connects over verified TLS; and with nothing pinned the application default is\n'
    + '      byte-for-byte what it was.\n');
}

try { main(); } catch (e) {
  console.error(`\ncheck-db-tls-verification: ${e.message}\n`);
  stop();
  process.exit(1);
}
process.on('exit', stop);
