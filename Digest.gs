/**
 * Digest.gs — the weekly plain-language summary for a trusted family member.
 *
 * STAGE 5 will implement:
 *   sendWeeklyDigest()  Sunday-evening trigger target
 *   sendDigestNow()     manual run for testing against real log data
 *
 * The digest lists sender + subject of quarantined mail only. Never bodies.
 *
 * Scope note: sending mail needs an OAuth scope we have NOT added yet
 * (script.send_mail). See SETUP.md "Scopes we will need later".
 */
