# LogDig quickstart

A small work journal in your existing Obsidian daily notes, built from your Pi and Claude Code sessions. Start manually, with one day, and keep automatic capture off until the results feel useful.

## 1. Install and configure

With Node.js 22.19+ and either Pi or Claude Code installed and signed in:

```sh
npm install -g logdig
logdig init
```

From a source checkout, run `npm link` from this project folder instead. No build step is needed. To work directly from the checkout without installing, replace `logdig` below with `node ./bin/logdig.js`.

In the wizard:

- **Daily-notes folder:** choose the folder holding `YYYY-MM-DD.md` notes, for example `My Vault/Daily`.
- **Summary cache:** choose `My Vault/LogDig` to keep the full summaries visible in Obsidian.
- **Heading and length:** `# Projects` and `small` are a good first try. Your personal `# Log` stays separate.
- **Anchor heading:** optionally choose `# Log` to create Projects at the end of the Log section, before the next same-level or higher-level heading. The default is `none` (blank): append at the end of the note. Missing anchors also append at the end; existing Projects sections stay in place.
- **Timezone:** check that this is the timezone you journal in.
- **Summarize with:** `auto` (the default) uses Pi when it is installed, and Claude Code otherwise. One run summarizes all your sessions with that one tool. Choose `pi` or `claude` to pin one.
- **Sessions:** Pi sessions are read from your Pi history folder. Claude Code sessions are read automatically from `~/.claude/projects` when that folder exists. Both go into the same notes. You can turn Claude Code off later in `logdig config`.
- **Advanced settings:** choose a custom Pi history folder, Pi executable or Claude Code command, model, thinking level, or concurrency here. Thinking defaults to no LogDig override; choose an explicit level such as `max` for a cost-first reasoning model if you are willing to wait longer. Concurrency defaults to four independent sessions; use `1` for sequential processing.
- **Automatic capture:** choose **no** for now.
- **Pi extension:** optional. The CLI works without it.

Press Enter to accept defaults. A typo only re-asks that question. Review the choices before saving. Ctrl+C or declining confirmation leaves your settings unchanged. Setup writes settings only, not summaries or daily notes.

To change a setting later, run `logdig config`. Choose its number or type a name such as `thinking`, then enter the new value. Available choices are shown first. Enter keeps the current value; each valid change saves immediately and refreshes the list. Type `q` and Enter to exit. Environment overrides are labeled and still take precedence. Redirected output stays read-only.

## 2. Check and preview

```sh
logdig doctor
logdig status 7
logdig backfill 1 --dry-run
```

`status` counts **logged**, **stale**, and **new** work blocks, with reusable summaries counted separately from blocks needing summarization. It is read-only. The backfill preview shows projects, dates, destination files, cache hits, and which blocks need summarizing. **Neither command makes model requests or changes files.** The preview does not display transcript excerpts.

`1` means conversation activity today in your chosen timezone. Continuous overnight work stays on its starting day, so today's backfill may update yesterday's note. Resuming on a later date after at least four hours without conversation activity starts a linked continuation entry. If its preceding snapshot is missing, preview explicitly includes the earlier block needed for that link. If nothing happened today:

```sh
logdig backfill 7 --dry-run
```

To backfill older work without spending model requests on ongoing sessions, add `--skip-today`:

```sh
logdig backfill 7 --skip-today --dry-run
logdig backfill 7 --skip-today
logdig backfill 14 --skip-today
logdig backfill 30 --skip-today
```

This selects complete calendar days through yesterday in your timezone and excludes whole work periods that continued today. Earlier periods in the same session can still be logged. Each wider run keeps saved summaries and creates only the missing ones. The flag also works with `backfill all` and `status`.

If no history is found at all, start a saved Pi or Claude Code session, or select the right history folder in the wizard's advanced settings. `doctor` shows which history folders and summary backend LogDig is using.

## 3. Make the first entry

Once the preview looks right, run the same range without `--dry-run`:

```sh
logdig backfill 1
```

To override the model and thinking level for one run, use `logdig backfill 1 --model provider/model --thinking max`. Add `--agent claude` to summarize with Claude Code for that run, for example `logdig backfill 1 --agent claude --model haiku --thinking high`. The saved agent setting does not change. Use `--thinking default` to ignore a saved thinking override. More thinking may improve factual reconstruction, but can increase latency and token cost; available effort depends on the model. Saved thinking preferences also apply to `/journal` and automatic capture.

This may send selected, redacted history to your summary model and incur provider charges. Pi uses its existing authentication, and Claude Code uses your `claude` login. If authentication fails, run `/login` in Pi or `claude`, then retry. Common secrets are redacted, but redaction is not a complete secret scanner.

Open the daily-note date printed by the command. You will find project subheadings under `# Projects`, with timestamped summaries grouped beneath each one. Your existing text stays in place. Click a timestamp to open that entry's saved snapshot of all three summary lengths, or browse `<cache folder>/Sessions/` for the latest work-block summaries. Snapshots written from now on include `agent: pi` or `agent: claude-code` in their front matter.

Repeating a run keeps saved summaries and does not insert their entries again. New messages in a session that already has a summary do not change that summary until you run with `--force`. Work that starts a new block gets its own summary and a linked entry. Manually edited blurbs and older snapshots in `Entries/` are preserved. Run only one save at a time against your journal, and let vault sync finish first.

If you used the older whole-session journal format, the first real save migrates the old rows to their work blocks and keeps their linked snapshots. Their summaries stay as they are unless you run with `--force`. Preview before saving to check the dates and model work.

Existing summaries are kept when LogDig upgrades, and when you change the model or thinking level. LogDig never regenerates a saved summary on its own. To rewrite summaries after an upgrade or a settings change, run `logdig backfill N --force` for the days you want rewritten, and preview it with `--dry-run` first. To use another model or thinking level for missing summaries only, pass `--model` and `--thinking` without `--force`.

## Optional: use `/journal` inside Pi

```sh
logdig pi-install
```

Restart Pi or run `/reload`. Then, inside Pi:

```text
/journal backfill 1 --dry-run
/journal
```

The first command previews today. The second journals the current session using your active Pi model, unless you configured a `provider/model` override. This extension always uses Pi's models, even when the summary backend is set to Claude Code. Automatic capture remains off unless you enable it.

## Updating

After a new npm release:

```sh
npm install -g logdig@latest
logdig --version
```

For more commands, privacy details, and troubleshooting, see [the full reference](docs/usage.md).
