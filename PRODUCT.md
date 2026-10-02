# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The product is a Node.js CLI and optional Pi extension, not a web app. Web applies only to the local launch-media artboard.

## Users

Pi power users who want to recover what happened across saved sessions, without writing a second account of their work.

## Product Purpose

Turn saved Pi sessions into a dated, project-grouped work journal. Make a large history approachable through parallel backfill and linked summaries.

## Operating Context

Originally made for Obsidian. Daily pages are ordinary Markdown with YYYY-MM-DD.md filenames. Other journal apps can use compatible files, or LogDig can create the daily pages on its own. Obsidian-style timestamp wikilinks need an app that supports them to be clickable.

## Capabilities and Constraints

- Node.js 22.19+; Pi installed and authenticated for real summarization.
- CLI backfill defaults to four independent sessions in parallel; concurrency is configurable.
- Reuses unchanged summaries; preserves handwritten content and manually edited daily blurbs.
- Small, Medium and Large summaries per work block; continuation links for resumed sessions.
- Read-only dry run; real runs send selected, redacted evidence to the configured model and may incur charges.
- Redaction is not a complete secret scanner. Summaries are not proof of completed work.
- Saved Pi history only; other coding-agent formats are not supported.

## Brand Commitments

Name: LogDig. Concise, natural language. User requests a tight, polished GitHub README and a short reveal for X and Discord. Avoid exaggerated claims and badge clutter.

## Evidence on Hand

Real backfill, journal writer and progress renderer in src/. Tests cover concurrency, reuse and note preservation. Launch demo will use ten synthetic sessions and canned model responses through the real pipeline, not private history or model benchmarks. The supplied Gilt README reference returns 404 and has not been inspected.

## Product Principles

- Show the resulting journal, not only commands.
- Make safe preview the first real-user step.
- Keep original history as the source of truth.
- Clearly distinguish synthetic demonstrations from measured model performance.
