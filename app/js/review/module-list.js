/**
 * module-list.js - The review modules as the rest of the app names them. Pure data, no logic:
 * settings screens, the module cards, the planner and the rules editor all read this list.
 *
 * input: 'bilingual' (source + target), 'target' (Spanish only), 'skeleton' (structure digest),
 *        'findings' (other modules' findings), 'names' (only the table of institutional names).
 * roles: which model slots the module offers ('triage' = economical pass over everything,
 *        'deep' = strong model on what triage or the local layer flagged).
 */
export const MODULES = [
  { id: 'grammar', label: 'Gram\u00e1tica', short: 'Gram\u00e1tica', input: 'target', roles: ['triage'], ai: true,
    desc: 'Concordancia, r\u00e9gimen, tiempos verbales y puntuaci\u00f3n del espa\u00f1ol (la ortograf\u00eda la corrige Word).' },
  { id: 'fidelity', label: 'Fidelidad', short: 'Fidelidad', input: 'bilingual', roles: ['triage', 'deep'], ai: true,
    desc: 'Errores de SENTIDO: lo que hace que la traducci\u00f3n diga algo distinto del original.' },
  { id: 'integrity', label: 'Integridad', short: 'Integridad', input: 'bilingual', roles: ['triage', 'deep'], ai: true,
    desc: 'Omisiones y adiciones respecto del original.' },
  { id: 'style', label: 'Estilo', short: 'Estilo', input: 'target', roles: ['triage'], ai: true,
    desc: 'Calcos, pasivas, gerundios, nominalizaciones, registro institucional y claridad.' },
  { id: 'coherence', label: 'Coherencia', short: 'Coherencia', input: 'skeleton', roles: ['triage'], ai: true,
    desc: 'Etiquetas, estructura, paralelismo de listas y coherencia de las expresiones repetidas.' },
  { id: 'conventions', label: 'Convenciones ONU', short: 'Convenciones', input: 'skeleton', roles: ['triage'], ai: true,
    desc: 'Pre\u00e1mbulo y parte dispositiva, cursivas, f\u00f3rmulas fijas, cifras, fechas y s\u00edmbolos.' },
  { id: 'coldread', label: 'Lectura en fr\u00edo', short: 'Lectura en fr\u00edo', input: 'target', roles: ['triage'], ai: true,
    desc: 'Lee la traducci\u00f3n sin el original y se\u00f1ala lo que no se entiende o suena a traducci\u00f3n.' },
  { id: 'names', label: 'Nombres oficiales', short: 'Nombres', input: 'names', roles: ['triage'], ai: true,
    desc: 'Denominaci\u00f3n oficial y coherencia de organismos, \u00f3rganos, cargos, pa\u00edses y lugares. Solo env\u00eda la lista de esos nombres, sin el texto.' },
  { id: 'verifier', label: 'Verificador', short: 'Verificador', input: 'findings', roles: ['deep'], ai: true,
    desc: 'Revisa solo los hallazgos de los dem\u00e1s m\u00f3dulos y descarta los falsos positivos.' }
];

export const AI_MODULES = MODULES.filter(m => m.ai);

export function moduleById(id) {
  return MODULES.find(m => m.id === id) || null;
}

export const ROLE_LABELS = { triage: 'Cribado', deep: 'A fondo' };

export const INPUT_ICONS = { names: '\u2630', bilingual: '\u21c4', target: '\u00b6', skeleton: '\u2317', findings: '\u2713', local: '\u2699' };
export const INPUT_LABELS = {
  names: 'Lista de nombres', bilingual: 'Biling\u00fce', target: 'Solo espa\u00f1ol', skeleton: 'Esqueleto', findings: 'Solo hallazgos', local: 'Sin IA'
};
