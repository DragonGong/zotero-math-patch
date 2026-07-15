# Changelog

## 0.2.4

- Fixed the preview being opened from the add-on's raw `jar:file:` URI, which prevented Zotero from initializing its privileged XUL content.
- Opened the preview through the registered `chrome://zotero-math-patch/content/preview.xhtml` URI used by Zotero dialogs.
- Added a regression assertion that rejects the non-privileged preview URL.

## 0.2.3

- Fixed the AI change preview appearing as an empty or title-bar-only window on Zotero 9.
- Rebuilt the preview as an explicitly sized Zotero window with visible `Apply` and `Cancel` actions.
- Added preview rendering and action regression tests so cancelled previews remain non-destructive.

## 0.2.2

- Increased the default AI request timeout from 60 to 120 seconds and made timeout errors report the configured duration.
- Increased the connection-test output allowance and distinguished empty or truncated model responses from generic invalid JSON.
- Disabled DeepSeek V4 thinking mode for official `api.deepseek.com` formula-repair requests to reduce latency and preserve the JSON output budget.
- Added a connection-test warning when the configured timeout is shorter than 60 seconds.

## 0.2.1

- Fixed `Test Connection` and prompt-reset actions in Zotero 9 preference panes.
- Updated API Key storage to use the Firefox 140 asynchronous login manager API.
- Added preference-pane interaction and credential-storage regression tests.

## 0.2.0

- Added the manual `Process Math with AI` command alongside `Render Markdown Math`.
- Added a Zotero 7 `Math Patch` preference pane for OpenAI-compatible services.
- Added local API Key storage through Firefox credential storage.
- Added safe note block extraction, long-note batching, strict operation validation, preview, conflict detection, and atomic save behavior.
- Added mocked Provider and workflow tests; no paid model API is called by the test suite.
- Preserved the existing rule-based Markdown math conversion behavior.
- Restored required Zotero update metadata so the XPI installs on Zotero 9.


## 0.1.9

- Added rule-based support for bracket-delimited block formulas and selected parenthetical inline formulas.
- Fixed Windows XPI entry paths so Zotero can load packaged scripts.
