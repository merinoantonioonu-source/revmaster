/**
 * compare-view.js - The dialog of "Comparar con la version final" (Corregir > Mas): the translator loads
 * the final, reviewed translation; review/compare.js sets UMBRA's findings against what the reviser
 * changed; the dialog shows the figures and offers the summary to paste in the chat, an Excel with the
 * detail and a bench of one's own built from this real work. Nothing goes to any AI.
 */

import { el, toast, modal, pickFiles, download, copyText } from '../util/dom.js';
import { state, saveProjectSoon } from '../state.js';
import { parseDocument } from '../formats/parse.js';
import { compareWithFinal, compareSummary, compareBench, compareBenchZip } from '../review/compare.js';
import { moduleById } from '../review/module-list.js';
import { helpBtn } from './help.js';

const VERDICT = { acertado: 'Acertado probable', posible: 'Posible', espurio: 'Espurio probable', sinfinal: 'Sin versi\u00f3n final' };
const _base = (name) => String(name || 'umbra').replace(/\.[^.]+$/, '');
const _label = (id) => (moduleById(id) || { label: id }).label;

export async function compareDialog() {
  if (!state.project || !state.session) return;
  if (!state.findings.some(f => f.source === 'ai' || f.source === 'external')) {
    toast('Primero revise el documento: no hay hallazgos de la IA que comparar.', 'warn', 7000);
    return;
  }
  const [file] = await pickFiles('.docx,.pptx,.xlsx', false);
  if (!file) return;
  let model;
  try { model = await parseDocument(file); } catch (e) { toast('No se pudo abrir: ' + e.message, 'err', 8000); return; }
  if (model.kind !== state.tgt.kind) { toast('La versi\u00f3n final debe tener el mismo formato que la traducci\u00f3n (' + state.tgt.kind.toUpperCase() + ').', 'err', 8000); return; }
  const res = compareWithFinal(state.session, state.findings, model);
  const s = res.stats;
  state.project.compare = { at: Date.now(), finalName: file.name, stats: s };
  saveProjectSoon();
  const models = [...new Set(state.findings.map(f => f.model).filter(Boolean))].join(', ');
  const info = { project: state.project.name, finalName: file.name, models, moduleLabel: _label, unitN: (i) => state.session.units[i].n };
  const row = (a, b, cls) => el('tr', el('td', a), el('td' + (cls ? '.' + cls : ''), String(b)));
  const body = el('div',
    el('p', 'La versi\u00f3n final (', el('b', file.name), ') frente a los hallazgos de UMBRA, p\u00e1rrafo a p\u00e1rrafo. ',
      el('span.muted', 'Probable, no seguro: un revisor tambi\u00e9n cambia por preferencia.')),
    el('table.grid.cmp',
      row('Hallazgos de la IA', s.findings),
      row('Acertados probables (el revisor cambi\u00f3 ah\u00ed)', s.acertado, 'ok-t'),
      row('\u2026con la misma correcci\u00f3n que el revisor', s.same),
      row('Posibles (sin lugar exacto, en un p\u00e1rrafo que el revisor cambi\u00f3)', s.posible),
      row('Espurios probables (el revisor no cambi\u00f3 nada ah\u00ed)', s.espurio, 'err-t'),
      row('Omitidos probables (cambios de texto del revisor que UMBRA no se\u00f1al\u00f3)', s.misses, 'warn-t'),
      row('Descartados por el Verificador donde el revisor s\u00ed cambi\u00f3', s.lostButChanged),
      row('Cambios del revisor solo de forma / solo de cifras (no son tarea de UMBRA)', s.changes.forma + ' / ' + s.changes.cifras)),
    s.unitsUnpaired ? el('p.note.warn', s.unitsUnpaired + ' p\u00e1rrafos no tienen pareja en la versi\u00f3n final (se a\u00f1adieron o quitaron p\u00e1rrafos): no se comparan.') : null,
    el('p.info', 'Para ajustar UMBRA: \u00abCopiar el resumen\u00bb y p\u00e9guelo en el chat con Claude. \u00abCrear banco\u00bb hace un banco de pruebas con este trabajo real (Archivos \u203a Banco de pruebas \u203a Cargar un banco propio), para medir cada ajuste antes y despu\u00e9s.'));
  await modal({ title: 'Comparaci\u00f3n con la versi\u00f3n final', help: helpBtn('compare'), width: '720px', body, buttons: [
    { label: 'Copiar el resumen', onClick: async () => { await copyText(compareSummary(res, info)); toast('Resumen copiado: p\u00e9guelo en el chat.', 'ok'); return false; } },
    { label: 'Descargar Excel', onClick: async () => { await _excel(res, file.name); return false; } },
    { label: 'Crear banco (.zip)', onClick: async () => {
      const spec = compareBench(state.session, res, 'Banco de ' + state.project.name, state.project.docType || '');
      if (!spec.paragraphs.length) { toast('No hay p\u00e1rrafos que llevar al banco.', 'warn'); return false; }
      download(await compareBenchZip(spec, state.session.srcLang), _base(state.project.tgtName) + '_BANCO.zip');
      toast('Banco creado: ' + spec.paragraphs.length + ' p\u00e1rrafos. C\u00e1rguelo en Banco de pruebas \u203a Cargar un banco propio.', 'ok', 8000);
      return false;
    } },
    { label: 'Cerrar', kind: 'primary', value: null }] });
}

