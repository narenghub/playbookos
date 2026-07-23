// Centralised Google auth. Primary path: a Google Workspace **service account**
// with Domain-Wide Delegation (DWD), impersonating a specific user per call.
// Fallback: the legacy OAuth **refresh token** (fixed Search-Console scope), kept
// so the currently-working GSC job doesn't break during the window before DWD is
// enabled in the Workspace Admin Console. Once DWD is live, the service account
// wins for every scope (Gmail/Calendar/Drive/GSC) and the fallback is unused.
const { google } = require('googleapis');

// Well-known scopes used across the agents.
const SCOPES = {
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  gmailModify: 'https://www.googleapis.com/auth/gmail.modify',
  calendarReadonly: 'https://www.googleapis.com/auth/calendar.readonly',
  driveReadonly: 'https://www.googleapis.com/auth/drive.readonly',
  webmastersReadonly: 'https://www.googleapis.com/auth/webmasters.readonly',
  // Admin SDK — org-wide user directory + activity reports. These require the
  // impersonated subject (WORKSPACE_SUPER_ADMIN) to be a Workspace super admin,
  // and must be added to the DWD client's scope list in admin.google.com before
  // they work (until then the calls 403 and the agent degrades gracefully).
  adminDirectoryUserReadonly: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
  adminReportsAuditReadonly: 'https://www.googleapis.com/auth/admin.reports.audit.readonly',
};

let _creds; // parsed service-account JSON, cached (undefined = not yet parsed)
function serviceAccountCreds() {
  if (_creds !== undefined) return _creds;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) { _creds = null; return null; }
  try {
    const c = JSON.parse(raw);
    _creds = (c && c.client_email && c.private_key) ? c : null;
  } catch { _creds = null; }
  return _creds;
}
function serviceAccountConfigured() { return !!serviceAccountCreds(); }

// Build an impersonating JWT auth client (pass to google.gmail/calendar/etc as `auth`).
// `subject` is the Workspace user to impersonate; `scopes` an array of scope URLs.
function serviceAccountClient({ subject, scopes }) {
  const creds = serviceAccountCreds();
  if (!creds) return { error: 'GOOGLE_SERVICE_ACCOUNT_JSON missing or invalid' };
  try {
    const client = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes, subject });
    return { client };
  } catch (e) { return { error: 'JWT init failed: ' + e.message }; }
}

// Mint a bearer access token. Tries the service account (DWD, impersonating
// `subject`) first, then falls back to the shared OAuth refresh token.
// Returns { access_token, via } or { error }.
async function getGoogleAccessToken({ subject, scopes } = {}) {
  let saErr = null;
  const sa = serviceAccountClient({ subject, scopes });
  if (!sa.error) {
    try {
      const t = await sa.client.getAccessToken();
      const token = t && (t.token || t.access_token);
      if (token) return { access_token: token, via: 'service_account' };
      saErr = 'service account returned no token';
    } catch (e) {
      // Most common before DWD is enabled: "unauthorized_client".
      saErr = e.message;
    }
  } else {
    saErr = sa.error;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET, refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (clientId && clientSecret && refreshToken) {
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.access_token) return { access_token: data.access_token, via: 'refresh_token' };
      return { error: `service account: ${saErr}; refresh fallback ${res.status}: ${JSON.stringify(data).slice(0, 140)}` };
    } catch (e) { return { error: `service account: ${saErr}; refresh fallback error: ${e.message}` }; }
  }
  return { error: saErr || 'no Google credentials configured' };
}

module.exports = { SCOPES, getGoogleAccessToken, serviceAccountClient, serviceAccountCreds, serviceAccountConfigured };
