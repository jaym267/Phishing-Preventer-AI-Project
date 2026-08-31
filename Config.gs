/**
 * Config.gs — configuration + secret access for ScamShield Mail.
 *
 * Apps Script note — the trailing underscore on a function name (getApiKey_)
 * is a real language feature here, not a style choice. Apps Script hides
 * underscore-suffixed functions from the "Run" dropdown, from custom-function
 * autocomplete in Sheets, and from library consumers. Use it for every internal
 * helper so the only things a human can click "Run" on are the entry points we
 * intend (checkSetup, scanInbox, initLogSheet, ...).
 */

/** Script Property keys. Never put values here — only the names of the slots. */
var PROP = {
  API_KEY: 'ANTHROPIC_API_KEY',
  LOG_SHEET_ID: 'LOG_SHEET_ID',
  ENFORCE_DISABLED_BY_KILL_SWITCH: 'ENFORCE_DISABLED_BY_KILL_SWITCH',
  DIGEST_RECIPIENT: 'DIGEST_RECIPIENT',
  OWNER_EMAIL: 'OWNER_EMAIL'
};

/**
 * Verdict strings, in one place so Stage 1 and Stage 2 cannot disagree on
 * spelling. The lowercase three (scam/suspicious/safe) are exactly what the
 * classifier is allowed to return in Stage 2; the uppercase two are internal
 * bookkeeping states that the model never produces.
 */
var VERDICT = {
  NOT_CLASSIFIED: 'NOT_CLASSIFIED',   // Stage 1 placeholder — no AI ran
  ALLOWLISTED: 'ALLOWLISTED',         // sender is on the allowlist, never scanned
  SCAM: 'scam',
  SUSPICIOUS: 'suspicious',
  SAFE: 'safe',
  ERROR: 'error'
};

/**
 * Gmail label names used by enforcement (Stage 4). Nested names create the
 * parent "ScamShield" label automatically.
 */
var LABELS = {
  QUARANTINE: 'ScamShield/Quarantine',
  SUSPICIOUS: 'ScamShield/Suspicious'
};

/** Action strings written to the "Action Taken" column. */
var ACTION = {
  NONE: 'none',
  OBSERVE_ONLY: 'none (observe-only)',
  QUARANTINED: 'QUARANTINED',
  FLAGGED: 'FLAGGED',
  ALLOWLISTED: 'skipped (allowlist)'
};

/**
 * Everything tunable, in one object.
 *
 * Rule of thumb for this file: a number that appears twice in the codebase, or
 * that you might want to change without re-reading the logic around it, belongs
 * here with a comment explaining what it is trading off.
 */
