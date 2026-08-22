/**
 * Sthira PhysioCenter — keyword guardrails and scheduled reports v3.
 *
 * Runs hourly. Keyword corrections are silent and accumulated for the Saturday report.
 * After the configured night hour, one email is sent per day. Saturday receives one combined
 * weekly email instead of a separate daily email.
 */

var CONFIG_URL =
  'https://raw.githubusercontent.com/sharankasandula/sthira-ads-public-control/main/config/active.json'

var HARD_RAILS = {
  expectedCampaignName: 'Whatsapp Leads -1',
  maxBudgetTargetInr: 300,
  maxAvgCpcInr: 80,
  minClicksBeforePauseFloor: 3,
  maxKeywordPausesPerRun: 3,
  maxNegativeAddsPerRun: 5,
  protectedTerms: ['sthira', 'sthirra', 'jahnavi', 'jahnavi kasandula'],
}

var STATE_KEYS = {
  corrections: 'STHIRA_ADS_CORRECTIONS_V1',
  lastReportDate: 'STHIRA_ADS_LAST_REPORT_DATE_V1',
  lastConfigIssueDate: 'STHIRA_ADS_LAST_CONFIG_ISSUE_DATE_V1',
}

function main() {
  var now = new Date()
  var loaded = loadAndValidateConfig()
  if (!loaded.ok) {
    Logger.log('Guardrail config issue; no changes made: ' + loaded.error)
    maybeSendConfigIssue(loaded.error, now)
    return
  }

  var config = loaded.config
  if (!config.enabled) {
    Logger.log('Automation disabled by config')
    return
  }

  var startDate = getDateString(
    new Date(now.getTime() - config.monitoring.lookbackDays * 24 * 60 * 60 * 1000),
  )
  var endDate = getDateString(now)
  var paused = []
  var negativeAdds = []
  var observations = []

  if (
    config.automation.autoPauseHighCpcKeywords ||
    config.automation.autoAlertLowCtrKeywords
  ) {
    inspectKeywords(config, startDate, endDate, paused, observations)
  }
  if (config.automation.autoAddSafeNegativeTerms) {
    inspectSearchTermsForNegatives(config, startDate, endDate, negativeAdds, observations)
  }

  if (!config.dryRun && (paused.length || negativeAdds.length)) {
    recordCorrections(paused, negativeAdds, now)
  }

  Logger.log(
    'Guardrail run complete; paused=' +
      paused.length +
      '; negatives=' +
      negativeAdds.length +
      '; observations=' +
      observations.length +
      '; dryRun=' +
      config.dryRun,
  )

  maybeSendScheduledReport(config, now)
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

function inspectKeywords(config, startDate, endDate, paused, observations) {
  var it = AdsApp.keywords()
    .withCondition('Status = ENABLED')
    .withCondition('CampaignStatus = ENABLED')
    .withCondition('AdGroupStatus = ENABLED')
    .withCondition('CampaignName = "' + escapeAwql(config.campaignName) + '"')
    .forDateRange(compactDate(startDate), compactDate(endDate))
    .get()

  while (it.hasNext()) {
    var keyword = it.next()
    var stats = keyword.getStatsFor(compactDate(startDate), compactDate(endDate))
    var clicks = stats.getClicks()
    var impressions = stats.getImpressions()
    var cost = stats.getCost()
    var conversions = stats.getConversions()
    var avgCpc = clicks > 0 ? cost / clicks : 0
    var ctr = impressions > 0 ? clicks / impressions : 0
    var text = keyword.getText()

    if (
      config.automation.autoPauseHighCpcKeywords &&
      paused.length < HARD_RAILS.maxKeywordPausesPerRun &&
      clicks >= config.thresholds.minClicksBeforeAutoPause &&
      avgCpc > config.thresholds.maxAvgCpcInr &&
      conversions === 0 &&
      !isProtectedKeyword(text)
    ) {
      var reason =
        'CPC ₹' +
        avgCpc.toFixed(2) +
        ' > ₹' +
        config.thresholds.maxAvgCpcInr +
        ' (' +
        clicks +
        ' clicks, ₹' +
        cost.toFixed(0) +
        ', 0 conv)'
      if (!config.dryRun) keyword.pause()
      paused.push({ keyword: text, reason: reason })
      continue
    }

    if (
      config.automation.autoAlertLowCtrKeywords &&
      impressions >= config.thresholds.minImpressionsForCtrAlert &&
      ctr < config.thresholds.lowCtrThreshold
    ) {
      observations.push(
        'Low CTR: ' +
          text +
          ' ' +
          (ctr * 100).toFixed(2) +
          '% (' +
          impressions +
          ' impressions)',
      )
    }
  }
}

function inspectSearchTermsForNegatives(
  config,
  startDate,
  endDate,
  negativeAdds,
  observations,
) {
  var safeTerms = config.safeNegativeTerms || []
  if (!safeTerms.length) return

  var existing = getExistingCampaignNegatives(config.campaignName)
  var report = AdsApp.report(
    'SELECT CampaignName, Query, Impressions, Clicks, Cost, Conversions ' +
      'FROM SEARCH_QUERY_PERFORMANCE_REPORT ' +
      'WHERE CampaignStatus = ENABLED ' +
      'AND CampaignName = "' +
      escapeAwql(config.campaignName) +
      '" DURING ' +
      compactDate(startDate) +
      ',' +
      compactDate(endDate),
  )
  var rows = report.rows()
  var campaignIt = AdsApp.campaigns()
    .withCondition('Name = "' + escapeAwql(config.campaignName) + '"')
    .get()
  if (!campaignIt.hasNext()) {
    observations.push('Campaign not found for negative-keyword scan')
    return
  }
  var campaign = campaignIt.next()

  while (rows.hasNext() && negativeAdds.length < HARD_RAILS.maxNegativeAddsPerRun) {
    var row = rows.next()
    var query = String(row.Query || '').toLowerCase()
    for (var i = 0; i < safeTerms.length; i++) {
      var term = String(safeTerms[i]).toLowerCase()
      if (query.indexOf(term) >= 0 && isSafeNegativeTerm(term) && !existing[term]) {
        var negativeText =
          config.automation.negativeMatchType === 'EXACT' ? '[' + term + ']' : '"' + term + '"'
        if (!config.dryRun) campaign.createNegativeKeyword(negativeText)
        existing[term] = true
        negativeAdds.push({ term: term, matchType: config.automation.negativeMatchType })
        break
      }
    }
  }
}

function getExistingCampaignNegatives(campaignName) {
  var found = {}
  var it = AdsApp.campaigns()
    .withCondition('Name = "' + escapeAwql(campaignName) + '"')
    .get()
  if (!it.hasNext()) return found
  var negatives = it.next().negativeKeywords().get()
  while (negatives.hasNext()) {
    var text = String(negatives.next().getText())
      .toLowerCase()
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .replace(/^"/, '')
      .replace(/"$/, '')
    found[text] = true
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
  MailApp.sendEmail(
    config.notificationEmail,
    'Sthira Ads nightly — ' + date,
    buildDailyEmail(date, calls, metrics.cost),
  )
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

  MailApp.sendEmail(
    config.notificationEmail,
    'Sthira Ads weekly — ' + startDate + ' to ' + endDate,
    buildWeeklyEmail(
      startDate,
      endDate,
      calls,
      metrics.cost,
      score,
      config.reporting.optimizationScoreFloor,
      corrections,
    ),
  )
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
    buildWeeklyEmail: buildWeeklyEmail,
    formatCallCount: formatCallCount,
    isReportDue: isReportDue,
  }
}
