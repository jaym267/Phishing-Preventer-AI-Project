/**
 * Main.gs — entry points for ScamShield Mail.
 *
 * Functions WITHOUT a trailing underscore are the ones you can select in the
 * Apps Script editor's "Run" dropdown. Keep that list short and intentional:
 *   checkSetup()       prove the key, scopes and network work
 *   initLogSheet()     create/report the log spreadsheet (Logger.gs)
 *   scanInbox()        read the inbox, classify, and log one row per message
 *   testClassifier()   three canned payloads through the API (Classifier.gs)
 *   installTriggers()  start running on a schedule
 *   removeTriggers()   stop running on a schedule
 *   listTriggers()     show what is scheduled
 *   restoreMessage()   undo a quarantine (ID via RESTORE_MESSAGE_ID property)
 *   clearKillSwitch()  re-enable enforcement after you have fixed a fault
 *   sendDigestNow()    send the weekly family summary now (Digest.gs)
 *
 * ===========================================================================
 * THE CEILING ON WHAT THIS SCRIPT MAY DO (hard rules 1 and 2)
 * ===========================================================================
 * The strongest action anywhere in this project is: apply a label, remove from
 * the inbox (archive), and mark read. There is NO moveToTrash call and there
 * must never be one — the gmail.modify scope we declare cannot delete mail at
 * all, which is why it was chosen over the broader mail.google.com scope.
 *
 * Every mutation lives in exactly two functions, applyAction_() and
 * restoreMessage(), and applyAction_ does nothing at all unless BOTH
 * CONFIG.ENFORCE is true and the kill switch is clear. If you are adding a
 * mailbox write anywhere else in this file, stop and reconsider.
 *
 * One consequence is worth internalizing, because it makes dedupe load-bearing
 * rather than an optimization: a message that is not quarantined is never
 * marked read, so it stays in the search results for the FULL 20-minute window
 * and is returned by every run in between. Without isProcessed_(), a 10-minute
 * trigger would classify each message two or three times — paying for it every
 * time. That is exactly what the "run it again, get zero new rows" acceptance
 * test checks.
 */

/**
 * Stage 0 acceptance check. Run this from the editor after storing the API key.
 *
 * Verifies, in order:
 *   1. The Anthropic API key exists in Script Properties (and is usable).
 *   2. The Gmail scope was actually granted (read-only probe).
 *   3. The trigger-management scope was actually granted.
 *   4. The send-mail scope was granted (read-only quota probe — sends nothing).
 *   5. Outbound HTTPS works and the key authenticates against api.anthropic.com.
 *   6. CONFIG.MODEL names a model this key can actually use.
 *
 * Steps 5 and 6 call GET /v1/models — metadata endpoints that consume zero
 * model tokens, so this check is free to run as often as you like. Step 6 is
 * here so a mistyped model ID fails loudly at setup instead of silently as an
 * 'error' verdict on every message at runtime.
 *
 * Nothing here writes to your mailbox, and the key is never logged in full.
 */
function checkSetup() {
  var problems = [];

  // 1. Secret present.
  var key;
  try {
    key = getApiKey_();
    Logger.log('[1/6] API key found in Script Properties: ' + maskSecret_(key));
  } catch (err) {
    Logger.log('[1/6] FAIL — ' + err.message);
    Logger.log('setup INCOMPLETE');
    return;
  }

  // 2. Gmail scope. getInboxUnreadCount() reads; it changes nothing.
  try {
    var unread = GmailApp.getInboxUnreadCount();
    Logger.log('[2/6] Gmail scope OK — ' + unread + ' unread message(s) in inbox.');
  } catch (err) {
    problems.push('Gmail scope: ' + err.message);
    Logger.log('[2/6] FAIL — ' + err.message);
  }

  // 3. Trigger scope.
  try {
    var triggerCount = ScriptApp.getProjectTriggers().length;
    Logger.log('[3/6] Trigger scope OK — ' + triggerCount + ' trigger(s) installed.');
  } catch (err) {
    problems.push('Trigger scope: ' + err.message);
    Logger.log('[3/6] FAIL — ' + err.message);
  }

  // 4. Send-mail scope. getRemainingDailyQuota() reads a counter; it sends
  //    nothing. If the scope is missing this throws, which is exactly what we
  //    want to learn now rather than when the kill switch tries to alert you.
  try {
    var quota = MailApp.getRemainingDailyQuota();
    Logger.log('[4/6] Send-mail scope OK — ' + quota + ' email(s) left in today\'s quota.');
  } catch (err) {
    problems.push('Send-mail scope: ' + err.message);
    Logger.log('[4/6] FAIL — ' + err.message);
  }

  // 5. Outbound HTTPS + key authenticates. muteHttpExceptions lets us read the
  //    error body instead of getting an opaque thrown exception on 4xx/5xx.
  try {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/models?limit=1', {
      method: 'get',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200) {
      Logger.log('[5/6] Anthropic API reachable and key accepted (HTTP 200).');
    } else if (code === 401) {
      problems.push('Anthropic API returned 401 — the stored key is invalid or revoked.');
      Logger.log('[5/6] FAIL — HTTP 401. Replace ANTHROPIC_API_KEY in Script Properties.');
    } else {
      problems.push('Anthropic API returned HTTP ' + code + '.');
      Logger.log('[5/6] FAIL — HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
    }
  } catch (err) {
    problems.push('UrlFetch: ' + err.message);
    Logger.log('[5/6] FAIL — ' + err.message);
  }

  // 6. The configured model exists for this key. A 404 here means CONFIG.MODEL
  //    is mistyped or not available to this account.
  try {
    var mres = UrlFetchApp.fetch(
      'https://api.anthropic.com/v1/models/' + encodeURIComponent(CONFIG.MODEL), {
        method: 'get',
        headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        muteHttpExceptions: true
      });
    var mcode = mres.getResponseCode();
    if (mcode === 200) {
      Logger.log('[6/6] Model OK — ' + CONFIG.MODEL + ' is available to this key.');
    } else if (mcode === 404) {
      problems.push('Model "' + CONFIG.MODEL + '" not found — check CONFIG.MODEL in Config.gs.');
      Logger.log('[6/6] FAIL — HTTP 404 for model ' + CONFIG.MODEL + '. Check the ID in Config.gs.');
    } else {
      problems.push('Model lookup returned HTTP ' + mcode + '.');
      Logger.log('[6/6] FAIL — HTTP ' + mcode + ': ' + mres.getContentText().slice(0, 300));
    }
  } catch (err) {
    problems.push('Model lookup: ' + err.message);
    Logger.log('[6/6] FAIL — ' + err.message);
  }

  if (problems.length === 0) {
    Logger.log('setup OK');
  } else {
    Logger.log('setup INCOMPLETE — ' + problems.length + ' problem(s): ' + problems.join(' | '));
  }
}

