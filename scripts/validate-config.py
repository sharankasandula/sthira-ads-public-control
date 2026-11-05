#!/usr/bin/env python3
"""Validate public control data without weakening the live review proof gate."""
import datetime as dt
import json
from pathlib import Path
import re
import sys

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
FORMATS = FormatChecker()


@FORMATS.checks('date-time')
def valid_review_time(value):
    # jsonschema's optional date-time extra is absent on some cron hosts.
    # Require a timezone rather than silently accepting an unchecked timestamp.
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})', value):
        return False
    try:
        parsed = dt.datetime.fromisoformat(value.upper().replace('Z', '+00:00'))
        return parsed.tzinfo is not None
    except ValueError:
        return False


def validation_errors(config, schema):
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FORMATS)
    return sorted(validator.iter_errors(config), key=lambda error: tuple(map(str, error.path)))


def main():
    config = json.loads((ROOT / 'config/active.json').read_text())
    schema = json.loads((ROOT / 'config/schema.json').read_text())
    errors = validation_errors(config, schema)
    for error in errors:
        location = '/'.join(map(str, error.path)) or '<root>'
        # Print the field and violated bound, not potentially sensitive values.
        print(f'CONFIG INVALID: {location}: {error.validator}={error.validator_value}', file=sys.stderr)
    if errors:
        print(f'Config schema validation failed: {len(errors)} error(s)', file=sys.stderr)
        return 1
    print('Config schema validation passed (Draft 2020-12 with formats)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
