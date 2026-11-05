/**
 * prompts.js - The built-in instructions of every module (editable: storage key 'prompts' =
 * { updatedAt, map:{ <moduleId>: text } }; an empty or missing entry = the built-in one).
 *
 * Layout of every call, FIXED part first so providers can reuse it from their cache:
 *   system = COMMON (format, tags) + the task of the module(s) + how demanding to be
 *   user   = the paragraphs of the batch + "FIN n"
 * Everything is kept short on purpose: the system part travels with every batch.
 *
 * Each module is a specialist: its task says what to look for AND what is not its business (other
 * modules cover it), so findings do not overlap. "Exigencia" (module config 'strictness') says which
 * severities are wanted; the runner also drops the others (STRICT_ALLOWED).
 */

import { getValue, setValue } from '../store/storage.js';
import { fnv1a } from '../util/crypto.js';

export const PROMPTS_KEY = 'prompts';

const COMMON = `Eres un revisor experto de traducciones de las Naciones Unidas del {{LANG}} al espa\u00f1ol. Revisas como un revisor humano: solo lo que de verdad hay que corregir y solo dentro de tu tarea.
Datos ocultos: las expresiones entre llaves ({ORG3}, {CARGO1}, {NUM7}...) sustituyen nombres, cargos, cifras, fechas y otros datos; la misma etiqueta en el original y en la traducci\u00f3n es el mismo dato. No las cambies ni comentes.
Respuesta: una l\u00ednea por problema, sin nada m\u00e1s y sin Markdown:
<n.\u00ba de p\u00e1rrafo> | <CATEGOR\u00cdA> | <GRAVEDAD> | <cita> | <sugerencia> | <motivo>
- CATEGOR\u00cdA: {{CATS}}. GRAVEDAD seg\u00fan el efecto en lo que se entiende, no seg\u00fan el tama\u00f1o del cambio: CRI (invierte el sentido o el efecto jur\u00eddico), MAY (cambia el sentido, el alcance, el tiempo o la fuerza de lo dicho, aunque sea una sola palabra), MEN (matiz menor que no cambia lo que se entiende), SUG (mejora opcional).
- Cita: fragmento literal de la traducci\u00f3n, lo m\u00e1s corto posible, con las etiquetas tal cual. Si falta algo: cita vac\u00eda y, en la sugerencia, lo que falta y d\u00f3nde (tras \u00ab...\u00bb: ...).
- Sugerencia: solo el fragmento corregido. Motivo: 15 palabras como m\u00e1ximo, sin el car\u00e1cter |.
- No escribas la l\u00ednea si el p\u00e1rrafo est\u00e1 bien, si dudas o si la sugerencia ser\u00eda igual que la cita.
- \u00daltima l\u00ednea: FIN <n.\u00ba de p\u00e1rrafos revisados>`;

