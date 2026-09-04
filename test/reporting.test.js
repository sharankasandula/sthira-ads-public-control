const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildDailyEmail,
  buildDailyHtmlEmail,
  buildWeeklyEmail,
  buildWeeklyHtmlEmail,
  formatCallCount,
  isReportDue,
  buildSearchTermReportQuery,
  compileSafeNegativeRules,
  negativeRuleKey,
  queryMatchesRule,
  normalizeNegativeText,
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

test('daily HTML email is compact and scannable', () => {
  const html = buildDailyHtmlEmail('2026-08-23', { ok: true, count: 4 }, 192.4)
  assert.match(html, /Daily snapshot/)
  assert.match(html, /23 Aug 2026/)
  assert.match(html, /CALLS FROM ADS[\s\S]*>4</)
  assert.match(html, /SPEND[\s\S]*>₹192</)
  assert.ok(html.length < 6000)
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

test('weekly HTML email highlights score and safely lists corrections', () => {
  const html = buildWeeklyHtmlEmail(
    '2026-08-17',
    '2026-08-23',
    { ok: true, count: 9 },
    1210.8,
    { ok: true, score: 0.884 },
    0.9,
    [{ type: 'negative_added', matchType: 'PHRASE', value: '<competitor>' }],
  )
  assert.match(html, /Weekly summary/)
  assert.match(html, /OPTIMISATION[\s\S]*88\.4%/)
  assert.match(html, /Corrections made · 1/)
  assert.match(html, /&lt;competitor&gt;/)
  assert.doesNotMatch(html, /<competitor>/)
  assert.ok(html.length < 9000)
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

test('negative rules support exact-only navigation matches and phrase allow-list matches', () => {
  assert.equal(
    queryMatchesRule('google maps', { term: 'google maps', matchType: 'EXACT' }),
    true,
  )
  assert.equal(
    queryMatchesRule('open google maps', { term: 'google maps', matchType: 'EXACT' }),
    false,
  )
  assert.equal(
    queryMatchesRule('best physiotherapy equipment', { term: 'equipment', matchType: 'PHRASE' }),
    true,
  )
  assert.equal(
    queryMatchesRule('best physiotherapy equipment store', { term: 'equipment', matchType: 'PHRASE' }),
    true,
  )
})

test('legacy allow-list and explicit exact rules are merged deterministically', () => {
  const rules = compileSafeNegativeRules({
    automation: { negativeMatchType: 'PHRASE' },
    safeNegativeTerms: ['jobs', 'free'],
    safeNegativeRules: [
      { term: 'google maps', matchType: 'EXACT' },
      { term: 'google maps', matchType: 'EXACT' },
    ],
  })
  assert.deepEqual(
    rules.map((rule) => `${rule.matchType}:${rule.term}`),
    ['EXACT:google maps', 'PHRASE:jobs', 'PHRASE:free'],
  )
  assert.equal(negativeRuleKey(rules[0]), 'EXACT|google maps')
  assert.equal(normalizeNegativeText('  GOOGLE   MAPS  '), 'google maps')
})

test('search-term report query stays isolated to the configured campaign', () => {
  const query = buildSearchTermReportQuery('Whatsapp Leads -1', '20260901', '20260904')
  assert.match(query, /CampaignName = "Whatsapp Leads -1"/)
  assert.match(query, /DURING 20260901,20260904/)
  assert.doesNotMatch(query, /Sthira Search - Core/)
})


test('receiver script accepts only the current campaign', () => {
  const valid = { campaignName: 'Whatsapp Leads -1', notificationEmail: 'sharankasandula@gmail.com',
    dailyBudgetTargetInr: 180, monitoring: {}, thresholds: { maxAvgCpcInr: 60 } }
  assert.doesNotThrow(() => validateConfigForReporting(valid))
  assert.throws(() => validateConfigForReporting({ ...valid, campaignName: 'Sthira Search - Core' }), /invalid campaignName/)
})
