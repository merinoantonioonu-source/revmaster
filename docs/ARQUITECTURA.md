# UMBRA — Arquitectura y contratos internos

Documento técnico para quien programe UMBRA (personas o sesiones de Claude). La propuesta
funcional está en `docs/PROPUESTA.md`.

## Reglas de código (obligatorias)

- **Sin compilación.** Módulos ES nativos (`<script type="module">`), importaciones relativas con
  extensión `.js`. Bibliotecas de terceros como scripts globales en `app/libs/` (JSZip → `window.JSZip`,
  SheetJS → `window.XLSX`).
- **Solo ASCII** en `.js`, `.html`, `.css` y `.json` publicados: los caracteres no ASCII se escriben como
  `\uXXXX` (JS/JSON) o `&#xXXXX;` (HTML). La herramienta `tools/asciify.py` los convierte y
  `tools/asciify.py --check` falla si queda alguno. Escribe con acentos si quieres y pasa la
  herramienta antes de hacer commit.
- **Textos de interfaz con mayúscula inicial** (salvo unidades y valores literales).
- **Comentarios del código en inglés**; textos de la interfaz en español.
- Nada de `chrome.*`: es una web. El almacenamiento va SIEMPRE por `app/js/store/`.
- Toda llamada a una IA pasa por `app/js/ai/gateway.js` (nunca `fetch` directo a un proveedor desde otro
  módulo).
- Cada archivo copiado de COMeT lleva en la cabecera: `Origin: COMeT <ruta> @ 04540f5 (adapted)`.

## Mapa de carpetas (`app/` es lo único publicado)

```
app/index.html            Shell: cabecera, pasos, barra superior, carril, lista, hojas, vistas
app/css/umbra.css         Estilos (tokens de Final Check, cabecera añil #3949AB)
app/libs/                 jszip.min.js, xlsx.mini.min.js (copiados de COMeT)
app/data/                 gazetteer.json, conventions.json, rules-default.json
app/js/main.js            Orquestador (estado del proyecto, vistas, eventos)
app/js/store/             storage.js (tipo chrome.storage), idb.js (IndexedDB)
app/js/util/              dom.js, crypto.js, hash.js, text.js
app/js/formats/           docx-model, pptx-model, xlsx-model, doc-writer, align-docs, ...
app/js/core/              copias de COMeT: srx-segmenter, number-words, url-spans...
app/js/redact/            detect.js, entities.js, masker.js
app/js/review/            modules.js, prompts.js, local-checks.js, parallel.js, planner.js,
                          runner.js, parse.js, findings.js, external.js
app/js/rules/             rules.js, powersearch.js, xbckl.js
app/js/ai/                providers.js, registry.js, gateway.js, usage.js
app/js/sync/              sync-fs.js, sync-autosave.js, sync-device.js, sync-spec.js
app/js/export/            exports.js (enmascarado, tablas, informes, proyecto .umbra)
app/js/ui/                vistas y paneles
tests/                    pruebas (Node + Playwright), fixtures y simulador de IA
tools/                    asciify.py, servidor local de pruebas
.github/workflows/pages.yml  publica app/ en GitHub Pages
```

## 1. Almacenamiento (`app/js/store/`)

`storage.js` imita `chrome.storage.local` sobre `localStorage` (prefijo `umbra:`), con aviso de cambios
también entre pestañas:

```js
import { storage, getValue, setValue } from './store/storage.js';
await storage.get('k' | ['k1','k2'] | null)   // -> { k: value }  (null = todas las claves de UMBRA)
await storage.set({ k: value })
await storage.remove('k' | ['k1'])
const off = storage.onChanged((changes) => {}) // changes = { k: { oldValue, newValue } }
await getValue('k', defaultValue); await setValue('k', value)
```

`idb.js` (base `umbra-db`, almacenes `projects`, `cache`, `handles`, `misc`):

```js
import { idbGet, idbPut, idbDel, idbAll, idbKeys } from './store/idb.js';
```

## 2. Modelo de documento (`app/js/formats/`)

Contrato de `docx-model.js` de COMeT (Final Check), compartido por los tres formatos:

```js
{
  kind: 'docx' | 'pptx' | 'xlsx', fileName,
  paras: [{ id, text, runs:[{ t, b, i, u, sup, sub, strike, fnRef, enRef, brk, img, link, ... }],
            loc:{ area:'body'|'footnote'|'endnote', table, row, col, fnId, slide?, sheet?, cellRef? },
            fmt, isHeading, listPrefix, listLabel, isSlideSep?, numeric?, ... }],
  blocks: [{ type:'p', paraId } | { type:'table', tIdx }],
  tables: [{ idx, rows:[[ { paraIds:[], gridSpan, vMerge } ]] , sheet? }],
  footnotes:[{ id, num, paraIds, text }], endnotes:[...],
  stats: {...}, _bytes: ArrayBuffer  // bytes ORIGINALES, para escribir sobre una copia nueva
}
```

- `para.text` es la proyección del texto que se ve: tabulador `\t`, salto de línea ` `, guion de no
  separación `-`, llamada de nota vacía. **Todas las posiciones (`start`, `end`) se miden sobre
  `para.text`.**
