# Security & Quality Review: PennCard Equipment Checkout v1.2.0

Date: 2026-03-26
Author: Codex
Scope: Full application (`index.html`, `app.js`, `styles.css`)

## Summary

This review covers the v1.2.0 hardening pass applied to the Codex-authored Equipment Checkout application. The previous review (v1.1) identified five findings. All five have been resolved. Additional hardening measures were introduced in v1.2.0.

---

## Previous Findings — Status

### 1) Inline script/handlers + missing CSP (High) — RESOLVED
- All inline event handlers removed in v1.1 (Codex conversion).
- CSP meta tag added with `script-src 'self'`.
- **v1.2.0**: Removed `'unsafe-inline'` from `style-src`. All inline `style=""` attributes converted to CSS classes or applied via CSSOM API.

### 2) Weak backup import validation (Medium) — RESOLVED
- `sanitizeBackupData()` performs deep schema validation, type checking, field length enforcement, ID deduplication, and reference integrity checks.
- File size capped at 10 MB. Equipment capped at 1,000 items; rentals at 10,000.

### 3) LocalStorage plaintext data (Medium) — MITIGATED
- **v1.2.0**: FNV-1a integrity hash stored in metadata. On load, hash mismatch triggers a user-visible warning toast.
- Shadow storage fallback now runs through `sanitizeBackupData()` before acceptance.
- Risk documented: shared workstations can expose/alter data. Server-side persistence recommended for production.

### 4) "Return All" scoped by event name (Medium) — RESOLVED
- `returnAllForRental()` scoped by `rentalId`, not event name string.

### 5) Export sorting side effect (Low) — RESOLVED
- `exportInventoryCSV()` sorts a shallow copy (`[...S.equipment].sort(...)`).

---

## New Hardening in v1.2.0

### Security
- **CSP tightened**: `style-src` no longer includes `'unsafe-inline'`. Dynamic styles (Gantt positioning, event colors) applied via CSSOM API and CSS classes.
- **Storage integrity**: FNV-1a hash verifies localStorage data has not been tampered with externally.
- **Shadow fallback validation**: Shadow storage data is validated through `sanitizeBackupData()` before use.
- **UUID fallback**: `crypto.randomUUID()` feature detection with Math.random fallback for non-secure contexts.
- **Equipment rate limit**: Maximum 200 equipment items enforced in `addUnit()`.
- **Magic numbers extracted**: All limits (file size, item counts, field lengths) defined as named constants.

### Performance
- **Conditional rendering**: `render()` only updates the active tab's content (dashboard/history/calendar).
- **Debounced search**: History search input debounced at 250ms to prevent excessive re-renders.
- **Paginated history**: History table shows 50 rows at a time with "Load more" button.
- **Cached storage usage**: `storageUsage()` uses cached byte count from most recent save instead of full localStorage scan.
- **Replaced setInterval**: Header date refreshes on `visibilitychange` instead of 60-second polling.

### Features
- **Sortable history columns**: Click column headers to sort by event, org, date, status.
- **Print stylesheet**: `@media print` rules hide UI chrome and optimize layout for paper.
- **ARIA accessibility**: Tab bar uses `role="tablist"`, tabs use `role="tab"` with `aria-selected`. Toast container has `aria-live="assertive"`. Calendar nav buttons have `aria-label`.

### Code Quality
- **Codex attribution**: File headers, section banners, and version strings credit Codex.
- **Naming convention documented**: Header comment explains abbreviated vs. full-word function names.
- **Constants centralized**: All numeric limits defined at top of `app.js`.

---

## Remaining Considerations

1. **innerHTML pattern**: Rendering still uses string concatenation + `innerHTML`. All user inputs pass through `escHtml()`. A full migration to DOM construction APIs would eliminate residual XSS risk but is not warranted for the current threat model.
2. **No server-side persistence**: All data lives in browser localStorage. For multi-device or multi-operator use, a backend with authentication and audit logging is recommended.
3. **No undo/redo**: Accidental deletions are permanent (confirmation dialogs mitigate but don't eliminate risk).