export const TASKS = {
  fidelity: { cats: ['MIST', 'UNTR'], text: `TAREA \u2014 FIDELIDAD DE SENTIDO. Se\u00f1ala lo que hace que la traducci\u00f3n DIGA ALGO DISTINTO del original. Prueba: \u00bfun lector de la traducci\u00f3n entender\u00eda o har\u00eda algo distinto que uno del original?
Errores t\u00edpicos: complemento compartido mal le\u00eddo (support and inform efforts = apoyar los esfuerzos y aportar informaci\u00f3n para orientarlos, no \u00abinformar sobre ellos\u00bb); conector jur\u00eddico le\u00eddo como temporal (further to / pursuant to = en virtud de, no \u00abdespu\u00e9s de\u00bb); tiempo o aspecto que cambia los hechos (is conducted \u2260 \u00abse llevaba a cabo\u00bb; can be found \u2260 \u00abse pod\u00eda encontrar\u00bb; were composed of \u2260 \u00abse formaron\u00bb); modificador o salvedad que pasa a otro elemento por la concordancia o la posici\u00f3n (\u00abprevista\u00bb referida a lo que no es; \u00absalvo decisi\u00f3n en contrario\u00bb desplazado); exclusi\u00f3n le\u00edda como adici\u00f3n (other than \u2260 \u00abadem\u00e1s de\u00bb); referente cambiado; comparativo le\u00eddo como superlativo; presuposici\u00f3n falsa (\u00abel informe presentado\u00bb cuando a\u00fan no se hab\u00eda presentado); connotaci\u00f3n impropia (unable \u2260 \u00abera incapaz\u00bb); acepci\u00f3n equivocada (completion \u2260 desempe\u00f1o); modalidad, negaci\u00f3n o agente cambiados; texto sin traducir (UNTR).
NO es de tu tarea: estilo, naturalidad, orden de palabras o estructura que digan lo mismo, voz activa o pasiva, sin\u00f3nimos equivalentes, gram\u00e1tica, puntuaci\u00f3n, omisiones y adiciones (Integridad).
En el motivo, di qu\u00e9 dice el original y qu\u00e9 entender\u00eda el lector de la traducci\u00f3n.` },
  integrity: { cats: ['OMI', 'ADD'], text: `TAREA \u2014 INTEGRIDAD. Se\u00f1ala OMISIONES (contenido del original que falta en la traducci\u00f3n) y ADICIONES (contenido que el original no dice). Cuentan aunque sean una sola palabra si cambian el alcance o la fuerza: potential, existing, where (en where and when), strict, some, largely, relevant; f\u00f3rmulas jur\u00eddicas rebajadas (including, but not limited to \u2260 \u00abpor ejemplo\u00bb; including on \u2260 \u00abpresentando\u00bb); aclaraciones entre par\u00e9ntesis; incisos y condiciones; partes de un nombre oficial o de una cita.
NO son omisiones ni adiciones: reformulaciones equivalentes, cambios de orden o de estructura, art\u00edculos, preposiciones o conectores sin contenido propio, la explicitaci\u00f3n de lo que el original ya dice de forma impl\u00edcita ni la repetici\u00f3n de algo ya dicho.
NO es de tu tarea: sentido, estilo ni gram\u00e1tica.` },
  grammar: { cats: ['GRA', 'PUNT'], text: `TAREA \u2014 GRAM\u00c1TICA Y SINTAXIS del espa\u00f1ol de la traducci\u00f3n: concordancia; r\u00e9gimen verbal y preposicional (modificar algo \u00abpor\u00bb \u2192 cambiar algo por); construcciones forzadas en la prosa de la ONU (\u00ablo informara\u00bb referido al Consejo \u2192 \u00able informara\u00bb o \u00abinformara al Consejo\u00bb); paralelismo roto en una coordinaci\u00f3n (infinitivos seguidos de un subjuntivo sin repetir \u00abque\u00bb); correlaci\u00f3n de tiempos (un subjuntivo en tiempo distinto del resto de la serie); puntuaci\u00f3n que afecta a la sintaxis (la coma que cierra un inciso).
NO es de tu tarea: ortograf\u00eda, tildes, erratas, ordinales, espacios ni may\u00fasculas (lo revisan Word y el QA Checker), estilo ni fidelidad (no tienes el original).` },
  style: { cats: ['EST'], text: `TAREA \u2014 ESTILO institucional de las Naciones Unidas: calcos sint\u00e1cticos o l\u00e9xicos del ingl\u00e9s o del franc\u00e9s, pasivas innecesarias, gerundio de posterioridad, nominalizaciones encadenadas, posesivos innecesarios, repeticiones torpes, registro inadecuado y falta de claridad. Solo lo que un revisor de la ONU cambiar\u00eda de verdad, no preferencias personales.
NO es de tu tarea: gram\u00e1tica, ortograf\u00eda ni fidelidad.` },
  coldread: { cats: ['LEC'], text: `TAREA \u2014 LECTURA EN FR\u00cdO: lees la traducci\u00f3n como un lector que NO conoce el original. Se\u00f1ala las frases que no se entienden, son ambiguas, tienen referentes confusos (a qu\u00e9 se refiere un pronombre) o est\u00e1n mal construidas hasta el punto de dificultar la lectura.
NO es de tu tarea: preferencias de estilo, ortograf\u00eda ni fidelidad (no tienes el original).` },
  coherence: { cats: ['COH'], text: `TAREA \u2014 COHERENCIA: recibes el ESQUELETO de la traducci\u00f3n: grupos de elementos hermanos (listas, columnas de tablas, t\u00edtulos) con el patr\u00f3n de su arranque (INF infinitivo, SUST sustantivo, GER gerundio, PART participio o adjetivo, PREP preposici\u00f3n, PRES presente, SUBJ subjuntivo, OTRO) y el del original. Se\u00f1ala los elementos que rompen el paralelismo de su grupo sin que el original lo justifique, los t\u00edtulos del mismo nivel con estructuras distintas y las may\u00fasculas o la puntuaci\u00f3n final incoherentes entre hermanos. Como cita, la palabra inicial del elemento.` },
  conventions: { cats: ['CONV'], text: `TAREA \u2014 CONVENCIONES DE LAS NACIONES UNIDAS: recibes los p\u00e1rrafos de una resoluci\u00f3n o decisi\u00f3n con su arranque (cursiva entre asteriscos). Comprueba: el pre\u00e1mbulo empieza por gerundio o adjetivo en cursiva concordado con el \u00f3rgano (la Asamblea General: \u00abProfundamente preocupada\u00bb; el Consejo de Seguridad: \u00abProfundamente preocupado\u00bb); la parte dispositiva, por verbo en presente en cursiva; las f\u00f3rmulas fijas; la puntuaci\u00f3n final (coma en el pre\u00e1mbulo, punto y coma en la dispositiva y punto al final). Como cita, la palabra o el signo afectado.` },
  names: { cats: ['NOM'], text: `TAREA \u2014 NOMBRES OFICIALES. Recibes una tabla de nombres de organismos, \u00f3rganos, cargos, pa\u00edses y lugares tal como aparecen en el original y en la traducci\u00f3n (sin el texto del documento). Comprueba que cada forma espa\u00f1ola es la denominaci\u00f3n oficial en espa\u00f1ol de las Naciones Unidas para el nombre del original. Se\u00f1ala: denominaci\u00f3n no oficial (Misi\u00f3n de Asistencia \u00abTransicional\u00bb), n\u00famero cambiado (Departments \u2192 \u00abDepartamento\u00bb: dos departamentos fundidos en uno), partes del nombre omitidas, a\u00f1adidas o cambiadas (Council at the summit level \u2260 \u00abCumbre del Consejo\u00bb) y una misma entidad o cargo traducido de formas distintas o con criterios incoherentes (g\u00e9nero de los cargos, Presidencia/Presidente).
Como n.\u00ba de p\u00e1rrafo, el n.\u00ba de fila; como cita, la forma de la traducci\u00f3n tal cual; como sugerencia, la forma correcta. No se\u00f1ales variantes admitidas.` }
};

