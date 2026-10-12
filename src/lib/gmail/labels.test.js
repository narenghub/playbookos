'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  labelForCampaign, ensureLabel, labelMessage, labelThread, ensureCampaignLabels,
  resetLabelCache, CAMPAIGN_LABELS,
} = require('./labels');

const SELF = 'naren@abiozen.com';

// A fake Gmail that behaves the way the real one does about label names: unique, and a create of a
// name that exists is a 409 rather than a second label.
function fakeGmail(initial = [], opts = {}) {
  const labels = initial.map((l) => ({ ...l }));
  const calls = { list: 0, create: 0, modifyMessage: [], modifyThread: [] };
  let nextId = 1000;
  return {
    calls, labels,
    users: {
      labels: {
        list: async () => {
          calls.list += 1;
          if (opts.listThrows) throw new Error(opts.listThrows);
          return { data: { labels: labels.slice() } };
        },
        create: async ({ requestBody }) => {
          calls.create += 1;
          if (opts.createThrows) throw Object.assign(new Error(opts.createThrows), { code: opts.createCode });
          if (labels.some((l) => l.name.toLowerCase() === requestBody.name.toLowerCase())) {
            throw Object.assign(new Error('Label name exists or conflicts'), { code: 409 });
          }
          const made = { id: `L_${nextId++}`, ...requestBody };
          labels.push(made);
          return { data: made };
        },
      },
      messages: {
        modify: async ({ id, requestBody }) => {
          calls.modifyMessage.push({ id, add: requestBody.addLabelIds });
          if (opts.modifyThrows) throw new Error(opts.modifyThrows);
          return { data: { id } };
        },
      },
      threads: {
        modify: async ({ id, requestBody }) => {
          calls.modifyThread.push({ id, add: requestBody.addLabelIds });
          if (opts.modifyThrows) throw new Error(opts.modifyThrows);
          return { data: { id } };
        },
      },
    },
  };
}

test.beforeEach(() => resetLabelCache());

// ── THE MAPPING HE ASKED FOR ──────────────────────────────────────────────────

test('three folders, and partner covers QC and platform', () => {
  assert.deepStrictEqual(Object.keys(CAMPAIGN_LABELS).sort(), ['buyer', 'partner', 'supplier']);
  assert.strictEqual(labelForCampaign('supplier'), 'Supplier');
  assert.strictEqual(labelForCampaign('buyer'), 'Buyer');
  // qc_lab and platform_partner both feed the `partner` campaign, so both land in one folder —
  // "in the partner, you can mention QC platform".
  assert.strictEqual(labelForCampaign('partner'), 'Partner');
});

test('an unknown campaign gets NO label rather than an invented one', () => {
  // A new segment added later must not quietly file itself under something plausible.
  assert.strictEqual(labelForCampaign('distributor'), null);
  assert.strictEqual(labelForCampaign(''), null);
  assert.strictEqual(labelForCampaign(undefined), null);
});

// ── EXISTING LABELS ARE REUSED, NOT DUPLICATED ───────────────────────────────

test('an existing label is found, and nothing is created', async () => {
  const g = fakeGmail([{ id: 'L_1', name: 'Supplier' }]);
  const r = await ensureLabel(g, SELF, 'Supplier');
  assert.strictEqual(r.id, 'L_1');
  assert.strictEqual(r.created, false);
  assert.strictEqual(g.calls.create, 0);
});

test('a label he made in the UI under a different case is REUSED', async () => {
  // If he has already dragged one message into a folder called "supplier", creating "Supplier"
  // beside it would give him two folders holding half a campaign each.
  const g = fakeGmail([{ id: 'L_7', name: 'supplier' }]);
  const r = await ensureLabel(g, SELF, 'Supplier');
  assert.strictEqual(r.id, 'L_7');
  assert.strictEqual(g.calls.create, 0);
});

test('a missing label is created, visible in the sidebar', async () => {
  const g = fakeGmail([{ id: 'L_1', name: 'Playbook' }]);
  const r = await ensureLabel(g, SELF, 'Buyer');
  assert.strictEqual(r.created, true);
  const made = g.labels.find((l) => l.name === 'Buyer');
  assert.strictEqual(made.labelListVisibility, 'labelShow');
  assert.strictEqual(made.messageListVisibility, 'show');
});

test('the id is cached: a second lookup does not re-list', async () => {
  const g = fakeGmail([{ id: 'L_1', name: 'Supplier' }]);
  await ensureLabel(g, SELF, 'Supplier');
  const again = await ensureLabel(g, SELF, 'Supplier');
  assert.strictEqual(again.id, 'L_1');
  assert.strictEqual(g.calls.list, 1, 'fifty sends should not list the label set fifty times');
});

