# Claude Zen in the Zen Browser: tabs, groups & folders

Status: **implemented** — auto-detect Zen → registry-only (emulated) grouping, with a
`◆ ` tab-title marker replacing the orange native group. Decision below was made by the
user (2026-06): auto-detect Zen = yes; losing the orange group = fine, mark another way.

## What shipped

- **Auto-detect Zen** (`firefox-page-shims.js`, tab-groups IIFE): `emulatedMode` is set from
  a manual override (`storage.local.__czPreferEmulatedGroups`) if present, else by
  auto-detecting Zen via `runtime.getBrowserInfo()` name/vendor + a UA scan. When on,
  `nativeAllowed()` is false → `isGroupable()` returns false → both group creation and the
  visual-promotion listener fall back to the emulated registry path (no native FF groups).
  - **Caveat:** Zen usually keeps a Firefox UA, so auto-detect is best-effort. If it
    misses, run `czEmulateGroups(true)` in the console (persists) — that's the reliable
    escape hatch. `czEmulateGroups(false)` forces native back on.
- **Alternative marking**: `FF_THREAD_MEMBERSHIP` now returns `mark: !thread.native`, and
  `firefox-thread-jump.js` prefixes the tab title with `◆ ` (kept in place by a `<title>`
  MutationObserver, since SPAs rewrite the title) for emulated/Zen members. Native-group
  threads keep the orange "Claude" chrome and get no extra marker.

The original analysis is kept below for context.

---

Status (historical): design note / open question.

## The problem

The Zen Browser (a Firefox fork) exposes **two** tab-organising systems, and the extension
already has **a third** of its own:

| System | Owner | WebExtension-visible? | Reliability in Zen |
|---|---|---|---|
| **Zen folders** (folders of *pinned* tabs in Zen's sidebar) | Zen | **No** — there is no WebExtension API for Zen folders | n/a (invisible to us) |
| **Native Firefox tab groups** (`chrome.tabs.group` / `chrome.tabGroups`) | Firefox/Zen | Yes | **Poor** in Zen (per field report — groups misbehave) |
| **Claude's group registry** (`__ffGroupMeta` / `__ffTabGroup` in `storage.session`) | this extension | Internal | Reliable (it's just our own data) |

The extension's grouping is a **hybrid** (see `CLAUDE.md` → "Tab Groups"):
- the **registry** is the *membership truth* and the agent's access boundary;
- on top of it, a **visual native group** is created (FF 138+) purely so the user *sees*
  an orange "Claude" group.

That visual layer is exactly the part that leans on native FF tab groups — i.e. the part
that "works ploхoва́то" in Zen.

## Why it (mostly) still works

The access boundary reads the **registry**, never the visual native id. So even when the
native/visual group fails in Zen:
- the agent still controls the right tabs (registry membership is intact);
- the **thread switcher** (`firefox-threads.js`) still lists/repoints/jumps threads — it
  reads the registry, not native groups.

What breaks in Zen is therefore **cosmetic**: the visible orange group may not appear,
flicker, or land tabs in the wrong native group. The "visual promotion" listener
(`tabs.onUpdated` → `tabs.group`) can also throw repeatedly and spam logs.

Zen **folders** are a separate, pinned-tab concept the extension cannot see or touch via
any API — so there is nothing to integrate directly; at most we avoid *fighting* them.

## Recommendation

Treat the visual native group as **optional and Zen-aware**:

1. **Detect Zen** and, there, **default to registry-only (emulated) mode** — skip the
   native `tabs.group` visual promotion entirely. The agent keeps full control (registry),
   and the **thread switcher becomes the primary UI** for moving between Claude sessions
   instead of native groups. This removes the flaky/poor native-group behaviour and the
   log spam, at the cost of no orange group chrome (which is unreliable in Zen anyway).
   - Detection options to validate (none are guaranteed — needs a real Zen build to test):
     - `navigator.userAgent` / `navigator.userAgentData` for a Zen marker;
     - presence of a Zen-specific global or pref;
     - **fallback heuristic:** if `chrome.tabs.group` exists but a probe group creation
       throws or the created group is immediately gone, flip to emulated for the session.
   - A user-facing toggle (`storage.local.__czPreferEmulatedGroups`) is the safe escape
     hatch if auto-detection is wrong.
2. **Don't try to write Zen folders** — no API. If anything, document that pinned-tab
   folders and Claude threads are independent; a Claude main tab that the user pins into a
   Zen folder still works (registry membership is by tabId, not by folder).
3. Keep the thread switcher as the cross-session navigation surface in Zen (it already
   doesn't depend on native groups).

## Decision needed (from the user)

- **Auto-detect Zen and go registry-only there**, or **add a manual toggle** (or both)?
- Is losing the visible orange "Claude" group in Zen acceptable (relying on the thread
  switcher instead), or is a visible grouping in Zen a hard requirement?
- Should a Claude main tab pinned into a Zen folder change any behaviour, or is "they're
  independent" the intended model?

Once the direction is picked, the code change is small and localised to the
visual-promotion gate in `firefox-page-shims.js` (the tab-groups IIFE) plus a detection
helper.
