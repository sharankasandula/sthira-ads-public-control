#!/usr/bin/env python3
"""Spandana pre-commit gate: a timestamp must come from a complete live snapshot."""
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys

PROOF = Path('/home/irona/.hermes/profiles/spandana/state/sthira-ads-live-review.json')


def validate(old, new, proof, now):
    if old == new:
        return
    if proof.get('status') != 'complete' or proof.get('customerId') != '5458767317' or proof.get('campaignId') != 24073581572:
        raise ValueError('Missing complete live campaign proof')
    fetched = dt.datetime.fromisoformat(proof['fetchedAt'].replace('Z', '+00:00'))
    if not 0 <= (now - fetched).total_seconds() <= 3600:
        raise ValueError('Live review proof is stale or future-dated')
    if new.get('negativeReview') != {'owner': 'spandana', 'reviewedAt': proof['fetchedAt']}:
        raise ValueError('Review timestamp must equal the successful live fetch timestamp')
    permitted = {'safeNegativeRules', 'watchOnlyTerms', 'negativeReview'}
    if any(old.get(k) != new.get(k) for k in (old.keys() | new.keys()) - permitted):
        raise ValueError('Config change exceeds search-quality scope')
    prior = {(r['term'], r['matchType']) for r in old.get('safeNegativeRules', [])}
    current = {(r['term'], r['matchType']) for r in new.get('safeNegativeRules', [])}
    if not prior.issubset(current) or not set(old.get('watchOnlyTerms', [])).issubset(new.get('watchOnlyTerms', [])):
        raise ValueError('Recurring publication may not remove existing rules or protections')
    queries = {' '.join(r['query'].lower().split()) for r in proof['rows']}
    protected = new.get('watchOnlyTerms', []) + ['sthira', 'sthirra', 'jahnavi', 'bone setting']
    for rule in new.get('safeNegativeRules', []):
        if (rule['term'], rule['matchType']) in prior:
            continue
        term = ' '.join(rule['term'].lower().split())
        if any(' ' + w.lower() + ' ' in ' ' + term + ' ' for w in protected):
            raise ValueError('New rule conflicts with a protected term')
        if rule['matchType'] == 'EXACT':
            seen = term in queries
        elif rule['matchType'] == 'PHRASE':
            seen = any(' ' + term + ' ' in ' ' + q + ' ' for q in queries)
        else:
            raise ValueError('Only EXACT or PHRASE rules are permitted')
        if not seen or len(rule.get('note', '').strip()) < 20:
            raise ValueError('New rule needs observed query evidence and a specific rationale')


if __name__ == '__main__':
    try:
        def git_json(ref):
            return json.loads(subprocess.check_output(['git', 'show', ref], text=True))
        old, new = git_json('HEAD:config/active.json'), git_json(':config/active.json')
        if old != new:
            validate(old, new, json.loads(PROOF.read_text()), dt.datetime.now(dt.timezone.utc))
        print('Live review commit gate passed')
    except Exception as error:
        print('REVIEW COMMIT BLOCKED: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
