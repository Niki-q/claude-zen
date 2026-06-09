// Firefox: block user input while Claude is driving the page.
//
// Listens for the same broadcast messages the bundle sends to the
// agent-visual-indicator content script:
//   SHOW_AGENT_INDICATORS → agent started working in this tab  → start blocking
//   HIDE_AGENT_INDICATORS → agent finished                     → stop blocking
//
// Why capture-phase listeners instead of a pointer-events overlay:
// the automation locates targets with document.elementFromPoint(x,y). A real
// overlay (pointer-events:auto) would be returned by elementFromPoint and Claude
// would "click" the overlay instead of the page. So we keep zero overlay and
// instead swallow input events in the capture phase, gated on event.isTrusted:
//   - real user input        → isTrusted === true  → blocked
//   - Claude's synthetic events (dispatched by the chrome.debugger CDP shim via
//     executeScript) → isTrusted === false → allowed through
// The "Stop Claude" button (injected by agent-visual-indicator) stays clickable
// because we let events whose target is inside #claude-agent-stop-container pass.
(function () {
  // chrome.dom shim for the content-script (ISOLATED) world — the bundle's DOM
  // traversal injected here uses chrome.dom.openOrClosedShadowRoot, absent in FF.
  try {
    if (typeof chrome !== 'undefined' && !chrome.dom) {
      chrome.dom = {
        openOrClosedShadowRoot: (el) => {
          try { if (el && typeof el.openOrClosedShadowRoot === 'function') return el.openOrClosedShadowRoot(); } catch {}
          return (el && el.shadowRoot) || null;
        },
      };
    }
  } catch {}

  if (window.__claudeZenInputBlockerInstalled) return;
  window.__claudeZenInputBlockerInstalled = true;

  const BLOCKED = [
    'click', 'dblclick', 'auxclick', 'contextmenu',
    'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'keydown', 'keyup', 'keypress',
    'wheel', 'touchstart', 'touchend', 'touchmove',
    'dragstart', 'drop', 'submit',
  ];

  // Blocking has TWO independent sources, OR'd together:
  //   sessionOn — the bundle's SHOW/HIDE_*_INDICATOR messages (whole session).
  //   ttlOn     — a heartbeat from our CDP shim: every synthetic input it dispatches
  //               to this tab refreshes a short TTL. This is the RELIABLE source — it
  //               fires exactly when Claude acts on the page, even if the bundle's
  //               indicator messages never reach this content script in Firefox
  //               (which is why "запрет не работает" — the session path can be silent).
  let active = false;
  let sessionOn = false;
  let ttlOn = false;
  let ttlTimer = null;
  let curKind = 'agent';

  // Controls the user must always be able to click while blocking is on:
  //   #claude-agent-stop-container       — the bundle's stop button (pulsing/main tab)
  //   #claude-static-indicator-container — the bundle's static indicator on driven
  //                                        tabs (its "Open chat" / close buttons)
  //   #__cz_stop_btn                     — our injected stop button (see ensureStop)
  const ALLOW = '#claude-agent-stop-container,#claude-static-indicator-container,#__cz_stop_btn';

  const handler = (ev) => {
    if (!active) return;
    if (!ev.isTrusted) return; // Claude's synthetic events — let them through
    const t = ev.target;
    if (t && t.closest && t.closest(ALLOW)) return; // keep stop / indicator controls usable
    ev.stopImmediatePropagation();
    ev.preventDefault();
  };

  // The bundle only injects its real stop button (#claude-agent-stop-container) on the
  // session's MAIN tab (the "pulsing" indicator). The tabs the agent actually DRIVES get
  // the "static" indicator, which has NO stop button — so the user has no way to stop the
  // agent from the page they're watching. Inject our own stop affordance there; it sends
  // the same STOP_AGENT message the bundle's button does (SW resolves the main tab and
  // routes it to the sidepanel, which aborts).
  let stopBtn = null;
  const ensureStop = () => {
    if (window.top !== window) return; // top frame only — never inject inside iframes
    if (stopBtn || !document.body) return;
    if (document.getElementById('claude-agent-stop-container')) return; // bundle's own stop present
    stopBtn = document.createElement('button');
    stopBtn.id = '__cz_stop_btn';
    stopBtn.type = 'button';
    stopBtn.textContent = '■ Stop Claude';
    stopBtn.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#d33;color:#fff;border:none;border-radius:999px;padding:8px 16px;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.35)';
    stopBtn.onclick = () => { try { chrome.runtime.sendMessage({ type: 'STOP_AGENT', fromTabId: 'CURRENT_TAB' }); } catch (e) {} };
    document.body.appendChild(stopBtn);
  };
  const removeStop = () => { if (stopBtn) { try { stopBtn.remove(); } catch (e) {} stopBtn = null; } };

  // Recompute the effective blocking state from both sources and (un)install listeners.
  const apply = (kind) => {
    if (kind) curKind = kind;
    const on = sessionOn || ttlOn;
    if (on !== active) {
      active = on;
      for (const type of BLOCKED) {
        if (on) window.addEventListener(type, handler, { capture: true, passive: false });
        else window.removeEventListener(type, handler, { capture: true });
      }
    }
    if (!on) { removeStop(); return; }
    // Only driven ("static") tabs lack a native stop button — inject ours there. On the
    // main ("pulsing") tab the bundle injects #claude-agent-stop-container itself; let it
    // (ensureStop also bails if that container is present, guarding the race either way).
    if (curKind === 'static') setTimeout(ensureStop, 150);
  };

  // CDP heartbeat: Claude just dispatched input to THIS tab → block for a window,
  // refreshed by each subsequent action. Generous TTL so brief "thinking" gaps between
  // actions stay blocked; when the session truly ends the input stops and it lapses.
  const TTL_MS = 8000;
  const heartbeat = () => {
    ttlOn = true;
    if (ttlTimer) clearTimeout(ttlTimer);
    ttlTimer = setTimeout(() => { ttlTimer = null; ttlOn = false; apply(); }, TTL_MS);
    apply('static');
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    // "pulsing" (main tab) → SHOW_AGENT_INDICATORS; "static" (driven tabs) →
    // SHOW_STATIC_INDICATOR. BOTH mean the agent session is active on this tab, so
    // block real user input in either state. "none" → HIDE_AGENT_INDICATORS.
    if (msg.type === 'SHOW_AGENT_INDICATORS') { sessionOn = true; apply('agent'); }
    else if (msg.type === 'SHOW_STATIC_INDICATOR') { sessionOn = true; apply('static'); }
    else if (msg.type === 'HIDE_AGENT_INDICATORS' || msg.type === 'HIDE_STATIC_INDICATOR') { sessionOn = false; apply(); }
    else if (msg.type === '__FF_AGENT_ACTIVE') heartbeat(); // from firefox-page-shims CDP shim
    // do not return true / sendResponse — the indicator script owns the reply
  });

  window.addEventListener('pagehide', () => { sessionOn = false; ttlOn = false; if (ttlTimer) clearTimeout(ttlTimer); apply(); });
})();
