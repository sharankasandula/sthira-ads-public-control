/**
 * Sthira PhysioCenter — keyword guardrails and scheduled reports v4.
 *
 * Runs hourly. Keyword corrections are silent and accumulated for the Saturday report.
 * After the configured night hour, one email is sent per day. Saturday receives one combined
 * weekly email instead of a separate daily email.
 */

var CONFIG_URL =
  'https://raw.githubusercontent.com/sharankasandula/sthira-ads-public-control/main/config/active.json'

var HARD_RAILS = {
  expectedCampaignName: 'Whatsapp Leads -1',
  expectedCustomerId: '5458767317',
  expectedCampaignId: 24073581572,
  maxBudgetTargetInr: 300,
  maxAvgCpcInr: 80,
  minClicksBeforePauseFloor: 3,
  maxKeywordPausesPerRun: 3,
  maxNegativeAddsPerRun: 5,
  maxNegativeAddsPerDay: 10,
  protectedTerms: ['sthira', 'sthirra', 'jahnavi', 'jahnavi kasandula'],
}

var STATE_KEYS = {
  corrections: 'STHIRA_ADS_CORRECTIONS_V1',
  lastReportDate: 'STHIRA_ADS_LAST_REPORT_DATE_V1',
  lastConfigIssueDate: 'STHIRA_ADS_LAST_CONFIG_ISSUE_DATE_V1',
  lastScan: 'STHIRA_ADS_LAST_SCAN_V4',
  lastRuntimeIssueDate: 'STHIRA_ADS_LAST_RUNTIME_ISSUE_DATE_V4',
}

function main() {
  var now = new Date()
  var preview = AdsApp.getExecutionInfo().isPreview()
  try {
    assertAccountIdentity(AdsApp.currentAccount().getCustomerId())
    var loaded = loadAndValidateConfig()
    if (!loaded.ok) throw new Error(loaded.error)
    var config = loaded.config
    if (!config.enabled) {
      Logger.log('Automation disabled by config')
      return
    }
    if (config.automation.autoPauseHighCpcKeywords) {
      throw new Error('Keyword pausing is not authorized in this executor')
    }
    assertFreshReview(config, now)
    var campaign = getTargetCampaign()
    var startDate = getDateString(new Date(now.getTime() - config.monitoring.lookbackDays * 86400000))
    var endDate = getDateString(now)
    var negativeAdds = []
    var observations = []
    var scan = { scanned: 0, proposed: 0, added: 0 }
    if (config.automation.autoAddSafeNegativeTerms) {
      scan = inspectSearchTermsForNegatives(config, startDate, endDate, negativeAdds, observations, campaign, preview)
    }
    if (!config.dryRun && !preview) {
      PropertiesService.getScriptProperties().setProperty(STATE_KEYS.lastScan,
        JSON.stringify({ at: now.toISOString(), version: 4, scanned: scan.scanned, added: scan.added }))
    }
    Logger.log('STHIRA_GUARDRAIL_V4 ' + JSON.stringify({
      campaignId: HARD_RAILS.expectedCampaignId, scanned: scan.scanned,
      proposed: scan.proposed, added: scan.added, preview: preview, dryRun: config.dryRun,
      reviewedAt: config.negativeReview.reviewedAt,
    }))
    if (!preview && !config.dryRun) maybeSendScheduledReport(config, now)
  } catch (error) {
    var message = error && error.message ? error.message : String(error)
    Logger.log('STHIRA_GUARDRAIL_V4_FAILED ' + message)
    if (!preview) notifyRuntimeFailure(message, now)
    throw error
  }
}

function assertAccountIdentity(customerId) {
  if (String(customerId).replace(/-/g, '') !== HARD_RAILS.expectedCustomerId) {
    throw new Error('Unexpected advertiser account; no changes made')
  }
}

function getTargetCampaign() {
  var it = AdsApp.campaigns().withIds([HARD_RAILS.expectedCampaignId]).get()
  if (!it.hasNext()) throw new Error('Expected campaign ID missing')
  var campaign = it.next()
  if (campaign.getName() !== HARD_RAILS.expectedCampaignName || !campaign.isEnabled()) {
    throw new Error('Campaign name/status mismatch; no changes made')
  }
  return campaign
}

