# Sthira Ads Public Control

Public-safe Google Ads automation config for Sthira.

Raw config URL used by Google Ads Scripts:

```text
https://raw.githubusercontent.com/sharankasandula/sthira-ads-public-control/main/config/active.json
```

Rules:

- No secrets, tokens, webhooks, patient data, or private lead notes.
- Only non-secret controls: thresholds, dry-run, safe negatives, watch terms.
- Google Ads Scripts enforce hardcoded guardrails beyond this config.

## Live scripts

- `scripts/auto-pause-expensive-keywords.js` runs hourly. It keeps approved keyword
  guardrails active, records corrections, and never sends per-run email. After 22:00 IST it sends
  one short call-click/spend email; Saturday's email is the weekly call-click/spend/optimisation-
  score/corrections summary.
- `scripts/daily-performance-summary.js` runs once each morning and posts the privacy-safe
  structured report to the private receiver. It is receiver-only and does not email.
- The primary call metric is the Google Ads conversion action named `Clicks to call`. It is an
  Ads-attributed Maps call-button click, not proof of an answered or qualified clinic call.

Tokens remain only in the live Google Ads script and server secret storage. The checked-in
receiver script intentionally contains a placeholder.
