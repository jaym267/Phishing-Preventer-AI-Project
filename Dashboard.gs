/**
 * Dashboard.gs — the maintainer web app.
 *
 * Serves Dashboard.html via HtmlService and exposes a small, auditable API to
 * it. Three Apps Script facts shape everything in this file:
 *
 *  1. `google.script.run.someFunction()` in the page can call ONLY functions
 *     whose names do not end in an underscore. So the public surface of the
 *     dashboard is exactly the `ui_*` functions below — one grep audits it.
 *  2. Arguments and return values must be JSON-serializable. Date objects do
 *     not survive the trip reliably, so every timestamp becomes an ISO string
 *     here, on the server.
 *  3. Deployment policy is pinned in appsscript.json: execute as the deploying
 *     user, access "only myself". Google's login is the auth. Nobody but the
 *     account owner can load the page or call these functions.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO DO. It never reads the API key, never
 * touches PropertiesService, never changes CONFIG.ENFORCE and never clears the
 * kill switch. Those stay deliberate editor/code actions (hard rule 2). A test
 * asserts these absences by grepping this file.
 *
 * Every `ui_*` returns {ok, data} or {ok, error} rather than throwing, so the
 * page can show a message instead of a spinner forever.
 */

/** Longest lookback the page may ask for, in days. */
var UI_MAX_DAYS = 90;

/** Most Decisions rows returned per call. */
var UI_MAX_ROWS = 1000;

/** The only values the Review column may be set to from the page. */
var UI_REVIEW_VALUES = ['', 'WRONG', 'OK'];

/**
 * Web-app entry point.
 * @param {Object} e
 * @return {HtmlOutput}
 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('ScamShield Mail')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DENY)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------------------
// Result + validation helpers
// ---------------------------------------------------------------------------

function uiOk_(data) { return { ok: true, data: data }; }

function uiFail_(err) {
  return { ok: false, error: String((err && err.message) || err || 'unknown error') };
}

/** Clamp a lookback to 1..UI_MAX_DAYS, defaulting to 7. */
function uiDays_(d) {
  var n = Number(d);
  if (!isFinite(n)) n = 7;
  return Math.max(1, Math.min(UI_MAX_DAYS, Math.floor(n)));
}

