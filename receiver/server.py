#!/usr/bin/env python3
import hmac
import json
import os
import re
import tempfile
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MAX_BYTES = int(os.environ.get("MAX_BYTES", str(256 * 1024)))
TOKEN = os.environ.get("STHIRA_ADS_REPORT_TOKEN", "").strip()
EXPECTED_CAMPAIGN_NAME = os.environ.get(
    "EXPECTED_CAMPAIGN_NAME", "Whatsapp Leads -1"
).strip()

REPORT_SCHEMA_REQUIRED = {
    "version",
    "reportDate",
    "generatedAt",
    "campaignName",
    "currency",
    "campaign",
    "windows",
    "topSearchTerms",
    "topKeywords",
    "actionsTaken",
    "recommendations",
}
SAFE_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
SAFE_CALL_FIELDS = {
    "googleCallId",
    "startCallDateTime",
    "endCallDateTime",
    "durationSeconds",
    "status",
    "displayLocation",
    "callerAreaCode",
    "callerCountryCode",
    "type",
    "campaignName",
}
DISALLOWED_CALL_FIELDS = {
    "callerPhoneNumber",
    "phoneNumber",
    "rawPhoneNumber",
    "normalizedPhoneNumber",
}


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_path = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    with os.fdopen(fd, "w") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary_path, path)


def parse_safe_date(value, field_name):
    text = str(value or "")
    if not SAFE_DATE.fullmatch(text):
        raise ValueError(f"{field_name} must be yyyy-mm-dd")
    try:
        return date.fromisoformat(text)
    except ValueError as error:
        raise ValueError(f"{field_name} must be a real calendar date") from error


def validate_call_details_probe(report):
    probe = report.get("callDetailsProbe")
    if probe is None:
        return
    if not isinstance(probe, dict) or not isinstance(probe.get("rows"), list):
        raise ValueError("callDetailsProbe must contain a rows array")
    for row in probe["rows"]:
        if not isinstance(row, dict):
            raise ValueError("callDetailsProbe rows must be objects")
        forbidden = sorted(DISALLOWED_CALL_FIELDS.intersection(row))
        if forbidden:
            raise ValueError("caller phone numbers are not accepted")
        unknown = sorted(set(row) - SAFE_CALL_FIELDS)
        if unknown:
            raise ValueError("unsupported call detail fields: " + ", ".join(unknown))


def validate_report(report):
    if not isinstance(report, dict):
        raise ValueError("report must be a JSON object")
    missing = sorted(REPORT_SCHEMA_REQUIRED - set(report))
    if missing:
        raise ValueError("missing required fields: " + ", ".join(missing))
    if report.get("campaignName") != EXPECTED_CAMPAIGN_NAME:
        raise ValueError("unexpected campaignName")
    if report.get("currency") != "INR":
        raise ValueError("currency must be INR")
    report_date = str(report.get("reportDate", ""))
    parse_safe_date(report_date, "reportDate")
    for key in ("campaign", "windows"):
        if not isinstance(report.get(key), dict):
            raise ValueError(key + " must be object")
    for key in ("topSearchTerms", "topKeywords", "actionsTaken", "recommendations"):
        if not isinstance(report.get(key), list):
            raise ValueError(key + " must be array")
    validate_call_details_probe(report)
    return report_date


def normalize_candidate(row):
    return {key: row.get(key, "") for key in SAFE_CALL_FIELDS}


def candidate_identity(candidate):
    return candidate.get("googleCallId") or "|".join(
        str(candidate.get(key, ""))
        for key in (
            "startCallDateTime",
            "endCallDateTime",
            "durationSeconds",
            "status",
            "campaignName",
        )
    )


