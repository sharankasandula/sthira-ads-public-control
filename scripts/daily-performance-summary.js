/**
 * Sthira PhysioCenter — private receiver feed v3.
 *
 * Runs once each morning. It posts structured Ads data to the private receiver and never emails.
 * Keep the receiver token only in the live Google Ads copy of this script.
 */

var CONFIG_URL =
  'https://raw.githubusercontent.com/sharankasandula/sthira-ads-public-control/main/config/active.json'
var REPORT_ENDPOINT_URL = 'https://host.sharan.cc/sthira-ads/api/sthira-ads/report'
var REPORT_RECEIVER_TOKEN = 'PASTE_STHIRA_ADS_REPORT_TOKEN_HERE'

var LOCAL_DEFAULTS = {
  notificationEmail: 'sharankasandula@gmail.com',
  campaignName: 'Whatsapp Leads -1',
  dailyBudgetTargetInr: 180,
  monitoring: {
    lookbackDays: 7,
    dailySummaryTopRows: 10,
    includeSearchTerms: true,
    includeKeywords: true,
  },
  thresholds: {
    maxAvgCpcInr: 60,
    lowCtrThreshold: 0.01,
    minImpressionsForCtrAlert: 100,
    costPerLeadAlertInr: 500,
    dailySpendAlertMultiplier: 1.5,
  },
}

function main() {
  var configResult = loadConfigForReporting()
  var config = configResult.config
  var today = new Date()
  var reportDate = getDateString(new Date(today.getTime() - 24 * 60 * 60 * 1000))
  var sevenDaysAgo = getDateString(new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000))
  var thirtyDaysAgo = getDateString(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000))
  var callDetails = getGoogleAdsCallDetailsSafe(config, sevenDaysAgo, reportDate, 25)

  var report = {
    version: 1,
    reportDate: reportDate,
    generatedAt: Utilities.formatDate(new Date(), 'Asia/Calcutta', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    campaignName: config.campaignName,
    currency: 'INR',
    campaign: getCampaignMetrics(config, reportDate, reportDate),
    windows: {
      sevenDay: getCampaignMetrics(config, sevenDaysAgo, reportDate),
      thirtyDay: getCampaignMetrics(config, thirtyDaysAgo, reportDate),
    },
    topSearchTerms: [],
    topKeywords: [],
    callDetailsProbe: callDetails,
    actionsTaken: [],
    recommendations: [],
  }

  var postResult = postReportJson(report)
  Logger.log(
    'Receiver-only report complete; configIssues=' +
      configResult.issues.length +
      '; callRows=' +
      callDetails.rowCount +
      '; postOk=' +
      postResult.ok +
      (postResult.error ? '; error=' + postResult.error : ''),
  )
}

function loadConfigForReporting() {
  var issues = []
  var config = JSON.parse(JSON.stringify(LOCAL_DEFAULTS))
  try {
    var response = UrlFetchApp.fetch(CONFIG_URL, { muteHttpExceptions: true })
    if (response.getResponseCode() !== 200) {
      throw new Error('config HTTP ' + response.getResponseCode())
    }
    var remote = JSON.parse(response.getContentText())
    validateConfigForReporting(remote)
    config = remote
  } catch (e) {
    issues.push('Remote config failed; used local reporting defaults: ' + e.message)
  }
  return { config: config, issues: issues }
}

function validateConfigForReporting(config) {
  if (!config || config.campaignName !== 'Whatsapp Leads -1') {
    throw new Error('invalid campaignName')
  }
  if (!config.notificationEmail || !config.monitoring || !config.thresholds) {
    throw new Error('missing required config sections')
  }
  if (config.dailyBudgetTargetInr > 300) throw new Error('dailyBudgetTargetInr exceeds hard rail')
  if (config.thresholds.maxAvgCpcInr > 80) throw new Error('maxAvgCpcInr exceeds hard rail')
}

