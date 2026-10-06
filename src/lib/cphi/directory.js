// ── THE CPHI PUBLIC EXHIBITOR DIRECTORY ───────────────────────────────────────
//
// One search against the event's own public exhibitor widget, and the two helpers that read its
// answers. Extracted from scripts/lookup-cphi-exhibitors.js so the supplier lookup and the
// role lookup (QC labs, buyers) share ONE implementation: CPHI rebuilds this widget every year,
// and two copies of the parse would mean finding out twice.
//
// PUBLIC SURFACE ONLY. A plain GET of the exhibitor-list widget with a ?search= term; results are
// server-rendered into __NEXT_DATA__. No login, no attendee data, no private endpoint. Callers
// serialise their requests with a delay — be polite, this is someone's site.
//
// WHY NOT ENUMERATE THE FLOOR. Milan has ~2,989 exhibitors and the directory cannot be walked
// without a persisted-query hash the widget does not expose. So every list here is built the other
// way round: take names we already hold and ask whether each one is on the floor. That is why
// there is no "all CDMOs at Milan" view and cannot be one without new data.

const WIDGET_BY_EVENT = {
  'cphi-milan-2026':
    'https://visitor.cphieventplanner.com/widget/event/cphi-milan-2026/exhibitors/RXZlbnRWaWV3XzEyNzIwOTk=',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function widgetFor(eventSlug) {
  const w = WIDGET_BY_EVENT[eventSlug];
  if (!w) throw new Error(`no exhibitor widget configured for event "${eventSlug}"`);
  return w;
}

/**
 * One public search. Returns { hits: [{name, booth}] } and NEVER throws — a lookup run is hundreds
 * of requests and one failure must not abandon the rest, so the error travels in the result.
 */
async function searchExhibitors(term, eventSlug = 'cphi-milan-2026') {
  try {
    const res = await fetch(`${widgetFor(eventSlug)}?search=${encodeURIComponent(term)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, hits: [] };
    const html = await res.text();
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { error: 'no __NEXT_DATA__ (widget layout changed)', hits: [] };
    const state = (JSON.parse(m[1]).props || {}).apolloState || {};
    const hits = Object.keys(state)
      .filter((k) => state[k].__typename === 'Core_Exhibitor')
      .map((k) => {
        const e = state[k];
        const wk = Object.keys(e).find((x) => x.startsWith('withEvent'));
        return { name: e.name, booth: wk && e[wk] ? e[wk].booth : null };
      });
    return { hits };
  } catch (err) {
    return { error: String(err.message || err), hits: [] };
  }
}

/** CPHI booths are <hall><row><number>, e.g. "10K47" is hall 10. */
function hallOf(booth) {
  const m = /^(\d+)/.exec(String(booth || ''));
  return m ? m[1] : null;
}

/**
 * The parent/sibling warning, written only for `prefix` matches. Prefix means one company name is a
 * PREFIX of the other rather than equal, which on live data is almost always a group relationship —
 * fine for a conversation at the stand, wrong for a contract.
 */
function entityNote(holder, best) {
  if (!best || best.tier !== 'prefix') return null;
  return `Booth is correct, legal entity may differ: the record is filed by "${holder}" but the `
    + `stand reads "${best.name}". Same group — confirm which entity holds the file before contracting.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { searchExhibitors, hallOf, entityNote, sleep, widgetFor, UA, WIDGET_BY_EVENT };
