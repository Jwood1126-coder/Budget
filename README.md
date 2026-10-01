# Household budget source demonstration

A dependency-free static household-budget app, exported as a fresh source snapshot with entirely invented data. Person A and Person B, merchants, income inputs, debt references, dates, and all fixture records are fictional. No private records, browser scenarios, credentials, deployment metadata, production build, or Git history are included.

This is a code handoff, not a financial recommendation or a finished UX redesign. See [SOURCE_HANDOFF.md](SOURCE_HANDOFF.md) for the code map, behavior, and limitations.

## Run the sample

Requires Python 3 and a modern browser. Node.js is only required for tests. No package install or remote asset is needed.

```sh
python3 assemble.py --sample
# Open dist/index.html directly, or use a loopback-only local server:
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

The browser app has five sections: Overview, Spending, Build your plan, Future & savings, and Review & next steps. Start in **Build your plan** to edit the fictitious take-home amounts and choose pay frequencies. Blank values remain unknown rather than silently becoming a complete plan.

## Test

```sh
python3 build_sample.py
python3 assemble.py --sample
python3 validate.py
node --check math.js
node --check app.js
node test-math.cjs
node test-runtime.cjs
```

The sample generator is deterministic and never reads private input files. Validation reconciles every monthly and baseline total. The math suite has 48 checks. The simulated DOM suite has 12 workflow checks; it is not a real-browser, visual-layout, accessibility, or cross-device test.

The delivered export intentionally contains no `dist/`. Build it locally when needed. Generated HTML must stay out of the repository even when it currently contains only the sample.

## Private-input workflow

1. Keep this source repository separate from private statements, account exports, screenshots, and saved financial plans
2. Create an ignored `data/budget-data.json` locally, using `data/sample-data.json` as the schema reference. Replace all fixture transactions, source labels, monthly totals, baseline summaries, evidence text, dates, and recurring records consistently. Do not simply mix private records into the sample
3. Run `python3 assemble.py` to select that local private file; without it, assembly falls back to the public sample. `--sample` always forces the invented fixture
4. Open the generated file locally. Replace fictitious planning defaults in the UI and confirm dates, pay frequency, debt payments, and available cash. The source's sample debt inventory is an illustration, not a private balance import
5. Treat `dist/index.html`, browser local storage, printed output, and every “Download a copy” file as sensitive. They contain included records and/or scenario values. Do not upload them or commit them
6. Before any source push, review the entire staged diff and file list. `.gitignore` is an accident-prevention aid; it does not erase already tracked files or make a build safe to publish

There is no raw bank-CSV importer, account connection, balance synchronization, authentication, access control, or encryption. The JSON file must already use the normalized schema. The provided validation and runtime tests intentionally test only the sample; they are not a private-data audit.

The browser stores edits locally under a key scoped to the build's embedded copy ID. Downloaded copies receive a fresh ID and carry the current scenario. Private local builds currently share the `local-private` copy ID, so reset local changes or use an isolated browser profile when switching households or private datasets. Reset affects only that browser's scenario and does not erase downloaded files, browser backups, or the embedded dataset.

## Sharing and repository hygiene

Only source, documentation, tests, and the invented fixture belong in version control. This repository was initialized from a clean source export; no production Git history was copied. Do not copy an existing private repository's `.git`, `.openai`, `.env`, `dist`, statement files, or local scenario into it.

The app performs no fetches and loads no remote libraries, fonts, trackers, or images. Its favicon is inline SVG. A supporting browser may expose the optional `document.modelContext` tools to inspect or update the current local scenario; that integration is not an account connection or an automatic sync service.

No license is assigned by this handoff. The repository owner should choose any license before wider distribution.