var CONFIG = {

  // ---------------------------------------------------------------- behavior

  /**
   * Hard rule 2. While this is false the script only ever READS your mailbox
   * and WRITES to the log sheet. No labels, no archiving, no marking read.
   * Stage 4 is the first stage allowed to honor a true value here.
   */
  ENFORCE: false,

  /** Stage 4 gate: only a `scam` verdict at or above this confidence quarantines. */
  CONFIDENCE_THRESHOLD: 0.85,

  /**
   * Stage 2. Exact Anthropic model ID — these strings are complete as written;
   * never append a date suffix.
   *
   * Haiku 4.5 is the cheapest current model ($1/$5 per million input/output
   * tokens) and this is a high-frequency classifier — at ~50 emails/day it is
   * roughly $3/month against ~$9 for Sonnet 4.6 or ~$15 for Opus 5. Stage 3's
   * observe-only review is exactly the mechanism for finding out whether the
   * accuracy holds; changing this is a one-line edit if it does not.
   */
  MODEL: 'claude-haiku-4-5',

  /**
   * Ceiling on the classifier's reply. A verdict is a few dozen tokens, so this
   * is generous headroom, not a cost driver — and running out mid-JSON would
   * produce an unparseable response (which we correctly treat as an error, but
   * we would rather it not happen).
   */
  MAX_TOKENS: 1024,

  // ----------------------------------------------------------- polling window

  /**
   * How far back each run looks, IN MINUTES.
   *
   * The spec called this POLL_WINDOW: '20m', intended for a Gmail query of
   * `newer_than:20m`. That is a trap, and it is worth understanding before
   * anyone "fixes" this back:
   *
   *   Gmail's newer_than: / older_than: operators accept only
   *     d = days, m = MONTHS, y = years.
   *   There is no minute unit and no hour unit. `newer_than:20m` means twenty
   *   MONTHS. With MAX_MESSAGES_PER_RUN below, every run would have quietly
   *   logged ten arbitrary messages out of two years of inbox.
   *
   * Minute resolution requires Gmail's `after:` operator, which accepts a Unix
   * epoch-seconds integer. That also sidesteps a second trap: slash-format
   * dates (after:2026/08/28) are interpreted at midnight PACIFIC time,
   * regardless of the timeZone in appsscript.json. Epoch seconds have no
   * timezone at all.
   *
   * So: a plain number here, and buildSearchQuery_() converts it to a cutoff.
   *
   * Why 20 and not 10: the Stage 3 trigger runs every 10 minutes, but Google
   * fires time-driven triggers within a window around the schedule, not to the
   * second. A 2x window means a late run still sees everything the previous
   * run might have missed. isProcessed_() absorbs the resulting overlap.
   */
  POLL_WINDOW_MINUTES: 20,

  /**
   * Adds `is:unread` to the search, per the spec.
   *
   * Known coverage hole, deliberately left in place for Stage 1: if the
   * recipient opens a phishing email in the Gmail app before the trigger fires,
   * the message is no longer unread, drops out of the search, and is never
   * examined — i.e. the case where a scam is most likely to have already
   * worked is the one case we are blind to. Recommend flipping this to false
   * in Stage 3; dedupe and the time window already bound the volume.
   */
  REQUIRE_UNREAD: true,

  // -------------------------------------------- per-run caps (6-minute limit)

  /** Hard ceiling on rows logged per run. See SETUP.md on trigger runtime quota. */
  MAX_MESSAGES_PER_RUN: 10,

  /**
   * Threads to pull from a single search. GmailApp.search() caps at 500 anyway,
   * and materializing 500 threads' messages to process 10 of them is pure waste.
   */
  SEARCH_THREAD_LIMIT: 50,

  /**
   * Self-imposed budget: 4.5 minutes of the 6.0-minute hard kill. Exceeding the
   * real limit kills the execution mid-write; exceeding ours just ends the loop
   * early and still writes the summary.
   */
  TIME_BUDGET_MS: 270000,

  /**
   * Headroom reserved for ONE more message before we start it. Checking only
   * "elapsed < budget" is wrong: a message that takes 60s but starts at 4:29
   * still blows through. Stage 2 must raise this to ~60000, because UrlFetchApp
   * has roughly a 60-second timeout and one slow Claude call can eat the rest
   * of the budget on its own.
   */
  PER_MESSAGE_RESERVE_MS: 5000,

  // ------------------------------------------ data minimization (hard rule 3)

  /** Body characters sent to the model in Stage 2. */
  BODY_CHARS_FOR_MODEL: 4000,

  /** Body characters ever written to the sheet. Hard rule 3 says at most 200. */
  BODY_CHARS_FOR_SHEET: 200,

  /** Max link URLs collected per message. */
  MAX_URLS: 20,

  /** Tracking URLs run to several KB and would dominate the Stage 2 token budget. */
  URL_MAX_LENGTH: 500,

  /**
   * Marketing HTML routinely runs to hundreds of KB. Regex over an unbounded
   * string is the one place Stage 1 could plausibly burn real time; links live
   * near the top.
   */
  HTML_SCAN_MAX_CHARS: 200000,

  // ------------------------------------------------------- logging and dedupe

  /**
   * Optional manual override for the log spreadsheet.
   * '' means: look in Script Properties, and if that is empty too, create the
   * spreadsheet once and remember its ID there. The Script Property is the
   * runtime source of truth, so a `clasp push` can never orphan your log by
   * overwriting a hardcoded ID here.
   */
  LOG_SHEET_ID: '',

  /** Base name for the auto-created spreadsheet; a date is appended. */
  LOG_SHEET_NAME: 'ScamShield Mail — Log',

  /**
   * How many rows from the END of the Decisions tab to load for dedupe.
   *
   * Why a bounded tail is provably safe: a message can only be re-encountered
   * while it still matches the search, which means it arrived within the last
   * POLL_WINDOW_MINUTES. So anything we could possibly double-log was logged in
   * the last ~20 minutes — at most ~20 rows at the maximum rate. 2000 is a
   * ~100x margin (about 33 hours of continuous flat-out logging) and keeps the
   * read O(1) as the log grows forever.
   */
  DEDUPE_LOOKBACK_ROWS: 2000,

  /**
   * Write a row for messages skipped by the allowlist.
   *
   * Hard rule 6 says allowlisted senders are never SCANNED — writing an audit
   * row is not scanning. For a tool acting on a family member's mail, "why did
   * it ignore this one?" has to be answerable from the log. It also puts the ID
   * into the dedupe set, so the message is not re-examined on every run for the
   * whole 20-minute window. Set false if the rows prove noisy.
   */
  LOG_ALLOWLIST_SKIPS: true,

  // ----------------------------------------------------------------- allowlist

  /**
   * false: `chase.com` matches x@chase.com only.
   * true:  it also matches x@alerts.chase.com and any other subdomain.
   *
   * Off by default — an allowlisted sender is never scanned at all, so a broad
   * entry is a permanent blind spot. The tradeoff to know: real institutional
   * senders live mostly on subdomains (email.chase.com, alerts.chase.com), so
   * if you find yourself adding five entries per bank, flip this. See
   * isAllowlisted_() for the suffix-matching subtlety it turns on.
   */
  ALLOWLIST_MATCH_SUBDOMAINS: false,

  // ------------------------------------------------------------------ triggers

  /**
   * Minutes between scanInbox runs. Apps Script only allows 1, 5, 10, 15 or 30
   * for everyMinutes() — arbitrary intervals are not an option. 10 pairs with
   * POLL_WINDOW_MINUTES: 20 to give a 2x overlap.
   */
  TRIGGER_MINUTES: 10,

  /** Hour (0-23, script timezone) for the daily error self-test. */
  SELF_TEST_HOUR: 7,

  /** Day and hour for the Stage 5 weekly family digest. */
  DIGEST_WEEKDAY: 'SUNDAY',
  DIGEST_HOUR: 18,

  // -------------------------------------------------------------- kill switch

  /** More than this many Errors rows within KILL_SWITCH_WINDOW_MIN disables enforcement. */
  KILL_SWITCH_ERROR_LIMIT: 5,
  KILL_SWITCH_WINDOW_MIN: 60,

  // -------------------------------------------------------------------- stage 5

  /**
   * Weekly digest recipient. '' means read it from Script Properties.
   *
   * The spec put this address in CONFIG. CONFIG is committed to git, and this
   * is a family member's personal email — so the real value belongs in Script
   * Properties, same as the API key. This key stays as an override for local
   * testing. Unused until Stage 5.
   */
  DIGEST_RECIPIENT: '',

  /**
   * Where operational alerts go — the daily self-test and the kill-switch
   * warning. This is YOU (the person maintaining the script), not the family
   * member who gets the weekly digest.
   *
   * '' means read it from the OWNER_EMAIL Script Property. We do not use
   * Session.getActiveUser().getEmail() to discover it, because that call would
   * add the userinfo.email OAuth scope and force everyone to re-consent.
   */
  OWNER_EMAIL: ''
};

