// OAuth callback page script.
// browser.identity.launchWebAuthFlow intercepts the redirect BEFORE this page
// loads, so this script runs only as a fallback (e.g. if the identity API
// fails and the tab actually navigates here).
(function () {
  try {
    chrome.runtime.sendMessage({
      type: 'FF_OAUTH_CALLBACK',
      url:  location.href,
    });
  } catch (_) {}
  window.close();
}());