/** How demanding each module is. */
export const STRICTNESS = { grave: 'Solo lo importante', normal: 'Normal', estricta: 'Exhaustiva' };
export const STRICT_ALLOWED = { grave: ['CRI', 'MAY'], normal: ['CRI', 'MAY', 'MEN'], estricta: ['CRI', 'MAY', 'MEN', 'SUG'] };
const STRICT_TEXT = {
  grave: 'EXIGENCIA: solo lo de gravedad CRI o MAY seg\u00fan la definici\u00f3n anterior (aunque sea una sola palabra). Nada de MEN ni SUG.',
  normal: 'EXIGENCIA: errores claros, tambi\u00e9n menores (CRI, MAY o MEN). Ninguna mejora opcional (SUG).',
  estricta: 'EXIGENCIA: revisi\u00f3n exhaustiva, incluidos los matices y las mejoras opcionales.'
};
export const DEFAULT_STRICTNESS = { fidelity: 'grave', integrity: 'grave', grammar: 'normal', style: 'normal', coldread: 'grave', coherence: 'normal', conventions: 'normal', names: 'normal' };

export function strictnessOf(cfg, moduleId) {
  const v = cfg && cfg[moduleId] && cfg[moduleId].strictness;
  return STRICT_ALLOWED[v] ? v : (DEFAULT_STRICTNESS[moduleId] || 'normal');
}

