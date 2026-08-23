// PlaybookOS — Thin MCP tool client (E2 step 3, part 3)
//
// A minimal JSON-RPC 2.0 client over http.js, MCP-compatible ON THE WIRE so
// @modelcontextprotocol/sdk can replace it later without a rewrite. It knows ONE method,
// tools/call — no initialize, no tools/list, no capability negotiation, no sessions (we
// control both ends and know the tool contract).
//
//   callMcpTool({ serverUrl, credential, toolName, args, meta, timeoutMs, deps })
//     -> { result }                                   on success
//     -> { error, transport:true, timedOut?, status? } when the server is unreachable/HTTP-failed
//     -> { error, rpcError, transport:false }         when the tool legitimately returns a JSON-RPC error
//
// The transport-vs-tool-error distinction is deliberate: an unreachable server and a tool
// that ran and returned an error are different events, and the audit must tell them apart.
//
// Auth: Bearer, from the credential the CALLER passes (accessor lookup happens in the gate,
// not here). tenant scope + on_behalf_of ride in the JSON-RPC `_meta` envelope and are
// mirrored into headers for edge logging. NEVER throws.

const { httpJson } = require('./http');

let _seq = 0;
function nextId(deps) { return (deps && deps.id != null) ? deps.id : (_seq = (_seq + 1) % Number.MAX_SAFE_INTEGER); }
function hv(x) { return x == null ? '' : String(x); } // header value: null → '' (headers must be strings)

async function callMcpTool({ serverUrl, credential, toolName, args, meta, timeoutMs, deps = {} } = {}) {
  try {
    if (!serverUrl) return { error: 'serverUrl is required', transport: true };
    if (!credential || !credential.secret) return { error: 'credential with a secret is required', transport: true };
    if (!toolName) return { error: 'toolName is required', transport: true };

    // _meta ALWAYS carries all four keys; tenant_id is present even when null (AROS enforces
    // it, other products ignore it — the field must exist from day one).
    const m = meta || {};
    const _meta = {
      product: m.product != null ? m.product : null,
      tenant_id: m.tenant_id !== undefined ? m.tenant_id : null,
      on_behalf_of: m.on_behalf_of != null ? m.on_behalf_of : null,
      actor_agent: m.actor_agent != null ? m.actor_agent : null,
    };

    const id = nextId(deps);
    const body = { jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args || {}, _meta } };
    const headers = {
      Authorization: 'Bearer ' + credential.secret,
      'X-Playbook-Product': hv(_meta.product),
      'X-Playbook-Tenant': hv(_meta.tenant_id),
      'X-Playbook-On-Behalf-Of': hv(_meta.on_behalf_of),
      'X-Playbook-Actor-Agent': hv(_meta.actor_agent),
    };

    const doHttp = deps.httpJson || httpJson;
    const resp = await doHttp({ url: serverUrl, method: 'POST', headers, body, timeoutMs });

    // Transport failure — server unreachable, HTTP non-2xx, non-JSON, or timeout.
    if (resp.error) return { error: resp.error, transport: true, timedOut: !!resp.timedOut, status: resp.status };

    const data = resp.data || {};
    // A JSON-RPC error member = the tool ran and returned an error (distinct from transport).
    if (data.error) {
      const code = data.error.code, message = data.error.message;
      return { error: `JSON-RPC error${code != null ? ' ' + code : ''}: ${message || 'unknown'}`, rpcError: data.error, transport: false };
    }
    if (!('result' in data)) return { error: 'malformed JSON-RPC response (no result or error)', transport: false };
    return { result: data.result };
  } catch (e) {
    // Defensive: never throws. (httpJson already never throws; this guards the framing code.)
    return { error: 'mcp client error: ' + (e && e.message ? e.message : String(e)), transport: true };
  }
}

module.exports = { callMcpTool };