function assertFreshReview(config, now) {
  var review = config.negativeReview || {}
  var reviewedAt = Date.parse(review.reviewedAt)
  var age = now.getTime() - reviewedAt
  if (review.owner !== 'spandana' || !isFinite(reviewedAt) || age < -300000 || age > 72 * 3600000) {
    throw new Error('Spandana search-quality review missing/stale (72h); negative additions frozen')
  }
}

function notifyRuntimeFailure(message, now) {
  var props = PropertiesService.getScriptProperties()
  var date = getDateString(now)
  if (props.getProperty(STATE_KEYS.lastRuntimeIssueDate) === date) return
  MailApp.sendEmail('sharankasandula@gmail.com', 'Sthira Ads automation needs attention',
    'Hourly negative-keyword automation failed. No further changes will be made in this run. ' +
    'Previously saved exclusions remain active.\n\n' + message)
  props.setProperty(STATE_KEYS.lastRuntimeIssueDate, date)
}

function loadAndValidateConfig() {
  try {
    var response = UrlFetchApp.fetch(CONFIG_URL, { muteHttpExceptions: true })
    if (response.getResponseCode() !== 200) {
      throw new Error('config HTTP ' + response.getResponseCode())
    }
    var c = JSON.parse(response.getContentText())
    if (c.campaignName !== HARD_RAILS.expectedCampaignName) {
      throw new Error('unexpected campaignName')
    }
    if (c.dailyBudgetTargetInr > HARD_RAILS.maxBudgetTargetInr) {
      throw new Error('budget target exceeds hard rail')
    }
    if (c.thresholds.maxAvgCpcInr > HARD_RAILS.maxAvgCpcInr) {
      throw new Error('CPC threshold exceeds hard rail')
    }
    if (c.thresholds.minClicksBeforeAutoPause < HARD_RAILS.minClicksBeforePauseFloor) {
      throw new Error('min clicks below hard rail')
    }
    if (c.monitoring.lookbackDays < 1 || c.monitoring.lookbackDays > 30) {
      throw new Error('lookbackDays out of range')
    }
    if (['PHRASE', 'EXACT'].indexOf(c.automation.negativeMatchType) < 0) {
      throw new Error('negativeMatchType must be PHRASE or EXACT')
    }
    if (!c.reporting || c.reporting.callConversionActionName !== 'Clicks to call') {
      throw new Error('invalid reporting config')
    }
    return { ok: true, config: c }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

function inspectSearchTermsForNegatives(config, startDate, endDate, negativeAdds, observations, campaign, preview) {
  campaign = campaign || getTargetCampaign()
  var rules = compileSafeNegativeRules(config)
  var existing = getExistingCampaignNegatives(config.campaignName)
  var protectedQueries = (config.watchOnlyTerms || []).concat(HARD_RAILS.protectedTerms)
  var positives = campaign.keywords().withCondition('Status = ENABLED').get()
  while (positives.hasNext()) protectedQueries.push(stripMatchSyntax(positives.next().getText()))
  rules = rules.filter(function(rule) {
    return !protectedQueries.some(function(text) { return queryMatchesRule(text, rule) })
  })
  var rows = AdsApp.report(buildSearchTermReportQuery(config.campaignName, startDate, endDate)).rows()
  var scan = { scanned: 0, proposed: 0, added: 0 }
  var today = getDateString(new Date())
  var addedToday = readCorrections(PropertiesService.getScriptProperties()).filter(function(item) {
    return item.type === 'negative_added' && item.at && item.at.slice(0, 10) === today
  }).length
  var runLimit = Math.min(HARD_RAILS.maxNegativeAddsPerRun, Math.max(0, HARD_RAILS.maxNegativeAddsPerDay - addedToday))
  while (rows.hasNext()) {
    var row = rows.next()
    scan.scanned++
    var query = normalizeNegativeText(row.Query || '')
    if (!query || isProtectedQuery(query, config)) continue
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i]
      if (isCoveredByNegatives(rule, existing) || !queryMatchesRule(query, rule)) continue
      if (scan.proposed >= runLimit) break
      scan.proposed++
      if (!config.dryRun && !preview) {
        campaign.createNegativeKeyword(buildNegativeText(rule))
        var readback = getExistingCampaignNegatives(config.campaignName)
        if (!isCoveredByNegatives(rule, readback)) throw new Error('Negative addition could not be verified')
        scan.added++
        recordCorrections([], [{ term: rule.term, matchType: rule.matchType }], new Date())
      }
      existing.push(rule)
      negativeAdds.push({ term: rule.term, matchType: rule.matchType })
      break
    }
  }
  return scan
}