/** A message ID is a short hex string. Anything else is rejected outright. */
function uiMessageId_(id) {
  var s = String(id || '').replace(/^'/, '').trim();
  if (!/^[0-9a-f]{8,32}$/i.test(s)) throw new Error('Invalid message ID.');
  return s;
}

function uiIso_(d) {
  return (d instanceof Date && !isNaN(d.getTime())) ? d.toISOString() : '';
}

/** Convert one getDecisionsSince_ row into a plain, serializable object. */
function uiRow_(r) {
  var conf = r['Confidence'];
  return {
    timestamp: uiIso_(r['Timestamp']),
    messageId: String(r['Message ID'] || ''),
    messageDate: uiIso_(r._messageDate || r['Message Date']),
    sender: String(r['Sender'] || ''),
    replyTo: String(r['Reply-To'] || ''),
    subject: String(r['Subject'] || ''),
    bodyPreview: String(r['Body Preview'] || ''),
    urlCount: Number(r['URL Count']) || 0,
    verdict: String(r['Verdict'] || ''),
    confidence: (conf === '' || conf === null || conf === undefined) ? null : Number(conf),
    reasons: String(r['Reasons'] || ''),
    actionTaken: String(r['Action Taken'] || ''),
    error: String(r['Error'] || ''),
    review: String(r['Review'] || '')
  };
}

/** Counts over a set of rows, in the shape the Overview tiles want. */
function uiCounts_(rows) {
  var c = { scanned: 0, scam: 0, suspicious: 0, safe: 0, allowlisted: 0,
            quarantined: 0, flagged: 0, restored: 0, wrong: 0, falsePositives: 0,
            precision: null };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    c.scanned++;
    if (r.verdict === VERDICT.SCAM) c.scam++;
    else if (r.verdict === VERDICT.SUSPICIOUS) c.suspicious++;
    else if (r.verdict === VERDICT.SAFE) c.safe++;
    else if (r.verdict === VERDICT.ALLOWLISTED) c.allowlisted++;
    if (r.actionTaken.indexOf(ACTION.QUARANTINED) === 0) c.quarantined++;
    else if (r.actionTaken.indexOf(ACTION.FLAGGED) === 0) c.flagged++;
    else if (r.actionTaken.indexOf('RESTORED') === 0) c.restored++;
    var wrong = r.review.toUpperCase().indexOf('WRONG') === 0;
    if (wrong) c.wrong++;
    if (wrong && r.actionTaken.indexOf(ACTION.QUARANTINED) === 0) c.falsePositives++;
  }
  if (c.quarantined > 0) c.precision = (c.quarantined - c.falsePositives) / c.quarantined;
  return c;
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/** Everything the Overview view needs, in one round trip. */
function ui_getOverview() {
  try {
    var now = Date.now();
    var rows30 = getDecisionsSince_(now - 30 * 86400000).map(uiRow_);
    var rows7 = rows30.filter(function (r) {
      return r.messageDate && Date.parse(r.messageDate) >= now - 7 * 86400000;
    });
    var lastRun = '';
    for (var i = 0; i < rows30.length; i++) {
      if (rows30[i].timestamp > lastRun) lastRun = rows30[i].timestamp;
    }
    return uiOk_({
      mode: isEnforcementActive_() ? 'ENFORCING' : 'observe-only',
      enforceFlag: !!CONFIG.ENFORCE,
      killSwitch: getKillSwitchReason_(),
      model: CONFIG.MODEL,
      threshold: CONFIG.CONFIDENCE_THRESHOLD,
      sheetUrl: getLogSpreadsheet_().getUrl(),
      lastRun: lastRun,
      errors24h: getErrorsSince_(now - 86400000).length,
      last7: uiCounts_(rows7),
      last30: uiCounts_(rows30)
    });
  } catch (err) {
    return uiFail_(err);
  }
}

/**
 * Decisions rows, newest first, capped.
 * @param {number} daysBack
 */
function ui_getDecisions(daysBack) {
  try {
    var days = uiDays_(daysBack);
    var rows = getDecisionsSince_(Date.now() - days * 86400000).map(uiRow_);
    rows.sort(function (a, b) { return a.messageDate < b.messageDate ? 1 : -1; });
    return uiOk_({ days: days, total: rows.length, rows: rows.slice(0, UI_MAX_ROWS) });
  } catch (err) {
    return uiFail_(err);
  }
}

/** @param {number} daysBack */
function ui_getErrors(daysBack) {
  try {
    var days = uiDays_(daysBack);
    var errs = getErrorsSince_(Date.now() - days * 86400000).map(function (e) {
      return { when: uiIso_(e.when), where: e.where, messageId: e.messageId, error: e.error };
    });
    errs.reverse();
    return uiOk_({ days: days, rows: errs });
  } catch (err) {
    return uiFail_(err);
  }
}

function ui_getAllowlist() {
  try {
    return uiOk_({ rows: getAllowlistRows_(), subdomains: !!CONFIG.ALLOWLIST_MATCH_SUBDOMAINS });
  } catch (err) {
    return uiFail_(err);
  }
}

// ---------------------------------------------------------------------------
// Write API — three narrow actions, each validated
// ---------------------------------------------------------------------------

/**
 * Sets the Review cell for a row.
 * @param {string} messageId
 * @param {string} value '' | 'WRONG' | 'OK'
 */
function ui_setReview(messageId, value) {
  try {
    var id = uiMessageId_(messageId);
    var v = String(value || '').toUpperCase().trim();
    if (UI_REVIEW_VALUES.indexOf(v) < 0) throw new Error('Review must be WRONG, OK, or blank.');
    var found = setReview_(id, v);
    if (!found) throw new Error('That row was not found in the recent log.');
    return uiOk_({ messageId: id, review: v });
  } catch (err) {
    return uiFail_(err);
  }
}

/**
 * Adds an email or domain to the allowlist.
 * @param {string} entry
 * @param {string} note
 */
function ui_addAllowlist(entry, note) {
  try {
    var e = String(entry || '').trim().toLowerCase();
    if (e.charAt(0) === '@') e = e.slice(1);
    if (!e || e.length > 254 || /\s/.test(e) || e.charAt(0) === '#' ||
        !/^[^@]+(@[^@]+)?$/.test(e) || e.indexOf('.') < 0) {
      throw new Error('Enter one email address or one domain, like alice@example.com or example.com.');
    }
    var n = String(note || '').trim().slice(0, 200);
    var added = addToAllowlist_(e, n || 'added from dashboard');
    return uiOk_({ added: added, rows: getAllowlistRows_() });
  } catch (err) {
    return uiFail_(err);
  }
}

/** @param {string} entry */
function ui_removeAllowlist(entry) {
  try {
    var e = String(entry || '').trim().toLowerCase();
    if (!e || e.length > 254 || /\s/.test(e)) throw new Error('Invalid allowlist entry.');
    var removed = removeFromAllowlist_(e);
    return uiOk_({ removed: removed, rows: getAllowlistRows_() });
  } catch (err) {
    return uiFail_(err);
  }
}

/**
 * Undo a quarantine. Same code path and guards as the editor's restoreMessage.
 * @param {string} messageId
 */
function ui_restore(messageId) {
  try {
    var id = uiMessageId_(messageId);
    var result = restoreById_(id);
    if (!result.ok) throw new Error(result.error);
    return uiOk_({ messageId: id, subject: result.subject, sender: result.sender,
                   allowlistAdded: result.allowlistAdded });
  } catch (err) {
    return uiFail_(err);
  }
}
