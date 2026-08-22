import json
import tempfile
import unittest
from pathlib import Path

import server


def sample_report(report_date="2026-08-22", rows=None):
    return {
        "version": 1,
        "reportDate": report_date,
        "generatedAt": report_date + "T09:00:00+05:30",
        "campaignName": "Whatsapp Leads -1",
        "currency": "INR",
        "campaign": {},
        "windows": {},
        "topSearchTerms": [],
        "topKeywords": [],
        "callDetailsProbe": {"ok": True, "rowCount": len(rows or []), "rows": rows or []},
        "actionsTaken": [],
        "recommendations": [],
    }


def call_row(call_id, start, status="RECEIVED"):
    return {
        "googleCallId": call_id,
        "startCallDateTime": start,
        "endCallDateTime": start,
        "durationSeconds": 85,
        "status": status,
        "displayLocation": "AD",
        "callerAreaCode": "40",
        "callerCountryCode": "IN",
        "type": "INCOMING",
        "campaignName": "Whatsapp Leads -1",
    }


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.previous_data_dir = server.DATA_DIR
        server.DATA_DIR = Path(self.temporary_directory.name)

    def tearDown(self):
        server.DATA_DIR = self.previous_data_dir
        self.temporary_directory.cleanup()

    def write_archive(self, name, report):
        path = server.DATA_DIR / "archive" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report))

    def test_report_accepts_safe_call_details(self):
        report = sample_report(rows=[call_row("call-1", "2026-08-22 10:11:12")])
        self.assertEqual(server.validate_report(report), "2026-08-22")

    def test_report_rejects_caller_phone_number(self):
        row = call_row("call-1", "2026-08-22 10:11:12")
        row["callerPhoneNumber"] = "+919999999999"
        with self.assertRaisesRegex(ValueError, "caller phone numbers"):
            server.validate_report(sample_report(rows=[row]))

    def test_candidates_are_filtered_deduplicated_and_phone_free(self):
        first = call_row("call-1", "2026-08-22 10:11:12")
        duplicate = {**first, "durationSeconds": 90}
        outside = call_row("call-2", "2026-07-10 10:11:12")
        self.write_archive("2026-08-22.json", sample_report(rows=[first, outside]))
        self.write_archive("2026-08-23.json", sample_report("2026-08-23", [duplicate]))

        candidates = server.collect_call_candidates("2026-08-20", "2026-08-23")

        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["googleCallId"], "call-1")
        self.assertEqual(candidates[0]["durationSeconds"], 90)
        self.assertFalse(server.DISALLOWED_CALL_FIELDS.intersection(candidates[0]))

    def test_candidate_window_is_bounded(self):
        with self.assertRaisesRegex(ValueError, "cannot exceed 31 days"):
            server.collect_call_candidates("2026-01-01", "2026-08-23")


if __name__ == "__main__":
    unittest.main()
