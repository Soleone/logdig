# LogDig reveal

## Decision

Lead with recovering Pi history, not installing another integration. Show the result immediately, with parallel backfill as the mechanism. Obsidian is the original home, not a requirement.

Use **the MP4 on X**, **the PNG in Discord**, and **the lightweight GIF at the top of the GitHub README**. The silent demo works without sound. No separate website or cinematic trailer is needed for this first reveal.

### X: two sentences

> I built LogDig to turn saved Pi sessions into a daily Markdown work journal, with parallel backfill and linked summaries. Made for Obsidian, but happy in a plain folder too: https://github.com/Soleone/logdig

Attach `assets/demo.mp4`. Keep the GitHub link in the main post. If people ask how it works, reply with the safe-preview command rather than stuffing installation instructions into the announcement. Suggested video alt/caption: “Ten synthetic Pi sessions processed four at a time, then grouped into a daily Markdown note with linked detail. Canned responses; real LogDig backfill pipeline, not a speed benchmark.”

### Pi Discord

> I made **LogDig** because I kept losing track of what happened across my Pi sessions. It turns saved history into project-grouped daily Markdown notes, backfills four sessions at a time by default, and keeps short entries linked to longer summaries.
>
> Originally built for Obsidian, but you can use a plain folder too. There's a read-only preview before any model calls or note changes. I'd love feedback on the journal format and first-run setup.
>
> https://github.com/Soleone/logdig

Attach `assets/hero.png`. Use the server's showcase/self-promotion channel and check its rules. Ask for specific feedback, not stars. For an Obsidian community, lead instead with “I wanted my daily note to remember what I built with Pi, without writing it twice.” Explain that Pi is the supported source; do not imply support for every coding agent or every journal app.

## Assets

| File | Use | Specification |
| --- | --- | --- |
| [assets/hero.png](assets/hero.png) | Discord, static fallback | 1600 × 1000, PNG, about 167 KB |
| [assets/demo.mp4](assets/demo.mp4) | X upload, downloadable demo | 1600 × 1000, about 18 seconds, H.264, 30 fps, yuv420p, no audio, about 755 KB |
| [assets/demo.gif](assets/demo.gif) | GitHub README | 960 × 600, 8 fps, looping, about 1.3 MB |

### Provenance and limits

The capture runs the **real** session scanner, work-block parser, summary/cache writer, daily-note writer, concurrency scheduler and terminal progress renderer. Its ten sessions, project names, transcripts, model responses and response delays are authored synthetic fixtures. No Pi executable, credentials, provider, personal history, or actual vault is used. It verifies ten entries, four concurrent responses, preserved handwritten content, and a rerun with ten reused summaries and no extra response calls.

The right-hand view renders the generated Markdown in a small purpose-built preview. It is **not an Obsidian screenshot** or a new LogDig application UI. The three summary lengths are real stored content; the demo's switching between them is presentation. The note remains visible while processing to show the end result alongside the mechanism, not to suggest live streaming into a note.

Timing is illustrative, not a speed or summary-quality benchmark. CLI result rows are cropped only as they grow; the active panel remains visible. The original recording and full generated vault are retained in the output directory for inspection.

Lato by Łukasz Dziedzic is bundled unmodified under the SIL Open Font License; see [Lato-LICENSE.txt](Lato-LICENSE.txt). The terminal uses DejaVu Sans Mono when available, otherwise the browser's monospace font. No stock media, music, generated imagery, or third-party logos are used.

## Reproduce

From a checkout with Node.js 22.19+:

```sh
npm run demo
```

This writes a **new temporary directory** and prints its path. Open its `index.html` for the local preview. It includes `recording.json`, `terminal.ansi`, ten synthetic JSONL sessions, and the real generated Markdown vault. A caller-supplied output path must not exist, including symlink aliases. Nothing is reset or deleted.

For automatic media export, install `agent-browser` and its browser separately, and have FFmpeg on PATH. These are developer tools, not LogDig dependencies. On WSL, use the Linux browser. No Remotion or React installation is needed.

```sh
npm run demo:capture
# Or retain the output under a new chosen directory:
npm run demo:capture -- /tmp/logdig-reveal-new-take
```

The command uses its own isolated browser session, waits for local fonts, captures the still, records the replay, exports MP4/GIF, and closes the browser. Output remains outside the repository unless explicitly chosen otherwise. Inspect the actual exports before replacing committed assets:

```sh
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,pix_fmt \
  -of json /tmp/logdig-reveal-new-take/assets/demo.mp4
```

Copy only `hero.png`, `demo.mp4`, and `demo.gif` into `docs/launch/assets/` after review. Generated recordings carry local absolute paths; they should not be added to the public repo. The capture creates `manifest.json` with provenance and verification results.

### Why not Remotion yet?

The creative-production skill points to [current official Remotion guidance](https://www.remotion.dev/docs/ai/skills) for motion work, rather than embedding old API assumptions. Remotion is useful for a second version with tighter crops, narrated beats, captions, or separately composed portrait/landscape variants. It should assemble real captures, not invent the product UI.

For this reveal, the smallest credible route is **real pipeline → recorded terminal replay + actual Markdown → browser capture → FFmpeg**. It stays dependency-free at runtime and is cheap to update when the CLI changes. If we adopt Remotion later, keep it in a separate tooling workspace and check [current licensing](https://www.remotion.dev/docs/license/pricing) first.

## Before posting

- Commit and push the README, full reference and assets to `main`. README media URLs will not resolve until those files exist on GitHub.
- Verify the repo is public and the media loads on GitHub, including on a phone. If the repo's default branch changes, update the absolute media URLs.
- Check the npm version and do a clean install/preview outside the development checkout. Version `0.2.2` was confirmed published during this preparation.
- Watch the MP4 at real speed and phone-sized, and inspect the GIF/still. Technical properties and representative first/middle/final frames were checked here; final editorial approval is yours.
- Use only synthetic or explicitly reviewed data. Keep the synthetic-data disclosure in the media and README.
- Post to X, then tailor the Discord message to each community. No posts, pushes, release or repository-setting changes are performed by this task.

## Direction and review

A restrained mint work surface, deep-green terminal, and off-white Markdown page keep the outcome legible. The composition is intentionally the user-approved actual-output, code-first direction, not a fabricated application shell. The large two-line promise should survive a feed thumbnail; the live panel and journal are readable when opened.

The Impeccable direction seed (`c4abba8f`) was subordinate to that explicit choice. The fixed 1600 × 1000 artboard is a media source, not a responsive public website. Inspection covered the full-size still and video contact sheets; the mechanical design detector reported no findings. Visual review was performed directly, not delegated.
