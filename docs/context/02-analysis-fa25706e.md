# Session Analysis — fa25706e (OAuth Login Port for claude-zen on Firefox)

Source transcript: Claude Code session `fa25706e-f7a9-4822-b5ff-1ff420f50bfd`.
Project: `D:\_dev\claude-zen` — a Firefox MV3 port of Anthropic's official bundled
Claude **Chrome** extension. The minified Chrome production assets are shipped
verbatim; Firefox compatibility is bolted on via hand-written shim/loader files.

This document focuses on what is **new / distinct** in this session: the deep
reverse-engineering of the OAuth login flow and the multiple Firefox-specific
porting obstacles encountered while trying to make sign-in actually work. The
extension's UI, sidebar, CSP, and API-domain plumbing were already working coming
into this session — only login was broken.

---

## 1. Goal and Operating Constraints

The session ran under a `/goal` Stop-hook directive (Russian):

> "make the extension maximally close to working on Firefox, apply any tricks,
> commands may only be run from this directory."

The Stop hook repeatedly refused to let the session end, insisting on **actual
end-to-end verification** of the auth flow in Firefox rather than theoretical
code correctness. This drove most of the empirical testing described below
(running the extension via `web-ext run`, probing the OAuth server with `curl`,
running startup tests inside Firefox). The goal was eventually cleared mid-session
but remained the operative objective.

A secondary running theme: keeping the browser-extension console clean (Datadog,
Segment, CSP noise) so real errors stand out.

---

## 2. Key Files Touched / Created

