# Adaptive Workspace

A shared presentation refresh for DashBen's web client and Android shell.

## Experience

- Full-height charcoal navigation, grouped sections, and a compact toolbar.
- Adaptive warm light and soft dark palettes, available in Management and the toolbar.
- Daily pairs focus/tasks with schedule/journal on desktop and stacks them on phones.
- Secondary weather/calendar sections start collapsed unless a saved preference says otherwise.
- Task rows use aligned metadata and contextual actions; dates retain exact ISO values in their tooltips.
- Details dock on the right on wide screens. Expand changes the editor's size without replacing its form or draft. Full page retains the existing document view.
- Note properties/tags collapse separately from the writing area. Save buttons explicitly say “Save & close”. Escape in an editor follows the existing save/validation path.
- Mobile uses a navigation drawer, quick navigation, safe-area spacing, touch targets, and full-screen editing.
- Reduced-motion preferences disable the new transitions.

## Implementation

`adaptive-workspace.css` and `adaptive-workspace.mjs` are identical in both repositories. They augment the existing view markup and keep writes routed through the host app's existing store and form handlers. No schema, backend, authentication, or sync-engine change is required.

The first visit defaults to Adaptive warm light. An explicit appearance selection is remembered locally as `workspace-theme`; the host's normal theme preference is also updated. Legacy palettes remain available. Saved tab order/grouping remains authoritative; fresh profiles use the new default grouping.

## Validation

The web production build passes. Browser checks exercise both the web client and Android web assets with synthetic SQLite data and mocked network responses; no production data or services are used.

Covered: all main destinations, light/dark and reload persistence, desktop sidebar collapse, mobile drawer, task creation/edit/save, note body editing with collapsed metadata, editor expansion preserving input, toolbar capture, and widths of 360, 412, 768, 1024, and 1440 pixels. Screenshots were inspected for Daily and task/note editors. No uncaught browser errors occurred in the successful run.

The Android web layer was exercised in Chromium at phone dimensions. A native APK build/device test is still required to verify keyboard, status-bar, biometric, widget, share-sheet, and native Back behaviour on the actual device.

## Release

Review the design branch before merging. Web uses the normal `npm run build` deployment. Android uses the existing `npx cap sync android` and native build steps after the branch is checked out. The web service-worker cache version is bumped for the new client assets. Neither branch applies a database migration or deploys itself.