async function _excel(res, finalName) {
  const XLSX = window.XLSX;
  const s = state.session;
  const n = (i) => s.units[i].n;
  const head = ['P\u00e1rr.', 'M\u00f3dulo', 'Gravedad', 'Cita', 'Sugerencia', 'Motivo', 'Estado', 'Veredicto', 'Igual que el revisor', 'Traducci\u00f3n revisada por UMBRA', 'Versi\u00f3n final'];
  const byUnit = new Map(res.units.map(U => [U.unit, U]));
  const rows = res.items.map(x => {
    const U = byUnit.get(x.f.unit) || {};
    return [n(x.f.unit), _label(x.f.module), x.f.sev || '', x.f.quote || '', x.f.edited != null ? x.f.edited : (x.f.suggestion || ''), x.f.reason || '',
      x.lost ? 'Descartado por el Verificador' : (x.f.state || ''), VERDICT[x.verdict] || x.verdict, x.same ? 's\u00ed' : '', U.before || '', U.after || ''];
  });
  const missHead = ['P\u00e1rr.', 'Antes (traducci\u00f3n revisada por UMBRA)', 'Despu\u00e9s (versi\u00f3n final)', 'Versi\u00f3n final del p\u00e1rrafo'];
  const misses = res.misses.map(x => [n(x.unit), x.old, x.text, x.after || '']);
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([head].concat(rows));
  ws1['!cols'] = [6, 14, 10, 30, 30, 40, 14, 18, 8, 60, 60].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Hallazgos');
  const ws2 = XLSX.utils.aoa_to_sheet([missHead].concat(misses));
  ws2['!cols'] = [6, 40, 40, 80].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws2, 'Omitidos');
  const st = res.stats;
  const ws3 = XLSX.utils.aoa_to_sheet([['Comparaci\u00f3n con la versi\u00f3n final'], [], ['Proyecto', state.project.name], ['Versi\u00f3n final', finalName],
    ['Fecha', new Date().toLocaleString('es')], ['Hallazgos', st.findings], ['Acertados probables', st.acertado], ['Posibles', st.posible],
    ['Espurios probables', st.espurio], ['Con la misma correcci\u00f3n que el revisor', st.same], ['Omitidos probables', st.misses],
    ['Descartados por el Verificador donde el revisor s\u00ed cambi\u00f3', st.lostButChanged],
    ['Cambios del revisor de texto / cifras / forma', st.changes.texto + ' / ' + st.changes.cifras + ' / ' + st.changes.forma]]);
  ws3['!cols'] = [{ wch: 52 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws3, 'Resumen');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), _base(state.project.tgtName) + '_COMPARACION.xlsx');
}
