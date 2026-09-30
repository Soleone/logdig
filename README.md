# LogDig

Remember what you worked on, without writing another status report.

LogDig turns saved [Pi](https://pi.dev) sessions into short entries in your Obsidian daily notes. Your handwritten content stays in place. Each session also gets a cached Markdown note with **Small**, **Medium**, and **Large** summaries, so the details are there when you want them.

No build step, runtime dependencies, or separate model credentials. Try a safe preview before sending any history to a model.

## Start small

You need **Node.js 22.19+**, Pi installed and signed in, and a daily-notes folder using `YYYY-MM-DD.md` filenames. Custom daily-note filename formats are not supported yet.

From this checkout:

```sh
node ./bin/logdig.js init
node ./bin/logdig.js doctor
node ./bin/logdig.js backfill 1 --dry-run
```

Setup explains the choices, keeps defaults on Enter, and re-asks only the question you mistyped. It shows a review before saving. Declining that review or pressing Ctrl+C leaves your settings unchanged. Setup does not summarize sessions or write daily notes.

For a comfortable first try:

- Choose the folder **inside your vault** holding your daily notes, such as `My Vault/Daily`.
- Put the summary cache in `My Vault/LogDig` if you want to browse it in Obsidian.
- Keep the `# Projects` heading and **small** summary unless you prefer otherwise. Your personal `# Log` section stays separate.
- Check the timezone. It determines the journal date and time.
- Leave automatic capture **off** until you have tried a manual run. Pi integration is optional.

`doctor` checks folder access and Pi availability without requesting a summary. It reports broken paths and a missing Pi executable together, with a next step for each.

**`--dry-run` never calls Pi, writes files, or creates folders.** It shows the projects, dates, destination files, matching cached summaries, and sessions that would need model requests. The preview does not print transcript excerpts.

When the preview looks right:

```sh
node ./bin/logdig.js backfill 1
```

This journals sessions whose last user message was **today in your configured timezone**, not a rolling 24-hour window. If today is quiet, preview seven days instead:

```sh
node ./bin/logdig.js backfill 7 --dry-run
```

See [QUICKSTART.md](QUICKSTART.md) for the short, copyable walkthrough.

## What you get

With `My Vault/Daily` and `My Vault/LogDig` selected:

```text
My Vault/
├── Daily/
│   └── YYYY-MM-DD.md             your writing, plus project-grouped summaries under # Projects
└── LogDig/
    ├── Sessions/
    │   └── <session-id>.md       latest cached summary and provenance
    └── Entries/
        └── <entry-id>.md         snapshot of all three layers for a journal entry
```

Daily entries live under `# Projects`, grouped by project in first-seen order, with timestamps sorted within each project. For [try](https://github.com/tobi/try)-style directories, a leading `YYYY-MM-DD-` is omitted from the project label: `2026-01-17-learn` becomes `learn`. The source path is unchanged.

For example:

```markdown
# Projects

## my-project

**[[<entry-id>|20:54]]**

A short summary.

**[[<another-entry-id>|21:19]]**

More work on the same project.

## another-project

**[[<single-entry-id>|23:13]]**: One entry stays compact.
```

A project with one entry puts the timestamp inline at the start of its summary. When a second entry arrives, both timestamps move to separate lines. Summary wording is preserved, including any edits you made.

Obsidian displays each link as just the timestamp; clicking it opens that entry's detailed summary. The detailed note has two compact frontmatter properties when available: `sessionUsage` for recorded Pi-session usage and `logUsage` for LogDig's summary-generation requests, including intermediate chunks. Each shows cost, cached input, uncached input, output, and elapsed time, for example `"$3.73 ⚡12.2M ↑747k ↓62k · 1h 55m"`. Session duration is wall-clock time, including idle periods; LogDig duration is the time spent generating that summary. The original session and LogDig calls are counted separately. Historical summaries made before usage tracking have no `logUsage`; their cost cannot be recovered without making new requests. Unknown cost or token counts are omitted, not shown as zero. Keep the summary cache inside your vault so Obsidian can resolve these links. Daily summaries do not create headings or code fences; structured detail stays in the linked note. Custom section headings are supported, with project subheadings one level deeper (or bold project labels beneath a level-six heading).

The **last user message** supplies the date and time, even if the assistant finishes after midnight. Alternate session branches are included as explorations, not assumed to be the final result.

Unchanged sessions reuse their summaries. The identifier in each timestamp link prevents duplicate entries, without HTML comments. Older project-name links and comment-wrapped entries are still recognized. Changing the default does not override existing saved heading preferences; rerun setup to change them. Changing the session, timezone, explicit model, summary level, or heading can append a **new version** rather than replace an earlier journal entry. Linked entry notes keep their original summary even when the latest session cache changes. Handwritten content and summary wording are preserved; an inline timestamp can be expanded when its project gains another entry. Headings inside frontmatter or fenced code are not insertion targets.

Missing daily-note and cache folders are created only by a real save. Raw Pi history stays in Pi's storage.

## Commands

All commands work as `node ./bin/logdig.js ...` from the checkout. If you prefer the shorter `logdig` command, run `npm link` once.

```text
logdig init                         configure paths, summaries, and optional Pi integration
logdig doctor                       check paths and Pi, with no model request
logdig config                       show effective settings and environment overrides
logdig backfill                     journal the last 3 calendar days
logdig backfill 7 --dry-run          preview seven days without changing anything
logdig backfill all --dry-run        preview every discoverable saved session
logdig backfill 7                    journal seven days
logdig backfill 7 --model provider/model
logdig backfill 7 --model default    ignore a saved model override for this run
logdig pi-install                   install the /journal extension
logdig pi-uninstall                 remove it without deleting notes or summaries
```

`--help` works before setup, including `logdig init --help` and `logdig backfill --help`.

New summaries may incur provider charges. Large sessions are summarized in chunks and may need several model requests each. Backfill shows which project it is working on before the model completes. Failed sessions are reported, other sessions continue, and the command exits nonzero if anything needs attention. Fix the issue and rerun the same command; completed summaries are reused, even if a previous attempt failed to write a daily note.

Run one backfill at a time against a given journal. The extension prevents overlapping saves within one Pi process, but separate CLI/Pi processes and external note editors are not coordinated. Let an existing save or vault sync finish first.

## Inside Pi

Install the extension from this checkout if you did not choose it during setup:

```sh
node ./bin/logdig.js pi-install
```

Restart Pi or run `/reload`. Then, **inside Pi**:

```text
/journal                           journal the current session
/journal backfill 1 --dry-run       preview today, including the active session
/journal backfill                   journal the last 3 calendar days
/journal backfill 7                 journal seven days
/journal backfill all               journal every discoverable session
/journal help                      show available commands
```

The extension shows progress in Pi's status area, clears it when the operation ends, and tells you where the note and full summaries live. An empty session gets a next step rather than a false “saved” message.

Automatic capture is opt-in through `logdig init` or `PI_JOURNAL_AUTO=1`. It catches up recent sessions when Pi shuts down and can delay shutdown while summaries are generated. Capture failures are reported with recovery instructions.

## Models and privacy

CLI backfill uses Pi's normal startup model and existing authentication unless you configure a `provider/model` override. It runs headless requests with **tools, extensions, skills, prompt templates, project context files, and session saving disabled**. Providers supplied only by extensions are therefore not available to CLI backfill.

`/journal` uses the current Pi model, including registered providers, unless a LogDig override is set. The preview needs no available model or authentication. `doctor` checks the executable but does not validate model authentication; open Pi and run `/login` if a real save reports an authentication problem.

Selected user prompts, assistant conclusions, tool actions, test results, and error excerpts are sent to the chosen model after common credential redaction. System prompts, hidden reasoning, and image payloads are excluded. **Redaction is not a comprehensive secret scanner.** Review your provider's data handling before processing sensitive sessions or enabling automatic capture. Summaries can also contain private project details, so treat your cache and vault accordingly.

Model summaries are aids to memory, not proof of completed work. Keep Pi history as the source of truth.

## Settings and troubleshooting

Settings contain paths and preferences, never provider credentials:

- Linux: `$XDG_CONFIG_HOME/logdig/settings.json`, or `~/.config/logdig/settings.json`
- macOS: `~/Library/Application Support/LogDig/settings.json`
- Windows: `%APPDATA%\LogDig\settings.json`

Set `LOGDIG_CONFIG_PATH` to choose another settings file. Existing `PI_JOURNAL_*` environment variables remain supported and override saved values. Setup, `config`, and `doctor` name active overrides so you can see why a saved preference is not taking effect.

- **No saved history found:** create a saved Pi session, or use setup's advanced settings to select your history folder. This is especially useful with a custom Pi session directory.
- **Notes went to the wrong folder:** run `config`, check environment overrides, then run `init` to choose the daily-notes folder rather than the vault root.
- **Pi cannot start:** run `doctor`, then use setup's advanced settings to set the executable path.
- **A summary or note failed:** read the error, fix the path, permissions, authentication, or provider issue, and rerun. Successful cached work is kept.
- **Want to stop automatic capture:** rerun `init` and choose “no”, or set `PI_JOURNAL_AUTO=0`.

## Development

```sh
npm test
```

Tests use temporary directories and local fake model responses, including CLI subprocess tests. They do not use your Pi credentials, call a provider, or write to your actual vault.
