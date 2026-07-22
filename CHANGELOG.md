# Changelog

## 0.3.3

- Fixed the operation-repair contract that incorrectly showed `replacement` as an array while local validation required one object.
- Repair requests now use a dedicated system instruction and a single type-specific response shape, so block repairs never contain the competing inline schema and vice versa.
- Kept strict local rejection of array replacements, reran canonical-source validation after repair, and added regressions for the exact DeepSeek response observed in diagnostic logs.

## 0.3.2

- Replaced the v0.3.1 newline-escape special case with a bounded model self-repair harness for locally rejected operations.
- Repair requests isolate the failing operation, validation error, candidate operations, and the same safe text blocks; all unrelated operations remain untouched.
- Repaired block operations return only `blockIds` and LaTeX, while local DOM code supplies the canonical source text and reruns every structural and safety check.
- Limited repairs to two attempts per batch, logged every repair stage, and preserved atomic no-write behavior when repair remains invalid or the request fails.

## 0.3.1

- Canonicalized block-operation source text only when model output differs from the note by JSON newline serialization artifacts such as a literal `\\n`; all other character and whitespace differences remain rejected.
- Added unique safe relocation for block operations whose copied block IDs are wrong, matching the existing inline recovery while rejecting ambiguous, protected, or out-of-batch targets.
- Strengthened provider instructions so block IDs are copied verbatim and block sources preserve U+000A newlines with exactly one layer of JSON escaping.
- Added regression coverage from the real `cases` failure, plus ambiguity, whitespace, and batch-boundary guards.

## 0.3.0

- Added an opt-out diagnostic logging system that writes one UTF-8 JSONL file per operation and retains Math Patch logs for a rolling 168 hours.
- Added complete local-rule and AI traces, including original/final note HTML, safe blocks, batch requests, full provider responses, `finish_reason`, usage, validation, preview, save, rollback, and error events.
- Added recursive redaction for API keys, authorization fields, bearer tokens, credentials, and registered secret values before any record reaches disk.
- Added a writable-directory probe, automatic fallback to the Zotero Profile log directory, non-blocking log failures, and cleanup across current and previously configured directories.
- Added preference controls to enable logging, choose/open the log directory, restore the default directory, and display plaintext-log privacy guidance.
- Added logging regression tests for ordering, UTF-8 and LaTeX preservation, redaction, directory fallback, retention boundaries, FIFO cleanup, active-file protection, and I/O failure isolation.
- Fixed Zotero startup by injecting the privileged-window `IOUtils` and `PathUtils` globals instead of importing module paths that do not exist in Zotero.
- Narrowed HTML-markup validation so LaTeX comparisons such as `A_i>0` and `\mathcal H_g<H_{\text{low}}` are accepted while explicit tags, attributes, comments, declarations, and unsafe commands remain blocked.
- Clarified that inline `occurrence` is counted within one `blockId` and safely normalizes an out-of-range model value when the source has exactly one unambiguous match in that block.
- Safely relocates an inline operation with a mistaken block ID only when its source has exactly one editable exact match in the request batch, while preserving strict rejection for ambiguous or out-of-batch matches.

- Removed local mathematical-semantic heuristics from AI operation validation so model-selected values such as `0`, `2026`, `TTC`, and numeric vectors can be converted.
- Kept exact source matching, block existence, occurrence, protected-content, overlap, LaTeX safety, and atomic-write validation unchanged.
- Added regression coverage for permissive inline sources and a bracket-delimited numeric vector spanning multiple note blocks.
- Rejected model operations with unbalanced unescaped LaTeX braces before preview or note modification, and reinforced the provider response instructions.
- Rejected every response marked with `finish_reason: "length"`, even when JSON mode returns a parseable but semantically truncated object.

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
