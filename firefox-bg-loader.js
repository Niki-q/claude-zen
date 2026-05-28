// Background entry (classic script). Loaded after firefox-page-shims.js in
// background.scripts, so chrome.tabGroups / sidePanel / offscreen are already shimmed.

// ── Firefox identity bridge ───────────────────────────────────────────────────
// Handles FF_IDENTITY_LAUNCH from sidepanel.
// Primary: browser.identity.launchWebAuthFlow.
// Fallback: manual tab + webRequest.onBeforeRedirect to intercept HTTP 302 →
//   chrome-extension:// at the channel level, before the browser tries to navigate
//   to a scheme that fires no tab/navigation events.
(function () {
  // The ONLY redirect URI registered with Anthropic for this client.
  const CHROME_URI  = 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html';
  const FF_REDIRECT = 'https://fcoeoabgfenejglbffodgkkbkcdhcgfn.chromiumapp.org/';

  function manualTabAuth(authUrl, interactive, timeoutMs) {
    return new Promise((resolve, reject) => {
      let authTabId, done = false;
      const cleanup = [];

      const finish = (result, err) => {
        if (done) return;
        done = true;
        cleanup.forEach(fn => { try { fn(); } catch {} });
        if (authTabId) chrome.tabs.remove(authTabId).catch(() => {});
        if (err) reject(err); else resolve(result);
      };

      const tryParse = (url) => {
        if (url && (url.startsWith(CHROME_URI) || url.startsWith(FF_REDIRECT))) {
          console.log('[claude-zen] OAuth redirect intercepted:', url.slice(0, 100));
          finish(url);
        }
      };

      // Secondary: tab/navigation events (won't fire for chrome-extension:// but kept
      // for chromiumapp.org or any future HTTPS redirect URI)
      const tabListener = (tabId, changeInfo) => {
        if (tabId === authTabId)
          tryParse(changeInfo.url || changeInfo.pendingUrl || '');
      };
      chrome.tabs.onUpdated.addListener(tabListener);
      cleanup.push(() => chrome.tabs.onUpdated.removeListener(tabListener));

      try {
        const navListener = (d) => { if (d.tabId === authTabId) tryParse(d.url || ''); };
        chrome.webNavigation.onBeforeNavigate.addListener(navListener);
        cleanup.push(() => chrome.webNavigation.onBeforeNavigate.removeListener(navListener));
      } catch {}

      try {
        const errListener = (d) => { if (d.tabId === authTabId) tryParse(d.url || ''); };
        chrome.webNavigation.onErrorOccurred.addListener(errListener);
        cleanup.push(() => chrome.webNavigation.onErrorOccurred.removeListener(errListener));
      } catch {}

      // Primary: intercept HTTP 302 at the channel level — fires on the HTTPS response
      // before the browser attempts to navigate to chrome-extension://.
      // Registered without tabId filter to avoid a race with tab creation;
      // authTabId check in each callback gates actual processing.
      const onRedirect = (d) => {
        if (d.tabId === authTabId) tryParse(d.redirectUrl || '');
      };
      const onHeaders = (d) => {
        if (d.tabId !== authTabId) return;
        const loc = (d.responseHeaders || []).find(h => h.name.toLowerCase() === 'location');
        if (loc?.value) tryParse(loc.value);
      };

      try {
        chrome.webRequest.onBeforeRedirect.addListener(onRedirect, { urls: ['<all_urls>'] });
        cleanup.push(() => chrome.webRequest.onBeforeRedirect.removeListener(onRedirect));
      } catch (e) {
        console.warn('[claude-zen] onBeforeRedirect unavailable:', e?.message);
      }

      try {
        chrome.webRequest.onHeadersReceived.addListener(
          onHeaders, { urls: ['<all_urls>'] }, ['responseHeaders']
        );
        cleanup.push(() => chrome.webRequest.onHeadersReceived.removeListener(onHeaders));
      } catch (e) {
        console.warn('[claude-zen] onHeadersReceived unavailable:', e?.message);
      }

      chrome.tabs.create({ url: authUrl, active: !!interactive }).then((t) => {
        authTabId = t.id;
        console.log('[claude-zen] OAuth tab created, tabId:', authTabId);
      });

      setTimeout(
        () => finish(null, new Error('manual tab auth timeout')),
        timeoutMs || 120_000
      );
    });
  }

  // Expose for the background-context identity shim in firefox-page-shims.js
  self._claudeZenManualAuth = manualTabAuth;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'FF_IDENTITY_LAUNCH') return false;

    (async () => {
      // 1. Try browser.identity
      try {
        const url = await browser.identity.launchWebAuthFlow({
          url:          msg.url,
          interactive:  msg.interactive,
          redirect_url: CHROME_URI,
        });
        return sendResponse({ url });
      } catch (e1) {
        console.warn('[claude-zen] browser.identity failed, trying manual tab:', e1.message);
      }

      // 2. Fallback: manual tab with webRequest interception
      try {
        const url = await manualTabAuth(msg.url, msg.interactive, msg.timeoutMs);
        return sendResponse({ url });
      } catch (e2) {
        return sendResponse({ error: e2?.message || String(e2) });
      }
    })();

    return true;
  });
})();

