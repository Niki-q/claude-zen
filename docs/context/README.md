# Project context archive

Distilled knowledge from the Claude Code sessions that reverse-engineered and
ported this extension. These are **scrubbed summaries**, not raw transcripts —
credentials (OAuth tokens, cookies), the owner's email, and HAR captures were
redacted when distilling. Do not commit raw transcripts or secrets here.

| Doc | Source session | Topic |
|---|---|---|
| `01-analysis-a009114b.md` | karma profile, `a009114b…` (~2.4 MB transcript) | Initial deep analysis of the extension's structure and behavior |
| `02-analysis-fa25706e.md` | karma profile, `fa25706e…` (~3.1 MB transcript) | Further analysis / Firefox-porting investigation |
| `03-firefox-port-session.md` | personal profile (this session) | Implementation log of the Firefox port: every fix, decision, and limitation |

See also `../../PORTING.md` (repo root) for the architecture reference of the
Firefox compatibility layer.

Two other karma-profile sessions for this project (`020d7811…`, `c1440f9e…`) were
empty (only `/model` and `/exit` commands) and contain no content worth preserving.
