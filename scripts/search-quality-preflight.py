#!/usr/bin/env python3
"""Private live Ads snapshot for the Spandana cron; never publishes telemetry."""
import datetime as dt
import importlib.util
import json
import os
import signal
from pathlib import Path
import sys
import tempfile
from zoneinfo import ZoneInfo

PROFILE = Path('/home/irona/.hermes/profiles/spandana')
PROOF = PROFILE / 'state/sthira-ads-live-review.json'
CUSTOMER = '5458767317'
CAMPAIGN = 24073581572


def collect():
    # Clear old evidence BEFORE any auth or API work. Failure cannot leave fresh proof.
    PROOF.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    PROOF.unlink(missing_ok=True)
    os.environ['GRPC_DNS_RESOLVER'] = 'native'
    spec = importlib.util.spec_from_file_location('ads_auth', PROFILE / 'scripts/google_ads_mcp_server.py')
    auth = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auth)
    def cleanup_on_signal(signum, _frame):
        auth._cleanup()
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, cleanup_on_signal)
    signal.signal(signal.SIGINT, cleanup_on_signal)
    env = auth._build_env()
    from google.ads.googleads.client import GoogleAdsClient
    client = GoogleAdsClient.load_from_dict({
        'developer_token': env['GOOGLE_ADS_DEVELOPER_TOKEN'],
        'json_key_file_path': env['GOOGLE_APPLICATION_CREDENTIALS'],
        'login_customer_id': env['GOOGLE_ADS_LOGIN_CUSTOMER_ID'],
        'use_proto_plus': True,
    })
    service = client.get_service('GoogleAdsService')

    def rows(query):
        count = 0
        for batch in service.search_stream(customer_id=CUSTOMER, query=query, timeout=90):
            for row in batch.results:
                count += 1
                if count > 10000:
                    raise RuntimeError('Report exceeds review limit; no partial proof is permitted')
                yield row

    campaigns = list(rows(f'SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = {CAMPAIGN}'))
    if len(campaigns) != 1 or campaigns[0].campaign.name != 'Whatsapp Leads -1' or campaigns[0].campaign.status.name != 'ENABLED':
        raise RuntimeError('Campaign identity/status mismatch')
    today = dt.datetime.now(ZoneInfo('Asia/Kolkata')).date()
    start = today - dt.timedelta(days=7)
    report = []
    for r in rows(f"SELECT search_term_view.search_term, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros FROM search_term_view WHERE campaign.id = {CAMPAIGN} AND segments.date BETWEEN '{start}' AND '{today}'"):
        report.append({'query': r.search_term_view.search_term, 'date': r.segments.date,
                       'impressions': r.metrics.impressions, 'clicks': r.metrics.clicks,
                       'costInr': r.metrics.cost_micros / 1000000})
    negatives = []
    for r in rows(f"SELECT campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id = {CAMPAIGN} AND campaign_criterion.negative = TRUE AND campaign_criterion.type = 'KEYWORD'"):
        negatives.append({'term': r.campaign_criterion.keyword.text, 'matchType': r.campaign_criterion.keyword.match_type.name})
    completed = [r for r in report if r['date'] < str(today)]
    partial = [r for r in report if r['date'] == str(today)]
    proof = {'status': 'complete', 'customerId': CUSTOMER, 'campaignId': CAMPAIGN,
             'fetchedAt': dt.datetime.now(dt.timezone.utc).isoformat().replace('+00:00', 'Z'),
             'completedWindow': [str(start), str(today - dt.timedelta(days=1))],
             'currentDayPartial': str(today), 'completedRowCount': len(completed),
             'partialRowCount': len(partial), 'negativeCount': len(negatives),
             'rows': report, 'negatives': negatives}
    fd, path = tempfile.mkstemp(dir=PROOF.parent, prefix='.review-')
    with os.fdopen(fd, 'w') as f:
        json.dump(proof, f, ensure_ascii=False)
    os.replace(path, PROOF)
    print('LIVE_GOOGLE_ADS_REVIEW_COMPLETE')
    print('Private complete snapshot: ' + str(PROOF) + '. Read the complete file if injected output is truncated.')
    print(json.dumps(proof, ensure_ascii=False))
    print('Use fetchedAt EXACTLY for negativeReview.reviewedAt. Private data: never copy rows to public git or Telegram.')


if __name__ == '__main__':
    if '--collect-child' not in sys.argv:
        # Bootstrap the existing approved profile secret source using Hermes's own loader.
        PROOF.unlink(missing_ok=True)
        os.environ['HERMES_HOME'] = str(PROFILE)
        sys.path.insert(0, '/home/irona/.hermes/hermes-agent')
        from hermes_cli.env_loader import load_hermes_dotenv
        load_hermes_dotenv()
        python = PROFILE / 'runtime/google-ads-mcp-venv/bin/python3'
        os.execv(str(python), [str(python), str(Path(__file__).resolve()), '--collect-child'])
    try:
        collect()
    except Exception as error:
        PROOF.unlink(missing_ok=True)
        # Keep credential-bearing exception details out of stdout/logs.
        print('LIVE_GOOGLE_ADS_REVIEW_FAILED: ' + type(error).__name__ + '. No review proof exists; do not publish or refresh timestamps.')
        raise SystemExit(1)
