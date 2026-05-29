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

  let active = false;

  const handler = (ev) => {
    if (!active) return;
    if (!ev.isTrusted) return; // Claude's synthetic events — let them through
    const t = ev.target;
    // Keep the Stop-Claude control usable.
    if (t && t.closest && t.closest('#claude-agent-stop-container')) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
  };

  const setActive = (on) => {
    if (on === active) return;
    active = on;
    for (const type of BLOCKED) {
      if (on) window.addEventListener(type, handler, { capture: true, passive: false });
      else window.removeEventListener(type, handler, { capture: true });
    }
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'SHOW_AGENT_INDICATORS') setActive(true);
    else if (msg.type === 'HIDE_AGENT_INDICATORS') setActive(false);
    // do not return true / sendResponse — the indicator script owns the reply
  });

  window.addEventListener('pagehide', () => setActive(false));
})();
