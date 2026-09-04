import copy
import datetime as dt
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

gate = load('gate', ROOT / 'scripts/validate-review-commit.py')
reader = load('reader', ROOT / 'scripts/search-quality-preflight.py')

class ReviewGateTest(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 9, 5, tzinfo=dt.timezone.utc)
        self.proof = {'status': 'complete', 'customerId': '5458767317', 'campaignId': 24073581572,
                      'fetchedAt': '2026-09-05T00:00:00Z', 'rows': [{'query': 'example equipment shop'}]}
        self.old = {'safeNegativeRules': [], 'watchOnlyTerms': ['bone setting'],
                    'negativeReview': {'owner': 'spandana', 'reviewedAt': '2026-09-04T00:00:00Z'},
                    'dailyBudgetTargetInr': 180}
        self.new = copy.deepcopy(self.old)
        self.new['negativeReview']['reviewedAt'] = self.proof['fetchedAt']

    def test_successful_full_read_allows_heartbeat_only(self):
        gate.validate(self.old, self.new, self.proof, self.now)

    def test_missing_stale_or_fabricated_proof_blocks_publication(self):
        for proof in ({}, dict(self.proof, status='failed'), dict(self.proof, fetchedAt='2026-09-04T00:00:00Z')):
            with self.assertRaises(ValueError): gate.validate(self.old, self.new, proof, self.now)
        self.new['negativeReview']['reviewedAt'] = '2026-09-05T00:00:01Z'
        with self.assertRaises(ValueError): gate.validate(self.old, self.new, self.proof, self.now)

    def test_budget_change_and_removed_protection_are_blocked(self):
        self.new['dailyBudgetTargetInr'] = 200
        with self.assertRaises(ValueError): gate.validate(self.old, self.new, self.proof, self.now)
        self.new['dailyBudgetTargetInr'] = 180
        self.new['watchOnlyTerms'] = []
        with self.assertRaises(ValueError): gate.validate(self.old, self.new, self.proof, self.now)

    def test_new_rule_requires_observed_query_and_rationale(self):
        self.new['safeNegativeRules'] = [{'term': 'example equipment shop', 'matchType': 'EXACT',
                                         'note': 'Exact equipment shopping intent, outside clinic treatment.'}]
        gate.validate(self.old, self.new, self.proof, self.now)
        self.new['safeNegativeRules'][0]['term'] = 'unobserved equipment shop'
        with self.assertRaises(ValueError): gate.validate(self.old, self.new, self.proof, self.now)

    def test_ambiguous_clinical_wording_is_protected(self):
        self.proof['rows'] = [{'query': 'bone setting near me'}]
        self.new['safeNegativeRules'] = [{'term': 'bone setting near me', 'matchType': 'EXACT',
                                         'note': 'A long but incorrect rationale does not override protection.'}]
        with self.assertRaises(ValueError): gate.validate(self.old, self.new, self.proof, self.now)

    def test_failed_fetch_invalidates_previous_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            proof = Path(folder) / 'proof.json'
            proof.write_text('previous-success')
            with patch.object(reader, 'PROOF', proof), patch.object(reader.importlib.util, 'spec_from_file_location', side_effect=RuntimeError('auth unavailable')):
                with self.assertRaises(RuntimeError): reader.collect()
            self.assertFalse(proof.exists())

if __name__ == '__main__': unittest.main()
