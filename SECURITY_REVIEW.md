# Security & Quality Review: `index.html`

Date: 2026-03-25
Scope: `/workspace/penncard-equipment-checkout/index.html`

## Summary

I reviewed the app for client-side vulnerabilities, input/data hardening gaps, and reliability issues that could lead to data loss or abuse.

## Findings (Flagged for Review)

### 1) Missing Content Security Policy + heavy inline script/handlers (High)

The page executes a large inline `<script>` block and many inline `onclick`/`onchange` attributes.
Without a strict CSP, any HTML/script injection bug can execute arbitrary script in the app origin.

**Why this matters**
- CSP is a major compensating control for XSS.
- Current architecture makes CSP harder to deploy because of inline handlers.

**Recommendation**
- Move inline handlers to `addEventListener` bindings.
- Move inline script into external JS file.
- Add a CSP meta/header that disables inline script (nonce/hash-based exceptions only if needed).

---

### 2) Backup import trust boundary is weak (Medium)

`importJSON()` only checks top-level shapes (`equipment`, `rentals`, `seq`) and then assigns `S = data` directly.
Malformed or adversarial JSON can create inconsistent state, runtime errors, or a persistent app DoS.

**Examples**
- Unknown `type` values break rendering paths expecting `TYPE[item.type]`.
- Wrong field types can break date comparisons and history views.
- Very large arrays could bloat localStorage and force repeated prune/error paths.

**Recommendation**
- Add strict schema validation (per-item and per-rental) before assignment.
- Reject unknown enum values (`reader|hotspot|charger`).
- Enforce max lengths for `event`, `org`, and `note` in imported data.
- Normalize missing/invalid fields to safe defaults.

---

### 3) LocalStorage contains operational data in plaintext (Medium)

All checkout history and metadata are stored in browser `localStorage`.
Any script running in the same origin can read/modify this data.

**Why this matters**
- If this is used on shared workstations or a compromised browser profile, records can be exposed/altered.

**Recommendation**
- Document this risk clearly for operators.
- Prefer server-side persistence with auth + audit trail for production use.
- If remaining client-only, consider integrity checks and explicit "trusted device" guidance.

---

### 4) Data integrity bug: event-level "Return All" can cross rental boundaries (Medium)

`returnAllForEvent(eventName)` batches all checked-out items matching event name text only.
If two different rentals reuse the same event name, one return action can unintentionally close/update multiple rentals.

**Recommendation**
- Scope "Return All" by `rentalId` instead of event string.
- Group checked-out sections by rental record (or event + rental id).

---

### 5) Reliability bug: sorting side effect in export path (Low)

`exportInventoryCSV()` sorts `S.equipment` in place.
While mostly harmless, mutating canonical state during export can cause unexpected order changes elsewhere.

**Recommendation**
- Sort a shallow copy (`[...S.equipment].sort(...)`) to avoid side effects.

## Quick Wins

1. Add JSON schema validation for imports (highest ROI).
2. Refactor inline handlers/scripts and introduce CSP.
3. Bind "Return All" to rental IDs.
4. Make export sorting immutable.

## Notes

- I did not find an obvious direct DOM-XSS sink in current render paths because user-provided fields are generally escaped with `escHtml()`.
- The biggest practical risk is **future injection + no CSP** and **state poisoning through weak import validation**.
