const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const source = fs.readFileSync('scripts/auto-pause-expensive-keywords.js', 'utf8')
const config = JSON.parse(fs.readFileSync('config/active.json'))
const { assertFreshReview, assertAccountIdentity, normalizeNegativeText, queryMatchesRule,
  isProtectedQuery, isCoveredByNegatives } = require('../scripts/auto-pause-expensive-keywords')
const iterator = values => { let index = 0; return { hasNext: () => index < values.length, next: () => values[index++] } }
function harness({ preview = false, customerId = '545-876-7317', name = 'Whatsapp Leads -1',
  failure = false, review = new Date().toISOString(), dryRun = false, terms = null, rules = null } = {}) {
  const negatives = [], writes = [], emails = [], logs = [], state = {}
  const cfg = structuredClone(config)
  cfg.safeNegativeTerms = ['jobs', 'buy']
  cfg.safeNegativeRules = [{ term: 'google maps', matchType: 'EXACT' }, { term: 'physiotherapy', matchType: 'EXACT' }].slice(0, 1)
  cfg.negativeReview.reviewedAt = review
  cfg.dryRun = dryRun
  if (rules) { cfg.safeNegativeTerms = []; cfg.safeNegativeRules = rules }
  const queries = terms || ['google maps', 'google maps', 'sthira jobs', 'knee pain jobs', 'physiotherapy jobs', 'physiotherapy near me', 'buyout physiotherapy', 'फिजियोथेरेपी google maps']
  const campaign = { getName: () => name, isEnabled: () => true,
    keywords: () => ({ withCondition: () => ({ get: () => iterator([{ getText: () => '[physiotherapy near me]' }]) }) }),
    negativeKeywords: () => ({ get: () => iterator(negatives.map(n => ({ getText: () => n.text, getMatchType: () => n.type }))) }),
    createNegativeKeyword: text => { writes.push(text); negatives.push({ text, type: text.startsWith('[') ? 'EXACT' : 'PHRASE' }) },
  }
  const props = { getProperty: k => state[k] ?? null, setProperty: (k, v) => { state[k] = v } }
  const context = vm.createContext({ Date, console, module: { exports: {} },
    Logger: { log: x => logs.push(x) },
    MailApp: { sendEmail: (...args) => emails.push(args) },
    PropertiesService: { getScriptProperties: () => props },
    Utilities: { formatDate: (date, zone, fmt) => fmt === 'H' ? '10' : fmt === 'u' ? '6' : fmt === 'yyyy-MM-dd' ? date.toISOString().slice(0, 10) : date.toISOString() },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(cfg) }) },
    AdsApp: { currentAccount: () => ({ getCustomerId: () => customerId }), getExecutionInfo: () => ({ isPreview: () => preview }),
      campaigns: () => ({ withIds: ids => { assert.deepEqual(Array.from(ids), [24073581572]); return { get: () => iterator([campaign]) } } }),
      report: query => { if (failure) throw new Error('report unavailable'); assert.match(query, /CampaignId = 24073581572/); return { rows: () => iterator(queries.map(Query => ({ Query }))) } },
    },
  })
  vm.runInContext(source, context)
  return { run: () => context.main(), negatives, writes, emails, logs, state }
}
test('live executor applies narrow rules once and second run performs no writes', () => {
  const h = harness(); h.run()
  assert.deepEqual(h.writes, ['[google maps]', '"jobs"'])
  h.run(); assert.equal(h.writes.length, 2)
  assert.equal(JSON.parse(h.state.STHIRA_ADS_CORRECTIONS_V1).length, 2)
  assert.equal(JSON.parse(h.state.STHIRA_ADS_LAST_SCAN_V4).added, 0)
})
test('preview and config dry-run never write negatives, corrections, heartbeat or email', () => {
  for (const options of [{ preview: true }, { dryRun: true }]) {
    const h = harness(options); h.run()
    assert.equal(h.writes.length, 0); assert.equal(h.emails.length, 0); assert.deepEqual(h.state, {})
    assert.ok(h.logs.some(x => /"proposed":2/.test(x)))
  }
})
test('missing or stale review and failed report freeze additions and surface one deduplicated alert', () => {
  for (const options of [{ review: '2020-01-01' }, { review: 'invalid' }, { failure: true }]) {
    const h = harness(options)
    assert.throws(() => h.run()); assert.throws(() => h.run())
    assert.equal(h.writes.length, 0); assert.equal(h.emails.length, 1)
    assert.equal(h.state.STHIRA_ADS_LAST_SCAN_V4, undefined)
  }
})
test('wrong advertiser or renamed campaign cannot mutate', () => {
  for (const options of [{ customerId: '000-000-0000' }, { name: 'Sthira Search - Core' }]) {
    const h = harness(options); assert.throws(() => h.run()); assert.equal(h.writes.length, 0)
  }
  assert.throws(() => assertAccountIdentity('0000000000'))
})
test('Unicode and clinical intent survive normalization and exact matching', () => {
  assert.equal(normalizeNegativeText(' हिंदी Google Maps '), 'हिंदी google maps')
  assert.equal(queryMatchesRule('हिंदी google maps', { term: 'google maps', matchType: 'EXACT' }), false)
  assert.equal(isProtectedQuery('knee pain equipment', config), true)
  assert.equal(queryMatchesRule('buyout physiotherapy', { term: 'buy', matchType: 'PHRASE' }), false)
})
test('existing phrase covers narrower exact but exact never covers a broader phrase', () => {
  assert.equal(isCoveredByNegatives({ term: 'physiotherapy jobs', matchType: 'EXACT' }, [{ term: 'jobs', matchType: 'PHRASE' }]), true)
  assert.equal(isCoveredByNegatives({ term: 'jobs', matchType: 'PHRASE' }, [{ term: 'jobs', matchType: 'EXACT' }]), false)
})
test('review timestamp in the future is rejected', () => {
  assert.throws(() => assertFreshReview({ negativeReview: { reviewedAt: '2099-01-01', owner: 'spandana' } }, new Date()))
})


test('at most five exclusions per run and ten per day, even across repeats', () => {
  const terms = Array.from({ length: 20 }, (_, i) => `equipment shop ${i}`)
  const h = harness({ terms, rules: terms.map(term => ({ term, matchType: 'EXACT' })) })
  h.run(); assert.equal(h.writes.length, 5)
  h.run(); assert.equal(h.writes.length, 10)
  h.run(); assert.equal(h.writes.length, 10)
})
test('enabled positive keywords and protected service terms cannot become new negatives', () => {
  const h = harness({ terms: ['physiotherapy near me', 'knee pain'], rules: [
    { term: 'physiotherapy near me', matchType: 'EXACT' }, { term: 'knee pain', matchType: 'PHRASE' },
  ] })
  h.run(); assert.equal(h.writes.length, 0)
})
