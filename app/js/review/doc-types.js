/**
 * doc-types.js - The type of document of a project (Archivos and Revisar). It goes into the
 * instructions in one short line, so the reviewers know the conventions of that kind of text and do
 * not report them as errors: the present tense of the summary records, "his delegation" given the
 * country's name, the gerunds of a preamble... Saving tokens: one line, only where it matters.
 *
 * A project's type is guessed from the file names (the eLUNa symbol: A/C.5/78/SR.12 -> summary record)
 * and can be changed; a bench may set it (banco.json "docType").
 */

export const DOC_TYPES = [
  { id: '', label: 'Sin especificar', line: '' },
  { id: 'sr', label: 'Acta resumida',
    line: 'Tipo de documento: acta resumida. Convenciones que no son errores: el espa\u00f1ol narra en presente lo que el original cuenta en pasado (said: \u00abdice\u00bb; were parties: \u00abson partes\u00bb) y \u00abhis/her delegation\u00bb o \u00abthe speaker\u00bb pueden darse con el nombre del pa\u00eds o de la persona.' },
  { id: 'pv', label: 'Acta literal',
    line: 'Tipo de documento: acta literal. Se traduce lo dicho tal cual, en primera persona y en el tiempo del orador.' },
  { id: 'res', label: 'Resoluci\u00f3n o decisi\u00f3n',
    line: 'Tipo de documento: resoluci\u00f3n o decisi\u00f3n. Convenciones que no son errores: el pre\u00e1mbulo con gerundio o participio (Recordando, Observando) y la parte dispositiva con el verbo en presente (Decide, Solicita).' },
  { id: 'report', label: 'Informe', line: 'Tipo de documento: informe.' },
  { id: 'fin', label: 'Estados financieros o presupuesto', line: 'Tipo de documento: estados financieros o presupuesto.' },
  { id: 'letter', label: 'Carta o nota verbal', line: 'Tipo de documento: carta o nota verbal.' }
];

export function docTypeById(id) { return DOC_TYPES.find(t => t.id === (id || '')) || DOC_TYPES[0]; }

/** The instructions' line for a type ('' when it has none). */
export function docTypeLine(id) { return docTypeById(id).line; }

/** The type the eLUNa symbol in a file name suggests (A_C.5_78_SR.12.docx, S_PV.9500.docx, A_RES_78_1...). */
export function guessDocType(names) {
  const s = (names || []).filter(Boolean).join(' ');
  if (/(^|[^A-Za-z])SR[._ -]?\d/.test(s)) return 'sr';
  if (/(^|[^A-Za-z])PV[._ -]?\d/.test(s)) return 'pv';
  if (/(^|[^A-Za-z])(RES|DEC)[._ /-]/.test(s)) return 'res';
  return '';
}