// ── OAuth probe ───────────────────────────────────────────────────────────────
// Tests the full auth flow via manualTabAuth + webRequest redirect interception.
// Run from about:debugging → Inspect background → console: ffOAuthProbe()
// Must be logged into claude.ai first, then authorize in the tab that opens.
(function () {
  const CHROME_URI = 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html';
  const b64url = (b) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  self.ffOAuthProbe = async function () {
    const verifier  = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    ));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const url = 'https://claude.ai/oauth/authorize?' + new URLSearchParams({
      client_id:             'dae2cad8-15c5-43d2-9046-fcaecc135fa4',
      response_type:         'code',
      scope:                 'user:profile user:inference user:chat',
      redirect_uri:          CHROME_URI,
      state,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
    });
    console.log('[PROBE] using manualTabAuth + webRequest interception...');
    try {
      const result = await self._claudeZenManualAuth(url, true, 120_000);
      console.log('[PROBE] SUCCESS:', result);
      return { success: true, url: result };
    } catch (err) {
      console.log('[PROBE] ERROR:', err.message);
      return { success: false, error: err.message };
    }
  };

  console.log('[claude-zen] ffOAuthProbe() ready — запусти из about:debugging → Inspect background');
})();

// ── OAuth external-message relay ──────────────────────────────────────────────
// Claude.ai's OAuth page calls chrome.runtime.sendMessage("fcoeoabgfenejglbffodgkkbkcdhcgfn", ...)
// which in Firefox fails — our extension has a different ID. firefox-oauth-bridge.js
// (MAIN world content script) intercepts the call and forwards it via postMessage →
// firefox-oauth-relay.js (isolation world) → here as {_czOAuthType: 'relay', message}.
(function () {
  const TOKEN_URL    = 'https://platform.claude.com/v1/oauth/token';
  const CLIENT_ID    = 'dae2cad8-15c5-43d2-9046-fcaecc135fa4';
  const REDIRECT_URI = 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html';
  const EXPIRES_IN   = '31536000';

  async function handleOAuthRedirect(redirectUri, tabId) {
    try {
      const u     = new URL(redirectUri);
      const code  = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const err   = u.searchParams.get('error');
      const errDesc = u.searchParams.get('error_description');

      if (err)   return { success: false, error: `Auth failed: ${err}${errDesc ? ' - ' + errDesc : ''}` };
      if (!code) return { success: false, error: 'No authorization code received' };

      const stored   = await chrome.storage.local.get(['codeVerifier']);
      const verifier = stored.codeVerifier || '';

      const resp = await fetch(TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     CLIENT_ID,
          code,
          redirect_uri:  REDIRECT_URI,
          state:         state || '',
          code_verifier: verifier,
          expires_in:    EXPIRES_IN,
        }),
      });

      if (!resp.ok) {
        const txt = await resp.text();
        return { success: false, error: `Token exchange failed: ${resp.status} ${txt}` };
      }

      const json = await resp.json();
      if (json.error) return { success: false, error: json.error_description || json.error };

      const expiresAt = json.expires_in
        ? Date.now() + 1000 * Number(json.expires_in)
        : undefined;

      // Store tokens (mirrors PermissionManager's storeTokens)
      await chrome.storage.local.remove(['lastAuthFailureReason', 'accountUuid', 'codeVerifier']);
      await chrome.storage.local.set({
        accessToken:  json.access_token,
        refreshToken: json.refresh_token,
        tokenExpiry:  expiresAt,
        oauthState:   state || '',
      });

      // Navigate the auth tab to claude.ai (success destination)
      if (tabId) chrome.tabs.update(tabId, { url: 'https://claude.ai/' }).catch(() => {});

      // Fetch and store accountUuid
      try {
        const profile = await fetch('https://api.anthropic.com/api/oauth/profile', {
          headers: {
            Authorization:   `Bearer ${json.access_token}`,
            'Content-Type':  'application/json',
          },
        });
        if (profile.ok) {
          const data = await profile.json();
          if (data?.account?.uuid) {
            await chrome.storage.local.set({ accountUuid: data.account.uuid });
          }
        }
      } catch (_) {}

      console.log('[claude-zen] OAuth token exchange successful');
      return { success: true, message: 'Authentication successful!' };
    } catch (e) {
      return { success: false, error: e?.message || String(e) };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?._czOAuthType !== 'relay') return false;

    const inner = msg.message;
    if (!inner?.type) return false;

    if (inner.type === 'ping') {
      sendResponse({ success: true, exists: true });
      return false;
    }

    if (inner.type === 'oauth_redirect') {
      handleOAuthRedirect(inner.redirect_uri, sender.tab?.id)
        .then(sendResponse)
        .catch(e => sendResponse({ success: false, error: String(e) }));
      return true;
    }

    return false;
  });
})();

