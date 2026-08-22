# Private Ads report receiver

This service receives the daily privacy-safe Google Ads report and exposes an authenticated,
phone-number-free candidate feed for local attribution matching.

- `POST /api/sthira-ads/report` stores the Ads Script report.
- `GET /api/sthira-ads/call-candidates?startDate=yyyy-mm-dd&endDate=yyyy-mm-dd` returns only Google
  call ID, timestamps, duration, received/missed status, display location, area/country code, type,
  and campaign. It requires `X-Sthira-Ads-Token`.
- `GET /api/sthira-ads/reports/latest.json` remains available for the existing reporting workflow.
- The receiver rejects any call-detail payload containing a caller phone number.

`STHIRA_ADS_REPORT_TOKEN` stays in server secret storage. Do not put it in this repository or in a
browser bundle.
