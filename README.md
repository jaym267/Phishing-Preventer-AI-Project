# ScamShield Mail

A Google Apps Script that watches an older adult's Gmail inbox for phishing and
scams. Every few minutes it reads new mail, asks Claude whether each message
looks like a scam, and moves the convincing ones out of the way — by **labelling
and archiving them, never deleting**. Every decision is written to a Google
Sheet so you can check its work.

It is built to be boring and reversible. The worst thing it can do to a real
email is put it in a folder.

---

## The six hard rules

These are not preferences. They are the design, and the code is arranged so
breaking one requires deliberate effort.

1. **It never deletes email.** The strongest action possible is: apply a label,
   remove from the inbox (archive), and mark as read. There is no `moveToTrash`
   call anywhere, and the OAuth scope it requests (`gmail.modify`) is physically
   incapable of deleting mail even if someone added one.
2. **It ships switched off.** Until you deliberately set `ENFORCE: true` in
   `Config.gs`, it only watches and logs. It will not touch a single label.
3. **It sends the minimum.** Only the sender, reply-to, subject, the list of
   link URLs, and the first ~4,000 characters of the plain-text body ever leave
   your account. Never attachments. The Sheet stores at most 200 characters of
   any body.
4. **It fails safe.** Any error — API down, bad JSON, a timeout, an ambiguous
   answer — results in *no action* on that message and an error row in the log.
   An email is never quarantined because of a bug.
5. **The API key lives in Script Properties only.** Never in the source, never
   in a log, never in the Sheet.
6. **The allowlist is absolute.** A sender on the allowlist is never scanned and
   never quarantined, whatever the classifier might say.

---

## How it works

```
every 10 minutes
   -> search Gmail: in:inbox is:unread -from:me after:<20 minutes ago>
   -> skip messages already in the log (by message ID)
   -> skip allowlisted senders entirely
   -> build a minimal payload (sender, reply-to, subject, links, truncated body)
   -> ask Claude to classify it: scam / suspicious / safe, with a confidence
   -> write one row to the Decisions sheet
   -> if ENFORCE is on:
        scam AND confidence >= 0.85 -> label "ScamShield/Quarantine", archive, mark read
        suspicious, or scam below   -> label "ScamShield/Suspicious", leave in inbox
        safe                        -> do nothing
weekly -> email a plain-language summary to a trusted family member
daily  -> email you if anything errored
```

| File | What it does |
|---|---|
| `appsscript.json` | Manifest: runtime, timezone, the five OAuth scopes |
| `Config.gs` | `CONFIG`, the API key, the run deadline, the enforcement switch |
| `Main.gs` | `scanInbox()`, payload extraction, triggers, enforcement, undo |
| `Classifier.gs` | The Anthropic API call, the prompt, verdict validation |
| `Logger.gs` | The Google Sheet: decisions, allowlist, errors, summary |
| `Digest.gs` | The weekly family email |

`SETUP.md` has the step-by-step install and the Apps Script quota notes.

**Two frontends live alongside the script:**

- A **maintainer dashboard** (`Dashboard.gs` + `Dashboard.html`) served by the
  script itself as a private web app — browse decisions, mark rows WRONG, restore
  a message, manage the allowlist. Deploy steps are in `SETUP.md` §8.
- A **public landing page** (`site/`, Astro, static) explaining the project.
  Built by GitHub Actions to GitHub Pages on push.

---

## Installing it on a family member's account

**Get their consent first, in plain words.** This reads their email. Say so.
Something like: *"It looks at who sent each message and what it says, sends a
short summary to an AI service to ask whether it looks like a scam, and moves
the bad ones into a folder. It never deletes anything, and I get a weekly
summary. Can I set it up?"* If they are uncomfortable, stop.

Then, on their account (roughly 30 minutes):

1. **Create the script.** <https://script.google.com> → New project → name it
   *ScamShield Mail*. Project Settings → tick "Show `appsscript.json` manifest
   file in editor".
2. **Add the code.** Either `clasp push` from this repo, or paste each `.gs`
   file into the editor with the ✚ button (name them `Config`, `Main`,
   `Classifier`, `Logger`, `Digest`), and paste `appsscript.json` into the
   manifest.
3. **Add the API key.** Get one from <https://console.anthropic.com>. In Project
   Settings → Script Properties, add `ANTHROPIC_API_KEY`.
4. **Add the two addresses**, also as Script Properties:
   - `OWNER_EMAIL` — you. Gets error alerts.
   - `DIGEST_RECIPIENT` — whoever gets the friendly weekly summary.
5. **Run `checkSetup`.** Approve the consent screen (it will say Google hasn't
   verified the app — that is expected for a script you wrote). It should log
   `setup OK`.
6. **Run `initLogSheet`.** It creates the spreadsheet and prints the link. Open
   it and bookmark it.
7. **Run `scanInbox` once by hand.** Check the Decisions tab looks sane.
8. **Run `installTriggers`.** It now runs on its own.
9. **Leave it in observe-only mode for at least a week.** This is the important
   step — see below.

### Do not skip the observe-only week

`ENFORCE` starts `false` on purpose. Let it watch a real inbox for a week and
read the Decisions tab with the person whose inbox it is. You are looking for
rows where it called something a scam that obviously was not. Every one of those
is a real email it would have hidden.