// ── Toolbar-button cold-start handler ─────────────────────────────────────────
// If the user clicks the action button (or hits Ctrl+E) before the SW bundle
// finishes loading, the real onClicked / onCommand handlers aren't registered
// yet — the click would be ignored. Register synchronous fallbacks that open
// the sidebar in the active user-gesture context. Must NOT await — Firefox
// consumes the user gesture after the first synchronous chunk.
chrome.action.onClicked.addListener(() => {
  try {
    if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.open) {
      browser.sidebarAction.open();
    }
  } catch {}
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== 'toggle-side-panel') return;
  try {
    if (typeof browser !== 'undefined' && browser.sidebarAction && browser.sidebarAction.open) {
      browser.sidebarAction.open();
    }
  } catch {}
});

// ── Startup diagnostics ───────────────────────────────────────────────────────
// Surface the host-permission state. In Firefox MV3 host_permissions are
// optional and must be granted by the user (about:addons → extension →
// Permissions). Without them, webRequest/DNR/content-script injection silently
// no-op — which manifests as 401s from the API and tabs without a `url`.
(function () {
  try {
    chrome.permissions.contains({ origins: ['<all_urls>'] }, (granted) => {
      console.log(`[claude-zen] host permission <all_urls> granted: ${granted}`);
      if (!granted) {
        console.warn('[claude-zen] ⚠ <all_urls> NOT granted — open about:addons → Claude → Permissions and enable "Access your data for all websites", then reload the extension.');
      }
    });
  } catch (e) {
    console.warn('[claude-zen] permission check failed:', e?.message);
  }

  // Self-test: confirm the DNR-enum shim applied in this real Firefox build, and
  // that building the bundle's MODIFY_HEADERS rule no longer throws.
  try {
    const dnr = chrome.declarativeNetRequest;
    const enumsOk = !!(dnr && dnr.RuleActionType && dnr.RuleActionType.MODIFY_HEADERS &&
                       dnr.HeaderOperation && dnr.HeaderOperation.SET &&
                       dnr.ResourceType && dnr.ResourceType.XMLHTTPREQUEST);
    console.log(`[claude-zen] DNR enums ready: ${enumsOk}`);
    let ruleBuilds = false;
    try {
      const _r = [{ id: 1, priority: 1, action: { type: dnr.RuleActionType.MODIFY_HEADERS, requestHeaders: [{ header: 'anthropic-client-platform', operation: dnr.HeaderOperation.SET, value: 'claude_browser_extension' }] }, condition: { urlFilter: 'https://api.anthropic.com/*', resourceTypes: [dnr.ResourceType.XMLHTTPREQUEST, dnr.ResourceType.OTHER] } }];
      ruleBuilds = Array.isArray(_r);
    } catch (e) { console.warn('[claude-zen] DNR rule still throws:', e?.message); }
    console.log(`[claude-zen] DNR rule builds without throw: ${ruleBuilds}`);
  } catch (e) {
    console.warn('[claude-zen] DNR self-test error:', e?.message);
  }
})();

// ── Inject anthropic-client-* headers via webRequest ──────────────────────────
// The bundle adds these via chrome.declarativeNetRequest.updateSessionRules,
// but Firefox's DNR modifyHeaders action is unreliable — when the rule doesn't
// apply, requests to api.anthropic.com reach the server WITHOUT the
// anthropic-client-platform header the API uses to validate the OAuth client,
// causing HTTP 401 on /v1/messages. webRequestBlocking is fully supported in
// Firefox MV3, so we set the same headers here as a reliable fallback. Using
// "set" semantics (replace if present) keeps it idempotent if DNR also applies.
(function () {
  try {
    const version = chrome.runtime.getManifest().version;
    const ua = `claude-browser-extension/${version} (external) ${navigator.userAgent} `;
    const overrides = {
      'user-agent': ua,
      'anthropic-client-platform': 'claude_browser_extension',
      'anthropic-client-version': version,
    };

    // Headers the browser auto-attaches to fetches issued from extension pages
    // (sidepanel = origin moz-extension://<uuid>). When api.anthropic.com sees an
    // Origin header on an OAuth-token request, it classifies it as a browser CORS
    // request and rejects with HTTP 401 "CORS requests are not allowed for this
    // Organization". Chrome's service-worker fetches carry no Origin, so this never
    // bites there. Stripping Origin/Referer makes the request look server-side and
    // bypasses the org CORS policy. Firefox webRequestBlocking allows removing these
    // headers (Chrome does not, which is why upstream never needed this).
    const strip = new Set(['origin', 'referer']);

    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        let headers = (details.requestHeaders || []).filter(
          (h) => !strip.has(h.name.toLowerCase())
        );
        for (const [name, value] of Object.entries(overrides)) {
          const existing = headers.find((h) => h.name.toLowerCase() === name);
          if (existing) existing.value = value;
          else headers.push({ name, value });
        }
        return { requestHeaders: headers };
      },
      { urls: ['https://api.anthropic.com/*'] },
      ['blocking', 'requestHeaders']
    );
  } catch (e) {
    console.warn('[claude-zen] webRequest header injection unavailable:', e?.message);
  }
})();

// Load the minified ES-module service worker via dynamic import().
import('./assets/service-worker.ts-B5az7Lf2.js').catch((e) => {
  console.error('[claude-zen] Failed to load service worker bundle:', e);
});
