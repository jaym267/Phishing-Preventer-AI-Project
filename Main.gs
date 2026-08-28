/**
 * Main.gs — entry points for ScamShield Mail.
 *
 * Functions WITHOUT a trailing underscore are the ones you can select in the
 * Apps Script editor's "Run" dropdown. Keep that list short and intentional:
 *   checkSetup()    Stage 0 — prove the key, scopes and network work
 *   initLogSheet()  Stage 1 — create/report the log spreadsheet (Logger.gs)
 *   scanInbox()     Stage 1 — read the inbox and log one row per new message
 *
 * ===========================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO (hard rules 1 and 2)
 * ===========================================================================
 * There is no addLabel, no moveToArchive, no markRead, and no moveToTrash
 * anywhere in this stage. Until the ENFORCE flag is deliberately switched on in
 * Stage 4, this script only READS your mailbox and WRITES to a spreadsheet.
 * If you are editing this file and about to add one of those calls, you are
 * leaving Stage 1 — do it on purpose.
 *
 * One consequence is worth internalizing, because it makes dedupe
 * load-bearing rather than an optimization: because we never mark anything
 * read, every message stays in the search results for the FULL 20-minute
 * window and is returned by every run in between. Without isProcessed_(), a
 * 10-minute trigger would log each message two or three times. That is exactly
 * what the "run it again, get zero new rows" acceptance test checks.
 */

/**
 * Stage 0 acceptance check. Run this from the editor after storing the API key.
 *
 * Verifies, in order:
 *   1. The Anthropic API key exists in Script Properties (and is usable).
 *   2. The Gmail scope was actually granted (read-only probe).
 *   3. The trigger-management scope was actually granted.
 *   4. Outbound HTTPS works and the key authenticates against api.anthropic.com.
 *
 * Step 4 calls GET /v1/models — a metadata endpoint that consumes zero model
 * tokens, so this check is free to run as often as you like.
 *
 * Nothing here writes to your mailbox, and the key is never logged in full.
 */
function checkSetup() {
  var problems = [];

  // 1. Secret present.
  var key;
  try {
    key = getApiKey_();
    Logger.log('[1/4] API key found in Script Properties: ' + maskSecret_(key));
  } catch (err) {
    Logger.log('[1/4] FAIL — ' + err.message);
    Logger.log('setup INCOMPLETE');
    return;
  }

  // 2. Gmail scope. getInboxUnreadCount() reads; it changes nothing.
  try {
    var unread = GmailApp.getInboxUnreadCount();
    Logger.log('[2/4] Gmail scope OK — ' + unread + ' unread message(s) in inbox.');
  } catch (err) {
    problems.push('Gmail scope: ' + err.message);
    Logger.log('[2/4] FAIL — ' + err.message);
  }

  // 3. Trigger scope.
  try {
    var triggerCount = ScriptApp.getProjectTriggers().length;
    Logger.log('[3/4] Trigger scope OK — ' + triggerCount + ' trigger(s) installed.');
  } catch (err) {
    problems.push('Trigger scope: ' + err.message);
    Logger.log('[3/4] FAIL — ' + err.message);
  }

  // 4. Outbound HTTPS + key authenticates. muteHttpExceptions lets us read the
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
      Logger.log('[4/4] Anthropic API reachable and key accepted (HTTP 200).');
    } else if (code === 401) {
      problems.push('Anthropic API returned 401 — the stored key is invalid or revoked.');
      Logger.log('[4/4] FAIL — HTTP 401. Replace ANTHROPIC_API_KEY in Script Properties.');
    } else {
      problems.push('Anthropic API returned HTTP ' + code + '.');
      Logger.log('[4/4] FAIL — HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
    }
  } catch (err) {
    problems.push('UrlFetch: ' + err.message);
    Logger.log('[4/4] FAIL — ' + err.message);
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
 * Observe-only. No message is labeled, archived, marked read, or deleted.
 * In Stage 1 every logged verdict is NOT_CLASSIFIED (or ALLOWLISTED); Stage 2
 * replaces that with a real verdict at a single call site.
 */
function scanInbox() {
  var startMs = Date.now();
  var stats = {
    threads: 0, candidates: 0, logged: 0,
    skippedProcessed: 0, skippedAllowlist: 0, errors: 0, bailReason: ''
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

        // STAGE 2 SEAM: this is the single call site where a real classifier
        // verdict replaces the placeholder.
        logDecision_({
          messageId: id,
          messageDate: payload.messageDate,
          sender: payload.sender,
          replyTo: payload.replyTo,
          subject: payload.subject,
          bodyPreview: payload.bodyPreview,
          urlCount: payload.urlCount,
          verdict: VERDICT.NOT_CLASSIFIED,
          confidence: '',
          reasons: '',
          actionTaken: 'none (observe-only)',
          error: ''
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
      'scanInbox: threads=' + stats.threads +
      ' candidates=' + stats.candidates +
      ' logged=' + stats.logged +
      ' skippedProcessed=' + stats.skippedProcessed +
      ' skippedAllowlist=' + stats.skippedAllowlist +
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
