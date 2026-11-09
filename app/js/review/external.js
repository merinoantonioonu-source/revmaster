/**
 * external.js - Bridge with external AIs (ChatGPT, Gemini, Claude... in their own websites):
 *   buildExternalText(session, opts) -> the masked bilingual text with instructions, ready to paste.
 *   importExternal(text, session)     -> findings in UMBRA's format (same parser as the modules).
 */

import { reviewableUnits, unitSrcMasked, unitTgtMasked } from './session.js';
import { parseFindings } from './parse.js';
import { anchorItem } from './findings.js';
import { TASKS, CAT_LABELS } from './prompts.js';
import { moduleById } from './module-list.js';

/**
 * opts = { modules:[ids] (tasks to ask for; default Sentido and Redaccion), bilingual:true, withInstructions:true }
 */
export function buildExternalText(session, opts) {
  const o = Object.assign({ modules: ['meaning', 'writing'], bilingual: true, withInstructions: true }, opts || {});
  const units = reviewableUnits(session).filter(u => u.tgtPara !== null || (o.bilingual && u.srcPara !== null));
  const cats = [];
  for (const id of o.modules) for (const c of (TASKS[id] ? TASKS[id].cats : [])) if (!cats.includes(c)) cats.push(c);
  let head = '';
  if (o.withInstructions) {
    const lang = session.srcLang === 'fr' ? 'franc\u00e9s' : 'ingl\u00e9s';
    head = 'Eres un revisor profesional de traducciones de las Naciones Unidas del ' + lang + ' al espa\u00f1ol.\n\n' +
      'El texto est\u00e1 ENMASCARADO: las expresiones entre llaves sustituyen datos confidenciales ({CARGO1}, {ORGANO2}, {NUM3}, {PAIS4}...); ' +
      'la misma etiqueta en el original y en la traducci\u00f3n es el mismo dato. No cambies las etiquetas ni intentes adivinar lo que ocultan.\n\n' +
      'Revisa:\n' + o.modules.filter(id => TASKS[id]).map(id => '- ' + TASKS[id].text.replace(/^TAREA \u2014 /, '')).join('\n') + '\n\n' +
      'RESPONDE SOLO con una l\u00ednea por problema, sin Markdown ni texto adicional:\n' +
      '<n.\u00ba de p\u00e1rrafo> | <categor\u00eda> | <gravedad> | <cita exacta de la traducci\u00f3n> | <sugerencia> | <motivo breve>\n' +
      'Categor\u00edas: ' + cats.map(c => c + ' (' + CAT_LABELS[c].toLowerCase() + ')').join(', ') + '.\n' +
      'Gravedad: CRI (cambia el sentido), MAY (error claro), MEN (menor), SUG (sugerencia).\n' +
      'La cita es una copia literal y breve del fragmento err\u00f3neo; si falta algo, deja la cita vac\u00eda y explica en la sugerencia qu\u00e9 falta y d\u00f3nde (tras \u00ab...\u00bb: ...).\n' +
      'No uses el car\u00e1cter | dentro de los campos. Revisa todos los p\u00e1rrafos y termina con: FIN <n\u00famero de p\u00e1rrafos revisados>\n\n';
  }
  const body = units.map(u => {
    const s = unitSrcMasked(session, u).replace(/\s+/g, ' ').trim();
    const t = unitTgtMasked(session, u).replace(/\s+/g, ' ').trim();
    return o.bilingual ? '[' + u.n + ']\nO: ' + s + '\nT: ' + t : '[' + u.n + '] ' + t;
  }).join('\n');
  return head + (o.bilingual ? 'P\u00c1RRAFOS (O = original, T = traducci\u00f3n):\n' : 'P\u00c1RRAFOS DE LA TRADUCCI\u00d3N:\n') + body + '\n';
}

/** -> { findings, ignored, fin } */
export function importExternal(text, session) {
  const unitByN = new Map(session.units.map(u => [u.n, u]));
  const parsed = parseFindings(text, new Set(unitByN.keys()));
  const findings = parsed.items.map(it => anchorItem(it, { session, unitByN, source: 'external', model: 'IA externa', role: 'external' })).filter(Boolean);
  return { findings, ignored: parsed.ignored, fin: parsed.fin };
}

export function moduleLabel(id) {
  const m = moduleById(id);
  return m ? m.label : id;
}