// ---------------------------------------------------------------------------
// Stage 1 — the scan
// ---------------------------------------------------------------------------

/**
 * Reads recent inbox mail and writes one Decisions row per new message.
 *
 * Observe-only while CONFIG.ENFORCE is false: no message is labeled, archived,
 * marked read, or deleted. Stage 2 fills in real verdicts from Classifier.gs;
 * Stage 4 adds the enforcement branch at the marked seam.
 */
function scanInbox() {
  var startMs = Date.now();
  // Share the deadline with Classifier.gs so its retry backoff cannot sleep us
  // past the 6-minute hard kill.
  setRunDeadline_(startMs);
  var stats = {
    threads: 0, candidates: 0, logged: 0,
    skippedProcessed: 0, skippedAllowlist: 0, errors: 0,
    classifyErrors: 0, scam: 0, suspicious: 0, safe: 0,
    quarantined: 0, flagged: 0, bailReason: ''
  };

  // Take the lock with ZERO wait. A second, overlapping run has nothing useful
  // to add — it would only re-scan the same window and risk duplicate rows —
  // and waiting on it would burn the daily trigger-runtime budget for nothing.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('scanInbox: another run is already in progress. Exiting.');
    return;
  }
  // Tell getLogSpreadsheet_() we already hold it — Apps Script locks are not
  // reentrant, so it must not try to take the same lock again.
  HOLDS_SCRIPT_LOCK_ = true;

  try {
    // The log sheet gets its own try/catch because this is the ONE error path
    // that cannot honor "an error produces an error row" — there is no sheet
    // to write the row to.
    var ss;
    try {
      ss = getLogSpreadsheet_();
    } catch (err) {
      Logger.log('scanInbox: cannot open the log spreadsheet, so nothing ran.\n' + err.message);
      return;
    }

    var cutoffMs = startMs - (CONFIG.POLL_WINDOW_MINUTES * 60 * 1000);
    var query = buildSearchQuery_(Math.floor(cutoffMs / 1000));

    // Logged verbatim on purpose: this is what proves the window is minutes and
    // not months, and you can paste it straight into the Gmail search box.
    Logger.log('scanInbox: query = ' + query);

    var threads = GmailApp.search(query, 0, CONFIG.SEARCH_THREAD_LIMIT);
    stats.threads = threads.length;

    var candidates = collectCandidateMessages_(threads, cutoffMs);
    stats.candidates = candidates.length;

    // Decide ONCE per run whether we are allowed to touch the mailbox. Both
    // switches must agree: the deliberate CONFIG.ENFORCE flag, and the kill
    // switch that trips automatically when the script is failing repeatedly.
    var killed = checkKillSwitch_();
    var enforcing = !killed && isEnforcementActive_();

    // Warm both caches before the loop: two batched Sheet reads per run, total.
    getAllowlist_();
    loadProcessedIds_();

    for (var i = 0; i < candidates.length; i++) {
      // Budget check FIRST, before any work on this message.
      if (!hasTimeBudget_(startMs, CONFIG.PER_MESSAGE_RESERVE_MS)) {
        stats.bailReason = 'time budget (' + CONFIG.TIME_BUDGET_MS + 'ms)';
        break;
      }
      if (stats.logged >= CONFIG.MAX_MESSAGES_PER_RUN) {
        stats.bailReason = 'message cap (' + CONFIG.MAX_MESSAGES_PER_RUN + ')';
        break;
      }

      var msg = candidates[i];
      var id = '';
      try {
        id = msg.getId();
        if (isProcessed_(id)) {
          stats.skippedProcessed++;
          continue;
        }

        var payload = buildMessagePayload_(msg);

        // Hard rule 6 — allowlisted senders are never scanned, whatever a
        // classifier might later say. We still write an audit row (see
        // CONFIG.LOG_ALLOWLIST_SKIPS) so "why did it ignore this one?" is
        // answerable, and so the ID enters the dedupe set.
        if (isAllowlisted_(payload.senderAddress)) {
          stats.skippedAllowlist++;
          if (CONFIG.LOG_ALLOWLIST_SKIPS) {
            logDecision_({
              messageId: id,
              messageDate: payload.messageDate,
              sender: payload.sender,
              replyTo: payload.replyTo,
              subject: payload.subject,
              bodyPreview: '',                 // trusted sender: store nothing
              urlCount: '',
              verdict: VERDICT.ALLOWLISTED,
              confidence: '',
              reasons: '',
              actionTaken: 'skipped (allowlist)',
              error: ''
            });
          } else {
            markProcessedInMemory_(id);
          }
          continue;
        }

        // ---- Stage 2: classify -------------------------------------------
        // Every failure path in Classifier.gs returns verdict 'error'.
        var result = classifyMessage_(payload);

        if (result.verdict === VERDICT.ERROR) {
          // Hard rule 4: no action, and an error row in the log.
          //
          // Note what we deliberately do NOT do here: write a Decisions row.
          // Dedupe reads the Decisions tab, so leaving this message out of it
          // means the next run tries again. A transient API outage therefore
          // costs a retry rather than permanently skipping the message — which
          // matters, because a message we never classified is a message this
          // tool did not protect against. The retry is self-limiting: once the
          // message falls outside POLL_WINDOW_MINUTES it stops being a
          // candidate, so a permanently-failing message is retried about twice
          // and then dropped, never forever.
          stats.classifyErrors++;
          logError_('classify', new Error(result.error), id);
          continue;
        }

        if (result.verdict === VERDICT.SCAM) stats.scam++;
        else if (result.verdict === VERDICT.SUSPICIOUS) stats.suspicious++;
        else stats.safe++;

        // ---- Stage 4: act ------------------------------------------------
        var decision = decideAction_(result, enforcing);
        var applied;
        var actionError = '';
        try {
          applied = applyAction_(msg, decision);
        } catch (err) {
          // A failed label/archive must be visible, but it must not stop the
          // run — and it must not be recorded as though it had succeeded.
          logError_('applyAction', err, id);
          applied = { action: ACTION.NONE, note: '' };
          actionError = 'action failed: ' + err.message;
          stats.errors++;
        }

        if (applied.action === ACTION.QUARANTINED) stats.quarantined++;
        else if (applied.action === ACTION.FLAGGED) stats.flagged++;

        logDecision_({
          messageId: id,
          messageDate: payload.messageDate,
          sender: payload.sender,
          replyTo: payload.replyTo,
          subject: payload.subject,
          bodyPreview: payload.bodyPreview,
          urlCount: payload.urlCount,
          verdict: result.verdict,
          confidence: result.confidence,
          reasons: result.reasons,
          actionTaken: applied.action + (applied.note ? ' — ' + applied.note : ''),
          error: actionError
        });
        stats.logged++;

      } catch (err) {
        // Hard rule 4, per message. One malformed message must never end the
        // run, and it must never cause an action to be taken.
        stats.errors++;
        logError_('scanInbox', err, id);
      }
    }

    SpreadsheetApp.flush();

    Logger.log(
      'scanInbox: mode=' + (enforcing ? 'ENFORCING' : 'observe-only') +
      ' threads=' + stats.threads +
      ' candidates=' + stats.candidates +
      ' logged=' + stats.logged +
      ' skippedProcessed=' + stats.skippedProcessed +
      ' skippedAllowlist=' + stats.skippedAllowlist +
      ' scam=' + stats.scam +
      ' suspicious=' + stats.suspicious +
      ' safe=' + stats.safe +
      ' quarantined=' + stats.quarantined +
      ' flagged=' + stats.flagged +
      ' classifyErrors=' + stats.classifyErrors +
      ' errors=' + stats.errors +
      ' elapsedMs=' + (Date.now() - startMs) +
      (stats.bailReason ? ' bail=' + stats.bailReason : '')
    );

  } finally {
    HOLDS_SCRIPT_LOCK_ = false;
    lock.releaseLock();
  }
}