def collect_call_candidates(start_date, end_date):
    start = parse_safe_date(start_date, "startDate")
    end = parse_safe_date(end_date, "endDate")
    if end < start:
        raise ValueError("endDate must be on or after startDate")
    if (end - start).days > 31:
        raise ValueError("date range cannot exceed 31 days")

    by_id = {}
    archive_dir = DATA_DIR / "archive"
    paths = sorted(archive_dir.glob("*.json")) if archive_dir.exists() else []
    latest = DATA_DIR / "latest.json"
    if latest.exists():
        paths.append(latest)

    for path in paths:
        try:
            report = json.loads(path.read_text())
            rows = report.get("callDetailsProbe", {}).get("rows", [])
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
        for row in rows:
            if not isinstance(row, dict) or DISALLOWED_CALL_FIELDS.intersection(row):
                continue
            candidate = normalize_candidate(row)
            timestamp = str(candidate.get("startCallDateTime", ""))[:10]
            if not SAFE_DATE.fullmatch(timestamp):
                continue
            if start_date <= timestamp <= end_date:
                by_id[candidate_identity(candidate)] = candidate

    return sorted(
        by_id.values(), key=lambda item: str(item.get("startCallDateTime", "")), reverse=True
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "sthira-ads-report-receiver/2.0"

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_ok(self):
        supplied = self.headers.get("X-Sthira-Ads-Token", "").strip()
        return bool(TOKEN) and hmac.compare_digest(supplied, TOKEN)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/health", "/api/health"):
            return self._send_json(
                200,
                {"ok": True, "service": "sthira-ads-report-receiver", "time": utc_now()},
            )
        if path in ("/reports/latest.json", "/api/sthira-ads/reports/latest.json"):
            latest = DATA_DIR / "latest.json"
            if not latest.exists():
                return self._send_json(404, {"ok": False, "error": "no report yet"})
            body = latest.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/sthira-ads/call-candidates":
            if not self._auth_ok():
                return self._send_json(401, {"ok": False, "error": "unauthorized"})
            query = parse_qs(parsed.query)
            start_date = (query.get("startDate") or [""])[0]
            end_date = (query.get("endDate") or [""])[0]
            try:
                candidates = collect_call_candidates(start_date, end_date)
            except ValueError as error:
                return self._send_json(400, {"ok": False, "error": str(error)})
            return self._send_json(
                200,
                {
                    "ok": True,
                    "version": 1,
                    "generatedAt": utc_now(),
                    "window": {"startDate": start_date, "endDate": end_date},
                    "candidates": candidates,
                },
            )
        return self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/sthira-ads/report", "/report"):
            return self._send_json(404, {"ok": False, "error": "not found"})
        if not self._auth_ok():
            return self._send_json(401, {"ok": False, "error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self._send_json(411, {"ok": False, "error": "invalid content length"})
        if length <= 0 or length > MAX_BYTES:
            return self._send_json(413, {"ok": False, "error": "invalid payload size"})
        raw = self.rfile.read(length)
        try:
            report = json.loads(raw.decode("utf-8"))
            report_date = validate_report(report)
        except Exception as error:
            return self._send_json(400, {"ok": False, "error": str(error)})

        received_at = utc_now()
        report["_receivedAt"] = received_at
        report["_source"] = "google-ads-script"
        day_path = DATA_DIR / "archive" / f"{report_date}.json"
        atomic_write_json(day_path, report)
        atomic_write_json(DATA_DIR / "latest.json", report)
        with (DATA_DIR / "events.jsonl").open("a") as handle:
            handle.write(
                json.dumps(
                    {
                        "receivedAt": received_at,
                        "reportDate": report_date,
                        "campaignName": report.get("campaignName"),
                    },
                    sort_keys=True,
                )
                + "\n"
            )
        return self._send_json(
            200,
            {
                "ok": True,
                "stored": {
                    "latest": "/reports/latest.json",
                    "archive": f"/archive/{report_date}.json",
                },
            },
        )

    def log_message(self, fmt, *args):
        print(
            "%s - - [%s] %s"
            % (self.client_address[0], self.log_date_time_string(), fmt % args),
            flush=True,
        )


if __name__ == "__main__":
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not TOKEN:
        print("ERROR: STHIRA_ADS_REPORT_TOKEN is required", flush=True)
        raise SystemExit(2)
    port = int(os.environ.get("PORT", "3075"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Listening on :{port}; data={DATA_DIR}", flush=True)
    server.serve_forever()
