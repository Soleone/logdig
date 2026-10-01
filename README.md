# LogDig

Remember what you worked on, without writing another status report.

LogDig turns saved [Pi](https://pi.dev) sessions into short entries in your Obsidian daily notes. Your handwritten content stays in place. Each work block also gets a cached Markdown note with **Small**, **Medium**, and **Large** summaries, so the details are there when you want them.

No build step, runtime dependencies, or separate model credentials. Try a safe preview before sending any history to a model.

## Start small

You need **Node.js 22.19+**, Pi installed and signed in, and a daily-notes folder using `YYYY-MM-DD.md` filenames. Custom daily-note filename formats are not supported yet.

Install globally to make `logdig` available on your PATH (once the first npm release is published):

```sh
npm install -g logdig
logdig init
logdig doctor
logdig backfill 1 --dry-run
```

Working from a checkout before the first release? Run `npm link` once, then use the same commands. No build step is needed. You can also run `node ./bin/logdig.js ...` without installing anything.

For a one-off run without a global install, use `npx logdig --help`.

Setup explains the choices, keeps defaults on Enter, and re-asks only the question you mistyped. It shows a review before saving. Declining that review or pressing Ctrl+C leaves your settings unchanged. Setup does not summarize sessions or write daily notes.

For a comfortable first try:

- Choose the folder **inside your vault** holding your daily notes, such as `My Vault/Daily`.
- Put the summary cache in `My Vault/LogDig` if you want to browse it in Obsidian.
- Keep the `# Projects` heading and **small** summary unless you prefer otherwise. Your personal `# Log` section stays separate.
- Check the timezone. It determines the journal date and time.
- Leave automatic capture **off** until you have tried a manual run. Pi integration is optional.

`doctor` checks folder access and Pi availability without requesting a summary. It reports broken paths and a missing Pi executable together, with a next step for each. Interactive terminals use colored Nerd Font status icons; set `LOGDIG_ICONS=0` for text markers, and `NO_COLOR` to disable color.

**`--dry-run` never calls Pi, writes files, or creates folders.** It shows the projects, dates, destination files, matching cached summaries, and sessions that would need model requests. The preview does not print transcript excerpts.

When the preview looks right:

```sh
logdig backfill 1
```

This journals work blocks with conversation activity **today in your configured timezone**, not a rolling 24-hour window. Overnight work can update yesterday's note without moving it to today. If today is quiet, preview seven days instead:

```sh
logdig backfill 7 --dry-run
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
    │   ├── <session-id>.md       latest summary of the first work block
│   └── <session-id>-<block-id>.md  latest summary of each continuation
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

Each entry keeps its timestamp inline at the start of its summary, even when a project has multiple entries. Summary wording is preserved, including any edits you made.

Obsidian displays each link as just the timestamp; clicking it opens that entry's detailed summary. The detailed note has two compact frontmatter properties when available: `sessionUsage` for recorded Pi usage within that work block and `logUsage` for LogDig's summary-generation requests, including intermediate chunks. Each shows cost, cached input, uncached input, output, and elapsed time, for example `"$3.73 ⚡12.2M ↑747k ↓62k · 1h 55m"`. Work-block duration is wall-clock time, including idle periods within the block; LogDig duration is the time spent generating that summary. The original session and LogDig calls are counted separately. Historical summaries made before usage tracking have no `logUsage`; their cost cannot be recovered without making new requests. Unknown cost or token counts are omitted, not shown as zero. Keep the summary cache inside your vault so Obsidian can resolve these links. Daily summaries do not create headings or code fences; structured detail stays in the linked note. Custom section headings are supported, with project subheadings one level deeper (or bold project labels beneath a level-six heading).

### Overnight work and continuations

A saved Pi session can contain several **work blocks**. A new block starts only at a new user message when both conditions hold:

- Its local date is later than the current block's starting date.
- At least **four hours** have passed since the preceding conversation activity. Assistant messages and tool results count as activity; session names, model switches, labels, usage records, and extension bookkeeping do not.

The block's **starting date and time** supply its journal timestamp. Continuous work from 10pm to 2am stays one entry on the starting day. Returning at 11am after a long break creates a separate entry on the new day, with a **Continues** link to the preceding block's saved snapshot. Repeated saves are checkpoints, not boundaries. Alternate session branches are included as explorations, not assumed to be the final result.

Date ranges select actual conversation activity, not just assigned journal dates. Today's backfill therefore catches assistant completion or continued work after midnight and updates yesterday's entry. If a selected continuation has no preceding snapshot, LogDig includes the missing earlier block(s) as prerequisites. Status and preview explicitly show these additions, including their summary-generation cost implications.

### Summary reuse and existing journals

Summary freshness is based on the selected, redacted evidence and bounded earlier context, plus summary-processing version, timezone, and configured generation policy. Earlier context is drawn from the preceding block's evidence, not its generated summary, and is marked as background rather than work to repeat. Metadata-only changes do not trigger model requests; usage totals can refresh separately. Explicit LogDig model or thinking-level changes invalidate summaries, while changes to Pi's defaults do not force regeneration under the default policy.

The identifier in each timestamp link prevents duplicate entries, without HTML comments. Older project-name links and comment-wrapped entries are still recognized. When a block evolves, LogDig replaces only that block's daily-note row with a link to the latest summary. Earlier blocks stay in place. Previous linked summary snapshots remain in `Entries/`, and manually edited daily summaries are preserved; usage metadata may be refreshed without regenerating the prose.

**Upgrading from whole-session journaling:** old summaries use an incompatible cache key and need one regeneration per selected work block. A real save assigns legacy entries to their work blocks using their recorded journal timestamp, updates or relocates their rows as needed, and keeps the original linked snapshots. Run `backfill N --dry-run` first to see the scope and model work. Status and preview never migrate files.

Saved heading preferences are not overridden by new defaults; rerun setup to change them. New entries keep their timestamps inline even when their project already has entries. Headings inside frontmatter or fenced code are not insertion targets.

Missing daily-note and cache folders are created only by a real save. Raw Pi history stays in Pi's storage.

## Commands

After a global install or `npm link`, use `logdig` from any directory. All commands also work as `node ./bin/logdig.js ...` from the checkout.

```text
logdig init                         configure paths, summaries, and optional Pi integration
logdig doctor                       check paths and Pi, with no model request
logdig config                       show effective settings and environment overrides
logdig --version                    show the installed version
logdig backfill                     journal the last 3 calendar days
logdig backfill 7 --dry-run          preview seven days without changing anything
logdig backfill all --dry-run        preview every discoverable saved session
logdig backfill 7                    journal seven days
logdig backfill 7 --model provider/model --thinking max
logdig backfill 7 --model default    ignore a saved model override for this run
logdig backfill 7 --thinking default ignore a saved thinking override for this run
logdig status                       show coverage for the last 3 calendar days
logdig status 7                     show coverage for seven days
logdig status all --json            output coverage for every saved session as JSON
logdig pi-install                   install the /journal extension
logdig pi-uninstall                 remove it without deleting notes or summaries
```

`--help` works before setup, including `logdig init --help`, `logdig backfill --help`, and `logdig status --help`.

`status` is a read-only coverage check. It counts work blocks: **logged** means the expected entry is present, **stale** means a previous snapshot exists but the entry needs updating, and **new** means no previous block snapshot was found. Summaries are reported separately as reusable or needing summarization. These are block counts, not exact request counts. It selects blocks by conversation activity in your configured timezone, including overnight updates and any missing continuation prerequisites. It never calls a model or writes files; scan warnings make the command exit nonzero so incomplete coverage is clear. JSON retains `sessions` as the result array, with one row per work block and both `sessionId` and `blockId`; totals use `logged`, `stale`, `new`, and `needsSummarizing`.

New summaries may incur provider charges. Large work blocks are summarized in chunks and may need several model requests each. Backfill shows which project it is working on before the model completes. Failed sessions are reported, other sessions continue, and the command exits nonzero if anything needs attention. Fix the issue and rerun the same command; completed summaries are reused, even if a previous attempt failed to write a daily note.

Run one backfill at a time against a given journal. The extension prevents overlapping saves within one Pi process, but separate CLI/Pi processes and external note editors are not coordinated. Let an existing save or vault sync finish first.

## Inside Pi

Install the extension if you did not choose it during setup:

```sh
logdig pi-install
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

Choose a **thinking level** alongside the model in setup's advanced settings, or use `--thinking` for one CLI backfill. Supported values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `default` removes the LogDig override. Saved settings use `thinkingLevel`, and `PI_JOURNAL_THINKING` overrides it. This applies to intermediate timeline extraction and final summaries, including `/journal` and automatic capture. Support and effort mapping depend on the model and Pi provider, so `max` is not necessarily a distinct supported tier on every model.

More thinking can help separate proposals, failed attempts, and verified outcomes, but can increase latency and token cost. Explicitly enabled thinking allows CLI requests up to 30 minutes each, rather than the usual five; providers may impose their own timeouts. With no LogDig override, CLI backfill keeps Pi's startup thinking policy, while `/journal` keeps its existing provider-default behavior and does **not** inherit the active session's thinking level. Select an explicit level for consistent control in both paths. Changing it causes selected cached summaries to need regeneration; preview first to see the scope.

Selected user prompts, assistant conclusions, tool actions, test results, and error excerpts are sent to the chosen model after common credential redaction. System prompts, hidden reasoning, and image payloads are excluded. **Redaction is not a comprehensive secret scanner.** Review your provider's data handling before processing sensitive sessions or enabling automatic capture. Summaries can also contain private project details, so treat your cache and vault accordingly.

Model summaries are aids to memory, not proof of completed work. Keep Pi history as the source of truth.

## Settings and troubleshooting

Settings contain paths and preferences, never provider credentials:

- Linux: `$XDG_CONFIG_HOME/logdig/settings.json`, or `~/.config/logdig/settings.json`
- macOS: `~/Library/Application Support/LogDig/settings.json`
- Windows: `%APPDATA%\LogDig\settings.json`

Backfill and automatic capture process up to **four independent sessions concurrently** by default. Set `concurrency` in the settings file or choose “Maximum parallel sessions” in setup's advanced settings. It must be a positive integer; use `1` for sequential processing or to reduce provider rate-limit pressure. Work blocks and extraction requests within each session remain sequential to preserve continuation links. Shared daily-note updates are serialized to avoid overwriting entries. CLI result rows appear in session order even when parallel sessions finish out of order. Session numbers are zero-padded to match the total, for example `[01/65]`, followed by the date, a fixed-width status column, project, and short session ID. Each work period has one final result row; resumed sessions can have multiple dated rows with the same session number. A slow earlier session can delay display of later results, but does not block their processing. Blocks outside the selected range that are needed for continuation links are marked `prerequisite`. The final checked count distinguishes work blocks from sessions. Status reports retain chronological session order. Changing concurrency does not invalidate cached summaries. Avoid running separate LogDig commands against the same notes at the same time; the write queue is local to one run.

Set `LOGDIG_CONFIG_PATH` to choose another settings file. Existing `PI_JOURNAL_*` environment variables remain supported and override saved values. Setup, `config`, and `doctor` name active overrides so you can see why a saved preference is not taking effect.

- **No saved history found:** create a saved Pi session, or use setup's advanced settings to select your history folder. This is especially useful with a custom Pi session directory.
- **Notes went to the wrong folder:** run `config`, check environment overrides, then run `init` to choose the daily-notes folder rather than the vault root.
- **Pi cannot start:** run `doctor`, then use setup's advanced settings to set the executable path.
- **A summary or note failed:** read the error, fix the path, permissions, authentication, or provider issue, and rerun. Successful cached work is kept.
- **Want to stop automatic capture:** rerun `init` and choose “no”, or set `PI_JOURNAL_AUTO=0`.

## Development

```sh
npm ci
npm test
npm link
```

Tests use temporary directories and local fake model responses, including CLI subprocess tests and a packed, globally installed CLI smoke test. They do not use your Pi credentials, call a provider, or write to your actual vault. The package test installs only into a temporary prefix, not your real global npm directory.

`release-it` is a development dependency only. Version 20 supports the same Node.js minimum as LogDig. The `undici` override keeps its pinned HTTP dependency on a patched 7.x version until release-it updates that dependency. Published installations have no runtime dependencies.

## Releases

Releases are interactive and run from a clean, committed `main` checkout with its upstream configured. You need npm publishing access and permission to push to `origin`. No GitHub API token is needed; this workflow creates Git tags, not GitHub release pages.

The starting version is `0.0.0`, so the first minor release becomes `0.1.0`:

```sh
npm ci
npm login
npm run release:dry-run -- minor
npm run release -- minor
```

The dry run runs tests and checks npm/Git access, but does not bump versions, commit, tag, push, or publish. The real command runs tests, updates `package.json` and `package-lock.json`, publishes to npm, creates a release commit and `vX.Y.Z` tag, and pushes the commit/tag. Follow npm's authentication or two-factor prompts if requested. Future releases can use `npm run release -- patch` or choose the version interactively with `npm run release`.

`prepublishOnly` also runs the tests before a direct `npm publish`. Use `npm pack --dry-run` to inspect the published files: CLI, source, docs, manifest, and license only.

After a release, update a global installation with `npm install -g logdig@latest`. Uninstall with `npm uninstall -g logdig`; this does not remove settings or notes. If you installed the Pi extension, run `logdig pi-uninstall` before uninstalling the CLI.

## License

[MIT](LICENSE).
