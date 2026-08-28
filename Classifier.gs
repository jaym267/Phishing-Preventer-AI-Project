/**
 * Classifier.gs — the Anthropic Claude API call.
 *
 * STAGE 2 will implement:
 *   classifyMessage_(payload)  POST https://api.anthropic.com/v1/messages
 *   buildPrompt_(payload)      the verbatim classification prompt from the spec
 *   parseVerdict_(text)        fence-stripping + strict JSON validation
 *
 * Hard rule 3: the payload carries only sender, reply-to, subject, the first
 * ~4,000 characters of the plain-text body, and the list of link URLs.
 * No attachments, ever.
 *
 * Hard rule 4: every failure path returns {verdict: 'error'} so that Main.gs
 * takes NO action on the message.
 */
