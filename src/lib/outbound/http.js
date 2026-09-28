// PlaybookOS — Shared outbound HTTP helper (E2 step 3, part 2)
//
// The sibling of llm.js for outbound JSON-over-HTTP. Same never-throws { data, error }
// contract as callClaude, PLUS the timeout llm.js lacks (AbortController). It normalizes the
// three failure shapes every integration in this repo hand-rolls — network throw, non-2xx
// (status + truncated body), non-JSON body — into a single { error } and returns { data } on
// success.
//
//   httpJson({ url, method, headers, body, timeoutMs }) -> { data, error, status, timedOut }
//
// It is a DUMB TRANSPORT. It deliberately does NOT:
//   • resolve authorization (that's resolve()/the gate)
//   • know MCP/JSON-RPC framing (that's mcp.js, on top)
//   • look up credentials or select by product/tenant (callers pass ready headers)
//   • audit or log (the gate owns tool_call_audit)
//   • retry/backoff (hidden retries double-spend — none here)
//   • cache, or throw.

const DEFAULT_TIMEOUT_MS = 15000;
// Sent by httpText when the caller passes no User-Agent of its own. Honest about what we are
// and reachable, rather than impersonating a browser.
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; PlayNexaBot/1.0; +https://app.playnexa.ai/bot)';

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers || {}).some(k => k.toLowerCase() === lower);
}

async function httpJson({ url, method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!url) return { error: 'url is required' };

  const finalHeaders = { ...headers };
  let payload;
  if (body != null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!hasHeader(finalHeaders, 'content-type')) finalHeaders['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, body: payload, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = !!(e && (e.name === 'AbortError' || controller.signal.aborted));
    return timedOut
      ? { error: `request timed out after ${timeoutMs}ms`, timedOut: true }
      : { error: 'request failed: ' + (e && e.message ? e.message : String(e)) };
  }
  clearTimeout(timer);

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { error: `HTTP ${res.status}: ${String(t).slice(0, 300)}`, status: res.status };
  }

  let data;
  try { data = await res.json(); }
  catch (e) { return { error: 'response not JSON: ' + (e && e.message ? e.message : String(e)), status: res.status }; }

  return { data, status: res.status };
}

// Like httpJson but returns the raw response BODY as text (for scraping HTML — e.g. the
// booking-signature qualifier). Same never-throws contract + timeout. Returns
// { text, status, contentType } on a 2xx, or { error, status?, timedOut? } otherwise.
async function httpText({ url, method = 'GET', headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!url) return { error: 'url is required' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const finalHeaders = { ...headers };
  // Identify ourselves. Without a User-Agent a meaningful share of small-business sites answer
  // 403 to the bare fetch agent, which lands in the prospecting pipeline as
  // unreachable_reason='403' — noise indistinguishable from a genuinely broken site. A caller
  // passing its own User-Agent always wins.
  if (!hasHeader(finalHeaders, 'user-agent')) finalHeaders['User-Agent'] = DEFAULT_USER_AGENT;
  let res;
  try {
    res = await fetch(url, { method, headers: finalHeaders, signal: controller.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = !!(e && (e.name === 'AbortError' || controller.signal.aborted));
    return timedOut
      ? { error: `request timed out after ${timeoutMs}ms`, timedOut: true }
      : { error: 'request failed: ' + (e && e.message ? e.message : String(e)) };
  }
  clearTimeout(timer);
  const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || null;
  // The URL after redirects. Needed to tell http → https apart from http-only, which no caller
  // could see before: fetch follows redirects silently, so the requested url proves nothing.
  // Falls back to the requested url when the response has none (stubs, exotic runtimes).
  const finalUrl = (typeof res.url === 'string' && res.url) ? res.url : url;
  // Body read is best-effort and guarded: a non-2xx response may legitimately carry no body,
  // and a stubbed response may have no .text() at all.
  let text = null, readError = null;
  if (typeof res.text === 'function') {
    try { text = await res.text(); }
    catch (e) { readError = e && e.message ? e.message : String(e); }
  }
  // Non-2xx keeps { error, status } EXACTLY as before — callers must keep checking `error`
  // FIRST — but now also carries the body, so an error page can be inspected (a parked-domain
  // or expired-host page is itself a site-quality signal) instead of being thrown away.
  if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status, url: finalUrl, contentType, text };
  if (readError) return { error: 'body read failed: ' + readError, status: res.status, url: finalUrl, contentType };
  return { text, status: res.status, contentType, url: finalUrl };
}

module.exports = { httpJson, httpText, DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT };
