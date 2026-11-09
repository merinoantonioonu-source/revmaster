/**
 * module-list.js - The review modules as the rest of the app names them. Pure data, no logic:
 * settings screens, the module cards, the planner and the rules editor all read this list.
 *
 * SIMPLIFIED (2026-11-09, the owner's choice): one master review of MEANING ("Sentido": what the
 * translation says differently from the original, what it leaves out or adds), checked by the Verifier;
 * the WRITING of the Spanish ("Redaccion": grammar and institutional style) as a lighter pass; the
 * official names. Before, nine specialist reviewers: Fidelidad and Integridad are now Sentido, Gramatica
 * and Estilo are Redaccion, and Lectura en frio, Coherencia and Convenciones ONU are gone (LEGACY_MODULES
 * maps their ids, still in old projects and sync files, to the module that now covers them).
 *
 * input: 'bilingual' (source + target), 'target' (Spanish only), 'findings' (other modules' findings),
 *        'names' (only the table of institutional names).
 * plain: the one-line description of the Revisar cards (plain words, no jargon).
 * roles: the model slot the module uses ('triage' = an economical model is enough, 'deep' = the strongest
 *        model: Sentido and the Verifier).
 */
export const MODULES = [
  { id: 'meaning', label: 'Sentido', short: 'Sentido', input: 'bilingual', roles: ['deep'], ai: true,
    plain: '\u00bfDice lo mismo que el original? Errores de sentido, omisiones y a\u00f1adidos, aunque sean una palabra.',
    desc: 'Lo que hace que la traducci\u00f3n diga algo distinto del original: errores de sentido, lo que falta, lo que sobra y lo que se ha quedado sin traducir.' },
  { id: 'writing', label: 'Redacci\u00f3n', short: 'Redacci\u00f3n', input: 'target', roles: ['triage'], ai: true,
    plain: 'Gram\u00e1tica y estilo del espa\u00f1ol de la ONU: concordancias, r\u00e9gimen, calcos, registro.',
    desc: 'Lee solo la traducci\u00f3n: gram\u00e1tica que afecta a la sintaxis, puntuaci\u00f3n de los incisos y estilo institucional (calcos, pasivas, gerundios, nominalizaciones, registro).' },
  { id: 'names', label: 'Nombres oficiales', short: 'Nombres', input: 'names', roles: ['triage'], ai: true,
    plain: '\u00d3rganos, cargos y pa\u00edses con su nombre oficial. Solo viaja la lista de nombres.',
    desc: 'Denominaci\u00f3n oficial y coherencia de organismos, \u00f3rganos, cargos, pa\u00edses y lugares. Solo env\u00eda la lista de esos nombres, sin el texto.' },
  { id: 'verifier', label: 'Verificador', short: 'Verificador', input: 'findings', roles: ['deep'], ai: true,
    plain: 'Descarta los falsos positivos de los dem\u00e1s revisores.',
    desc: 'Revisa solo los hallazgos de los dem\u00e1s m\u00f3dulos y descarta los falsos positivos.' }
];

/** The ids of the reviewers before the simplification -> the module that covers their work now. */
export const LEGACY_MODULES = Object.freeze({
  fidelity: 'meaning', integrity: 'meaning',
  grammar: 'writing', style: 'writing', coldread: 'writing', coherence: 'writing', conventions: 'writing'
});

/** A module id as it is today (an old one, from an old project or sync file, becomes its successor). */
export function currentModuleId(id) {
  return LEGACY_MODULES[id] || id;
}

export const AI_MODULES = MODULES.filter(m => m.ai);

export function moduleById(id) {
  return MODULES.find(m => m.id === id) || MODULES.find(m => m.id === LEGACY_MODULES[id]) || null;
}

export const ROLE_LABELS = { triage: 'Econ\u00f3mico', deep: 'El m\u00e1s fuerte' };

export const INPUT_ICONS = { names: '\u2630', bilingual: '\u21c4', target: '\u00b6', findings: '\u2713', local: '\u2699' };
export const INPUT_LABELS = {
  names: 'Lista de nombres', bilingual: 'Biling\u00fce', target: 'Solo espa\u00f1ol', findings: 'Solo hallazgos', local: 'Sin IA'
};
