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
  score/corrections summary. Both use compact, mobile-friendly HTML with a plain-text fallback.
- `scripts/daily-performance-summary.js` runs once each morning and posts the privacy-safe
  structured report to the private receiver. It is receiver-only and does not email.
- `receiver/server.py` is the deployable receiver source. Its authenticated call-candidate endpoint
  gives the clinic app timestamps, duration and received/missed state for local matching while
  rejecting caller phone numbers.
- The primary call metric is the Google Ads conversion action named `Clicks to call`. It is an
  Ads-attributed Maps call-button click, not proof of an answered or qualified clinic call.

Tokens remain only in the live Google Ads script and server secret storage. The checked-in
receiver script intentionally contains a placeholder.

## Search-quality owner and executor (v4)

Spandana owns fresh search-term review; the existing hourly Google Ads script is the only Ads
writer. Append audited `safeNegativeRules` using EXACT for full unrelated queries by default;
PHRASE rules require a specific, justified irrelevant intent. Never publish raw search reports,
patient data, secrets or ambiguous clinical exclusions. Preserve the rest of the config.

After a successful live read and review, update `negativeReview.reviewedAt` to its UTC ISO time
and keep `negativeReview.owner` as `spandana`, including when no new rules qualify. Never refresh
that timestamp from cached, failed or partial source reads. The executor freezes new additions and
alerts the existing owner email when this review is more than 72 hours old or a runtime query fails.
Its diagnostics are `STHIRA_GUARDRAIL_V4` / `STHIRA_GUARDRAIL_V4_FAILED` in Google Ads run logs.

The executor hard-checks advertiser 5458767317 and campaign 24073581572 and its enabled name,
blocks brand/watch-only/positive-keyword conflicts, retains Unicode, checks existing match types,
and verifies each addition. Limits: five additions per run and ten per day. Keyword pauses are
prohibited. Preview/dry runs do not write negatives, correction history, success timestamps or
emails. A successful live scan stores `STHIRA_ADS_LAST_SCAN_V4` in script properties; this local
state is not independently accessible to the reviewer without the Google Ads editor.

Rollback: set `automation.autoAddSafeNegativeTerms` false to stop new exclusions (or `enabled`
false for the whole script). Existing negatives stay in Google Ads; remove only individually
reviewed incorrect exclusions. Keep the last known good source revision before editor replacement.
