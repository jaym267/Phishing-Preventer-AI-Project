/**
 * Logger.gs — the Google Sheet audit trail.
 *
 * STAGE 1 will implement:
 *   getLogSheet_()   auto-create the spreadsheet with Decisions /
 *                    Config-Allowlist / Errors tabs on first run
 *   logDecision_()   one row per classified message
 *   logError_()      one row per failure (fail-safe: no action is ever taken
 *                    on a message whose processing errored)
 *   getAllowlist_()  senders/domains that are never scanned
 *   isProcessed_()   message-ID dedupe so re-runs never double-log
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