Hand-written Firefox adaptation layer (the parts under the author's control):

- `manifest.json` — MV3 manifest; `background.scripts`, `sidebar_action`,
  `web_accessible_resources`, `content_scripts`, CSP, `browser_specific_settings.gecko`.
- `firefox-page-shims.js` — classic script loaded **first** in every context
  (background + every extension HTML page). Must run before the minified bundles.
  Hosts `chrome.tabGroups`, `chrome.debugger`, `chrome.sidePanel`, `chrome.offscreen`,
  theme detection, the `chrome.identity` shim, console-noise suppression, and a
  CDN-script-injection blocker.
- `firefox-bg-loader.js` — background entry (classic script), loaded after the
  shims. Dynamically `import()`s the real minified service worker
  (`assets/service-worker.ts-B5az7Lf2.js`), and hosts the Firefox identity bridge,
  the manual-tab auth fallback, the OAuth feasibility probe, and the OAuth
  external-message relay handler.
- `oauth_callback.html` + `oauth_callback.js` — the OAuth redirect target page
  (created this session). Linked into `web_accessible_resources`. The inline script
  was later externalised into `oauth_callback.js` to satisfy CSP / `web-ext lint`.
- `firefox-oauth-bridge.js` (created) — MAIN-world content script for `claude.ai`.
- `firefox-oauth-relay.js` (created) — isolation-world relay content script.

Minified Chrome production bundles (read-only, reverse-engineered, **not** edited):

- `assets/PermissionManager-uCwrpbh7.js` — contains the entire OAuth client logic
  (`launchWebAuthFlow`, `initiateOAuthFlow`, `exchangeCodeForToken`,
  `handleOAuthRedirect`, `storeTokens`, PKCE helpers, storage-key enum).
- `assets/service-worker.ts-B5az7Lf2.js` — small (~17 KB) SW entry; message router
  (`check_and_refresh_oauth`, `open_side_panel`, keepalive) and
  `chrome.runtime.onMessageExternal` handler for `oauth_redirect`.
- `assets/mcpPermissions-CUBzZeeG.js` — also references `client_id`.
- `assets/useStorageState-QZr08jZQ.js` — bundles the Segment/Amplitude analytics
  SDK that dynamically injects a CDN `<script>`.

---

## 3. Early Console Cleanup Work

Before the OAuth deep-dive, several console-noise problems were addressed:

### 3.1 OAuth feasibility probe leftover
`firefox-bg-loader.js` had a TEMP debug block exposing `ffOAuthProbe()` with a
"Remove this block once the auth approach is decided" comment. It was removed,
then immediately **restored** when the user decided to do a "light check" of
whether the OAuth server accepts a Firefox-originated request. The probe became a
central tool for the rest of the session.

### 3.2 Datadog "SDK loaded more than once" / "No storage"
The bundler split the Datadog Browser SDK across two chunks
(`sidepanel-*.js` and `useStorageState-*.js`), so it initialises twice. Without
rebuilding the bundle the root cause can't be fixed; instead a `console.warn`
filter was added to `firefox-page-shims.js` (runs before bundles load) to suppress
the known warnings. Noted as cosmetic — the proper fix is bundler dedup
(`manualChunks` in vite/rollup).

### 3.3 Segment CDN script blocked by CSP
The Segment SDK inside `useStorageState-*.js` dynamically creates a `<script>`
pointing at `cdn.segment.com/next-integrations/...amplitude-plugins/...js`. This
violates the extension CSP.

- First attempt: add `https://cdn.segment.com` to `script-src` in `manifest.json`.
  **Rejected by Firefox** — MV3 forbids `https://` protocol sources in the
  `extension_pages` CSP `script-src` ("Директива «script-src» содержит запрещённый
  источник протокола https:"). Reverted.
- Working fix: in `firefox-page-shims.js`, patch `Element.prototype.appendChild`
  / `insertBefore` to silently drop any `<script>` whose `src` matches a
  `cdn.segment.com` regex, guarded by `typeof document !== 'undefined'` so it
  doesn't run in the SW context. Analytics stays dead (acceptable) but the
  CSP error and failed-load noise disappear.

**Decision recorded:** Extension-page CSP in Firefox MV3 is effectively locked to
`script-src 'self'`; any external script must be neutralised at the DOM level, not
whitelisted.

---

## 4. Reverse-Engineering the OAuth Flow

The core of the session. Findings extracted from the minified bundles (mostly
`PermissionManager-uCwrpbh7.js`) via PowerShell/Node substring extraction and
`Explore` subagents (direct `Grep` failed because the minified lines are too long).

### 4.1 OAuth constants
- Production `client_id`: `dae2cad8-15c5-43d2-9046-fcaecc135fa4`.
- Production `REDIRECT_URI`: `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html`
  (built from the Chrome extension ID `fcoeoabgfenejglbffodgkkbkcdhcgfn`).
- Development config uses a different client_id and the dev extension ID
  `dihbgbndebgnbjfmelmegjepbnkhlgni`.
- `AUTHORIZE_URL`: `https://claude.ai/oauth/authorize`.
- `TOKEN_URL`: `https://platform.claude.com/v1/oauth/token`.
- `SCOPES_STR`: `user:profile user:inference user:chat`.
- `expires_in` constant `ye = 31536e3` (one year in seconds) is sent in the
  token-exchange body.

### 4.2 Storage keys (enum `W` in PermissionManager)
`accessToken`, `refreshToken`, `tokenExpiry`, `oauthState`, `codeVerifier`
(`CODE_VERIFIER`), plus `LAST_AUTH_FAILURE_REASON` and an `accountUuid`/user id.
Tokens are written via `storeTokens` (`Te`) using `chrome.storage.local`.

### 4.3 Two distinct auth paths in the bundle
A crucial discovery: the bundle has **two** flows.

1. **Silent / non-interactive** (`launchWebAuthFlow` with `interactive:!1`,
   `abortOnLoadForNonInteractive:!1`, `timeoutMsForNonInteractive:5e3`,
   `prompt:"none"`, `login_hint`): builds `redirect_uri` from
   `chrome.identity.getRedirectURL()` (the `chromiumapp.org` form) and races
   against a 15 s timeout.
2. **User-initiated login** (`initiateOAuthFlow`, internal name `Ne` →
   `chrome.tabs.create`): uses the hardcoded `oauth.REDIRECT_URI`
   (`chrome-extension://...oauth_callback.html`). This is the path a user actually
   triggers, and it is the one that produced "Authorization failed".

The exported auth module `De` (frozen object) maps internal names:
`exchangeCodeForToken:Se`, `handleOAuthRedirect:Le`, `initiateOAuthFlow:Ne`,
`refreshToken:Oe`, `storeTokens:Te`, `getAuthToken:ke`, `checkAndRefreshOAuthTokenIfNeeded:Pe`,
`generateCodeChallenge:Ee`, `getUserId:Re`.

### 4.4 Token exchange request shape (`exchangeCodeForToken` / `Se`)
`POST` to `TOKEN_URL`, `Content-Type: application/x-www-form-urlencoded`, body
fields: `grant_type=authorization_code`, `client_id`, `code`, `redirect_uri`
(= `REDIRECT_URI`), `state`, `code_verifier`, and `expires_in`.

**Key empirical finding (verified against the live server with dummy codes):**
The endpoint **requires** the non-standard `state` and `expires_in` fields. Omit
them and the server returns `{"type":"invalid_request_error","message":"Invalid
request format"}` (request_id form `req_011...`). Include them and the server
returns `invalid_grant` ("Invalid 'code' in request.") — i.e. correct format,
wrong code. This explained the original "Invalid request format" failures: earlier
manual probes were sending a standards-compliant body missing `state`/`expires_in`.
The `Origin` header (chrome-extension:// vs moz-extension://) was tested and shown
to **not** matter.

### 4.5 The `onMessageExternal` extension-detection handshake
The service worker registers `chrome.runtime.onMessageExternal` and only accepts
messages whose `sender.origin` is `https://claude.ai`. It handles
`{type:"oauth_redirect", redirect_uri: <callbackUrlWithCode>}`. On load, the
claude.ai OAuth page calls
`chrome.runtime.sendMessage("fcoeoabgfenejglbffodgkkbkcdhcgfn", {type:"ping"})`
to detect whether the Chrome extension is installed and connectable.

---

## 5. The Chain of Firefox-Specific Failures (and how each was diagnosed)

This was an iterative debugging chain — each fix revealed the next obstacle.

### 5.1 "Invalid request format" with `chromiumapp.org` redirect
First probe used `https://...chromiumapp.org/` as `redirect_uri` and tried to catch
the redirect with `webRequest.onBeforeRequest`. Server returned an error page /
"Invalid request format" on the page's internal `POST /v1/oauth/{id}/authorize`.
The `{id}` (`bc313f34-...`) is the server-side application id, confirming the
server *found* the client and proceeded. Tried `prompt=none` — no help.

### 5.2 webRequest cannot see `chrome-extension://`
Switched the probe `redirect_uri` to the real registered
`chrome-extension://.../oauth_callback.html` and switched interception to
`tabs.onUpdated` + `webNavigation.onBeforeNavigate`. Rationale: Firefox `webRequest`
only fires for `http/https/ftp/ws` schemes, never `chrome-extension://`.

### 5.3 `browser.identity` cannot intercept `chrome-extension://` either
Investigated Firefox's actual `browser.identity.launchWebAuthFlow` implementation
by fetching `toolkit/components/extensions/parent/ext-identity.js` from gecko-dev
(searchfox failed; raw.githubusercontent.com worked). It opens an OAuth window and
watches HTTP activity via `nsIHttpActivityDistributor` + `resolveIfRedirectURI`,
which checks `channel.URI.spec.startsWith(redirectURI)`. Because that distributor
only sees **HTTP/HTTPS channels**, it can never observe a redirect to a
`chrome-extension://` URL. So `browser.identity` is structurally unable to catch
the production redirect.

### 5.4 Attempt: change gecko ID to the Chrome hash ID
Idea: set `browser_specific_settings.gecko.id` to `fcoeoabgfenejglbffodgkkbkcdhcgfn`
so `chrome-extension://...` would resolve to *our* extension. `web-ext lint`
rejected it with `JSON_INVALID` on `/browser_specific_settings/gecko/id` — the
bare Chrome-hash form is not a valid gecko id. Reverted to `claude-zen@firefox`.

### 5.5 Empirical confirmation: no tab/navigation events for `chrome-extension://`
A temporary startup test was injected into `firefox-bg-loader.js`: register
`webNavigation.onBeforeNavigate` + `tabs.onUpdated`, navigate to a
`chrome-extension://...?code=...` URL, write the result to a file in Downloads.
Result: `{"result":"TIMEOUT_no_events_fired"}`. This **empirically proved** that
neither `webNavigation` nor `tabs.onUpdated` fires for `chrome-extension://`
navigations in Firefox — killing the manual-tab fallback as designed.

### 5.6 Pivot to `webRequest.onBeforeRedirect`
Since the server issues a `302 Location: chrome-extension://...` at the HTTP layer,
`webRequest.onBeforeRedirect` (and `onHeadersReceived`) fires on the **HTTP
channel** before the browser attempts the non-interceptable scheme; the full
destination (including `?code=`) is in the `redirectUrl` property. `manualTabAuth`
was rewritten to register these listeners (no tabId filter at registration; an
`authTabId` guard inside the callbacks), exposed globally as
`self._claudeZenManualAuth`, and wired as the fallback inside the shim's
`_doLaunch`. The probe was switched to use this same path.

### 5.7 The real blocker: "Authorization failed" before any redirect
After the webRequest rewrite the user clicked "Authorize" and saw "Authorization
failed — This isn't working right now." This happens **before** any redirect,
meaning the consent page itself bailed. Root cause traced to the
`onMessageExternal` handshake (section 4.5): the claude.ai OAuth page calls
`chrome.runtime.sendMessage("fcoeoabgfenejglbffodgkkbkcdhcgfn", ...)`. On a Firefox
web page `chrome.runtime` does not exist, the call throws, and the React app shows
"Authorization failed".

---

## 6. The Final Approach — MAIN-world bridge + relay

To satisfy the page's extension-detection handshake, two content scripts were added
for `https://claude.ai/*` injected at `document_start`:

- `firefox-oauth-bridge.js` — runs in the **MAIN** world (page JS context) before
  page scripts. Creates `window.chrome.runtime.sendMessage` so the page's
  `sendMessage(extId, {type:"ping"})` / `oauth_redirect` calls resolve. It
  `postMessage`s requests (tagged `_czOAuth:'req'`, with a `msgId`) to the
  isolation world.
- `firefox-oauth-relay.js` — runs in the isolation (extension) content-script world.
  Listens for the bridge's `postMessage`s, forwards them to the background via
  `chrome.runtime.sendMessage` (tagged `_czOAuthType:'relay'`), and returns the
  response back to the page via `postMessage`.

Background side (`firefox-bg-loader.js`) gained an `FF_OAUTH_RELAY` handler that:
- responds to `ping` (so the page believes the extension is installed),
- on `oauth_redirect`, runs `handleOAuthRedirect`: extracts `code`/`state` from the
  callback URL, performs the full token exchange `POST` to
  `platform.claude.com/v1/oauth/token` (with the required `state`+`expires_in`),
  stores `accessToken`/`refreshToken`/`tokenExpiry`/`oauthState` in
  `chrome.storage.local`, then navigates the auth tab to `https://claude.ai/`.

`manifest.json` was updated to add both content scripts before the existing
`content-script.ts-loader` entry, matching `https://claude.ai/*` and
`https://*.claude.ai/*` at `document_start`.

The session ended after wiring these four files together. The author's final
message describes the expected flow and asks the user to reload and report the
console output — **the bridge/relay path was not yet confirmed working end-to-end**
in this transcript.

---

## 7. `chrome.identity` Shim Details

Implemented in `firefox-page-shims.js`:

- `getRedirectURL(path)` → returns `FF_REDIRECT + (path||'')` where `FF_REDIRECT`
  is the `chromiumapp.org` form. (This is what the silent-auth path reads.)
- `launchWebAuthFlow(details, callback)` → background context calls
  `browser.identity.launchWebAuthFlow` directly with `redirect_url: CHROME_URI`
  (the registered `chrome-extension://` form); page context (sidepanel) routes the
  request to the background via an `FF_IDENTITY_LAUNCH` message. Interactive default
  timeout 120 s; non-interactive shorter.
- `getAuthToken`, `removeCachedAuthToken`, `clearAllCachedAuthTokens` → stubs
  (the extension does not use Google auth).
- A short-lived `fetch` patch that rewrote the token-exchange `redirect_uri`
  (`chrome-extension://` ↔ `chromiumapp.org`) was added and then **removed** once it
  was understood that authorize and token-exchange must use the *same*
  `redirect_uri`; rewriting one side guarantees a mismatch.

Background `_doLaunch` was later updated so that when `browser.identity` fails it
falls back to `_claudeZenManualAuth` (the `webRequest`-based manual tab auth).

---

## 8. Verification / Tooling Notes

- Syntax checks: `node --check` on the two classic scripts (HTML/`oauth_callback`
  obviously can't be `--check`'d).
- `web-ext lint` (v10.2.0 via npx) — remaining errors are only the pre-existing
  `ICON_NOT_SQUARE` on `icon-128.png` (not addressed; cosmetic/packaging) plus
  `MISSING_DATA_COLLECTION_PERMISSIONS` warning. A `data_collection_permissions`
  block with empty arrays was tried and caused a `JSON_INVALID` error, so it was
  removed. `INLINE_SCRIPT` in the original `oauth_callback.html` was fixed by
  externalising to `oauth_callback.js`.
- `web-ext run` with `--firefox-binary "C:\Program Files\Mozilla Firefox\firefox.exe"`
  successfully installs the extension as a temporary add-on (confirmed in both a
  fresh temp profile and the user's real `default-release` profile via
  `--firefox-profile ... --keep-profile-changes`). No runtime load errors observed.
- Remote-debugging hookup attempts (`--remote-debugging-port`, marionette,
  RDP/CDP ports) did **not** succeed from the bash environment — ports weren't
  reachable, so the probe could not be driven programmatically. Verification of the
  actual auth result therefore depended on manual user action.
- Direct `curl`/`Invoke-WebRequest` probing of the OAuth server: PowerShell
  `Invoke-WebRequest` got `403` (Cloudflare blocks non-browser UAs); `curl` with a
  Firefox UA got `200` (the React SPA) for both `chrome-extension://` and
  `chromiumapp.org` redirect_uri values, confirming server-side validation happens
  on the page's internal POST, not on the initial GET.

---

## 9. Decisions and Rationale Summary

- **Do not edit minified bundles.** All Firefox adaptation lives in the
  hand-written shim/loader/content-script layer; bundles are treated as read-only
  ground truth.
- **CSP external scripts are unfixable via whitelist** in Firefox MV3 — block at
  the DOM level instead.
- **`browser.identity` is insufficient** for this OAuth flow because the registered
  redirect is a `chrome-extension://` URL that no Firefox interception API
  (identity, webNavigation, tabs) can observe except `webRequest` at the HTTP-302
  layer.
- **The decisive obstacle is the page-side extension handshake**, not the redirect
  capture — hence the MAIN-world bridge solution, which mirrors what the Chrome
  extension's external messaging provides natively.
- Token exchange must replicate the bundle's exact body, including the non-standard
  `state` and `expires_in` fields, or the server rejects with "Invalid request
  format".

---

## 10. Open Questions / Unfinished Work

- **End-to-end auth was never confirmed working** in this transcript. The
  bridge+relay+token-exchange path was implemented but the final "reload and report
  console output" step was left to the user.
- Will the server actually issue the `302 → chrome-extension://...?code=` redirect
  when the request originates from Firefox via the bridge, or will it still bail at
  the consent step for some other reason (CSRF/header check observed earlier as
  `headers: {}` in an error payload)? Unverified.
- Does the `webRequest.onBeforeRedirect` interception path coexist cleanly with the
  bridge path, or is one now redundant? The two mechanisms target the same redirect
  but via different layers; reconciliation not finalised.
- `ICON_NOT_SQUARE` lint errors remain (packaging hygiene, ignored as pre-existing).
- The silent-auth path's reliance on `chrome.identity.getRedirectURL()` →
  `chromiumapp.org` may still be a dead path on Firefox; only the user-initiated
  bridge path was carried through.
- Datadog double-load and dead analytics are only suppressed, not fixed; a proper
  fix needs a bundle rebuild.

---

## 11. Identifier Quick Reference

- Production extension id (Chrome): `fcoeoabgfenejglbffodgkkbkcdhcgfn`
- Dev extension id: `dihbgbndebgnbjfmelmegjepbnkhlgni`
- Production OAuth `client_id`: `dae2cad8-15c5-43d2-9046-fcaecc135fa4`
- Authorize: `https://claude.ai/oauth/authorize`
- Token: `https://platform.claude.com/v1/oauth/token`
- Scopes: `user:profile user:inference user:chat`
- Registered redirect: `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html`
- Storage keys: `accessToken`, `refreshToken`, `tokenExpiry`, `oauthState`, `codeVerifier`
- Internal bundle symbols: `Se`=exchangeCodeForToken, `Le`=handleOAuthRedirect,
  `Ne`=initiateOAuthFlow, `Te`=storeTokens, `Oe`=refreshToken, `Ee`=generateCodeChallenge
- Custom message types: `FF_IDENTITY_LAUNCH`, `FF_OAUTH_CALLBACK`, `FF_OAUTH_RELAY`,
  page-bridge tags `_czOAuth:'req'`, `_czOAuthType:'relay'`
- Probe entry point: `ffOAuthProbe()` (run from about:debugging → Inspect background)

_Note: no live credential, OAuth token, session key, or cookie value appeared in
this session; the identifiers above are public client identifiers and endpoint URLs,
not secrets._
