# Claude Desktop login from a pooled CLI token

Investigation date: 2026-10-21 (America/Los_Angeles).

## Question and bounded conclusion

Can an existing pooled Claude Code OAuth credential log standard Claude Desktop into the same
claude.ai account, with no new Google/email authentication and no existing session for that account?

**The current inputs cannot complete that standard account-login flow.** A live, valid OAuth token
was refused by the Desktop authorization endpoint specifically because it is an OAuth access token.
Desktop's native first-party flow requires an independent web session before requesting an OAuth
grant. Installing a cached grant does not supply that session.

This is a conclusion about the installed version, the inspected native flow, and the credentials
available on this machine. It is not a mathematical proof that no undisclosed endpoint or future
version could offer an exchange. A valid Desktop/web session or a completed identity-provider login
would change the inputs and therefore this conclusion.

## Inspected version

- Claude Desktop: `3.1623.1`.
- `app.asar` SHA-256: `477e6e635cec045e579a293509c107d8a65072a78e61938294e2fd3e4b391a67`.
- Main chunk: `.vite/build/index.chunk-CG9jv6zY.js`.
- Main chunk SHA-256: `429f11be76446920f3d2b339b6fbc1223c45632b511036b267e35a2d9f3f7fc3`.
- No app-binary patch, invented session cookie, or identity-label replacement was used.

## Live observations

| Check | Result | What it establishes |
| --- | --- | --- |
| CLI authentication status | Logged in to the requested Max account | The CLI credential exists; not proof of Desktop login |
| `GET https://api.anthropic.com/api/oauth/profile` with its bearer | HTTP 200; returned account matched the target; no Set-Cookie | Token and target identity are valid |
| `GET https://api.anthropic.com/api/oauth/account` with its bearer | HTTP 200; no Set-Cookie | Account metadata can be read without creating a web session |
| V2 encrypted cache seed and `lastKnownAccountUuid` | Installer read-back succeeded; idle App restart still reached Get started and the sign-in form | Cache installation is insufficient for standard Desktop login |
| Native Desktop authorization request with the same bearer | HTTP 403, `permission_error` | This endpoint refuses the credential type; exact response below |
| `GET https://api.anthropic.com/v1/models?limit=1000` with the bearer | HTTP 200; 14 model records; no Set-Cookie | Native API-mode admission can succeed; this does not establish account login or prove a billable inference call |
| Existing browser and Google sessions | Browser account was a different account; Google chooser had no target-account session | No target web/Google session was available to reuse automatically |
| `GET https://claude.ai/api/auth/accounts` with bearer | HTTP 404 | Inconclusive; not used as evidence of impossibility |

## Reproduced server boundary

Request followed the installed native flow's endpoint, Desktop client, redirect URI, and PKCE shape:

```http
POST https://api.anthropic.com/v1/oauth/<target-organization-uuid>/authorize
Authorization: Bearer <existing-valid-cli-access-token>
anthropic-version: 2023-06-01
anthropic-client-platform: desktop_app
anthropic-client-version: 3.1623.1
Content-Type: application/json
```

```json
{
  "response_type": "code",
  "client_id": "89355bc3-cbfd-4382-905b-976645cad410",
  "organization_uuid": "<target-organization-uuid>",
  "redirect_uri": "https://claude.ai/desktop/callback",
  "scope": "user:inference",
  "state": "<fresh-random-state>",
  "code_challenge": "<fresh-S256-PKCE-challenge>",
  "code_challenge_method": "S256"
}
```

Response classification and message:

```json
{
  "status": 403,
  "error_type": "permission_error",
  "error_message": "This endpoint does not accept OAuth access tokens."
}
```

No authorization code was redeemed and no refresh token was presented or rotated in this probe.
The response distinguishes a valid-but-ineligible credential type from an expired token or a local
file-install failure. The scopes on the existing grant included `user:inference`, `user:file_upload`,
`user:profile`, and `user:sessions:claude_code`; missing inference scope is not the explanation.

## Native flow source anchors

In the inspected main chunk:

- `lwn` checks the session-cookie names `sessionKey`, `sessionKeyV2`, and `sessionKeyV3` at startup.
- `rwn` reads `sessionKey`; the hardened read filters for HttpOnly and Secure cookies.
- `cEn` refuses absent, mismatched, or insufficiently protected session cookies before requesting
  authorization. It sends that session credential to `/v1/oauth/<organization>/authorize`, then
  uses PKCE to obtain an OAuth grant. The direction is web session to OAuth.
- `lastKnownAccountUuid` and `oauth:tokenCacheV2` are persisted account/cache state, not a replacement
  for the server-issued web session. The live cache-seeding check confirms this distinction.

## Why native API mode is not the requested account login

The separate 3P deployment is real and can transport an OAuth bearer via static/helper credentials.
The models probe above succeeded, so claiming that Desktop cannot send the existing token would
be wrong. No inference request was made to establish its billing or subscription behavior.

However, that deployment loads a local web application and uses local-device identity. The inspected
`ECn` deployment reports no claude.ai account and disables account-dependent product features and
remote Cowork-memory sync. Relabeling that local identity as the requested person would not log in
to their account. This investigation therefore did not switch the user's App into that mode.

The native interactive Console flow is also separate: `TUa` starts `AnthropicConsoleSource` / `Mcn`,
which calls `doAnthropicConsoleGrant` in `.vite/build/index.chunk-CVbbWKB4.js`. It requests a fresh
Console grant with client `c2828930-6f78-4856-b5f2-7aa7e5f40afe` and scope `user:inference`; it is not
an import of a CLI grant or a conversion to a claude.ai web session.

Primary documentation:

- [Desktop 3P architecture](https://claude.com/docs/third-party/claude-desktop/overview): contrasts
  Anthropic-account identity and backend storage with local-device identity and local storage.
- [Native Claude API deployment](https://claude.com/docs/third-party/claude-desktop/claude-api):
  browser sign-in selects a Console API organization; that organization is billed for usage.
- [Account login](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account):
  standard web/Desktop login uses Google or an emailed login link/code.

## What would make standard automatic switching possible

The missing input is a valid, authorized web/Desktop session for the target account, or a provider-
supported method that issues one from the available grant. Once such a session is available,
restoration/switching could be investigated separately, subject to its expiry and device binding.
The current `claude_credentials_v1` producer in `build_claude_auth_blob` uploads OAuth credentials and
allowlisted CLI state; it does not acquire the missing web session. Repeating a cache write,
restarting the App, or changing the cached account label cannot create it.

Tokens, cookies, authorization codes, PKCE verifiers, account UUIDs, email-session identifiers, and
unrelated account details are intentionally absent from this report.
