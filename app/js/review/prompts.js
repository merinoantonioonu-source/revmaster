/**
 * prompts.js - The built-in instructions of every module (editable: storage key 'prompts' =
 * { updatedAt, map:{ <moduleId>: text } }; an empty or missing entry = the built-in one).
 *
 * Layout of every call, FIXED part first so providers can reuse it from their cache:
 *   system = COMMON + task of the module(s) + rules that always travel (style/structure)
 *   user   = rules of this batch (expressions present in its source) + the batch + closing reminder
 */

import { getValue, setValue } from '../store/storage.js';
import { fnv1a } from '../util/crypto.js';

export const PROMPTS_KEY = 'prompts';

const COMMON = `Eres un revisor profesional de traducciones de las Naciones Unidas del {{LANG}} al espa\u00f1ol.

ETIQUETAS: el texto est\u00e1 enmascarado. Las expresiones entre llaves sustituyen datos reales: {CARGO1} es un cargo; {ORGANO2}, un \u00f3rgano; {ORG3}, un organismo; {PAIS4}, un pa\u00eds; {LUGAR5}, un lugar; {PER6}, una persona; {NUM7}, una cifra; {FECHA8}, una fecha; {SIMB9}, un s\u00edmbolo de documento; {URL10}, una direcci\u00f3n; {X11}, un t\u00e9rmino confidencial. En la traducci\u00f3n, el art\u00edculo que va DENTRO de la llave (el, la, los, las) indica el g\u00e9nero y el n\u00famero de la entidad, para que puedas revisar la concordancia; el art\u00edculo o la contracci\u00f3n que va FUERA de la llave es parte del texto y s\u00ed se revisa. La misma etiqueta en el original y en la traducci\u00f3n es la misma entidad. No cambies las etiquetas ni pidas sustituirlas por texto real, y no se\u00f1ales cifras ni etiquetas que falten o sobren: eso se comprueba aparte.

FORMATO DE RESPUESTA (obligatorio): una l\u00ednea por problema, sin texto antes ni despu\u00e9s y sin Markdown:
<n.\u00ba de p\u00e1rrafo> | <CATEGOR\u00cdA> | <GRAVEDAD> | <cita exacta de la traducci\u00f3n> | <sugerencia> | <motivo>
- CATEGOR\u00cdA: {{CATS}}.
- GRAVEDAD: CRI (cambia el sentido o es muy grave), MAY (error claro), MEN (error menor), SUG (mejora opcional).
- Cita: copia literal y lo m\u00e1s corta posible del fragmento err\u00f3neo de la traducci\u00f3n, con las etiquetas tal cual. Si es una omisi\u00f3n, deja la cita vac\u00eda y pon en la sugerencia lo que falta y d\u00f3nde (tras \u00ab...\u00bb: ...).
- Sugerencia: solo el fragmento corregido que sustituir\u00eda a la cita, no el p\u00e1rrafo entero.
- Motivo: como m\u00e1ximo 15 palabras, en espa\u00f1ol.
- No uses el car\u00e1cter | dentro de los campos.
- Revisa TODOS los p\u00e1rrafos, uno por uno. Los p\u00e1rrafos correctos no generan ninguna l\u00ednea.
- Al final escribe exactamente: FIN <n\u00famero de p\u00e1rrafos revisados>`;