/**
 * Builds the Gmail search query.
 *
 * `after:` takes Unix epoch SECONDS. See the POLL_WINDOW_MINUTES comment in
 * Config.gs for why this is not `newer_than:20m` (short version: Gmail's `m`
 * unit means months).
 *
 * `-from:me` excludes your own sent mail that landed back in the inbox. The
 * obvious alternative — comparing against Session.getActiveUser().getEmail() —
 * would add the userinfo.email scope to this project. Because appsscript.json
 * declares scopes explicitly, that call would throw at runtime until the
 * manifest was edited and every user re-consented. `-from:me` is free.
 *
 * @param {number} cutoffEpochSeconds
 * @return {string}
 */
function buildSearchQuery_(cutoffEpochSeconds) {
  var parts = ['in:inbox'];
  if (CONFIG.REQUIRE_UNREAD) parts.push('is:unread');
  parts.push('-from:me');
  parts.push('after:' + cutoffEpochSeconds);
  return parts.join(' ');
}

/**
 * Is this message one we should look at?
 *
 * GmailApp.search() matches THREADS, not messages. `is:unread` returns any
 * thread containing at least one unread message, and thread.getMessages()
 * hands back every message in it — including read ones, archived ones, drafts,
 * and your own replies. A three-year-old thread that someone just replied to
 * matches the query and drags its entire history along.
 *
 * @param {GmailMessage} msg
 * @param {number} cutoffMs
 * @return {boolean}
 */