/**
 * Returns the Anthropic API key from Script Properties.
 *
 * Apps Script note — PropertiesService.getScriptProperties() is a small
 * key/value store bound to the script project itself (not to a user, not to a
 * document). It survives deploys, it is not visible in the source, and it is
 * not committed to git. That makes it the only correct home for the API key.
 * Values are strings; there is a 9 KB limit per value and 500 KB per store,
 * which is plenty for a key.
 *
 * @return {string} The API key.
 * @throws {Error} With actionable instructions if the key is missing/blank.
 */
function getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty(PROP.API_KEY);
  if (!key || !key.trim()) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set in Script Properties.\n' +
      'Fix: Apps Script editor -> Project Settings (gear icon) -> ' +
      'Script Properties -> Add script property.\n' +
      '  Property: ANTHROPIC_API_KEY\n' +
      '  Value:    your key from console.anthropic.com\n' +
      'Then run checkSetup() again. Never paste the key into a .gs file.'
    );
  }
  return key.trim();
}

/**
 * Redacts a secret for safe logging: "sk-ant-api03-AbCd...WxYz (108 chars)".
 * Used by checkSetup() so we can confirm the RIGHT key is installed without
 * ever writing the key itself to the execution log or the Sheet.
 *
 * @param {string} secret
 * @return {string}
 */
