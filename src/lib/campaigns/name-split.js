// ── SPLITTING A NAME WITHOUT GETTING IT WRONG ─────────────────────────────────
//
// Extracted from scripts/export-cphi-contacts.js when the follow-up runner needed the same
// judgement. It is the same question in both places — "can I greet this person by their given
// name?" — and two copies of that answer would drift.
//
// The greeting is the first line of a message to somebody met four days ago at a trade show.
// Getting it wrong is worse than not sending, which is why callers treat an unsafe split as a
// reason to HOLD the contact rather than to guess.
'use strict';

// Common romanised Chinese and Korean family names. Used ONLY to decide whether a two-token name
// may be family-name-first, and only when it is the FIRST token. Deliberately excludes anything
// that is also a common Western given name (Lee, Young, Song, An) — a false flag on a Western name
// costs a pointless manual check, which is cheap, but the list earns nothing by being long.
const CJK_FAMILY_FIRST = new Set([
  'wu', 'li', 'wang', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao', 'zhou', 'xu', 'sun',
  'ma', 'zhu', 'hu', 'guo', 'he', 'lin', 'gao', 'luo', 'zheng', 'liang', 'xie', 'tang', 'han',
  'cao', 'deng', 'feng', 'zeng', 'peng', 'xiao', 'tian', 'dong', 'pan', 'jiang', 'cai', 'yu',
  'kim', 'park', 'choi', 'jeong', 'kang', 'yoon', 'jang', 'shin',
  // Added 13 Oct after "Xia Xiaoqin" passed as safe and would have been greeted "Hi Xia" — her
  // family name. Her own address, niexiaoqin@thinheal.com, suggests the card may even read Nie.
  // The asymmetry decides which way to err: a false positive here costs one greeting to confirm
  // by hand; a false negative greets a stranger by their surname in the first line of a
  // follow-up. So the list is generous.
  'xia', 'nie', 'shen', 'ren', 'ding', 'lv', 'lu', 'wei', 'su', 'cheng', 'ye', 'du', 'jin',
  'xiong', 'zou', 'liao', 'tan', 'yao', 'shi', 'fan', 'song', 'qian', 'bai', 'cui', 'kong',
  'mao', 'qiu', 'hou', 'shao', 'meng', 'long', 'duan', 'lei', 'qin', 'wan', 'fu', 'yin',
  'ni', 'ji', 'qi', 'an', 'chang', 'kang', 'bo', 'mu', 'rao', 'gu', 'geng', 'xue', 'zhan',
  'ou', 'yan', 'zhuang', 'teng', 'ran', 'tong', 'pang', 'hao', 'guan', 'chu', 'ling',
  'nguyen', 'tran', 'pham', 'huynh', 'vo', 'dang', 'bui', 'ngo',
  'tanaka', 'suzuki', 'sato', 'takahashi', 'watanabe', 'ito', 'yamamoto', 'nakamura',
]);

// ── NAME SPLITTING, WITH ITS OWN DOUBTS DECLARED ─────────────────────────────
//
// Returns { first, last, safe, why }. `safe: false` means a human must read it before import.
function splitName(full) {
  const raw = String(full || '').trim().replace(/\s+/g, ' ');
  const parts = raw.split(' ');
  if (parts.length < 2) return { first: raw, last: '', safe: false, why: 'single token — no surname to split' };

  // An initial anywhere means the printed order is not reliably given-name-first.
  if (parts.some((p) => /^[A-Z]\.?$/.test(p))) {
    return { first: parts[0], last: parts.slice(1).join(' '), safe: false,
             why: 'contains an initial — the card may print surname first' };
  }
  // CJK names are family-name-first, and a ROMANISED one gives no clue which token is which.
  //
  // The first version of this check tested for CJK characters — and "Wu Minnan", the one card in
  // the day-1 set it was written for, passed as safe, because the card is romanised Latin. A guard
  // placed where the condition cannot occur is the same mistake as a checker whose fixture cannot
  // produce the bug. So the test is now on the FIRST TOKEN against common romanised surnames:
  // "Wu Minnan" flags (Wu is the family name, Minnan the given name), while "Trevor Huang" does
  // not, because Trevor is not a surname and Huang is already in the right place.
  //
  // A short list and openly a heuristic. It is not trying to identify nationality — only to stop
  // Apollo greeting a Chinese supplier's Marketing Director by his surname in the first line.
  if (parts.length === 2 && CJK_FAMILY_FIRST.has(parts[0].toLowerCase())) {
    return { first: parts[1], last: parts[0], safe: false,
             why: `"${parts[0]}" is commonly a family name placed FIRST — confirm which is the given name` };
  }
  if (/[\u2E80-\u9FFF]/.test(raw)) {
    return { first: parts.slice(1).join(' '), last: parts[0], safe: false,
             why: 'CJK characters — family name is usually FIRST' };
  }
  if (parts.length > 3) {
    return { first: parts[0], last: parts.slice(1).join(' '), safe: false,
             why: `${parts.length} tokens — check where the surname starts` };
  }
  return { first: parts[0], last: parts.slice(1).join(' '), safe: true, why: null };
}

module.exports = { splitName, CJK_FAMILY_FIRST };