test('the cache is per mailbox — a label id from one does not leak into another', async () => {
  // naren@ and sales@ have unrelated label ids. Using one in the other mailbox fails, or worse,
  // silently labels something else.
  const g = fakeGmail([{ id: 'L_naren', name: 'Supplier' }]);
  await ensureLabel(g, SELF, 'Supplier');
  const other = fakeGmail([{ id: 'L_sales', name: 'Supplier' }]);
  const r = await ensureLabel(other, 'sales@abiozen.com', 'Supplier');
  assert.strictEqual(r.id, 'L_sales');
});

test('a 409 from create is resolved by re-reading, not reported as a failure', async () => {
  // Two runs racing, or he made the folder himself between the list and the create. The label
  // exists; that is the desired state.
  let listed = 0;
  const g = {
    users: {
      labels: {
        list: async () => {
          listed += 1;
          return { data: { labels: listed === 1 ? [] : [{ id: 'L_race', name: 'Partner' }] } };
        },
        create: async () => { throw Object.assign(new Error('conflict'), { code: 409 }); },
      },
    },
  };
  const r = await ensureLabel(g, SELF, 'Partner');
  assert.strictEqual(r.id, 'L_race');
  assert.strictEqual(r.error, undefined);
});

// ── A LABEL PROBLEM IS REPORTED, NEVER THROWN ────────────────────────────────

test('a scope refusal returns an error object and does not throw', async () => {
  // If the grant ever narrows to gmail.send, labels.list is refused. The caller is mid-campaign
  // with a message already delivered; an exception here would be caught by the send handler and
  // recorded as a failed send, which is the opposite of what happened.
  const g = fakeGmail([], { listThrows: 'Request had insufficient authentication scopes.' });
  const r = await ensureLabel(g, SELF, 'Supplier');
  assert.match(r.error, /insufficient authentication scopes/);
});

test('labelMessage on a refused modify returns an error, not an exception', async () => {
  const g = fakeGmail([{ id: 'L_1', name: 'Supplier' }], { modifyThrows: 'insufficientPermissions' });
  const r = await labelMessage(g, SELF, 'm1', 'Supplier');
  assert.match(r.error, /insufficientPermissions/);
  assert.strictEqual(r.ok, undefined);
});

test('a missing message or thread id is an error, and nothing is called', async () => {
  const g = fakeGmail([{ id: 'L_1', name: 'Supplier' }]);
  assert.match((await labelMessage(g, SELF, null, 'Supplier')).error, /no message id/);
  assert.match((await labelThread(g, SELF, '', 'Supplier')).error, /no thread id/);
  assert.strictEqual(g.calls.modifyMessage.length, 0);
  assert.strictEqual(g.calls.modifyThread.length, 0);
});

// ── WHAT ACTUALLY GETS LABELLED ──────────────────────────────────────────────

test('labelMessage adds the label id, and adds nothing else', async () => {
  const g = fakeGmail([{ id: 'L_sup', name: 'Supplier' }]);
  const r = await labelMessage(g, SELF, 'm42', 'Supplier');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(g.calls.modifyMessage, [{ id: 'm42', add: ['L_sup'] }]);
});

test('labelThread labels the whole thread, so replies match label: searches too', async () => {
  const g = fakeGmail([{ id: 'L_par', name: 'Partner' }]);
  const r = await labelThread(g, SELF, 't99', 'Partner');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(g.calls.modifyThread, [{ id: 't99', add: ['L_par'] }]);
  assert.strictEqual(g.calls.modifyMessage.length, 0);
});

test('re-labelling is a no-op rather than a second copy — the backfill can re-run', async () => {
  const g = fakeGmail([{ id: 'L_sup', name: 'Supplier' }]);
  await labelThread(g, SELF, 't1', 'Supplier');
  await labelThread(g, SELF, 't1', 'Supplier');
  assert.strictEqual(g.calls.create, 0);
  assert.strictEqual(g.labels.length, 1);
});

// ── ALL THREE, UP FRONT ──────────────────────────────────────────────────────

test('ensureCampaignLabels makes all three even when nothing is due', async () => {
  const g = fakeGmail([{ id: 'L_1', name: 'Playbook' }]);
  const r = await ensureCampaignLabels(g, SELF);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.labels).sort(), ['buyer', 'partner', 'supplier']);
  const names = g.labels.map((l) => l.name).sort();
  assert.deepStrictEqual(names, ['Buyer', 'Partner', 'Playbook', 'Supplier']);
});

test('ensureCampaignLabels reports a scope problem ONCE, at the top, and is not ok', async () => {
  const g = fakeGmail([], { listThrows: 'insufficient authentication scopes' });
  const r = await ensureCampaignLabels(g, SELF);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors.length, 3);
  assert.deepStrictEqual(r.labels, {});
});

test('a mailbox is required — never label as whoever the token happens to be', async () => {
  const g = fakeGmail([{ id: 'L_1', name: 'Supplier' }]);
  assert.match((await ensureLabel(g, '', 'Supplier')).error, /subject mailbox is required/);
});
