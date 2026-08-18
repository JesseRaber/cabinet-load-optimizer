# Cabinet Load Optimizer — Implementation Notes

**Branch:** `agent/deep-scan-remediation`  
**Scope:** Deep-scan remediation for safety validation, manual-layout parity, output safety, persistence, import guardrails, diagnostics, documentation, testing, and delivery hardening.

## Delivered changes

| Area | Implemented change | Result |
|---|---|---|
| Upright tip-up safety | Added `load-placement-core.js`, a shared pure clearance helper used by the fallback packer, V2, Manual Layout, and behavioral tests. | A 24 × 84 × 24 in cabinet requires 90.361 in of clearance with the 3 in margin; it is rejected in a 90 in trailer. |
| Active V2 validation | Added `CLO_RULES_V2.validatePlacement()` and routed Manual Layout preview, commit, annotations, and pre-optimization pinned checks through it. | Manual placement follows the active V2 geometry, support, door-bank, restraint, and tip-up rules rather than intersecting V2 with legacy validation. |
| Pinned safety | Optimization stops and highlights unsafe pinned placements instead of packing around an unsafe layout. | Pinned positions remain immutable, but unsafe pins cannot silently become part of a generated plan. |
| Door-bank behavior | Corrected visible crew/plan/tuning language and implemented door-bank coverage checking in V2. | Face-up cabinets never go on the floor. A single qualifying piece may ride on doors only when coverage, support, bulk, forward-restraint, and one-piece conditions pass. |
| Output safety | Escaped the remaining printable room/cabinet label and Manual Layout warning sinks. | User-controlled import and warning text is not injected as markup in the reviewed paths. |
| Persistence | Clear Hand Placements now calls `saveAll()` immediately. | Cleared pins do not reappear after reload due to an unsaved local state change. |
| Static deployment | Replaced the implicit `api/settings` default with opt-in `window.CLO_SETTINGS_URL`. | GitHub Pages remains browser-local without probing a nonexistent endpoint; NAS/server sync remains configurable. |
| Import guardrails | Added limits for item count, per-row/manual quantity, dimensions, CSV/text input, and database input, with large-import confirmations. | Accidental oversized imports, zero/negative/fractional quantities, and extreme dimensions are rejected before object expansion. |
| Diagnostics and guidance | Added a header status indicator for **Packing rules: V2 active** versus an explicit legacy fallback warning. Updated README and Tuning-tab pointers to identify V2 as authoritative. | Operators can see which packing engine is running, and tuning advice points to active implementation locations. |
| Delivery hardening | Protected `main` with pull-request requirements, strict passing `test` status checks, disabled force pushes/deletions, and zero required approvals for the one-owner workflow. | CI must pass before merge while Jesse can still merge without a second reviewer. |

## Validation evidence

The repository test command completed with **22 passing tests** and no failures. Coverage includes shared tip-up math, live V2 manual validation, trailer geometry constraints, support thresholds, plywood stacking height, forward restraint, door-bank coverage/capacity/bulk/no-further-stacking, import limits, output escaping, persistence wiring, pose-order synchronization, static sync behavior, main inline-script compilation, and a 220-item packing sanity fixture. `npm run check` completed successfully across all first-party JavaScript modules, and `git diff --check` found no whitespace errors.

A temporary browser smoke test loaded the current branch under a separate static origin. The browser showed **Packing rules: V2 active** and **Saved in this browser**. A built-in CSV sample previewed, imported into six cabinet items, reloaded from browser-local storage, and optimized successfully with six loaded and zero failed. The 3D plan, loading sequence, and Manual Layout interface rendered without a visible runtime failure.

## Intentional limitations and follow-up work

The application remains a **spatial planning aid**, not a transport certification system. It does not yet calculate weight, payload, axle/tongue loading, center of gravity, GVWR/GAWR, tie-down capacity, or cabinet-specific structural capacity. Those are explicitly disclosed in the README and crew/print output as future major features rather than implied capabilities.

The static GitHub Pages deployment cannot provide response headers itself. Third-party runtime dependencies remain externally hosted for this narrow patch; self-hosting pinned production assets and applying a restrictive Content Security Policy should be treated as a future deployment/infrastructure change rather than mixed into this safety remediation.

The pre-existing open pull request #4 was not modified. This branch was created from the current `main` baseline and preserves its own separate changes.