- XLSX: una hoja = una tabla; cada celda con texto (o número) = un párrafo; `numeric:true` para celdas
  numéricas; `loc.sheet`, `loc.cellRef` ('B3').
- PPTX: cada diapositiva aporta un párrafo separador `isSlideSep:true` ("Slide N").

API:

```js
import { parseDocument } from './formats/parse.js';        // File -> model (según extensión)
import { alignDocs } from './formats/align-docs.js';       // (src, tgt) -> { pairs:[{ src:[ids], tgt:[ids], score }] }
import { writeReplacements, writeCorrected } from './formats/doc-writer.js';
await writeReplacements(model, repl /* Map<paraId, [{start,end,text}]> */) // -> Blob, sin control de cambios
await writeCorrected(model, newTexts /* Map<paraId, string> */, {
  tracked: true, author: 'UMBRA', date,           // DOCX: control de cambios
  comments: [{ paraId, quote, text, author }]      // DOCX: comentarios de Word
}) // -> Blob. PPTX/XLSX: cambios directos (sin control de cambios), comentarios ignorados
```

`alignDocs`: DOCX/PPTX → `alignModels` de COMeT (1:1 por párrafo); XLSX → por hoja y celda.
`pairs` va en orden de documento e incluye los no emparejados (`src:[]` o `tgt:[]`).

## 3. Datos (`app/data/`)

`gazetteer.json`:

```json
{ "version": 1, "entries": [
  { "id": "organo:asamblea-general", "cat": "ORGANO", "art": "la",
    "en": ["General Assembly"], "fr": ["Assemblée générale"], "es": ["Asamblea General"],
    "artByForm": { } }
]}
```

- `cat`: `ORG` (organismos, fondos, programas, agencias, ONG), `ORGANO` (órganos y comités), `PAIS`,
  `LUGAR`, `CARGO`.
- `art`: género y número de la forma española principal: `el`, `la`, `los`, `las`. `artByForm` lo
  sobrescribe por forma ("Secretaria General": "la").
- Formas: completas, cortas y siglas de cada lengua.

`conventions.json`: aperturas de párrafos del preámbulo y verbos dispositivos (EN/FR/ES), tratamientos
(Mr., M., Sr....), meses y fórmulas fijas. `rules-default.json`: reglas de serie (esquema del §7).

## 4. Enmascarado (`app/js/redact/`)

- `detect.js`: `detectSpans(text, lang, opts) -> [{ start, end, cat, key, surface, art }]`.
  `key` identifica la entidad en las tres lenguas: `num:1250`, `date:2024-03-12`, `g:<id gazetteer>`,
  `sym:A/RES/78/1`, `url:...`, `per:smith john`, `acr:UNDP`, `x:<texto>`.
- `entities.js`: entidades del proyecto `{ id, cat, n, key, art, srcForms, tgtForms, occ:[{ side, paraId,
  start, end }] }` + ajustes manuales (añadidas, quitadas, fusiones, categoría, artículo).
- Etiquetas: original `{CARGO1}`; traducción `{el CARGO1}` (sin artículo si no se conoce). El artículo o
  contracción del propio texto se queda fuera.
- `masker.js`: texto enmascarado por párrafo y mapa etiqueta → formas. Prueba de enmascarado: cada
  texto enmascarado lleva una marca `MASKED` que comprueba `gateway.js`.

## 5. IA (`app/js/ai/`)

```js
// providers.js
createClient(profile, modelId, apiKey) -> { name, model, complete(prompt, system, opts) }
//   opts: { temperature, maxTokens, thinking:'minimal'|'low'|'high'|null, onUsage(u), signal }
//   u = { input, cached, output, thoughts }
testConnection(profile, modelId, apiKey) -> { ok, message }   // detecta CORS ('No acepta llamadas desde la web')
// registry.js (claves de almacenamiento: 'providers', 'module_models', 'key:<providerId>')
listProviders(), saveProvider(p), removeProvider(id), getApiKey(id), setApiKey(id, key),
addModel(providerId, {id,label}), removeModel(providerId, modelId),
getModuleModels(), setModuleModel(moduleId, role /* 'triage'|'deep' */, { provider, model } | null),
resolveClient(moduleId, role) -> { client, providerId, modelId, trust, fallback }
// usage.js (de COMeT ai-usage.js): 'usage:<deviceId>', 'ai_prices', 'usage_notes'
recordUsage({ module, provider, model, usage, project, file, words }), readUsageRows(),
loadPrices(), savePrices(p), lookupPrices(keys), costOf(u, price), priceKey(provider, model)
// gateway.js
callAI({ module, role, prompt, system, masked, project, file, words, thinking, maxTokens, signal })
  -> { text, usage, providerId, modelId }
```

Perfil de proveedor: `{ id, name, adapter:'gemini'|'mistral'|'azure-openai'|'openai-compatible'|'anthropic',
baseUrl, deployment, apiVersion, models:[{ id, label, price? }], trust:'external'|'local', builtIn }`.

## 6. Sincronización (`app/js/sync/`)

