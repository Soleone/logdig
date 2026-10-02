# Summary model evaluations

Developer-only, dependency-free pilot harness. It calls the real `summarizeSession()` pipeline through Pi, with tools/extensions/context/session saving disabled. It does not call backfill or write to the vault. `scripts/` is excluded from the published package.

## Select and freeze

Use LogDig's read-only commands to discover eligible work blocks and effective settings:

```sh
logdig status all --skip-today --json > "$DATA/apps/logdig/evals/status.json"
logdig backfill 4 --skip-today --dry-run
logdig config > "$DATA/apps/logdig/evals/settings.txt"
```

The settings export has a `Settings:` heading followed by JSON; the harness accepts that format. Create a selection JSON file outside the repository:

```json
{
  "settingsPath": "/absolute/path/settings.txt",
  "baselineAttribution": "Historical generation model/effort may be unknown",
  "cases": [
    {
      "id": "short-fix",
      "sessionId": "exact-session-id",
      "blockId": "exact-block-id",
      "reason": "Clear outcome, tests, remaining restart step"
    }
  ]
}
```

Select cases before seeing candidate outputs. Include a short fix, ordinary tested implementation, debugging with superseded hypotheses, long/chunked work, and resumed/ambiguous work.

```sh
node scripts/eval.js freeze /absolute/path/selection.json "$DATA/apps/logdig/evals/my-pilot"
```

Freeze requests no model. It verifies current default-policy cache freshness, excludes work active today, saves processed/redacted evidence and historical Markdown, hashes those inputs, and archives/hashes the pipeline. A fresh directory is required. The output directory cannot overlap the repository, history, cache, or daily-note directories, including symlink aliases.

A cache fingerprint verifies processing policy and evidence, **not** historical model identity or that the prose was never manually edited. `Pi startup default` notes remain attributed historical outputs, not verified Luna max baselines. Fresh explicit Luna max runs provide the operational baseline.

## Generate, judge, report

```sh
node scripts/eval.js run "$DATA/apps/logdig/evals/my-pilot"
node scripts/eval.js judge "$DATA/apps/logdig/evals/my-pilot"
node scripts/eval.js report "$DATA/apps/logdig/evals/my-pilot" > /absolute/path/report.json
```

Fixed generation arms: `openai-codex/gpt-6-luna:max`, `openai-codex/gpt-6.1-sol:medium`, and `openai-codex/gpt-6.1-sol:high`. An optional arm argument runs just one configuration. Every configuration owns its intermediate extraction and final generation. Cases run sequentially with rotating arm order. Actual response model/provider must match the requested configuration. CLI thinking is explicit but provider-specific mapping/clamping still applies.

For five cases, generation makes 15 full work-block pipelines, potentially many more individual requests. Judgment makes ten Sol high requests: one anonymous four-candidate panel per case, then another with reversed ordering. Historical summaries are the fourth candidate. The judge receives original processed evidence, not candidate extraction digests or model labels, usage, timing, or provenance. Every layer gets explicit 1-5 dimension scores; every pair gets a preference or tie. Issue citations must match an exact source passage. Reversed-order disagreements are reported as `order-sensitive`, not converted into confident wins.

Completed results resume without provider calls. Failed results and individual request artifacts are preserved. A fresh attempt needs a new evaluation directory. Pipeline/input changes invalidate the frozen run. If interrupted before a terminal result, preserve that directory and start a new one rather than silently mixing attempts.

Artifacts include prompts, text responses (not hidden reasoning), raw reported usage, wall times, model identity, historical notes, mappings, judgments, and source hashes. They contain private project details. The frozen directory and files are owner-only; production redaction is not a comprehensive secret scanner.

## Replay a prompt/effort comparison

To reuse a pilot after changing production prompts, create a new selection file:

```json
{
  "settingsPath": "/absolute/path/settings.txt",
  "replayFrom": "/absolute/path/original-pilot"
}
```

Run the same `freeze`, `run`, `judge`, and `report` commands against a new output directory. Freeze verifies the old archived pipeline and evidence instead of requiring it to match today's code. It copies the exact evidence, historical Markdown, and explicit old Luna max results. It does not reread live sessions or require cache freshness under the new prompts.

Replay generates two arms: `revised-max` and `revised-medium`, both on `openai-codex/gpt-6-luna`. The fixed third candidate is `old-luna-max`, copied byte-for-byte into `references/`. This separates the prompt comparison (old versus revised max) from the effort comparison (revised max versus medium). Source-derived facts from the pilot's `manual-checklist.json` are validated, copied, and supplied to the judge. Each candidate must assess every checklist fact across its layers. The rubric treats mere lack of “reported” attribution as at most minor, not invented test success.

Reference results have `source: "prior-run"` in reports. Do not count their costs as newly incurred or assume their older wall times isolate the effect of prompts; provider load and run variation are confounds. These are development cases used to tune the prompt, not an untouched holdout set. Inspect all fresh summary layers against the checklist before deciding on effort settings.

## Interpretation

- Five purpose-selected cases and one generation per arm are a pilot, not statistical proof.
- Prefer factual reliability, then useful coverage, then style. Spot-check cited issues in source evidence.
- Sol judging its own family in the original pilot can introduce self-preference; anonymity and order reversal cannot remove it. In the Luna-only replay, it is not judging its own family's candidates, but evaluator bias and variability still apply.
- Report generation and judging costs separately. Pi cost fields are catalog estimates, not verified subscription charges. Missing usage stays unknown; provider failures can have unreported usage.
- Historical `logUsage` is rounded and reflects another point in time. Use fresh generations for timing/cost comparisons.
- Prompt caching, provider load, retries, and startup overhead affect observed wall time. No cold-cache or repeated-trial claim is made.
- Original transcript events are clipped/redacted by the production extractor. Judge against that available evidence, and manually consult raw history if an apparent defect may be extraction loss.

Local tests run entirely with fake responses and temporary files:

```sh
node --test test/eval.test.js test/pi-client.test.js
npm test
```
