/**
 * doc-type.js - The selector of the project's type of document (Archivos and Revisar): the same choice
 * in both places, kept in step through the 'project-flags' event.
 */

import { el } from '../util/dom.js';
import { state, on, setDocType } from '../state.js';
import { DOC_TYPES } from '../review/doc-types.js';
import { helpBtn } from './help.js';

/** A row "Tipo de documento [select] ?" bound to the open project. */
export function docTypeRow(id) {
  const sel = el('select.inp.doctype-sel', { id, title: 'Las convenciones de este tipo de texto no se se\u00f1alan como errores (se a\u00f1ade una l\u00ednea a las instrucciones)' },
    ...DOC_TYPES.map(t => el('option', { value: t.id }, t.label)));
  sel.addEventListener('change', () => setDocType(sel.value));
  const row = el('label.doctype', el('b', 'Tipo de documento'), sel, helpBtn('doctype'));
  const sync = () => {
    sel.value = (state.project && state.project.docType) || '';
    row.classList.toggle('hidden', !state.project);
  };
  on('project', sync);
  on('project-flags', sync);
  sync();
  return row;
}
