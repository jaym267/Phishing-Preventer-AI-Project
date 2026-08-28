/**
 * Config.gs — configuration + secret access for ScamShield Mail.
 *
 * STAGE 0: secrets only. The CONFIG object arrives in Stage 1.
 *
 * Apps Script note — the trailing underscore on a function name (getApiKey_)
 * is a real language feature here, not a style choice. Apps Script hides
 * underscore-suffixed functions from the "Run" dropdown, from custom-function
 * autocomplete in Sheets, and from library consumers. Use it for every internal
 * helper so the only things a human can click "Run" on are the entry points we
 * intend (checkSetup, scanInbox, installTriggers, ...).
 */

/** Script Property keys. Never put values here — only the names of the slots. */
var PROP = {
  API_KEY: 'ANTHROPIC_API_KEY',
  LOG_SHEET_ID: 'LOG_SHEET_ID',
  ENFORCE_DISABLED_BY_KILL_SWITCH: 'ENFORCE_DISABLED_BY_KILL_SWITCH'
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
