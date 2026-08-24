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
  let res;
  try {
    res = await fetch(url, { method, headers, signal: controller.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    const timedOut = !!(e && (e.name === 'AbortError' || controller.signal.aborted));
    return timedOut
      ? { error: `request timed out after ${timeoutMs}ms`, timedOut: true }
      : { error: 'request failed: ' + (e && e.message ? e.message : String(e)) };
  }
  clearTimeout(timer);
  if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
  let text;
  try { text = await res.text(); }
  catch (e) { return { error: 'body read failed: ' + (e && e.message ? e.message : String(e)), status: res.status }; }
  const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || null;
  return { text, status: res.status, contentType };
}

module.exports = { httpJson, httpText, DEFAULT_TIMEOUT_MS };