function getCampaignMetrics(config, startDate, endDate) {
  var metrics = {
    impressions: 0,
    clicks: 0,
    cost: 0,
    conversions: 0,
    avgCpc: 0,
    ctr: 0,
    costPerConversion: 0,
  }
  var report = AdsApp.report(
    'SELECT CampaignName, Impressions, Clicks, Cost, Conversions ' +
      'FROM CAMPAIGN_PERFORMANCE_REPORT WHERE CampaignStatus = ENABLED ' +
      'AND CampaignName = "' +
      escapeAwql(config.campaignName) +
      '" DURING ' +
      compactDate(startDate) +
      ',' +
      compactDate(endDate),
  )
  var rows = report.rows()
  while (rows.hasNext()) {
    var row = rows.next()
    metrics.impressions += parseWholeNumber(row.Impressions)
    metrics.clicks += parseWholeNumber(row.Clicks)
    metrics.cost += parseAdsNumber(row.Cost)
    metrics.conversions += parseAdsNumber(row.Conversions)
  }
  metrics.avgCpc = metrics.clicks ? metrics.cost / metrics.clicks : 0
  metrics.ctr = metrics.impressions ? metrics.clicks / metrics.impressions : 0
  metrics.costPerConversion = metrics.conversions ? metrics.cost / metrics.conversions : 0
  return metrics
}

function getGoogleAdsCallDetailsSafe(config, startDate, endDate, limit) {
  try {
    var rows = getGoogleAdsCallDetails(config, startDate, endDate, limit)
    return {
      ok: true,
      window: { startDate: startDate, endDate: endDate },
      rowCount: rows.length,
      rows: rows,
    }
  } catch (e) {
    return {
      ok: false,
      window: { startDate: startDate, endDate: endDate },
      rowCount: 0,
      error: e && e.message ? e.message : String(e),
      rows: [],
    }
  }
}

function getGoogleAdsCallDetails(config, startDate, endDate, limit) {
  var safeLimit = Math.max(1, Math.min(100, limit || 25))
  var query = [
    'SELECT call_view.resource_name, call_view.start_call_date_time,',
    'call_view.end_call_date_time, call_view.call_duration_seconds,',
    'call_view.call_status, call_view.call_tracking_display_location,',
    'call_view.caller_area_code, call_view.caller_country_code, call_view.type, campaign.name',
    'FROM call_view',
    "WHERE campaign.name = '" + escapeGaqlString(config.campaignName) + "'",
    "AND call_view.start_call_date_time >= '" + startDate + " 00:00:00'",
    "AND call_view.start_call_date_time <= '" + endDate + " 23:59:59'",
    'ORDER BY call_view.start_call_date_time DESC LIMIT ' + safeLimit,
  ].join(' ')
  var search = AdsApp.search(query)
  var rows = []
  while (search.hasNext()) {
    var row = search.next()
    var callView = row.callView || {}
    rows.push({
      googleCallId: callView.resourceName || '',
      startCallDateTime: callView.startCallDateTime || '',
      endCallDateTime: callView.endCallDateTime || '',
      durationSeconds: parseWholeNumber(callView.callDurationSeconds),
      status: callView.callStatus || '',
      displayLocation: callView.callTrackingDisplayLocation || '',
      callerAreaCode: callView.callerAreaCode || '',
      callerCountryCode: callView.callerCountryCode || '',
      type: callView.type || '',
      campaignName: row.campaign ? row.campaign.name || '' : '',
    })
  }
  return rows
}

function postReportJson(report) {
  var token = String(REPORT_RECEIVER_TOKEN || '').trim()
  if (!token || token.indexOf('PASTE_') === 0) {
    return { ok: false, error: 'receiver token missing' }
  }
  try {
    var response = UrlFetchApp.fetch(REPORT_ENDPOINT_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Sthira-Ads-Token': token },
      payload: JSON.stringify(report),
      muteHttpExceptions: true,
      followRedirects: false,
    })
    var code = response.getResponseCode()
    return code >= 200 && code < 300
      ? { ok: true }
      : { ok: false, error: 'HTTP ' + code + ' from report receiver' }
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}

function parseWholeNumber(value) {
  return Math.round(parseAdsNumber(value))
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
  module.exports = { validateConfigForReporting: validateConfigForReporting }
}
