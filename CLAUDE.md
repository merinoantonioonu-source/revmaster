# UMBRA — Project context for Claude Code

UMBRA (*Unified Masking & Bilingual Review Assistant*) is a static web app published with GitHub
Pages (`app/` only). It helps United Nations translators (EN/FR -> ES):
1. **Mask** figures, organizations, organs, countries, places, persons, titles, dates, document
   symbols and URLs in DOCX/PPTX/XLSX files exported from eLUNa, with bilingual tags
   (`{CARGO1}` in the source, `{el CARGO1}` in the Spanish target), and export the masked files.
2. **Review** the masked translation with eight AI modules (each with its own provider/model and
   rules) plus a local, AI-free layer.

The owner is both developer and end user and **does not code**. Explain things in plain terms.

## How to work in this repo (READ FIRST)

- **Always respond to the user in Spanish.**
- **UMBRA is NOT part of COMeT.** Never modify the COMeT repository, never add anything about UMBRA to
  it. Code copied from COMeT is copied (with the header `Origin: COMeT <path> @ <commit> (adapted)`),
  never imported.
- **Work on a branch and deliver each change as a pull request.** Read a file before editing it.
- **No build step.** Native ES modules; third-party libraries are global scripts in `app/libs/`.
- **ASCII only** in `app/**` and `tests/**` (`.js .html .css .json`): run
  `python3 -I tools/asciify.py` then `python3 -I tools/asciify.py --check` before committing.
- **UI text in Spanish, starting with a capital letter.** Code comments in English.
- **No `chrome.*` APIs**: storage goes through `app/js/store/`. Every AI call goes through
  `app/js/ai/gateway.js`, which refuses unmasked text for external providers.
- **Tests**: `node tests/run-all.mjs` (Playwright + Chromium are preinstalled; it starts a static
  server and a mock OpenAI-compatible provider). Run them before opening a PR.
- **VERSION.md** is append-only: one line per change.
- After any change, tell the user how to check it in the browser (the published URL is
  `https://merinoantonioonu-source.github.io/revmaster/`; after merging, wait 1-2 minutes and press
  `Ctrl+Shift+R`).

## Architecture

See `docs/ARQUITECTURA.md` (contracts between modules) and `docs/PROPUESTA.md` (functional design).

- `app/js/formats/`: DOCX/PPTX/XLSX models (DOCX/PPTX copied from COMeT Final Check), alignment,
  writers (masked copy, corrected copy with tracked changes and Word comments).
- `app/js/redact/`: detectors, entities, tags, masking, rehydration.
- `app/js/review/`: module list, prompts, local checks (layer 0), planner (batches, merge, cascade,
  cache, budget), runner, parser (`unit | CAT | SEV | quote | suggestion | reason` + `FIN n`), findings.
- `app/js/rules/`: built-in rules (`app/data/rules-default.json`, editable and restorable) + user rules.
- `app/js/ai/`: providers, registry (profiles, models per module), gateway, usage/cost.
- `app/js/sync/`: sync file (`umbra-sync.json`, `meta.kind = 'umbra-sync'`), copied from COMeT.

## Recurring lessons
- All offsets (`start`, `end`) are measured on `para.text` of the document model.
- Masking: the tag carries the Spanish article of the ENTITY (`{la ORGANO2}`); the article or
  contraction already in the text stays outside, so article errors remain visible.
- A shared string in XLSX can be used by several cells: the writer clones it when the edits differ.
- Contextual help: every feature has a "?" (`helpBtn(topic)` from `app/js/ui/help.js`; in a dialog,
  `modal({ help: helpBtn(topic) })`; in a menu, `helpItem(topic, anchor)`). A NEW feature or setting
  gets its topic in `help.js` and its button; update the text when behaviour changes.
  `tests/help.e2e.mjs` fails on a missing or unused topic.
