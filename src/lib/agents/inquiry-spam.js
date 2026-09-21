// Spam gate for inbound inquiries.
//
// Sept 2026: 9 of the 11 open inquiries were reply-bait spam. The agent answered every
// one of them, repeatedly, and escalated one to a human. They shared a shape:
//   - a "Re:" to a thread Abiozen never sent, subject carrying a tracker code
//     ("Re: Handle your inquiry - wbx nks", "- wbx gbq", "- wbx rcm")
//   - a display name unrelated to the address ("Jennifer Daniels" <tracydixon995@gmail.com>)
//   - a greeting to someone who does not work here ("Hi William Myers,")
//   - and never a molecule, a quantity or a company
//
// SAFETY PROPERTY: an inquiry naming a molecule, a quantity OR a company is NEVER spam,
// whatever else it looks like. A real buyer who says what they want always gets through;
// the gate can only fire on a message with no commercial substance at all. That is why
// `no_substance` is a required condition and not just another point of score.

const GENERIC_GREETINGS = new Set([
  'there', 'team', 'all', 'everyone', 'sir', 'madam', 'sirs', 'colleague', 'colleagues',
  'friend', 'friends', 'support', 'sales', 'folks', 'guys', 'hi', 'hello', 'greetings',
]);

// "- wbx nks" / "— abc def" at the end of a subject: a sender-side thread tracker.
const TRACKER_CODE = /[-–—]\s*[a-z]{2,6}\s+[a-z]{2,6}\s*$/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z]+/).filter(t => t.length >= 3);

// Does the display name correspond to the address at all?
// "Debayan Saha" <medebayan@gmail.com> → yes (local part contains "debayan").
// "Jennifer Daniels" <tracydixon995@gmail.com> → no.
function nameMatchesAddress(displayName, email) {
  const local = norm(String(email || '').split('@')[0]);
  const nameNorm = norm(displayName);
  if (!local || !nameNorm) return true; // unknown → not evidence of anything
  if (local.includes(nameNorm) || nameNorm.includes(local)) return true;
  for (const t of tokens(displayName)) {
    if (local.includes(t)) return true;
    // initial + surname, e.g. "Brian Pierce" → bpierce
    if (t.length >= 4 && local.includes(t.slice(0, 4))) return true;
  }
  const first = tokens(displayName)[0];
  const last = tokens(displayName).slice(-1)[0];
  if (first && last && local.includes(first[0] + last)) return true;
  return false;
}

// The name a message greets, if it greets a specific person.
function greetedName(body) {
  const m = String(body || '').match(/^\s*(?:hi|hello|dear|hey)\s+([A-Za-z][A-Za-z'’.-]*(?:\s+[A-Za-z][A-Za-z'’.-]*)?)\s*[,!.]/im);
  if (!m) return null;
  const name = m[1].trim();
  if (GENERIC_GREETINGS.has(name.toLowerCase())) return null;
  return name;
}

function isKnownPerson(name, employeeNames = []) {
  const n = norm(name);
  if (!n) return true;
  return employeeNames.some(e => {
    const en = norm(e);
    if (!en) return false;
    if (en === n || en.includes(n) || n.includes(en)) return true;
    // surname-only greeting ("Hi Chen,") still counts as ours
    return tokens(e).some(t => t.length >= 4 && norm(t) === n);
  });
}

/**
 * Classify an inbound inquiry.
 * @param {object} i
 * @param {string} [i.subject]         raw Subject header
 * @param {string} [i.body]            raw body text
 * @param {string} [i.fromName]        display name on the From header
 * @param {string} [i.fromEmail]       address the mail came from
 * @param {string} [i.molecule]        molecule extracted from the message
 * @param {number} [i.quantity]        quantity extracted
 * @param {string} [i.company]         company extracted
 * @param {boolean} [i.weEverEmailed]  have we ever sent mail to this address before?
 * @param {string[]} [i.employeeNames] names of real Abiozen people
 * @returns {{spam: boolean, reasons: string[], signals: string[]}}
 */
function classifyInquirySpam(i = {}) {
  const subject = String(i.subject || '');
  const body = String(i.body || '');
  const signals = [];

  const noSubstance = !String(i.molecule || '').trim()
    && !(Number(i.quantity) > 0)
    && !String(i.company || '').trim();

  if (TRACKER_CODE.test(subject.trim())) signals.push('tracker_code_in_subject');
  if (/^\s*re\s*:/i.test(subject) && i.weEverEmailed === false) signals.push('reply_to_thread_we_never_sent');
  if (i.fromName && !nameMatchesAddress(i.fromName, i.fromEmail)) signals.push('display_name_unrelated_to_address');

  const greeted = greetedName(body);
  if (greeted && !isKnownPerson(greeted, i.employeeNames || [])) signals.push(`greets_non_employee:${greeted}`);

  const spam = noSubstance && signals.length > 0;
  const reasons = spam ? [...signals, 'no_molecule_quantity_or_company'] : [];
  return { spam, reasons, signals };
}

module.exports = { classifyInquirySpam, nameMatchesAddress, greetedName, TRACKER_CODE };
