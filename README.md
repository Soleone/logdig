# LogDig

**Your Pi and Claude Code history. A journal you can read.**

Turn saved [Pi](https://pi.dev) and Claude Code sessions into daily Markdown notes, grouped by project. Backfill a week of work in parallel, keep the short version in your journal, and click a timestamp for the details.

![LogDig processing ten synthetic Pi sessions, four at a time, beside the generated daily Markdown note](https://raw.githubusercontent.com/Soleone/logdig/main/docs/launch/assets/demo.webp)

<sub>Ten synthetic sessions, canned model responses, real backfill pipeline. Illustrative timing, not a model benchmark. [Still image](https://github.com/Soleone/logdig/blob/main/docs/launch/assets/hero.png) · [MP4 demo](https://github.com/Soleone/logdig/blob/main/docs/launch/assets/demo.mp4)</sub>

**[Try it in your browser](https://logdig.soleone.xyz)**, no install. The real CLI runs on ten sample sessions, with canned summaries in place of a model.

## Remember the work, not just the chat

- **Catch up in parallel.** Four independent sessions at once by default, with live progress and configurable concurrency.
- **Short here, detailed there.** Every work block gets Small, Medium, and Large summaries. Your daily note links to the saved detail.
- **Keep your own writing.** Handwritten notes and manually edited daily blurbs stay in place. Saved summaries are kept as written. LogDig never rewrites one unless you ask with `--force`.
- **One journal for both tools.** Pi and Claude Code sessions go into the same notes, grouped by project. Each entry's details say which tool it came from.
- **Pick up where you left off.** Continuous overnight work stays together. Returning the next day after a long break creates a linked continuation.

Originally built for **Obsidian**, but the daily pages are ordinary Markdown. Use another journal app that reads `YYYY-MM-DD.md` files, or let LogDig create those pages in a folder with no journal app at all. Timestamp links use Obsidian-style `[[wikilinks]]`; opening them depends on your reader.

## Try one day

You need **Node.js 22.19+** and either Pi or Claude Code installed and signed in. LogDig summarizes with Pi when it is installed, and with Claude Code otherwise. Claude Code sessions are read automatically when `~/.claude/projects` exists.

```sh
npm install -g logdig
logdig init
logdig doctor
logdig backfill 1 --dry-run
```

Choose your daily-notes folder and a summary folder. For Obsidian, keep both inside your vault. Leave automatic capture off for your first try.

**The preview never calls a model or writes files.** When it looks right:

```sh
logdig backfill 1
```

`1` means today in your configured timezone. To catch up on a quieter day, try `7`; to recover your history, use `all`.

```sh
logdig backfill 7 --skip-today   # complete days through yesterday
logdig status all               # see what is logged, stale, or new
logdig config                   # change model, summary length, parallelism, and more
```

Want to save without leaving Pi? Run `logdig pi-install`, reload Pi, then use `/journal`. Automatic capture on shutdown is opt-in.

## Your model, your notes

LogDig uses the authentication you already have in Pi or Claude Code, with no separate model credentials or runtime dependencies. Real summaries send selected, redacted session evidence to your chosen model and may incur provider charges. Common credentials are redacted, but **redaction is not a complete secret scanner**. Review sensitive history before processing it.

Saved sessions are the source of truth; summaries are a memory aid. Run one save at a time against a given journal.

[Quickstart](QUICKSTART.md) · [Full reference & troubleshooting](docs/usage.md) · [Launch assets & capture workflow](docs/launch/README.md)

## Development

```sh
npm ci
npm test
npm link
```

Tests use temporary folders and fake model responses, not your credentials or vault. [Release instructions](docs/usage.md#releases).

[MIT](LICENSE)