Copia adaptada de COMeT (`sync-fs.js`, `sync-autosave.js`, `sync-device.js`). Archivo por defecto
`umbra-sync.json`, `meta.kind = 'umbra-sync'`; un archivo `comet-sync` se RECHAZA. Las claves que viajan
y su forma de fusión están en `sync-spec.js`:

| Clave | Fusión |
|---|---|
| `providers`, `module_models`, `module_cfg`, `lists`, `prefs`, `prompts` | `newest` (`updatedAt`) |
| `rules` | `rules` (unión por id con `updatedAt` y lápidas) |
| `entity_dict` | `byId` (unión por id, gana el `updatedAt` más reciente) |
| `usage:<device>` | `usage` (por equipo, como COMeT) |
| `ai_prices`, `usage_notes` | `prices` / `notes` (como COMeT) |
| `secrets` | `newest` (solo si el usuario activa "Incluir claves cifradas") |

## 7. Reglas (`app/js/rules/`)

```js
{ id, origin:'serie'|'usuario', on, modules:['grammar'|'fidelity'|'integrity'|'style'|'coherence'|
  'conventions'|'verifier'|'coldread'], kind:'expr'|'forbid'|'pattern'|'style'|'structure'|'ignore',
  src, es, avoid, regex, srcRegex, note, severity:'CRI'|'MAY'|'MEN'|'SUG', profiles:[], updatedAt }
```

- `src`/`avoid`: formas separadas por `|`, `*` = cualquier final (como `sourcePattern` de COMeT).
- Reglas de serie: `app/data/rules-default.json`. El usuario guarda solo sus cambios
  (`rules.overrides[id]`), sus reglas (`rules.user`) y lápidas (`rules.tombstones`). Restaurar = borrar
  el override.

## 8. Módulos de revisión

Ids: `grammar`, `fidelity`, `integrity`, `style`, `coherence`, `conventions`, `verifier`, `coldread`,
más la Capa 0 `local`. Formato de respuesta de la IA (y de una IA externa):

```
<unidad> | <CAT> | <SEV> | <cita exacta> | <sugerencia> | <motivo>
FIN <n>
```

## 9. Estado de la versión 1 (2026-11-04) y detalles de implementación

- **Formatos.** `writeReplacements(model, repl, opts)` admite en DOCX `{ acceptRevisions, removeComments }`.
  Las copias enmascaradas usan los dos, para que no quede texto borrado ni comentarios con datos reales.
  En XLSX las celdas tapadas por una combinación llevan `merged:true` (el visor las omite). Los números y
  las fórmulas enmascarados pasan a texto (`inlineStr`). No se enmascaran encabezados ni pies de página
  de DOCX, notas del orador de PPTX ni comentarios de celda de XLSX.
- **Prueba de enmascarado.** `gateway.callAI` exige `masked: true` (lo pone solo `runner.js`, que construye
  los prompts con `session.masked`). No hay una marca dentro del texto.
- **Llamadas fusionadas.** Se resuelve el modelo con el primer módulo (`module`) y el gasto se anota con
  `usageModule` (`fidelity+integrity`).
- **Capa 0.** `review/local-checks.js` hace estas comprobaciones:
  - cifras y etiquetas por párrafo;
  - formas distintas de una entidad;
  - párrafos sin pareja o sin traducir;
  - longitud y número de oraciones;
  - limpieza (palabras repetidas, espacios, signos de apertura y cierre);
  - mismo original con traducciones distintas;
  - paralelismo de los hermanos (agrupados por tipo de numeración);
  - convenciones de resoluciones (fórmulas, cursiva, `fixedPhrases` de `conventions.json`);
  - formato de millares;
  - reglas sin IA.

  A esto se suma `review/spell.js`: un corrector ortográfico local con Hunspell (`app/data/hunspell/es.*`,
  diccionario `dictionary-es` 4.0.0 con su licencia) y `app/libs/nspell.esm.js` (nspell 2.1.5, MIT,
  empaquetado una vez con esbuild).
- **Pendiente (fase 6 de la propuesta).** Falta la similitud semántica local con *embeddings* y el modo
  diferido de lotes (−50 %). El «puente» para proveedores sin CORS sí está: es el campo `relayUrl` del
  perfil.
- **Pruebas.** `node tests/run-all.mjs` ejecuta estas cuatro:
  - la regla ASCII;
  - `formats.test.mjs` (escritura de los tres formatos, verificada con python-docx, python-pptx y
    openpyxl);
  - `ai-sync.test.mjs` (adaptadores, registro, puerta de salida, uso y sincronización);
  - `app.e2e.mjs`.

  `app.e2e.mjs` recorre la aplicación completa en Chromium con un proveedor simulado:
  - enmascarado y exportación;
  - Alt+E;
  - IA externa;
  - Capa 0 con errores provocados;
  - fusión, cascada y verificador;
  - aceptar y exportar el DOCX con cambios y comentarios;
  - reglas;
  - proyecto `.umbra`;
  - PPTX y XLSX.

  Los documentos de prueba se generan con `tests/fixtures/make_fixtures.py` y
  `tests/fixtures/make_e2e_fixtures.py`.
