# UMBRA — Project context for Claude Code

UMBRA (*Unified Masking & Bilingual Review Assistant*) is a static web app published with GitHub
Pages (`app/` only). It helps United Nations translators (EN/FR -> ES):
1. **Mask** figures, organizations, organs, countries, places, persons, titles, dates, document
   symbols and URLs in DOCX/PPTX/XLSX files exported from eLUNa, with tags (`{CARGO1}`, the same
   tag in the source and in the Spanish target), and export the masked files.
2. **Review** the masked translation with AI, as a human reviser would. Since 2026-11-09 (the owner's
   choice, to keep it simple): **Sentido** (`meaning`), the master review of meaning - what the
   translation says differently, leaves out or adds - with the strongest model on every paragraph;
   **Redaccion** (`writing`), the Spanish alone (grammar and institutional style); **Nombres oficiales**
   (`names`); and the **Verificador**, which discards false positives. Each has its own model and
   strictness.

**Purpose (the owner's words, 2026-11-05):** a substantive, content-level review by AI. NO rule-based or
AI-free checks (figures, spelling, glossaries, fixed rules): COMeT's QA Checker and Final Check do that,
and here they only add noise. Fidelity is about MEANING, never style or structure. Saving tokens is a
priority: short prompts, nothing repeated, no rule lists or vocabularies in prompts.

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
  `app/js/ai/gateway.js`, which refuses unmasked text for external providers. The ONE exception,
  chosen by the owner: `callAINames` (module "Nombres oficiales") sends the table of institutional
  names (ORG, ORGANO, CARGO, PAIS, LUGAR; never persons, figures, dates, symbols or the text), built
  and checked row by row inside the gateway. Do not widen it. The second exception, also the owner's
  (2026-11-09): a project marked **"Sin enmascarar"** in Archivos (`project.unmasked`, a text already
  published) sends its real text (`session.unmasked`: the "masked" texts are the real ones; callers pass
  `unmaskedProject: true` instead of `masked: true`). It is per project, asked when switched on, off for
  every new project, and shown on every screen (side bar badge, Enmascarar, Revisar, the plan, the
  report). `tests/unmasked.e2e.mjs` covers it. No other way out for unmasked text.
  The names table also carries names of the original that their paragraph's translation does not show
  (a name translated wrong is not recognised, so it is "Sin pareja"): paired with a Spanish name of that
  paragraph that has no counterpart in the original, or with "—" and the AI gives the official name;
  a finding only where that name is absent (`review/names.js`). Still only names travel.
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
- `app/js/review/`: module list, prompts (tasks, strictness), planner (batches, merge, cascade, cache,
  budget), runner (cut answers re-asked in halves), parser (`unit | CAT | SEV | quote | suggestion |
  reason` + `FIN n`), findings.
- `app/js/ai/`: providers, registry (profiles, models per module), gateway, usage/cost.
- `app/js/sync/`: sync file (`umbra-sync.json`, `meta.kind = 'umbra-sync'`), copied from COMeT.

## Recurring lessons
- All offsets (`start`, `end`) are measured on `para.text` of the document model.
- Tags carry NO article any more (removed at the owner's request: it confused more than it helped):
  the same tag on both sides. `TAG_RE` still reads `{la ORGANO2}` in old texts and external answers.
- A shared string in XLSX can be used by several cells: the writer clones it when the edits differ.
- Contextual help: every feature has a "?" (`helpBtn(topic)` from `app/js/ui/help.js`; in a dialog,
  `modal({ help: helpBtn(topic) })`; in a menu, `helpItem(topic, anchor)`). A NEW feature or setting
  gets its topic in `help.js` and its button; update the text when behaviour changes.
  `tests/help.e2e.mjs` fails on a missing or unused topic.
- The UI (2026-11-06, the owner's choice among six designs): a side bar of five steps (`main.js`:
  Archivos, Enmascarar, Revisar, Corregir, Exportar; Ajustes at its foot), each with its state.
  Revisar = large cards (`review-view.js`), Corregir = aligned rows + inspector (`correct-view.js`,
  "Documento" = the two sheets), Exportar = large options (`export-view.js`). Icons from
  `ui/icons.js` (stroke SVG, no emoji). Palette tokens on `:root` in `umbra.css`.
- Navigation between the sheets is by SENTENCE (`app/js/ui/nav.js`, emulating COMeT Final Check):
  offsets are those of `para.text`, stored on rendered nodes by `preview.js` (`__o`, `__e`); marks are
  CSS highlights (`um-seg`, `um-focus`). Do not re-render the sheets to show a selection; after a
  re-render call `nav.refresh()`. `tests/nav.e2e.mjs` covers it.
- Removed on purpose (do not bring back): the spell checker (Word does spelling), the AI-free
  "Capa 0" checks, the rules system (editor, built-in rules, profiles) and the semantic similarity.
  And (2026-11-09) the nine specialist reviewers: Fidelidad + Integridad are now Sentido, Gramatica +
  Estilo are Redaccion; Lectura en frio, Coherencia and Convenciones ONU are gone (with the "skeleton"
  they sent: `skeleton.js`, `parallel.js`, `conventions.json`), and so is the fusion of modules. Old ids
  in projects, sync files and usage records map to the new modules (`LEGACY_MODULES` and
  `currentModuleId` in `module-list.js`; `LEGACY_SLOTS` and `migrateModuleModels` in `ai/registry.js`
  carry the models chosen before). The cascade (an economical model, then a strong one on what it
  flagged) is still in the planner and runner but no module uses it: Sentido reads everything with one
  model. Decide with the test bench before adding a reviewer back.
- **Type of document** (`project.docType`, `review/doc-types.js`, 2026-11-09): guessed from the eLUNa symbol
  in the file names (SR, PV, RES/DEC), chosen in Archivos or Revisar (same selector, `ui/doc-type.js`); ONE
  short line in the instructions (after their first line) and in the Verifier's, so the conventions of
  that kind of text (the present tense of summary records, the country's name for "his delegation") are
  not reported. A bench may bring it (banco.json `docType`). Keep each line short: no rule lists.
- "Exigencia" (module config `strictness`: grave | normal | estricta) is in the prompt AND enforced by
  the runner (`STRICT_ALLOWED`): findings of a severity not asked for are dropped. Severity is about
  the effect on what is understood, not the size of the change (one word can be MAY).
- **Tuning loop** (2026-11-09): Corregir > Mas > "Comparar con la version final" (`review/compare.js`,
  `ui/compare-view.js`) sets the findings against the final, reviewed translation (no AI): probably right /
  spurious / missed, with "Copiar el resumen" for the chat, an Excel and a bench of one's own built from the
  real work. Tune prompts on those summaries and benches, never by putting examples or rule lists in the
  prompts. The app does not change its own instructions.
- The prompts are calibrated on the owner's review report (2026-11-05): its cases are the test bench
  (`tools/make_bench.py` -> `app/data/calibration/`; Archivos > Banco de pruebas, result in Mas). When tuning a
  module, ask the owner for the bench result ("Copiar el resumen") before and after; add new report
  cases to `make_bench.py` and rebuild. `tests/bench.e2e.mjs` checks the scoring and the names call.