export const TASKS = {
  grammar: { cats: ['ORT', 'GRA', 'PUNT'], text: `TAREA \u2014 ORTOGRAF\u00cdA Y GRAM\u00c1TICA: revisa el espa\u00f1ol de la traducci\u00f3n: tildes y graf\u00eda, concordancia de g\u00e9nero y n\u00famero (usa el art\u00edculo de las etiquetas), r\u00e9gimen preposicional, tiempos y modos verbales, pronombres, puntuaci\u00f3n (comas, punto y coma, signos de apertura) y may\u00fasculas. No propongas cambios de estilo ni de traducci\u00f3n si el texto es correcto.` },
  fidelity: { cats: ['MIST', 'UNTR'], text: `TAREA \u2014 FIDELIDAD: compara cada p\u00e1rrafo de la traducci\u00f3n con su original y se\u00f1ala los ERRORES DE TRADUCCI\u00d3N: sentido distinto, falsos amigos, modalidad cambiada (shall/should, doit/devrait), negaciones invertidas, sujeto o agente cambiado, grado de intensidad alterado (urges/encourages, prie instamment/encourage), tiempos verbales que alteran el sentido y t\u00e9rminos con una acepci\u00f3n que no corresponde. No se\u00f1ales estilo si el sentido es correcto.` },
  integrity: { cats: ['OMI', 'ADD'], text: `TAREA \u2014 INTEGRIDAD: compara cada p\u00e1rrafo con su original y se\u00f1ala OMISIONES (informaci\u00f3n del original que falta: palabras con contenido, incisos, matices, elementos de una enumeraci\u00f3n) y ADICIONES (informaci\u00f3n que no est\u00e1 en el original). No se\u00f1ales reformulaciones equivalentes ni cambios de orden.` },
  style: { cats: ['EST'], text: `TAREA \u2014 ESTILO: revisa la traducci\u00f3n como texto institucional de las Naciones Unidas: calcos sint\u00e1cticos y l\u00e9xicos del ingl\u00e9s o del franc\u00e9s, pasivas innecesarias, gerundio de posterioridad, nominalizaciones encadenadas, posesivos innecesarios, repeticiones, registro, claridad y naturalidad. Se\u00f1ala solo lo que un revisor de las Naciones Unidas cambiar\u00eda.` },
  coldread: { cats: ['LEC'], text: `TAREA \u2014 LECTURA EN FR\u00cdO: lee la traducci\u00f3n como un lector que NO conoce el original. Se\u00f1ala las frases que no se entienden, ambiguas, con referentes confusos (a qu\u00e9 se refiere un pronombre), mal construidas o que suenan a traducci\u00f3n. No revises la fidelidad: no tienes el original.` },
  coherence: { cats: ['COH'], text: `TAREA \u2014 COHERENCIA: recibes el ESQUELETO de la traducci\u00f3n: grupos de elementos hermanos (listas, columnas de tablas, t\u00edtulos) con el patr\u00f3n de su arranque calculado (INF infinitivo, SUST sustantivo, GER gerundio, PART participio o adjetivo, PREP preposici\u00f3n, PRES presente, SUBJ subjuntivo, OTRO) y el patr\u00f3n del original. Se\u00f1ala los elementos que rompen el paralelismo de su grupo sin que el original lo justifique, los t\u00edtulos del mismo nivel con estructuras distintas y las may\u00fasculas o la puntuaci\u00f3n final incoherentes entre hermanos. Como cita, usa la palabra inicial del elemento.` },
  conventions: { cats: ['CONV'], text: `TAREA \u2014 CONVENCIONES DE LAS NACIONES UNIDAS: recibes los p\u00e1rrafos de una resoluci\u00f3n o decisi\u00f3n (pre\u00e1mbulo y parte dispositiva) con su arranque; las palabras en cursiva van entre asteriscos. Comprueba: el pre\u00e1mbulo empieza por gerundio o adjetivo en cursiva concordado con el \u00f3rgano (la Asamblea General: \u00abProfundamente preocupada\u00bb; el Consejo de Seguridad: \u00abProfundamente preocupado\u00bb); la parte dispositiva empieza por verbo en presente de indicativo en cursiva; las f\u00f3rmulas fijas; la puntuaci\u00f3n final (coma en el pre\u00e1mbulo, punto y coma en la dispositiva y punto en el \u00faltimo p\u00e1rrafo). Como cita, usa la palabra o el signo afectado.` }
};

