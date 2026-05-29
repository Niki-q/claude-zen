// Sidebar placeholder shown (per-tab) when the active tab is NOT part of Claude's
// working group. Clicking the button asks the background to switch the active tab
// back to Claude's main/working tab; that tab activation then swaps the sidebar
// panel back to the chat (see the tabs.onActivated handler in firefox-page-shims.js).
// Inline scripts are blocked by the extension_pages CSP, so this lives in its own file.
document.getElementById('open-chat')?.addEventListener('click', () => {
  try { chrome.runtime.sendMessage({ type: 'SWITCH_TO_MAIN_TAB' }); } catch (e) {}
});
