# ScamShield Mail — Setup (Stage 0)

A Google Apps Script that watches an older adult's Gmail inbox, classifies new
mail with the Anthropic Claude API, and quarantines likely scams by **labeling
and archiving** them. It never deletes anything.

Stage 0 gets the project created, the files in place, the scopes declared, and
the API key stored — and gives you one function, `checkSetup()`, that proves
all of it works.

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
| `Config.gs` | Secrets access (`getApiKey_`); `CONFIG` object lands in Stage 1 | Stage 0 ✅ |
| `Main.gs` | Entry points; `checkSetup()` now, `scanInbox()` in Stage 1 | Stage 0 ✅ |
| `Logger.gs` | Google Sheet audit trail | Stage 1 |
| `Classifier.gs` | Anthropic API call + verdict parsing | Stage 2 |
| `Digest.gs` | Weekly family summary email | Stage 5 |

`timeZone` in the manifest is set to `America/New_York`. Change it if that is
not yours — it controls when the daily/weekly triggers actually fire.
