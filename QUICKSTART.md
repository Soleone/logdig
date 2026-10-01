# LogDig quickstart

A small work journal in your existing Obsidian daily notes. Start manually, with one day, and keep automatic capture off until the results feel useful.

## 1. Install and configure

With Node.js 22.19+ and Pi installed (once the first npm release is published):

```sh
npm install -g logdig
logdig init
```

Before the first release, run `npm link` from this project folder instead. No build step is needed. To work directly from the checkout without installing, replace `logdig` below with `node ./bin/logdig.js`.

In the wizard:

- **Daily-notes folder:** choose the folder holding `YYYY-MM-DD.md` notes, for example `My Vault/Daily`.
- **Summary cache:** choose `My Vault/LogDig` to keep the full summaries visible in Obsidian.
- **Heading and length:** `# Projects` and `small` are a good first try. Your personal `# Log` stays separate.
- **Timezone:** check that this is the timezone you journal in.
- **Advanced settings:** choose a custom Pi history folder, executable, model, or thinking level here. Thinking defaults to no LogDig override; choose an explicit level such as `max` for a cost-first reasoning model if you are willing to wait longer.
- **Automatic capture:** choose **no** for now.
- **Pi extension:** optional. The CLI works without it.

Press Enter to accept defaults. A typo only re-asks that question. Review the choices before saving. Ctrl+C or declining confirmation leaves your settings unchanged. Setup writes settings only, not summaries or daily notes.

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

If no history is found at all, start a saved Pi session or select the right history folder in the wizard's advanced settings.

## 3. Make the first entry

Once the preview looks right, run the same range without `--dry-run`:

```sh
logdig backfill 1
```

To override the model and thinking level for one run, use `logdig backfill 1 --model provider/model --thinking max`. Use `--thinking default` to ignore a saved thinking override. More thinking may improve factual reconstruction, but can increase latency and token cost; available effort depends on the model. Saved thinking preferences also apply to `/journal` and automatic capture.

This may send selected, redacted history to your Pi model and incur provider charges. Pi uses its existing authentication. If authentication fails, open Pi, run `/login`, then retry. Common secrets are redacted, but redaction is not a complete secret scanner.

Open the daily-note date printed by the command. You will find project subheadings under `# Projects`, with timestamped summaries grouped beneath each one. Your existing text stays in place. Click a timestamp to open that entry's saved snapshot of all three summary lengths, or browse `<cache folder>/Sessions/` for the latest work-block summaries.

Repeating unchanged work reuses its summary and does not insert that entry again. Session renames and other bookkeeping do not trigger regeneration. New work in the same block updates that block's row; continuation blocks get separate linked entries. Manually edited blurbs and older snapshots in `Entries/` are preserved. Run only one save at a time against your journal, and let vault sync finish first.

If you used the older whole-session journal format, the first real save regenerates summaries for selected work blocks and migrates the old rows while keeping their linked snapshots. Preview before saving to check the dates and model work.

## Optional: use `/journal` inside Pi

```sh
logdig pi-install
```

Restart Pi or run `/reload`. Then, inside Pi:

```text
/journal backfill 1 --dry-run
/journal
```

The first command previews today. The second journals the current session using your active Pi model, unless you configured an override. Automatic capture remains off unless you enable it.

## Updating

After a new npm release:

```sh
npm install -g logdig@latest
logdig --version
```

For more commands, privacy details, and troubleshooting, see [README.md](README.md).