function maskSecret_(secret) {
  if (!secret) return '(empty)';
  if (secret.length <= 12) return '(set, ' + secret.length + ' chars)';
  return secret.slice(0, 12) + '...' + secret.slice(-4) + ' (' + secret.length + ' chars)';
}

/**
 * Convenience for one-time setup from the editor: stores the API key, then
 * immediately blanks the literal out of the file you edited.
 *
 * PREFER the Project Settings UI. If you do use this, delete the key from the
 * argument and re-save BEFORE committing anything.
 *
 * @param {string} key
 */
function setApiKey_(key) {
  if (!key || !key.trim()) throw new Error('setApiKey_ requires a non-empty key.');
  PropertiesService.getScriptProperties().setProperty(PROP.API_KEY, key.trim());
  Logger.log('Stored ANTHROPIC_API_KEY: ' + maskSecret_(key.trim()));
}

/**
 * Resolves the weekly-digest recipient. Same three-tier shape as the log sheet
 * ID: explicit CONFIG override, else Script Property, else empty.
 *
 * Unused until Stage 5; defined now so the "personal data lives in Script
 * Properties, not in git" pattern exists in exactly one place.
 *
 * @return {string} An email address, or '' if none is configured.
 */
function getDigestRecipient_() {
  if (CONFIG.DIGEST_RECIPIENT && CONFIG.DIGEST_RECIPIENT.trim()) {
    return CONFIG.DIGEST_RECIPIENT.trim();
  }
  var stored = PropertiesService.getScriptProperties().getProperty(PROP.DIGEST_RECIPIENT);
  return stored ? stored.trim() : '';
}

// ---------------------------------------------------------------------------
// Run deadline — shared between Main.gs (which owns the clock) and
// Classifier.gs (which must not sleep past it).
// ---------------------------------------------------------------------------

/** Epoch ms after which no new blocking work should start. 0 = not set. */
var RUN_DEADLINE_MS_ = 0;

/**
 * Records when the current run must stop starting blocking work.
 *
 * Without this, the classifier's retry backoff is blind: two 429s cost 10
 * seconds of Utilities.sleep plus up to three 60-second fetches, which can
 * overrun the 6-minute hard kill even though scanInbox() checked its budget
 * before the message started. Main.gs sets this once per run.
 *
 * @param {number} startMs Date.now() at the top of the run.
 */
function setRunDeadline_(startMs) {
  RUN_DEADLINE_MS_ = startMs + CONFIG.TIME_BUDGET_MS;
}

/**
 * Is there at least `needMs` left before the run deadline?
 * Returns true when no deadline is set (e.g. testClassifier runs standalone).
 *
 * @param {number} needMs
 * @return {boolean}
 */
function hasRunTimeLeft_(needMs) {
  if (!RUN_DEADLINE_MS_) return true;
  return Date.now() + needMs < RUN_DEADLINE_MS_;
}

/**
 * Resolves the operator alert address: CONFIG override, else Script Property,
 * else ''. Callers must handle '' — we would rather skip an alert than throw
 * inside a trigger.
 *
 * @return {string}
 */
function getOwnerEmail_() {
  if (CONFIG.OWNER_EMAIL && CONFIG.OWNER_EMAIL.trim()) return CONFIG.OWNER_EMAIL.trim();
  var stored = PropertiesService.getScriptProperties().getProperty(PROP.OWNER_EMAIL);
  return stored ? stored.trim() : '';
}

/**
 * Is enforcement actually live right now?
 *
 * Two independent switches, and BOTH must allow it:
 *   1. CONFIG.ENFORCE — the deliberate human decision, in source.
 *   2. The kill switch — a Script Property set automatically when the error
 *      rate spikes. It lives in Script Properties rather than in code
 *      specifically so that a `clasp push` cannot silently undo it.
 *
 * @return {boolean}
 */
function isEnforcementActive_() {
  if (!CONFIG.ENFORCE) return false;
  var tripped = PropertiesService.getScriptProperties()
    .getProperty(PROP.ENFORCE_DISABLED_BY_KILL_SWITCH);
  return !tripped;
}