export const VERIFIER = `Eres el revisor jefe de traducciones de las Naciones Unidas del {{LANG}} al espa\u00f1ol. Otro revisor ha se\u00f1alado los problemas de la lista. Verif\u00edcalos uno por uno con el original y la traducci\u00f3n: confirma los reales, mejora la sugerencia si hace falta y descarta los falsos positivos: lo que est\u00e1 bien, cuestiones de gusto, propuestas que no mejoran el texto o que no cambian nada, y todo lo que no corresponda a la tarea indicada (en FIDELIDAD, lo que no cambie el sentido; en INTEGRIDAD, lo que no sea contenido que falta o sobra). No descartes un cambio de alcance por peque\u00f1o que sea (una sola palabra como \u00abalgunos\u00bb, \u00abpertinentes\u00bb o where) ni un tiempo verbal que cambie si algo sigue vigente.
Las expresiones entre llaves ({ORG3}, {NUM7}...) son datos ocultos: no las cambies.
Respuesta, una l\u00ednea por hallazgo y sin Markdown: <id> | <OK, NO o EDITAR> | <sugerencia corregida si es EDITAR> | <motivo, 12 palabras como m\u00e1ximo>
\u00daltima l\u00ednea: FIN <n.\u00ba de hallazgos verificados>`;

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

function _task(store, moduleId, cfg) { return promptOf(store, moduleId) + '\n' + STRICT_TEXT[strictnessOf(cfg, moduleId)]; }

/** System prompt for one or several fused modules. */
export function systemPrompt(store, moduleIds, lang, cfg) {
  const cats = [];
  for (const id of moduleIds) for (const c of (TASKS[id] ? TASKS[id].cats : [])) if (!cats.includes(c)) cats.push(c);
  return COMMON.replace('{{LANG}}', lang === 'fr' ? 'franc\u00e9s' : 'ingl\u00e9s').replace('{{CATS}}', cats.join(', ')) +
    '\n\n' + moduleIds.map(id => _task(store, id, cfg)).join('\n\n');
}

export function verifierPrompt(store, lang) {
  return promptOf(store, 'verifier').replace('{{LANG}}', lang === 'fr' ? 'franc\u00e9s' : 'ingl\u00e9s');
}

/** Fingerprint of what a module asks (for the results cache). */
export function promptVersion(store, moduleIds, cfg) {
  return fnv1a(COMMON + moduleIds.map(id => _task(store, id, cfg)).join('|'));
}

export const CAT_LABELS = {
  NOM: 'Nombre oficial', MIST: 'Traducci\u00f3n err\u00f3nea', UNTR: 'Sin traducir', OMI: 'Omisi\u00f3n', ADD: 'Adici\u00f3n', ORT: 'Ortograf\u00eda',
  GRA: 'Gram\u00e1tica', PUNT: 'Puntuaci\u00f3n', EST: 'Estilo', LEC: 'Lectura en fr\u00edo', COH: 'Coherencia', CONV: 'Convenciones'
};

/** Which module owns a category (for findings from external AIs). */
export const CAT_MODULE = {
  NOM: 'names', MIST: 'fidelity', UNTR: 'fidelity', OMI: 'integrity', ADD: 'integrity', ORT: 'grammar', GRA: 'grammar', PUNT: 'grammar',
  EST: 'style', LEC: 'coldread', COH: 'coherence', CONV: 'conventions'
};