export const VERIFIER = `Eres un revisor jefe de traducciones de las Naciones Unidas del {{LANG}} al espa\u00f1ol. Otro revisor ha se\u00f1alado los problemas de la lista. Tu trabajo es VERIFICARLOS uno por uno con el original y la traducci\u00f3n: confirma los correctos, corrige la sugerencia cuando sea mejorable y descarta los falsos positivos (lo que en realidad est\u00e1 bien, cuestiones de gusto o sugerencias que empeoran el texto).

El texto est\u00e1 enmascarado: las expresiones entre llaves ({CARGO1}, {la ORGANO2}, {NUM3}...) sustituyen datos reales; el art\u00edculo dentro de la llave indica el g\u00e9nero y el n\u00famero. No las cambies.

FORMATO DE RESPUESTA (obligatorio), una l\u00ednea por hallazgo y sin Markdown:
<id del hallazgo> | <OK, NO o EDITAR> | <sugerencia corregida si es EDITAR; vac\u00edo si no> | <motivo, como m\u00e1ximo 12 palabras>
Al final escribe exactamente: FIN <n\u00famero de hallazgos verificados>`;

export function defaultPrompt(moduleId) {
  if (moduleId === 'verifier') return VERIFIER;
  return TASKS[moduleId] ? TASKS[moduleId].text : '';
}

export async function loadPrompts() {
  const v = await getValue(PROMPTS_KEY, null);
  return (v && v.map) ? v : { updatedAt: 0, map: {} };
}

export async function savePrompt(moduleId, text) {
  const store = await loadPrompts();
  if (!text || text.trim() === defaultPrompt(moduleId).trim()) delete store.map[moduleId];
  else store.map[moduleId] = text;
  store.updatedAt = Date.now();
  await setValue(PROMPTS_KEY, store);
}

export function promptOf(store, moduleId) {
  const t = store && store.map && store.map[moduleId];
  return (t && t.trim()) ? t : defaultPrompt(moduleId);
}

/** System prompt for one or several fused modules. */
export function systemPrompt(store, moduleIds, lang, alwaysRulesText) {
  const cats = [];
  for (const id of moduleIds) for (const c of (TASKS[id] ? TASKS[id].cats : [])) if (!cats.includes(c)) cats.push(c);
  const tasks = moduleIds.map(id => promptOf(store, id)).join('\n\n');
  return COMMON.replace('{{LANG}}', lang === 'fr' ? 'franc\u00e9s' : 'ingl\u00e9s').replace('{{CATS}}', cats.join(', ')) +
    '\n\n' + tasks + (alwaysRulesText || '');
}

export function verifierPrompt(store, lang) {
  return promptOf(store, 'verifier').replace('{{LANG}}', lang === 'fr' ? 'franc\u00e9s' : 'ingl\u00e9s');
}

/** Fingerprint of what a module asks (for the results cache). */
export function promptVersion(store, moduleIds) {
  return fnv1a(COMMON + moduleIds.map(id => promptOf(store, id)).join('|'));
}

export const CAT_LABELS = {
  MIST: 'Traducci\u00f3n err\u00f3nea', UNTR: 'Sin traducir', OMI: 'Omisi\u00f3n', ADD: 'Adici\u00f3n', ORT: 'Ortograf\u00eda',
  GRA: 'Gram\u00e1tica', PUNT: 'Puntuaci\u00f3n', EST: 'Estilo', LEC: 'Lectura en fr\u00edo', COH: 'Coherencia', CONV: 'Convenciones'
};

/** Which module owns a category (for findings from external AIs). */
export const CAT_MODULE = {
  MIST: 'fidelity', UNTR: 'fidelity', OMI: 'integrity', ADD: 'integrity', ORT: 'grammar', GRA: 'grammar', PUNT: 'grammar',
  EST: 'style', LEC: 'coldread', COH: 'coherence', CONV: 'conventions'
};
