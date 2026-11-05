import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('validate_config', ROOT / 'scripts/validate-config.py')
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConfigValidationTest(unittest.TestCase):
    def test_actual_schema_rejects_overlength_terms(self):
        schema = json.loads((ROOT / 'config/schema.json').read_text())
        config = json.loads((ROOT / 'config/active.json').read_text())
        # Isolate the deliberate invalid term from unrelated current config debt.
        config['safeNegativeRules'] = [{'term': 'x' * 81, 'matchType': 'EXACT'}]
        errors = module.validation_errors(config, schema)
        self.assertEqual([(list(e.path), e.validator) for e in errors],
                         [(['safeNegativeRules', 0, 'term'], 'maxLength')])
        config['safeNegativeRules'][0]['term'] = 'x' * 80
        self.assertEqual(module.validation_errors(config, schema), [])

    def test_actual_schema_rejects_terms_over_ten_words(self):
        # Google Ads keywords allow at most 10 words; longer rules can never be applied.
        schema = json.loads((ROOT / 'config/schema.json').read_text())
        config = json.loads((ROOT / 'config/active.json').read_text())
        config['safeNegativeRules'] = [{'term': ' '.join(['word'] * 11), 'matchType': 'EXACT'}]
        errors = module.validation_errors(config, schema)
        self.assertEqual([(list(e.path), e.validator) for e in errors],
                         [(['safeNegativeRules', 0, 'term'], 'pattern')])
        config['safeNegativeRules'][0]['term'] = ' '.join(['word'] * 10)
        self.assertEqual(module.validation_errors(config, schema), [])

    def test_formats_and_unknown_fields_are_enforced(self):
        schema = {'type': 'object', 'properties': {'at': {'type': 'string', 'format': 'date-time'}},
                  'additionalProperties': False}
        self.assertEqual(module.validation_errors({'at': '2026-11-02T00:00:00Z'}, schema), [])
        self.assertEqual(len(module.validation_errors({'at': 'not-a-date'}, schema)), 1)
        self.assertEqual(len(module.validation_errors({'at': '2026-02-30T00:00:00Z'}, schema)), 1)
        self.assertEqual(len(module.validation_errors({'at': '2026-11-02T00:00:00'}, schema)), 1)
        self.assertEqual(len(module.validation_errors({'unknown': True}, schema)), 1)

    def test_all_errors_are_returned(self):
        schema = {'type': 'array', 'items': {'type': 'string', 'maxLength': 2}}
        errors = module.validation_errors(['long', 'also-long'], schema)
        self.assertEqual([list(e.path) for e in errors], [[0], [1]])


if __name__ == '__main__':
    unittest.main()
