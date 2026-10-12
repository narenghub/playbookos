'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { gmailClientFor, resetScopeCache } = require('./client');

const SEND = 'https://www.googleapis.com/auth/gmail.send';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

// A fake Gmail whose getProfile answers for one address only.
const fakeGmail = (addr, { throws } = {}) => () => ({
  users: {
    getProfile: async () => {
      if (throws) { const e = new Error(throws); throw e; }
      return { data: { emailAddress: addr, messagesTotal: 1, threadsTotal: 1 } };
    },
  },
});

test('prefers gmail.send when the grant has it', async () => {
  resetScopeCache();
  const asked = [];
  const res = await gmailClientFor('naren@abiozen.com', {
    getGoogleAccessToken: async ({ scopes }) => { asked.push(scopes); return { access_token: 't', via: 'service_account' }; },
    gmailFactory: fakeGmail('naren@abiozen.com'),
  });
  assert.strictEqual(res.scopeSet, 'send+readonly');
  assert.ok(asked[0].includes(SEND), 'the first attempt must be the narrow set');
});

test('falls back to gmail.modify, which is what the 2026-10-12 grant actually held', async () => {
  // The real grant: gmail.readonly + gmail.modify and NO gmail.send. Asking for send gets
  // unauthorized_client, which is indistinguishable from delegation being off — so the only way to
  // discover modify is available is to try it.
  resetScopeCache();
  const asked = [];
  const res = await gmailClientFor('naren@abiozen.com', {
    getGoogleAccessToken: async ({ scopes }) => {
      asked.push(scopes);
      if (scopes.includes(SEND)) return { error: 'unauthorized_client' };
      return { access_token: 't', via: 'service_account' };
    },
    gmailFactory: fakeGmail('naren@abiozen.com'),
  });
  assert.strictEqual(res.error, undefined, res.error);
  assert.strictEqual(res.scopeSet, 'modify+readonly');
  assert.strictEqual(res.via, 'service_account');
  assert.ok(asked[1].includes(MODIFY));
});

test('a token for the WRONG mailbox is refused, not used', async () => {
  // A token can mint and be a valid token for somebody else. Sending a warm follow-up from the
  // wrong address is worse than not sending it, so this must fail rather than proceed.
  resetScopeCache();
  const res = await gmailClientFor('naren@abiozen.com', {
    getGoogleAccessToken: async () => ({ access_token: 't', via: 'service_account' }),
    gmailFactory: fakeGmail('someone.else@abiozen.com'),
  });
  assert.ok(res.error, 'must not return a client for the wrong identity');
  assert.ok(res.tried.join(' ').includes('someone.else@abiozen.com'));
});

test('a minted token that cannot call Gmail is not treated as success', async () => {
  // Exactly what happened live: the Search-Console refresh token minted happily and the first
  // Gmail call said "Request had insufficient authentication scopes". A resolver that trusted the
  // mint would have handed a sending client to the caller.
  resetScopeCache();
  const res = await gmailClientFor('naren@abiozen.com', {
    getGoogleAccessToken: async () => ({ access_token: 't', via: 'refresh_token' }),
    gmailFactory: fakeGmail('naren@abiozen.com', { throws: 'Request had insufficient authentication scopes.' }),
  });
  assert.ok(res.error, 'a token that cannot call Gmail is not a usable client');
  assert.match(res.tried.join(' '), /insufficient authentication scopes/);
});

test('the winning scope set is cached, so fifty sends do not re-probe a refused scope', async () => {
  resetScopeCache();
  let calls = 0;
  const deps = {
    getGoogleAccessToken: async ({ scopes }) => {
      calls += 1;
      if (scopes.includes(SEND)) return { error: 'unauthorized_client' };
      return { access_token: 't', via: 'service_account' };
    },
    gmailFactory: fakeGmail('naren@abiozen.com'),
  };
  await gmailClientFor('naren@abiozen.com', deps);
  const afterFirst = calls;          // 2: send refused, modify accepted
  await gmailClientFor('naren@abiozen.com', deps);
  assert.strictEqual(calls, afterFirst + 1, 'the second call must go straight to the winning set');
});

test('no subject means no impersonation — never default to "me"', async () => {
  resetScopeCache();
  const res = await gmailClientFor(undefined, { getGoogleAccessToken: async () => ({ access_token: 't' }) });
  assert.match(res.error, /subject mailbox is required/);
});
