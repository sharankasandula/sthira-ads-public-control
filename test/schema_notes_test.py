"""Dependency-free regressions for public config string metadata bounds.

This deliberately checks only string bounds, not full JSON Schema validation.
"""
import copy
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def within_string_bounds(value, schema):
    return (isinstance(value, str)
            and len(value) >= schema.get('minLength', 0)
            and len(value) <= schema.get('maxLength', float('inf')))


class SchemaNotesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads((ROOT / 'config/active.json').read_text())
        cls.schema = json.loads((ROOT / 'config/schema.json').read_text())
        cls.rule_schema = cls.schema['properties']['safeNegativeRules']['items']
        cls.note_schema = cls.rule_schema['properties']['note']

    def test_note_limit_is_512(self):
        self.assertEqual(self.note_schema, {'type': 'string', 'maxLength': 512})

    def test_every_active_rule_note_fits_schema(self):
        self.assertTrue(self.config['safeNegativeRules'])
        for index, rule in enumerate(self.config['safeNegativeRules']):
            with self.subTest(rule=index):
                if 'note' in rule:
                    self.assertTrue(within_string_bounds(rule['note'], self.note_schema))

    def test_note_boundary_accepts_512_rejects_513(self):
        rule = copy.deepcopy(self.config['safeNegativeRules'][0])
        for size, accepted in ((160, True), (300, True), (512, True), (513, False)):
            with self.subTest(size=size):
                rule['note'] = 'x' * size
                self.assertEqual(within_string_bounds(rule['note'], self.note_schema), accepted)
        self.assertFalse(within_string_bounds(512, self.note_schema))

    def test_term_lengths_and_match_types_stay_restricted(self):
        properties = self.rule_schema['properties']
        self.assertEqual(properties['term'], {'type': 'string', 'minLength': 2, 'maxLength': 80,
                                             'pattern': r'^\S+(?:\s+\S+){0,9}$'})
        self.assertTrue(within_string_bounds('x' * 80, properties['term']))
        self.assertFalse(within_string_bounds('x' * 81, properties['term']))
        self.assertEqual(properties['matchType']['enum'], ['PHRASE', 'EXACT'])
        self.assertFalse(self.rule_schema['additionalProperties'])
        self.assertEqual(self.rule_schema['required'], ['term', 'matchType'])
        self.assertEqual(self.schema['properties']['safeNegativeRules']['maxItems'], 200)

    def test_other_note_and_term_bounds_are_unchanged(self):
        properties = self.schema['properties']
        self.assertEqual(properties['positiveKeywordCandidates']['items']['properties']['note']['maxLength'], 160)
        for name in ('safeNegativeTerms', 'watchOnlyTerms'):
            with self.subTest(field=name):
                self.assertEqual(properties[name]['items']['maxLength'], 80)


if __name__ == '__main__':
    unittest.main()
