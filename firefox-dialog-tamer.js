// Firefox: tame native JS dialogs while Claude is driving the page.
//
// Chrome answers alert/confirm/prompt and suppresses the beforeunload prompt via CDP
// (Page.javascriptDialogOpening / Page.handleJavaScriptDialog). Firefox exposes no such
// API, and these dialogs block the page's JS thread SYNCHRONOUSLY — so an automated flow
// that triggers one (a confirm() in a click handler, a beforeunload on navigation) just
// HANGS the agent. Native dialogs can't be intercepted from outside the page, so we
// override them IN the page (MAIN world) — but ONLY while the agent is actively driving,
// so the user's own dialogs on idle tabs behave exactly as normal.
//
// Agent-active gate (cross-world): firefox-input-blocker.js (ISOLATED world) sets
// document.documentElement.dataset.czAgent = '1' while the agent acts in this frame and
// clears it when idle. ISOLATED and MAIN share the same DOM per frame, so we read that
// flag here — no runtime messaging needed (which MAIN world can't receive anyway).
(function () {
  if (window.__claudeZenDialogTamerInstalled) return;
  window.__claudeZenDialogTamerInstalled = true;

  const agentActive = () => {
    try { return !!(document.documentElement && document.documentElement.dataset.czAgent === '1'); }
    catch (e) { return false; }
  };
  const note = (msg) => { try { console.warn('[claude-zen][dialog] ' + msg); } catch (e) {} };

  const origAlert = window.alert;
  const origConfirm = window.confirm;
  const origPrompt = window.prompt;

  try {
    // alert → no-op; confirm → accept (true); prompt → default value (or ''). These match
    // the bundle's CDP default of accepting dialogs so automation proceeds. When the agent
    // is idle, delegate to the originals so the user sees real dialogs.
    window.alert = function (m) {
      if (agentActive()) { note('suppressed alert: ' + m); return undefined; }
      return origAlert ? origAlert.apply(window, arguments) : undefined;
    };
    window.confirm = function (m) {
      if (agentActive()) { note('auto-accepted confirm: ' + m); return true; }
      return origConfirm ? origConfirm.apply(window, arguments) : false;
    };
    window.prompt = function (m, def) {
      if (agentActive()) { note('auto-answered prompt: ' + m); return (def != null ? def : ''); }
      return origPrompt ? origPrompt.apply(window, arguments) : null;
    };
  } catch (e) {}

  // beforeunload: while the agent is acting, suppress the "Leave site?" prompt an
  // agent-triggered navigation/close would pop. Capture phase + stopImmediatePropagation
  // so the page's own beforeunload handler (which would set returnValue) never runs.
  // Browser-UI-initiated unloads (the user closing the tab) still prompt — only the
  // agent-active window is suppressed.
  window.addEventListener('beforeunload', (e) => {
    if (!agentActive()) return;
    try { e.stopImmediatePropagation(); e.preventDefault(); e.returnValue = undefined; } catch (err) {}
  }, { capture: true });
})();
