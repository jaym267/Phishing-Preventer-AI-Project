/**
 * Main.gs — entry points for ScamShield Mail.
 *
 * STAGE 0: setup verification only. scanInbox() arrives in Stage 1.
 *
 * Functions WITHOUT a trailing underscore are the ones you can select in the
 * Apps Script editor's "Run" dropdown. Keep that list short and intentional.
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