When the verdicts look right, set `ENFORCE: true` in `Config.gs` and push again.
Nothing else changes.

---

## Reading the Sheet

**Decisions** — one row per message.

| Column | Meaning |
|---|---|
| Timestamp / Message Date | when the row was written / when the mail arrived |
| Sender / Reply-To | Reply-To is blank unless it *differs* from the sender, which is itself a warning sign |
| Subject / Body Preview | first 200 characters only |
| URL Count | how many links were found; a surprising `0` often explains a surprising verdict |
| Verdict / Confidence / Reasons | what Claude decided and why |
| Action Taken | `none (observe-only)`, `QUARANTINED`, `FLAGGED`, `RESTORED` |
| Error | only filled when something went wrong |
| **Review** | **yours** — type `WRONG` next to anything you disagree with |

**Config-Allowlist** — one email or domain per row. Lines starting with `#` are
ignored. `chase.com` matches `x@chase.com` but not `x@alerts.chase.com`; add
subdomains explicitly, or flip `ALLOWLIST_MATCH_SUBDOMAINS` in `Config.gs`.
Be sparing: **an allowlisted sender is never examined at all**, and From
addresses can be forged.

**Errors** — anything that failed. Should be nearly empty.

**Summary** — live formulas. The number to watch is **precision on quarantine**:
of everything it set aside, how much really was a scam. It only becomes
meaningful once you have marked some rows `WRONG`.

---

## How to undo anything

| You want to | Do this |
|---|---|
| Get one message back | Copy its Message ID from the Decisions tab. Project Settings → Script Properties → add `RESTORE_MESSAGE_ID` = that ID. Run `restoreMessage`. It returns to the inbox, the sender is allowlisted so it cannot recur, and the property is cleared. (The Run dropdown cannot pass arguments, hence the property.) |
| Stop quarantining, keep watching | Set `ENFORCE: false` in `Config.gs`, push. |
| Stop it running entirely | Run `removeTriggers()`. |
| Find everything it has hidden | Open the `ScamShield/Quarantine` label in Gmail. Nothing was deleted; it is all there. |
| Remove it completely | `removeTriggers()`, delete the Apps Script project, delete the two ScamShield labels in Gmail. Mail that was archived stays archived — search the label first and move anything you want back. |

### The kill switch

If more than 5 errors are logged in an hour, it disables enforcement by itself
and emails `OWNER_EMAIL`. The reasoning: a system that is failing repeatedly
does not understand what is happening, and something that does not understand
what is happening should not be moving someone's mail. It keeps watching and
logging while stopped. Run `clearKillSwitch()` once you have fixed the cause.

---

## What it costs

One Claude API call per new message. On `claude-haiku-4-5` (the default) that is
roughly **$3 a month** at about 50 emails a day. Switching `CONFIG.MODEL` to
`claude-sonnet-4-6` is about $9, `claude-opus-5` about $15. Google charges
nothing.

`MAX_MESSAGES_PER_RUN: 10` caps this: at most 10 calls per run, 144 runs a day.

---

## Known limitations

Worth being honest about:

- **It only sees unread inbox mail.** If the message is opened before the next
  run, it drops out of the search and is never examined — which is exactly the
  case where a scam has most likely already worked. Setting
  `REQUIRE_UNREAD: false` closes this at the cost of scanning more.
- **Throughput is capped** at ~60 messages an hour. A very busy inbox will
  overflow it, and the excess is skipped rather than queued.
- **The allowlist trusts the From header**, which can be forged. Prefer exact
  addresses over whole domains.
- **A scam replying inside a real conversation is only flagged, never
  archived.** Gmail archives whole threads, so archiving would hide the real
  conversation too. Deliberate: labelling is recoverable, hiding is not.
- **Prompt injection is possible in principle** — the email body is untrusted
  text going to a model. The response schema bounds the damage: the worst
  outcome is a missed scam, never a wrongly quarantined real email.
- **It cannot share the log spreadsheet** with anyone, because that would need a
  Drive scope it deliberately does not request. Share it by hand if you want to.

---

## Confirm on the first live run

This code was tested against simulated Google services, and Google's reference
docs could not be reached from the build environment. Each item below is
handled defensively either way, but confirm it once on a real run and tick it:

- [ ] `initLogSheet` creates the sheet with only the `spreadsheets` scope (no
      Drive consent prompt appears).
- [ ] In the Decisions tab, the `Sender` cell shows the address **without** a
      leading apostrophe. (If one shows, the text-marker is being stored
      literally; dedupe and injection defense still work, but tell me.)
- [ ] A message with no Reply-To header logs a blank `Reply-To` cell.
- [ ] `installTriggers` logs `OK` for all three handlers, not `SKIP`.
- [ ] Running `installTriggers` a second time creates no duplicates.
- [ ] `restoreMessage` works via the `RESTORE_MESSAGE_ID` property and clears it.

## Accuracy, honestly

**Not yet measured.** The Summary tab computes precision and recall the moment
there is data to compute them from, and this section should be filled in with
real numbers from two weeks of use before anyone relies on it.

Every false positive and false negative should turn into an edit to
`CLASSIFICATION_PROMPT` in `Classifier.gs` — not into special-case code
elsewhere. That prompt is the one place the policy lives.