function isCandidateMessage_(msg, cutoffMs) {
  // Date first: it is the most selective test (it eliminates the whole old body
  // of a bumped thread in one go), and it makes us independent of exactly how
  // precise Gmail's `after:` operator is. If `after:` ever rounded to a day
  // boundary, this still behaves correctly — we would just fetch more threads
  // than we needed.
  if (msg.getDate().getTime() < cutoffMs) return false;
  if (CONFIG.REQUIRE_UNREAD && !msg.isUnread()) return false;
  if (!msg.isInInbox()) return false;
  if (msg.isDraft()) return false;      // a half-written draft is not incoming mail
  if (msg.isInChats()) return false;    // Chat records surface as messages
  return true;
}

/**
 * Flattens threads to candidate messages, OLDEST FIRST.
 *
 * The ordering is not cosmetic. GmailApp.search() returns threads newest-first.
 * If 40 messages arrive in a burst and MAX_MESSAGES_PER_RUN is 10, a
 * newest-first loop handles the 10 newest and drops the other 30. Next run,
 * more new mail has arrived and the newest 10 win again — so the oldest
 * messages are starved until they age out of the 20-minute window and are
 * never examined at all. Sorting ascending inverts that: the messages closest
 * to falling out of the window go first, and the newest ones are still
 * comfortably inside it next run. The cost is slightly higher latency on the
 * very newest mail, which is the right trade.
 *
 * @param {GmailThread[]} threads
 * @param {number} cutoffMs
 * @return {GmailMessage[]}
 */
function collectCandidateMessages_(threads, cutoffMs) {
  var out = [];
  for (var t = 0; t < threads.length; t++) {
    try {
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length; m++) {
        if (isCandidateMessage_(messages[m], cutoffMs)) out.push(messages[m]);
      }
    } catch (err) {
      // One corrupt thread must not abort the run.
      logError_('collectCandidateMessages', err, '');
    }
  }
  out.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });
  return out;
}

/**
 * Is there room for one more message inside our self-imposed budget?
 *
 * Checking bare "elapsed < budget" is wrong: a message that takes 60 seconds
 * but starts at 4:29 still blows past the limit. Reserve the headroom for the
 * work you are about to start.
 *
 * @param {number} startMs
 * @param {number} reserveMs
 * @return {boolean}
 */