function isProtectedQuery(query, config) {
  if (isProtectedKeyword(query)) return true
  return (config.watchOnlyTerms || []).some(function(term) {
    return queryMatchesRule(query, { term: term, matchType: 'PHRASE' })
  })
}

function isCoveredByNegatives(rule, negatives) {
  return negatives.some(function(existing) {
    if (existing.matchType === 'BROAD') {
      return normalizeNegativeText(existing.term).split(' ').every(function(word) {
        return (' ' + rule.term + ' ').indexOf(' ' + word + ' ') >= 0
      })
    }
    if (existing.matchType === 'EXACT') return negativeRuleKey(rule) === negativeRuleKey(existing)
    return queryMatchesRule(rule.term, existing)
  })
}

function buildSearchTermReportQuery(campaignName, startDate, endDate) {
  return (
    'SELECT CampaignName, Query, Impressions, Clicks, Cost, Conversions ' +
    'FROM SEARCH_QUERY_PERFORMANCE_REPORT ' +
    'WHERE CampaignStatus = ENABLED ' +
    'AND CampaignId = ' + HARD_RAILS.expectedCampaignId + ' ' +
    'AND CampaignName = "' +
    escapeAwql(campaignName) +
    '" DURING ' +
    compactDate(startDate) +
    ',' +
    compactDate(endDate)
  )
}

function compileSafeNegativeRules(config) {
  var rules = []
  var seen = {}

  function addRule(term, matchType, source) {
    var normalized = normalizeNegativeRule({ term: term, matchType: matchType, source: source })
    if (!normalized) return
    var key = negativeRuleKey(normalized)
    if (seen[key]) return
    seen[key] = true
    rules.push(normalized)
  }

  var explicit = config.safeNegativeRules || []
  for (var i = 0; i < explicit.length; i++) {
    addRule(explicit[i].term, explicit[i].matchType, 'explicit')
  }

  var legacyTerms = config.safeNegativeTerms || []
  var legacyMatchType = config.automation && config.automation.negativeMatchType
  if (['PHRASE', 'EXACT'].indexOf(legacyMatchType) < 0) legacyMatchType = 'PHRASE'
  for (var j = 0; j < legacyTerms.length; j++) {
    addRule(legacyTerms[j], legacyMatchType, 'legacy')
  }

  return rules
}

