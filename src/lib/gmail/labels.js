// ── THE THREE FOLDERS: SUPPLIER · BUYER · PARTNER ─────────────────────────────
//
// Naren wants each CPHI conversation filed under its segment so he can open one folder and see
// every thread with that kind of company, the way "Playbook" and "Village of Buffalo Grove" already
// sit in his sidebar. Those are flat, top-level labels, so these three are too.
//
// Gmail has no folders. What the sidebar calls a folder is a LABEL, and the three facts that matter:
//
//   1. A user label applied to ONE message makes the whole THREAD appear under that label in the
//      web UI. So labelling the message we just sent is enough — their reply lands in the same
//      thread and shows up in the same folder without anything further running. That is the point:
//      the filing must keep working while he is travelling and nothing is being run by hand.
//   2. Label names are unique. Creating one that exists returns 409, which is not an error worth
//      failing on — it means somebody (or an earlier run) already made it. Re-list and use theirs.
//   3. `gmail.modify` permits labels.create and messages.modify. `gmail.send` does not. The grant on
//      abiozen.com is modify, so this works; but if that ever narrows to send-only, labelling must
//      degrade to a warning and NEVER to a failed send.
//
// ── WHY A LABEL FAILURE IS NOT A SEND FAILURE ────────────────────────────────
//
// Labelling happens after Gmail has accepted the message. By then the mail is gone — it cannot be
// unsent, and the send row must record that it went. If the label call fails and the caller treats
// that as a failed send, the next run sees an unconfirmed claim, a human is told the message "may or
// may not have gone", and the actual state of the world is that it went and is merely unfiled.
//
// So every function here returns { ok } or { error } and throws nothing the caller must catch. An
// unfiled thread is a tidiness problem Naren can fix with one drag; a mis-recorded send is not.
'use strict';

// campaign → the name he will read in the sidebar. The campaign keys are the ones in
// src/lib/campaigns/cphi-followup.js, and `partner` already covers both qc_lab and platform_partner
// — which is what he asked for: "in the partner, you can mention QC platform".
const CAMPAIGN_LABELS = Object.freeze({
  supplier: 'Supplier',
  buyer: 'Buyer',
  partner: 'Partner',
  // SCOPE Europe. Without this every demand_intel thread sends UNFILED, and filing is not
  // cosmetic: reply-sync finds replies by walking the campaign's labelled threads, so an unlabelled
  // thread is one whose reply never stops the sequence. The person answers and gets chased anyway.
  demand_intel: 'Demand Intelligence',
  lab_network: 'Lab Network',
});

// ── NEED-BASED OUTREACH, FILED SEPARATELY ────────────────────────────────────
//
// A second family of sequences, routed by what a contact needs rather than by a show they stood
// at. Kept in its own map for the same reason the campaign→event mapping is per event: these
// label names are read by reply-sync, and a key colliding across the two families would file a
// professor's reply in the CPHI supplier folder.
//
// Filing is not cosmetic here either. Reply-sync finds replies by walking the labelled threads, so
// an unlabelled thread is one whose reply never stops the sequence — the person answers, and gets
// chased anyway.
const NEED_LABELS = Object.freeze({
  discovery: 'Discovery',
  clinical_api: 'Clinical API',
  custom_synthesis: 'Custom Synthesis',
  catalogue_api: 'Catalogue',
  reference_standard: 'Reference Standards',
});

/** The label for a campaign, or null if that campaign has none. Never invents a name. */
function labelForCampaign(campaign) {
  return CAMPAIGN_LABELS[String(campaign || '').toLowerCase()] || null;
}

/** The label for a need, or null. Never invents a name — an unknown need files nowhere. */
function labelForNeed(need) {
  return NEED_LABELS[String(need || '').toLowerCase()] || null;
}

// Resolved label ids, per mailbox. A run of fifty sends should not list the label set fifty times.
// Keyed by subject because one process can act as more than one mailbox, and a label id from
// naren@ means nothing in sales@.
const cache = new Map();
const key = (subject, name) => `${String(subject).toLowerCase()}\u0000${name.toLowerCase()}`;

/** Forget cached label ids — for a test, or after a label is renamed in the UI. */
function resetLabelCache() { cache.clear(); }

const msg = (e) => (e && e.message) || String(e);

/**
 * The id of `name`, creating the label if it does not exist.
 * Returns { id, created } or { error }.
 *
 * Matching is case-insensitive on lookup but the label is CREATED with the exact name given, so
 * "supplier" typed somewhere in code still finds the "Supplier" he sees in the sidebar rather than
 * making a second folder beside it.
 */
