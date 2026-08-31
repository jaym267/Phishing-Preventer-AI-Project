/**
 * Digest.gs — the weekly summary email for a trusted family member.
 *
 * STAGE 5.
 *
 * The audience for this email is NOT a developer. It is the son, daughter, or
 * grandchild who agreed to keep an eye on things. Everything here should read
 * like a short, calm note from a helpful neighbour:
 *
 *   - no jargon: no "verdicts", no "confidence scores", no "classifier"
 *   - no numbers that do not help someone decide whether to do anything
 *   - never alarming: most weeks the honest summary is "nothing to worry about"
 *   - always state that nothing was deleted, because that is the fear
 *
 * Hard rule 3 applies here too: sender and subject only. No message bodies ever
 * appear in this email, not even the 200-character preview.
 */

/**
 * Weekly trigger target. Installed by installTriggers().
 */
function sendWeeklyDigest() {
  sendDigest_(7);
}

/**
 * Run from the "Run" dropdown to send the digest immediately, for testing.
 */
function sendDigestNow() {
  sendDigest_(7);
}

/**
 * Builds and sends the digest for the last `days` days.
 *
 * @param {number} days
 */
function sendDigest_(days) {
  var to = getDigestRecipient_();
  if (!to) {
    Logger.log('No digest recipient configured, so nothing was sent.');
    Logger.log('Fix: Apps Script editor -> Project Settings -> Script Properties ' +
               '-> add ' + PROP.DIGEST_RECIPIENT + ' with the family member\'s ' +
               'email address. Ask them first — this is their inbox too.');
    return;
  }

  var sinceMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  var rows;
  try {
    rows = getDecisionsSince_(sinceMs);
  } catch (err) {
    Logger.log('Could not read the log, so no digest was sent: ' + err.message);
    notifyOwner_('ScamShield: weekly digest could not be sent',
      'The digest could not read the decision log.\n\n' + err.message);
    return;
  }

  var digest = buildDigest_(rows, days);

  try {
    MailApp.sendEmail(to, digest.subject, digest.body);
    Logger.log('Digest sent to ' + to + ' — ' + digest.subject);
  } catch (err) {
    Logger.log('Could not send the digest: ' + err.message);
    notifyOwner_('ScamShield: weekly digest could not be sent', err.message);
  }
}

/**
 * Turns log rows into the digest email.
 *
 * PURE — no reading, no sending. Everything that decides what the family member
 * reads lives here, so the wording can be tested and reviewed without sending
 * anything to anyone.
 *
 * @param {Object[]} rows From getDecisionsSince_().
 * @param {number} days
 * @return {{subject: string, body: string}}
 */
function buildDigest_(rows, days) {
  var quarantined = [];
  var flagged = [];
  var scanned = 0;

  for (var i = 0; i < rows.length; i++) {
    var action = String(rows[i]['Action Taken'] || '');
    scanned++;
    if (action.indexOf(ACTION.QUARANTINED) === 0) quarantined.push(rows[i]);
    else if (action.indexOf(ACTION.FLAGGED) === 0) flagged.push(rows[i]);
  }

  // Each entry is a paragraph; wrap_ handles line length so no sentence is ever
  // broken awkwardly by hand-wrapping.
  var paras = [];
  paras.push('Hello,');
  paras.push('Here is this week\'s note from ScamShield, the helper that keeps an eye on ' +
             'the email inbox for scams.');

  if (scanned === 0) {
    paras.push('There was no new email to look at this week.');
    paras.push('Nothing needs doing.');
    return { subject: 'ScamShield: a quiet week', body: render_(paras) };
  }

  paras.push('This week it read through ' + countPhrase_(scanned, 'message', 'messages') + '.');

  if (quarantined.length === 0 && flagged.length === 0) {
    paras.push('Nothing looked like a scam. That is good news, and there is nothing for ' +
               'you to do.');
    paras.push(CLOSING_);
    return { subject: 'ScamShield: nothing to worry about this week', body: render_(paras) };
  }

  if (quarantined.length > 0) {
    paras.push('It set aside ' + countPhrase_(quarantined.length, 'message', 'messages') +
               ' that looked like a scam:');
    // A pre-formatted block: wrap_ leaves lines starting with a space alone.
    var listed = [];
    for (var q = 0; q < quarantined.length; q++) {
      listed.push('   - "' + oneLine_(quarantined[q]['Subject']) + '"');
      listed.push('     from ' + oneLine_(quarantined[q]['Sender']));
    }
    paras.push(listed.join('\n'));
    paras.push('These have NOT been deleted. Nothing is ever deleted. They were moved out ' +
               'of the inbox into a folder called "ScamShield/Quarantine", where they can ' +
               'be read at any time.');
  }

  if (flagged.length > 0) {
    // "also" only reads correctly when something was already mentioned above.
    paras.push((quarantined.length > 0 ? 'It also put' : 'It put') +
               ' a warning label on ' + countPhrase_(flagged.length, 'message', 'messages') +
               ' that seemed a little odd, but not clearly a scam. Those are still sitting ' +
               'in the inbox as usual, just marked so they are easier to spot.');
  }

  if (quarantined.length > 0) {
    paras.push('If one of those set-aside messages was actually a real email, it can be put ' +
               'straight back into the inbox, and ScamShield will learn to leave that ' +
               'sender alone from then on. Just reply to this email and say which one, and ' +
               'it can be restored in a minute.');
  }

  paras.push(CLOSING_);

  var subject = quarantined.length > 0
    ? 'ScamShield: ' + countPhrase_(quarantined.length, 'message', 'messages') + ' set aside this week'
    : 'ScamShield: ' + countPhrase_(flagged.length, 'message', 'messages') + ' worth a look';

  return { subject: subject, body: render_(paras) };
}

/** The sign-off, identical in every version of the email. */
var CLOSING_ =
  'ScamShield never deletes anything, and it never replies to anyone. It only ' +
  'moves suspicious mail aside so it is easier to ignore.\n\n- ScamShield';

/**
 * Joins paragraphs with blank lines, wrapping each to a comfortable width.
 * @param {string[]} paras
 * @return {string}
 */
function render_(paras) {
  var out = [];
  for (var i = 0; i < paras.length; i++) out.push(wrap_(paras[i], 72));
  return out.join('\n\n');
}

/**
 * Word-wraps text to `width` columns.
 *
 * Lines that are already indented (the quarantined-message list) are passed
 * through untouched, so the list keeps its shape.
 *
 * @param {string} text
 * @param {number} width
 * @return {string}
 */
function wrap_(text, width) {
  var lines = String(text).split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.charAt(0) === ' ' || line.length <= width) { out.push(line); continue; }
    var words = line.split(' ');
    var current = '';
    for (var w = 0; w < words.length; w++) {
      if (!current) { current = words[w]; continue; }
      if ((current + ' ' + words[w]).length <= width) current += ' ' + words[w];
      else { out.push(current); current = words[w]; }
    }
    if (current) out.push(current);
  }
  return out.join('\n');
}

/**
 * "1 message" / "4 messages".
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @return {string}
 */
function countPhrase_(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

/**
 * Collapses whitespace and trims a field to a readable length for the email.
 * Subjects are attacker-controlled, so a 900-character subject would otherwise
 * wreck the layout of a message a family member has to read.
 *
 * @param {*} value
 * @return {string}
 */
function oneLine_(value) {
  var s = String(value === null || value === undefined ? '' : value)
    .replace(/^'/, '')          // drop the sheet's text marker if it survived
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '(no subject)';
  return s.length > 120 ? s.slice(0, 120) + '...' : s;
}