function normalizeNegativeRule(rule) {
  if (!rule) return null
  var term = normalizeNegativeText(rule.term || '')
  if (!term) return null
  if (!isSafeNegativeTerm(term)) return null
  var matchType = String(rule.matchType || 'PHRASE').toUpperCase()
  if (['PHRASE', 'EXACT'].indexOf(matchType) < 0) return null
  if (/[\[\]\"<>]/.test(term)) throw new Error('Negative rule must contain plain keyword text')
  if (['physiotherapy', 'physiotherapist', 'hospital', 'clinic', 'rehab', 'rehabilitation', 'pain', 'near me', 'home visit'].indexOf(term) >= 0) throw new Error('Generic clinical negative is prohibited')
  return { term: term, matchType: matchType, source: rule.source || 'legacy' }
}

function queryMatchesRule(query, rule) {
  var haystack = ' ' + normalizeNegativeText(query) + ' '
  var needle = ' ' + normalizeNegativeText(rule.term) + ' '
  if (rule.matchType === 'EXACT') return haystack === needle
  return haystack.indexOf(needle) >= 0
}

function buildNegativeText(rule) {
  return rule.matchType === 'EXACT' ? '[' + rule.term + ']' : '"' + rule.term + '"'
}

function normalizeNegativeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
}

function negativeRuleKey(rule) {
  return String(rule.matchType || 'PHRASE').toUpperCase() + '|' + normalizeNegativeText(rule.term)
}

function isSafeNegativeRule(rule) {
  return rule && isSafeNegativeTerm(rule.term)
}

function stripMatchSyntax(text) {
  return String(text).replace(/^\[/, '').replace(/\]$/, '').replace(/^"/, '').replace(/"$/, '')
}

function getExistingCampaignNegatives(campaignName) {
  if (campaignName !== HARD_RAILS.expectedCampaignName) throw new Error('Unexpected campaign name')
  var found = []
  var negatives = getTargetCampaign().negativeKeywords().get()
  while (negatives.hasNext()) {
    var keyword = negatives.next()
    found.push({ term: normalizeNegativeText(stripMatchSyntax(keyword.getText())), matchType: keyword.getMatchType() })
  }
  return found
}

function recordCorrections(paused, negatives, now) {
  var props = PropertiesService.getScriptProperties()
  var corrections = readCorrections(props)
  var at = Utilities.formatDate(now, 'Asia/Calcutta', "yyyy-MM-dd'T'HH:mm:ssXXX")

  paused.forEach(function (item) {
    corrections.push({ at: at, type: 'keyword_paused', value: item.keyword, reason: item.reason })
  })
  negatives.forEach(function (item) {
    corrections.push({
      at: at,
      type: 'negative_added',
      value: item.term,
      matchType: item.matchType,
    })
  })

  var cutoff = getDateString(new Date(now.getTime() - 35 * 24 * 60 * 60 * 1000))
  corrections = corrections.filter(function (item) {
    return item.at && item.at.slice(0, 10) >= cutoff
  })
  if (corrections.length > 300) corrections = corrections.slice(corrections.length - 300)
  props.setProperty(STATE_KEYS.corrections, JSON.stringify(corrections))
}

function readCorrections(props) {
  try {
    var parsed = JSON.parse(props.getProperty(STATE_KEYS.corrections) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    Logger.log('Correction history was unreadable and has been reset')
    return []
  }
}

function maybeSendScheduledReport(config, now) {
  var props = PropertiesService.getScriptProperties()
  var date = getDateString(now)
  var hour = Number(Utilities.formatDate(now, 'Asia/Calcutta', 'H'))
  var isoDay = Number(Utilities.formatDate(now, 'Asia/Calcutta', 'u'))
  if (!isReportDue(date, hour, config.reporting.dailyEmailHourIst, props)) return

  if (isoDay === config.reporting.weeklyEmailDayIso) {
    sendWeeklyReport(config, now, props)
  } else {
    sendDailyReport(config, date)
  }
  props.setProperty(STATE_KEYS.lastReportDate, date)
}

function isReportDue(date, hour, reportHour, props) {
  return hour >= reportHour && props.getProperty(STATE_KEYS.lastReportDate) !== date
}

function sendDailyReport(config, date) {
  var metrics = getCampaignSpend(config.campaignName, date, date)
  var calls = getMapsCallClicks(
    config.campaignName,
    config.reporting.callConversionActionName,
    date,
    date,
  )
  MailApp.sendEmail({
    to: config.notificationEmail,
    subject: 'Sthira Ads nightly — ' + date,
    body: buildDailyEmail(date, calls, metrics.cost),
    htmlBody: buildDailyHtmlEmail(date, calls, metrics.cost),
  })
  Logger.log('Nightly report emailed for ' + date)
}

function sendWeeklyReport(config, now, props) {
  var endDate = getDateString(now)
  var startDate = getDateString(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000))
  var metrics = getCampaignSpend(config.campaignName, startDate, endDate)
  var calls = getMapsCallClicks(
    config.campaignName,
    config.reporting.callConversionActionName,
    startDate,
    endDate,
  )
  var score = getOptimizationScore(config.campaignName)
  var corrections = readCorrections(props).filter(function (item) {
    var date = item.at ? item.at.slice(0, 10) : ''
    return date >= startDate && date <= endDate
  })

  MailApp.sendEmail({
    to: config.notificationEmail,
    subject: 'Sthira Ads weekly — ' + startDate + ' to ' + endDate,
    body: buildWeeklyEmail(
      startDate,
      endDate,
      calls,
      metrics.cost,
      score,
      config.reporting.optimizationScoreFloor,
      corrections,
    ),
    htmlBody: buildWeeklyHtmlEmail(
      startDate,
      endDate,
      calls,
      metrics.cost,
      score,
      config.reporting.optimizationScoreFloor,
      corrections,
    ),
  })
  Logger.log('Weekly report emailed for ' + startDate + ' to ' + endDate)
}

function getCampaignSpend(campaignName, startDate, endDate) {
  var cost = 0
  var report = AdsApp.report(
    'SELECT CampaignName, Cost FROM CAMPAIGN_PERFORMANCE_REPORT ' +
      'WHERE CampaignStatus = ENABLED ' +
      'AND CampaignName = "' +
      escapeAwql(campaignName) +
      '" DURING ' +
      compactDate(startDate) +
      ',' +
      compactDate(endDate),
  )
  var rows = report.rows()
  while (rows.hasNext()) cost += parseAdsNumber(rows.next().Cost)
  return { cost: cost }
}

function getMapsCallClicks(campaignName, conversionActionName, startDate, endDate) {
  try {
    var query = [
      'SELECT segments.conversion_action_name, metrics.all_conversions',
      'FROM campaign',
      "WHERE campaign.name = '" + escapeGaqlString(campaignName) + "'",
      "AND segments.date BETWEEN '" + startDate + "' AND '" + endDate + "'",
    ].join(' ')
    var rows = AdsApp.search(query)
    var count = 0
    while (rows.hasNext()) {
      var row = rows.next()
      var name = row.segments ? row.segments.conversionActionName : ''
      if (String(name || '').toLowerCase() === conversionActionName.toLowerCase()) {
        count += parseAdsNumber(row.metrics ? row.metrics.allConversions : 0)
      }
    }
    return { ok: true, count: count }
  } catch (e) {
    Logger.log('Clicks to call query failed: ' + (e && e.message ? e.message : e))
    return { ok: false, count: null }
  }
}

function getOptimizationScore(campaignName) {
  try {
    var query =
      'SELECT campaign.optimization_score FROM campaign ' +
      "WHERE campaign.name = '" +
      escapeGaqlString(campaignName) +
      "' LIMIT 1"
    var rows = AdsApp.search(query)
    if (!rows.hasNext()) return { ok: false, score: null }
    var row = rows.next()
    var value = row.campaign ? row.campaign.optimizationScore : null
    return value === null || value === undefined
      ? { ok: false, score: null }
      : { ok: true, score: Number(value) }
  } catch (e) {
    Logger.log('Optimization score query failed: ' + (e && e.message ? e.message : e))
    return { ok: false, score: null }
  }
}

function buildDailyEmail(date, calls, spend) {
  return [
    'Sthira Google Ads — ' + date,
    'Maps call clicks from Google Ads: ' + formatCallCount(calls),
    'Spend: ₹' + Number(spend || 0).toFixed(0),
    '',
    'Call clicks are ad-attributed Maps call-button clicks, not confirmed answered calls.',
  ].join('\n')
}

function buildWeeklyEmail(startDate, endDate, calls, spend, score, scoreFloor, corrections) {
  var scoreText = 'unavailable'
  if (score && score.ok) {
    scoreText = (score.score * 100).toFixed(1) + '%'
    if (score.score < scoreFloor) scoreText += ' — below 90% floor'
  }
  var lines = [
    'Sthira Google Ads — week ' + startDate + ' to ' + endDate,
    'Maps call clicks from Google Ads: ' + formatCallCount(calls),
    'Spend: ₹' + Number(spend || 0).toFixed(0),
    'Optimization score: ' + scoreText,
    '',
    'Corrections made: ' + corrections.length,
  ]
  if (!corrections.length) {
    lines.push('• None')
  } else {
    corrections.forEach(function (item) {
      if (item.type === 'negative_added') {
        lines.push('• Added ' + (item.matchType || 'PHRASE') + ' negative: ' + item.value)
      } else if (item.type === 'keyword_paused') {
        lines.push('• Paused keyword: ' + item.value + (item.reason ? ' — ' + item.reason : ''))
      }
    })
  }
  lines.push('', 'Call clicks are ad-attributed Maps call-button clicks, not confirmed answered calls.')
  return lines.join('\n')
}

function buildDailyHtmlEmail(date, calls, spend) {
  return buildEmailShell(
    'Daily snapshot',
    formatHumanDate(date),
    buildMetricsTable([
      { label: 'CALLS FROM ADS', value: formatCallCount(calls), colour: '#0f766e' },
      { label: 'SPEND', value: '₹' + Number(spend || 0).toFixed(0), colour: '#1f2937' },
    ]),
    '<div style="margin-top:18px;color:#6b7280;font-size:12px;line-height:18px">' +
      'Calls are Ads-attributed Google Maps call-button clicks, not confirmed answered calls.' +
      '</div>',
  )
}

function buildWeeklyHtmlEmail(startDate, endDate, calls, spend, score, scoreFloor, corrections) {
  var scoreText = 'Unavailable'
  var scoreColour = '#6b7280'
  if (score && score.ok) {
    scoreText = (score.score * 100).toFixed(1) + '%'
    scoreColour = score.score < scoreFloor ? '#b91c1c' : '#0f766e'
  }

  var correctionItems = ''
  for (var i = 0; i < corrections.length; i++) {
    var item = corrections[i]
    var text = ''
    if (item.type === 'negative_added') {
      text = 'Added ' + (item.matchType || 'PHRASE') + ' negative: ' + item.value
    } else if (item.type === 'keyword_paused') {
      text = 'Paused keyword: ' + item.value + (item.reason ? ' — ' + item.reason : '')
    }
    if (text) {
      correctionItems +=
        '<li style="margin:0 0 8px;color:#374151;font-size:13px;line-height:19px">' +
        escapeHtml(text) +
        '</li>'
    }
  }

  var correctionBody = corrections.length
    ? '<ol style="margin:10px 0 0;padding-left:20px">' + correctionItems + '</ol>'
    : '<div style="margin-top:8px;color:#6b7280;font-size:13px">No corrections were needed.</div>'

  var details =
    '<div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:10px">' +
    '<div style="color:#111827;font-size:14px;font-weight:700">Corrections made · ' +
    corrections.length +
    '</div>' +
    correctionBody +
    '</div>' +
    '<div style="margin-top:16px;color:#6b7280;font-size:12px;line-height:18px">' +
    'Calls are Ads-attributed Google Maps call-button clicks, not confirmed answered calls.' +
    '</div>'

  return buildEmailShell(
    'Weekly summary',
    formatHumanDate(startDate) + ' – ' + formatHumanDate(endDate),
    buildMetricsTable([
      { label: 'CALLS FROM ADS', value: formatCallCount(calls), colour: '#0f766e' },
      { label: 'SPEND', value: '₹' + Number(spend || 0).toFixed(0), colour: '#1f2937' },
      { label: 'OPTIMISATION', value: scoreText, colour: scoreColour },
    ]),
    details,
  )
}

function buildEmailShell(title, period, metrics, details) {
  return (
    '<div style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px">' +
    '<div style="color:#0f766e;font-size:11px;font-weight:700;letter-spacing:1.2px">STHIRA ADS</div>' +
    '<div style="margin-top:6px;color:#111827;font-size:22px;font-weight:700;line-height:28px">' +
    escapeHtml(title) +
    '</div>' +
    '<div style="margin-top:3px;color:#6b7280;font-size:13px">' +
    escapeHtml(period) +
    '</div>' +
    metrics +
    details +
    '</div></div>'
  )
}

function buildMetricsTable(metrics) {
  var cells = ''
  for (var i = 0; i < metrics.length; i++) {
    if (i) cells += '<td style="width:8px"></td>'
    cells +=
      '<td style="padding:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;vertical-align:top">' +
      '<div style="color:#6b7280;font-size:10px;font-weight:700;letter-spacing:.5px">' +
      escapeHtml(metrics[i].label) +
      '</div>' +
      '<div style="margin-top:6px;color:' +
      metrics[i].colour +
      ';font-size:24px;font-weight:700;line-height:28px">' +
      escapeHtml(metrics[i].value) +
      '</div></td>'
  }
  return (
    '<table role="presentation" style="width:100%;margin-top:20px;border-collapse:separate;border-spacing:0"><tr>' +
    cells +
    '</tr></table>'
  )
}

function formatHumanDate(value) {
  var parts = String(value).split('-')
  if (parts.length !== 3) return String(value)
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  var month = months[Number(parts[1]) - 1]
  return month ? Number(parts[2]) + ' ' + month + ' ' + parts[0] : String(value)
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatCallCount(result) {
  if (!result || !result.ok) return 'unavailable'
  var count = Number(result.count || 0)
  return Math.abs(count - Math.round(count)) < 0.001 ? String(Math.round(count)) : count.toFixed(1)
}

function maybeSendConfigIssue(error, now) {
  var date = getDateString(now)
  var hour = Number(Utilities.formatDate(now, 'Asia/Calcutta', 'H'))
  if (hour < 22) return
  var props = PropertiesService.getScriptProperties()
  if (props.getProperty(STATE_KEYS.lastConfigIssueDate) === date) return
  MailApp.sendEmail(
    'sharankasandula@gmail.com',
    'Sthira Ads nightly — config issue',
    'Keyword automation was frozen; no changes were made.\n\n' + error,
  )
  props.setProperty(STATE_KEYS.lastConfigIssueDate, date)
}

function isProtectedKeyword(text) {
  var value = String(text).toLowerCase()
  for (var i = 0; i < HARD_RAILS.protectedTerms.length; i++) {
    if (value.indexOf(HARD_RAILS.protectedTerms[i]) >= 0) return true
  }
  return false
}

function isSafeNegativeTerm(term) {
  return term && term.length >= 2 && term.length <= 80 && !isProtectedKeyword(term)
}

function parseAdsNumber(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  var cleaned = String(value).replace(/₹/g, '').replace(/,/g, '').replace(/%/g, '').trim()
  var number = parseFloat(cleaned)
  return isFinite(number) ? number : 0
}

function getDateString(date) {
  return Utilities.formatDate(date, 'Asia/Calcutta', 'yyyy-MM-dd')
}

function compactDate(value) {
  return value.replace(/-/g, '')
}

function escapeAwql(value) {
  return String(value).replace(/"/g, '\\"')
}

function escapeGaqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildDailyEmail: buildDailyEmail,
    buildDailyHtmlEmail: buildDailyHtmlEmail,
    buildWeeklyEmail: buildWeeklyEmail,
    buildWeeklyHtmlEmail: buildWeeklyHtmlEmail,
    formatCallCount: formatCallCount,
    isReportDue: isReportDue,
    buildSearchTermReportQuery: buildSearchTermReportQuery,
    compileSafeNegativeRules: compileSafeNegativeRules,
    normalizeNegativeText: normalizeNegativeText,
    negativeRuleKey: negativeRuleKey,
    queryMatchesRule: queryMatchesRule,
    buildNegativeText: buildNegativeText,
    normalizeNegativeRule: normalizeNegativeRule,
    main: main,
    assertFreshReview: assertFreshReview,
    assertAccountIdentity: assertAccountIdentity,
    isProtectedQuery: isProtectedQuery,
    isCoveredByNegatives: isCoveredByNegatives,
  }
}