async function ensureLabel(gmail, subject, name) {
  if (!gmail) return { error: 'no gmail client' };
  if (!subject) return { error: 'a subject mailbox is required' };
  if (!name) return { error: 'a label name is required' };

  const cached = cache.get(key(subject, name));
  if (cached) return { id: cached, created: false };

  let existing;
  try {
    existing = ((await gmail.users.labels.list({ userId: 'me' })).data.labels) || [];
  } catch (e) {
    return { error: `cannot list labels: ${msg(e)}` };
  }

  const hit = existing.find((l) => String(l.name).toLowerCase() === name.toLowerCase());
  if (hit) {
    cache.set(key(subject, name), hit.id);
    return { id: hit.id, created: false };
  }

  try {
    const made = (await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',    // in the sidebar, not behind "More"
        messageListVisibility: 'show',
      },
    })).data;
    cache.set(key(subject, name), made.id);
    return { id: made.id, created: true };
  } catch (e) {
    // 409 means it exists after all — two runs racing, or it was made in the UI between the list
    // and the create. Not a failure: re-read and use the one that is there.
    const code = (e && (e.code || (e.response && e.response.status))) || 0;
    if (Number(code) === 409) {
      try {
        const again = ((await gmail.users.labels.list({ userId: 'me' })).data.labels) || [];
        const now = again.find((l) => String(l.name).toLowerCase() === name.toLowerCase());
        if (now) { cache.set(key(subject, name), now.id); return { id: now.id, created: false }; }
      } catch (e2) { return { error: `label exists but cannot be read back: ${msg(e2)}` }; }
      return { error: `label "${name}" exists but was not in the list` };
    }
    return { error: `cannot create label "${name}": ${msg(e)}` };
  }
}

/**
 * Put `labelName` on one message. Returns { ok: true, labelId } or { error }.
 *
 * addLabelIds is a set operation — applying a label a message already carries is a no-op, so a
 * backfill can be re-run without thinking about what it did last time.
 */
async function labelMessage(gmail, subject, messageId, labelName) {
  if (!messageId) return { error: 'no message id' };
  const l = await ensureLabel(gmail, subject, labelName);
  if (l.error) return { error: l.error };
  try {
    await gmail.users.messages.modify({
      userId: 'me', id: messageId, requestBody: { addLabelIds: [l.id] },
    });
    return { ok: true, labelId: l.id, labelName, created: l.created };
  } catch (e) {
    return { error: `cannot label message ${messageId}: ${msg(e)}` };
  }
}

/**
 * Put `labelName` on every message in a thread. Returns { ok, labelId, messages } or { error }.
 *
 * Labelling the whole thread is not strictly necessary for the folder view — one labelled message
 * is enough for the thread to appear — but it is what makes a SEARCH inside the folder behave the
 * way he expects, because `label:supplier` matches messages and a reply with no label does not
 * match it. Used by the backfill, where the thread may already have replies in it.
 */
async function labelThread(gmail, subject, threadId, labelName) {
  if (!threadId) return { error: 'no thread id' };
  const l = await ensureLabel(gmail, subject, labelName);
  if (l.error) return { error: l.error };
  try {
    // threads.modify applies to every message in the thread in one call, including messages that
    // arrive from the other side — which is the whole reason to prefer it here.
    await gmail.users.threads.modify({
      userId: 'me', id: threadId, requestBody: { addLabelIds: [l.id] },
    });
    return { ok: true, labelId: l.id, labelName, created: l.created };
  } catch (e) {
    return { error: `cannot label thread ${threadId}: ${msg(e)}` };
  }
}

/**
 * Make sure all three folders exist, before a run rather than during one.
 * Returns { ok, labels: {campaign: {name, id, created}}, errors: [...] }.
 *
 * Called at startup so the sidebar is right even on a run where nothing turns out to be due, and so
 * a missing scope is reported once at the top instead of once per message.
 */
async function ensureCampaignLabels(gmail, subject) {
  const labels = {};
  const errors = [];
  for (const [campaign, name] of Object.entries(CAMPAIGN_LABELS)) {
    const r = await ensureLabel(gmail, subject, name);
    if (r.error) { errors.push(`${campaign} → "${name}": ${r.error}`); continue; }
    labels[campaign] = { name, id: r.id, created: r.created };
  }
  return { ok: !errors.length, labels, errors };
}

/** The same, for the need-based sequences. Returns { ok, labels, errors }. */
async function ensureNeedLabels(gmail, subject) {
  const labels = {};
  const errors = [];
  for (const [need, name] of Object.entries(NEED_LABELS)) {
    const r = await ensureLabel(gmail, subject, name);
    if (r.error) { errors.push(`${need} → "${name}": ${r.error}`); continue; }
    labels[need] = { name, id: r.id, created: r.created };
  }
  return { ok: !errors.length, labels, errors };
}

module.exports = {
  CAMPAIGN_LABELS, labelForCampaign,
  NEED_LABELS, labelForNeed, ensureNeedLabels,
  ensureLabel, labelMessage, labelThread, ensureCampaignLabels,
  resetLabelCache,
};
