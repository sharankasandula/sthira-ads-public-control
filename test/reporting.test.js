const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildDailyEmail,
  buildWeeklyEmail,
  formatCallCount,
  isReportDue,
} = require('../scripts/auto-pause-expensive-keywords.js')
const {
  validateConfigForReporting,
} = require('../scripts/daily-performance-summary.js')

test('daily email contains only the requested call-click and spend summary', () => {
  const body = buildDailyEmail('2026-08-22', { ok: true, count: 3 }, 187.01)
  assert.match(body, /Maps call clicks from Google Ads: 3/)
  assert.match(body, /Spend: ₹187/)
  assert.doesNotMatch(body, /CTR|keyword|impressions|guardrail/i)
})

test('weekly email includes score and every correction', () => {
  const body = buildWeeklyEmail(
    '2026-08-16',
    '2026-08-22',
    { ok: true, count: 8 },
    1078.4,
    { ok: true, score: 0.973 },
    0.9,
    [
      { type: 'negative_added', matchType: 'PHRASE', value: 'free' },
      { type: 'keyword_paused', value: 'example', reason: 'high CPC' },
    ],
  )
  assert.match(body, /Maps call clicks from Google Ads: 8/)
  assert.match(body, /Spend: ₹1078/)
  assert.match(body, /Optimization score: 97.3%/)
  assert.match(body, /Corrections made: 2/)
  assert.match(body, /Added PHRASE negative: free/)
  assert.match(body, /Paused keyword: example — high CPC/)
})

test('failed call query is never reported as zero calls', () => {
  assert.equal(formatCallCount({ ok: false, count: null }), 'unavailable')
})

test('nightly report is emitted only once after the configured hour', () => {
  const props = { getProperty: () => null }
  assert.equal(isReportDue('2026-08-22', 21, 22, props), false)
  assert.equal(isReportDue('2026-08-22', 22, 22, props), true)
  assert.equal(
    isReportDue('2026-08-22', 23, 22, { getProperty: () => '2026-08-22' }),
    false,
  )
})

test('receiver script accepts only the current campaign', () => {
  const valid = {
    campaignName: 'Whatsapp Leads -1',
    notificationEmail: 'sharankasandula@gmail.com',
    dailyBudgetTargetInr: 180,
    monitoring: {},
    thresholds: { maxAvgCpcInr: 60 },
  }
  assert.doesNotThrow(() => validateConfigForReporting(valid))
  assert.throws(
    () => validateConfigForReporting({ ...valid, campaignName: 'Sthira Search - Core' }),
    /invalid campaignName/,
  )
})