function hasTimeBudget_(startMs, reserveMs) {
  return (Date.now() - startMs) + reserveMs < CONFIG.TIME_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// Payload extraction (hard rule 3 — this is the complete list of what we take)
// ---------------------------------------------------------------------------

/**
 * Builds the minimal per-message payload.
 *
 * Hard rule 3: sender, reply-to, subject, truncated plain-text body, and link
 * URLs. Nothing else — no attachments, no headers beyond these, no raw HTML.
 *
 * @param {GmailMessage} msg
 * @return {Object}
 */
function buildMessagePayload_(msg) {
  var sender = msg.getFrom();                 // raw header — see below
  var senderAddress = extractEmailAddress_(sender);
  var replyToRaw = msg.getReplyTo();
  var replyTo = extractEmailAddress_(replyToRaw);

  var plain = msg.getPlainBody() || '';
  var html = '';
  try {
    html = msg.getBody() || '';
  } catch (err) {
    html = '';                                // some messages have no HTML part
  }

  var body = truncate_(plain, CONFIG.BODY_CHARS_FOR_MODEL);
  var urls = extractUrls_(plain, html);

  return {
    messageId: msg.getId(),
    messageDate: msg.getDate(),

    // The RAW From header, display name included. "Amazon Support
    // <billing@sketchy.ru>" is the signal — a display name that impersonates a
    // company whose domain does not match is one of the strongest tells there
    // is, and it would be destroyed by storing only the parsed address.
    sender: sender,
    senderAddress: senderAddress,

    // '' when it matches the sender, so a POPULATED Reply-To column means
    // mismatch — which is the only reason to look at the column at all.
    replyTo: (replyTo && replyTo !== senderAddress) ? replyTo : '',

    subject: msg.getSubject() || '',
    body: body,
    bodyTruncated: plain.length > CONFIG.BODY_CHARS_FOR_MODEL,

    // Collapse whitespace BEFORE slicing, or the 200 characters are mostly
    // newlines: the cell becomes an unreadable multi-line block and CSV export
    // breaks.
    bodyPreview: truncate_(collapseWhitespace_(plain), CONFIG.BODY_CHARS_FOR_SHEET),

    urls: urls,
    urlCount: urls.length
  };
}

/**
 * Pulls the bare address out of a From/Reply-To header value.
 *
 * getFrom() returns either "addr@x.com" or 'Display Name <addr@x.com>'.
 *
 * We match the LAST angle-bracket pair, anchored at the end of the string.
 * That detail matters for a phishing tool: a classic trick is a display name
 * that itself looks like an address —
 *
 *   "support@paypal.com <security@paypal.com>" <evil@ru-host.tld>
 *
 * A regex that grabs the FIRST <...> returns support@paypal.com and the
 * allowlist waves the attacker straight through.
 *
 * @param {string} headerValue
 * @return {string} Lowercased address, or '' .
 */
function extractEmailAddress_(headerValue) {
  var raw = String(headerValue || '').trim();
  if (!raw) return '';
  var m = /<([^<>]*)>\s*$/.exec(raw);
  var addr = m ? m[1] : raw;
  return addr.trim().toLowerCase();
}

/**
 * Harvests link targets from the HTML body and bare URLs from the plain body.
 *
 * WHY BOTH. getPlainBody() on an HTML-only message returns Gmail's text
 * rendering, which keeps the ANCHOR TEXT and throws away the HREF. For a
 * phishing classifier that inverts the signal exactly: you are left with
 * "Click here to verify your account" and you have lost
 * http://paypa1-secure.ru/login. Since nearly all phishing is HTML mail, the
 * single most important feature would be missing from essentially every
 * message.
 *
 * HARD RULE 3 COMPLIANCE: the HTML is read into memory only to run a regex over
 * it. It is never stored in the sheet and never placed in the payload. The only
 * thing that leaves this function is a list of URL strings.
 *
 * STAGE 2 SEAM: the highest-value signal is not the href alone, it is the
 * MISMATCH between anchor text and href ("PayPal.com" linking to paypa1.ru).
 * Capturing that means returning {href, text} objects instead of strings. Only
 * two call sites consume this value (buildMessagePayload_ and, later,
 * Classifier.gs), so widening the shape is cheap. Anchor text is body text,
 * which is already in the payload, so it adds no new data category.
 *
 * @param {string} plainBody
 * @param {string} htmlBody
 * @return {string[]} Deduped, capped at CONFIG.MAX_URLS.
 */
function extractUrls_(plainBody, htmlBody) {
  // Bound the input. Marketing HTML routinely runs to hundreds of KB, and a
  // regex over an unbounded string is the one place this stage could plausibly
  // burn real time. Links live near the top.
  var html = String(htmlBody || '').slice(0, CONFIG.HTML_SCAN_MAX_CHARS);
  var plain = String(plainBody || '');

  var seen = {};
  var out = [];

  function add(raw) {
    if (out.length >= CONFIG.MAX_URLS) return;

    // Decode entities. Skipping this is a silent correctness bug: &amp; appears
    // in essentially every multi-parameter URL, and without decoding, the model
    // reasons about a string that does not exist.
    var url = decodeHtmlEntities_(String(raw || '').trim());

    // Regexes over-capture sentence punctuation, and "paypal.com/login." is a
    // different string from "paypal.com/login".
    url = url.replace(/[.,;:!?)\]}'"]+$/, '');

    // Drop mailto:, tel:, cid:, #fragments, javascript:, and empties.
    if (!/^https?:\/\//i.test(url)) return;

    if (url.length > CONFIG.URL_MAX_LENGTH) {
      // Truncate from the END — the host carries almost all of the signal and
      // sits at the front. A truncated URL is not resolvable.
      url = url.slice(0, CONFIG.URL_MAX_LENGTH) + '...';
    }

    // Dedupe on a normalized key, but keep the URL AS IT APPEARED. Percent
    // encoding, odd casing in the path, and homograph characters are all
    // deception signals; normalizing them away before the classifier sees them
    // would destroy the evidence.
    var key = normalizeUrlForDedupe_(url);
    if (seen[key] === true) return;
    seen[key] = true;
    out.push(url);
  }

  var m;

  // Hrefs first — these are the real destinations.
  var reQuotedHref = /href\s*=\s*["']([^"']*)["']/gi;
  while ((m = reQuotedHref.exec(html)) !== null) add(m[1]);

  var reUnquotedHref = /href\s*=\s*([^\s">']+)/gi;
  while ((m = reUnquotedHref.exec(html)) !== null) add(m[1]);

  // Then bare URLs typed into the plain text.
  var reBare = /\bhttps?:\/\/[^\s<>"'\)\]]+/gi;
  while ((m = reBare.exec(plain)) !== null) add(m[0]);

  var reWww = /\bwww\.[^\s<>"'\)\]]+/gi;
  while ((m = reWww.exec(plain)) !== null) add('http://' + m[0]);

  return out;
}

/**
 * Dedupe key only. Lowercases the scheme and host (the only parts that are
 * case-insensitive by spec) and drops one bare trailing slash. The path, query
 * and fragment are left exactly alone.
 *
 * @param {string} url
 * @return {string}
 */
function normalizeUrlForDedupe_(url) {
  var m = /^(https?:\/\/)([^\/?#]*)(.*)$/i.exec(url);
  if (!m) return url;
  return m[1].toLowerCase() + m[2].toLowerCase() + m[3].replace(/\/$/, '');
}

/**
 * Decodes the handful of HTML entities that actually show up inside href
 * attributes. &amp; is decoded LAST so that "&amp;quot;" does not get decoded
 * twice into a literal quote.
 *
 * @param {string} s
 * @return {string}
 */
function decodeHtmlEntities_(s) {
  return String(s)
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:amp|#38|#x26);/gi, '&');
}

/**
 * Collapses every run of whitespace (including newlines and tabs) to one space.
 * @param {string} s
 * @return {string}
 */
function collapseWhitespace_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} s
 * @param {number} n
 * @return {string}
 */
function truncate_(s, n) {
  var str = String(s || '');
  return str.length > n ? str.slice(0, n) : str;
}

// ---------------------------------------------------------------------------
// Stage 3 — triggers
// ---------------------------------------------------------------------------

/**
 * Run ONCE from the "Run" dropdown to start the script running on its own.
 *
 * Apps Script note — a "time-driven trigger" is Google's cron. It belongs to
 * the script project and to the user who created it, and it keeps running even
 * with the editor closed. Two limits shape what we can ask for:
 *
 *   1. everyMinutes() accepts only 1, 5, 10, 15 or 30. Arbitrary intervals are
 *      not available, which is why CONFIG.TRIGGER_MINUTES is 10 and not 7.
 *   2. Triggers fire within a WINDOW around the scheduled time, not to the
 *      second. That is why the search window is twice the interval — a late run
 *      still sees everything the previous one might have missed.
 *
 * Also worth knowing: total trigger runtime is capped per day (roughly 90
 * minutes on a consumer @gmail.com account). At 144 runs a day that is about 37
 * seconds each, which is the real reason MAX_MESSAGES_PER_RUN is 10 rather than
 * "drain the inbox".
 *
 * Safe to run twice — existing triggers for the same function are left alone.
 */
function installTriggers() {
  // `typeof <undeclaredIdentifier>` is 'undefined' by spec and never throws,
  // so these checks are safe even if a handler is missing. The earlier
  // `typeof this[fn]` form depended on sloppy-mode `this` being the global
  // object — true today, but undocumented, and a silent no-op if it changed.
  var wanted = [
    { fn: 'scanInbox', exists: typeof scanInbox === 'function',
      describe: 'every ' + CONFIG.TRIGGER_MINUTES + ' minutes' },
    { fn: 'dailySelfTest', exists: typeof dailySelfTest === 'function',
      describe: 'daily around ' + CONFIG.SELF_TEST_HOUR + ':00' },
    { fn: 'sendWeeklyDigest', exists: typeof sendWeeklyDigest === 'function',
      describe: CONFIG.DIGEST_WEEKDAY + ' around ' + CONFIG.DIGEST_HOUR + ':00' }
  ];

  var existing = {};
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    existing[triggers[i].getHandlerFunction()] = true;
  }

  for (var w = 0; w < wanted.length; w++) {
    var fn = wanted[w].fn;

    // Apps Script will happily create a trigger for a function that does not
    // exist; it just fails every time it fires. Skip anything not defined.
    if (!wanted[w].exists) {
      Logger.log('SKIP  ' + fn + ' — not implemented yet in this version.');
      continue;
    }

    if (existing[fn]) {
      Logger.log('SKIP  ' + fn + ' — a trigger already exists. Not creating a duplicate.');
      continue;
    }
    if (fn === 'scanInbox') {
      ScriptApp.newTrigger(fn).timeBased().everyMinutes(CONFIG.TRIGGER_MINUTES).create();
    } else if (fn === 'dailySelfTest') {
      ScriptApp.newTrigger(fn).timeBased().atHour(CONFIG.SELF_TEST_HOUR).everyDays(1).create();
    } else {
      ScriptApp.newTrigger(fn).timeBased()
        .onWeekDay(ScriptApp.WeekDay[CONFIG.DIGEST_WEEKDAY])
        .atHour(CONFIG.DIGEST_HOUR).create();
    }
    Logger.log('OK    ' + fn + ' — ' + wanted[w].describe);
  }

  Logger.log('Triggers now installed: ' + ScriptApp.getProjectTriggers().length);
  Logger.log('Enforcement is ' + (isEnforcementActive_() ? 'ACTIVE' : 'OFF (observe-only)') + '.');
}

/**
 * Removes every trigger this project owns. Use before uninstalling, or to stop
 * the script cleanly without deleting it.
 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    Logger.log('Removing trigger for ' + triggers[i].getHandlerFunction());
    ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log('Removed ' + triggers.length + ' trigger(s). The script will no longer run on its own.');
}

/**
 * Lists what is currently scheduled. Read-only; handy when something is not
 * running and you want to know whether a trigger actually exists.
 */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  if (!triggers.length) {
    Logger.log('No triggers installed. Run installTriggers() to start.');
    return;
  }
  for (var i = 0; i < triggers.length; i++) {
    Logger.log((i + 1) + '. ' + triggers[i].getHandlerFunction() +
               ' (' + triggers[i].getEventType() + ')');
  }
}

/**
 * Daily health check. Emails you only if something actually went wrong, so a
 * message from this function always means "look at me".
 *
 * Reports: how many errors were logged in the last 24 hours, a sample of them,
 * and whether the kill switch has disabled enforcement.
 */
function dailySelfTest() {
  var since = Date.now() - (24 * 60 * 60 * 1000);

  var errors;
  try {
    errors = getErrorsSince_(since);
  } catch (err) {
    // If we cannot even read the log, that is itself worth an alert.
    Logger.log('dailySelfTest could not read the log: ' + err.message);
    notifyOwner_('ScamShield: cannot read the log sheet',
      'The daily self-test could not open the decision log.\n\n' + err.message);
    return;
  }

  var killed = PropertiesService.getScriptProperties()
    .getProperty(PROP.ENFORCE_DISABLED_BY_KILL_SWITCH);

  if (!errors.length && !killed) {
    Logger.log('dailySelfTest: healthy — 0 errors in the last 24h. No email sent.');
    return;
  }

  var lines = [];
  if (killed) {
    lines.push('ENFORCEMENT IS DISABLED. The kill switch tripped: ' + killed);
    lines.push('Nothing is being quarantined until you clear the ' +
               PROP.ENFORCE_DISABLED_BY_KILL_SWITCH + ' script property.');
    lines.push('');
  }
  lines.push(errors.length + ' error(s) logged in the last 24 hours.');
  lines.push('');
  var sample = errors.slice(-10);
  for (var i = 0; i < sample.length; i++) {
    lines.push('- [' + sample[i].where + '] ' + sample[i].error);
  }
  if (errors.length > sample.length) {
    lines.push('...and ' + (errors.length - sample.length) + ' more. See the Errors tab.');
  }
  lines.push('');
  lines.push('Log: ' + getLogSpreadsheet_().getUrl());

  Logger.log('dailySelfTest: ' + errors.length + ' error(s), killSwitch=' + (killed || 'no'));
  notifyOwner_('ScamShield: ' + errors.length + ' error(s) in the last 24h', lines.join('\n'));
}

/**
 * Sends an operational alert to the script owner.
 *
 * Never throws: this is called from triggers and from the kill switch, and an
 * alert that fails must not take the run down with it. Silently does nothing if
 * no owner address is configured, after saying so in the log.
 *
 * @param {string} subject
 * @param {string} body Plain text.
 */
function notifyOwner_(subject, body) {
  var to = getOwnerEmail_();
  if (!to) {
    Logger.log('notifyOwner_: no OWNER_EMAIL script property set, so no alert was sent.');
    Logger.log('  Would have sent: ' + subject);
    return;
  }
  try {
    MailApp.sendEmail(to, subject, body);
    Logger.log('notifyOwner_: alert sent to ' + to);
  } catch (err) {
    Logger.log('notifyOwner_: could not send mail — ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Stage 4 — enforcement
//
// This is the only part of the project that changes your mailbox, so read the
// ceiling once more before editing anything here:
//
//   The strongest action allowed is: apply a label, remove from the inbox
//   (archive), and mark read. NOTHING here may delete mail. There is no
//   moveToTrash call in this codebase and there must never be one. The
//   gmail.modify OAuth scope we declare is physically incapable of deleting,
//   which is exactly why it was chosen over the broader mail.google.com scope.
// ---------------------------------------------------------------------------

/** Run-scoped cache so we resolve the labels once per execution. */
var LABEL_CACHE_ = null;

/**
 * Creates the ScamShield labels if they do not exist, and returns them.
 * Idempotent.
 *
 * @return {{quarantine: GmailLabel, suspicious: GmailLabel}}
 */
function ensureLabels_() {
  if (LABEL_CACHE_) return LABEL_CACHE_;
  LABEL_CACHE_ = {
    quarantine: GmailApp.getUserLabelByName(LABELS.QUARANTINE) ||
                GmailApp.createLabel(LABELS.QUARANTINE),
    suspicious: GmailApp.getUserLabelByName(LABELS.SUSPICIOUS) ||
                GmailApp.createLabel(LABELS.SUSPICIOUS)
  };
  return LABEL_CACHE_;
}

/**
 * Decides what should happen to a classified message.
 *
 * PURE — reads only its arguments and CONFIG, and touches nothing. All the
 * policy lives here so it can be tested exhaustively without a mailbox.
 *
 * Policy:
 *   scam AND confidence >= threshold  -> QUARANTINED (label, archive, mark read)
 *   suspicious, any confidence        -> FLAGGED (label only, stays in inbox)
 *   scam BELOW threshold              -> FLAGGED (the conservative choice)
 *   safe                              -> nothing
 *   error                             -> nothing (hard rule 4; never reaches here)
 *
 * @param {{verdict: string, confidence: number}} result
 * @param {boolean} enforcing
 * @return {{action: string, label: string, archive: boolean, markRead: boolean}}
 */
function decideAction_(result, enforcing) {
  var none = { action: ACTION.OBSERVE_ONLY, label: '', archive: false, markRead: false };
  if (!enforcing) return none;

  // Defensive: an 'error' or unrecognized verdict must never cause an action.
  if (result.verdict === VERDICT.SAFE) return { action: ACTION.NONE, label: '', archive: false, markRead: false };
  if (result.verdict !== VERDICT.SCAM && result.verdict !== VERDICT.SUSPICIOUS) return none;

  if (result.verdict === VERDICT.SCAM &&
      typeof result.confidence === 'number' &&
      result.confidence >= CONFIG.CONFIDENCE_THRESHOLD) {
    return { action: ACTION.QUARANTINED, label: LABELS.QUARANTINE, archive: true, markRead: true };
  }

  // Either 'suspicious', or 'scam' that did not clear the bar. Label it so it is
  // visible, but leave it where the recipient can see it.
  return { action: ACTION.FLAGGED, label: LABELS.SUSPICIOUS, archive: false, markRead: false };
}

/**
 * Carries out a decision against a real message.
 *
 * IMPORTANT Apps Script behavior — labels and archiving are THREAD-level
 * operations in Gmail, not message-level. There is no message.addLabel(). That
 * creates a real hazard: if a scam lands as a reply inside an existing genuine
 * conversation, archiving the thread would hide that whole conversation from
 * the person we are trying to protect.
 *
 * So a quarantine is downgraded to a flag whenever the thread holds more than
 * one message. Labeling a mixed thread is recoverable and visible; archiving
 * one is exactly the "false quarantine of a real email" the classification
 * prompt tells the model to fear most.
 *
 * @param {GmailMessage} msg
 * @param {Object} decision From decideAction_.
 * @return {{action: string, note: string}} What actually happened.
 */
function applyAction_(msg, decision) {
  if (decision.action === ACTION.OBSERVE_ONLY || decision.action === ACTION.NONE) {
    return { action: decision.action, note: '' };
  }

  var labels = ensureLabels_();
  var thread = msg.getThread();
  var note = '';

  if (decision.archive && thread.getMessageCount() > 1) {
    // Downgrade. Label only, leave the conversation in the inbox.
    thread.addLabel(labels.suspicious);
    return {
      action: ACTION.FLAGGED,
      note: 'downgraded from QUARANTINE: thread has ' + thread.getMessageCount() +
            ' messages and archiving it would hide the whole conversation'
    };
  }

  if (decision.label === LABELS.QUARANTINE) {
    thread.addLabel(labels.quarantine);
  } else {
    thread.addLabel(labels.suspicious);
  }

  if (decision.archive) thread.moveToArchive();
  if (decision.markRead) msg.markRead();

  return { action: decision.action, note: note };
}

/**
 * Manual undo for a false positive.
 *
 * Puts the message's thread back in the inbox, removes the ScamShield labels,
 * and adds the sender to the allowlist so it cannot happen again.
 *
 * HOW TO CALL IT. The Apps Script "Run" dropdown cannot pass arguments, so
 * "run restoreMessage(id)" is not something the editor lets you do. Instead:
 *   1. Copy the Message ID from the Decisions tab.
 *   2. Project Settings -> Script Properties -> add RESTORE_MESSAGE_ID = that ID.
 *   3. Run restoreMessage from the dropdown.
 * The property is deleted after a successful restore, so it cannot be replayed
 * by accident. The optional argument still works when called from code.
 *
 * @param {string=} messageId Optional; falls back to the Script Property.
 */
function restoreMessage(messageId) {
  var props = PropertiesService.getScriptProperties();
  var fromProperty = false;
  if (!messageId) {
    messageId = props.getProperty(PROP.RESTORE_MESSAGE_ID);
    fromProperty = !!messageId;
  }
  if (!messageId) {
    Logger.log('restoreMessage needs a Message ID.');
    Logger.log('Copy one from the Decisions tab, then Project Settings -> Script ' +
               'Properties -> add ' + PROP.RESTORE_MESSAGE_ID + ' = <that id>, and run again.');
    return;
  }
  var id = String(messageId).replace(/^'/, '').trim();

  var msg;
  try {
    msg = GmailApp.getMessageById(id);
  } catch (err) {
    Logger.log('Could not find a message with ID "' + id + '": ' + err.message);
    return;
  }
  if (!msg) {
    Logger.log('Could not find a message with ID "' + id + '".');
    return;
  }

  var labels = ensureLabels_();
  var thread = msg.getThread();
  thread.removeLabel(labels.quarantine);
  thread.removeLabel(labels.suspicious);
  thread.moveToInbox();

  var sender = extractEmailAddress_(msg.getFrom());
  var added = addToAllowlist_(sender, 'restored ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));

  logDecision_({
    messageId: id,
    messageDate: msg.getDate(),
    sender: msg.getFrom(),
    replyTo: '',
    subject: msg.getSubject(),
    bodyPreview: '',
    urlCount: '',
    verdict: VERDICT.ALLOWLISTED,
    confidence: '',
    reasons: ['restored manually — this was a false positive'],
    actionTaken: 'RESTORED',
    error: ''
  });

  Logger.log('Restored "' + msg.getSubject() + '" to the inbox.');
  Logger.log(added
    ? 'Added ' + sender + ' to the allowlist — it will never be scanned again.'
    : sender + ' was already on the allowlist.');

  // One-shot: clear the property so re-running the function later does not
  // silently re-restore (and re-allowlist) the same message.
  if (fromProperty) props.deleteProperty(PROP.RESTORE_MESSAGE_ID);
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * Disables enforcement automatically if the script is failing repeatedly.
 *
 * The reasoning: a burst of errors means we do not understand what is
 * happening, and a system that does not understand what is happening should not
 * be moving someone's mail. Better to stop acting and shout.
 *
 * The flag is stored in Script Properties rather than in code so that pushing a
 * new version cannot silently re-enable enforcement. Clearing it is a
 * deliberate manual act.
 *
 * @return {boolean} true if the kill switch is (now) tripped.
 */
function checkKillSwitch_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP.ENFORCE_DISABLED_BY_KILL_SWITCH)) return true;

  var since = Date.now() - (CONFIG.KILL_SWITCH_WINDOW_MIN * 60 * 1000);
  var recent;
  try {
    recent = getErrorsSince_(since);
  } catch (err) {
    return false;   // cannot read the log; do not trip on a guess
  }
  if (recent.length <= CONFIG.KILL_SWITCH_ERROR_LIMIT) return false;

  var reason = recent.length + ' errors in the last ' +
               CONFIG.KILL_SWITCH_WINDOW_MIN + ' minutes (limit ' +
               CONFIG.KILL_SWITCH_ERROR_LIMIT + ') at ' + new Date().toISOString();
  props.setProperty(PROP.ENFORCE_DISABLED_BY_KILL_SWITCH, reason);

  Logger.log('KILL SWITCH TRIPPED — ' + reason);
  notifyOwner_('ScamShield: enforcement disabled automatically',
    'ScamShield has stopped quarantining mail because it is erroring repeatedly.\n\n' +
    reason + '\n\n' +
    'Nothing has been deleted, and anything already quarantined is still in the\n' +
    'ScamShield/Quarantine label. Scanning and logging continue.\n\n' +
    'To re-enable after you have fixed the cause: Apps Script editor ->\n' +
    'Project Settings -> Script Properties -> delete "' +
    PROP.ENFORCE_DISABLED_BY_KILL_SWITCH + '".\n\n' +
    'Recent errors:\n' +
    recent.slice(-5).map(function (e) { return '- [' + e.where + '] ' + e.error; }).join('\n'));
  return true;
}

/**
 * Clears the kill switch after you have fixed whatever tripped it.
 */
function clearKillSwitch() {
  PropertiesService.getScriptProperties().deleteProperty(PROP.ENFORCE_DISABLED_BY_KILL_SWITCH);
  Logger.log('Kill switch cleared. Enforcement is now ' +
             (isEnforcementActive_() ? 'ACTIVE' : 'still OFF because CONFIG.ENFORCE is false') + '.');
}
