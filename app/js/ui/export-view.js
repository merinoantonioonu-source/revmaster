/**
 * export-view.js - Step 5 "Exportar": large options, grouped: the corrected translation (DOCX with
 * tracked changes and Word comments, or the changes applied), the reports, the masked documents and
 * the project file (.umbra).
 */

import { helpBtn } from './help.js';
import { el, clear, toast, promptDialog } from '../util/dom.js';
import { state, on, emit } from '../state.js';
import { exportCorrected, exportReportHtml, exportReportXlsx, exportFindingsJson, exportProject,
  exportMasked, exportBilingualXlsx } from '../export/exports.js';
import { feedbackDialog } from './correct-view.js';
import { icon } from './icons.js';

let root, toolsHost;

export function mountExportView(host, tools) {
  root = host;
  toolsHost = tools;
  on('view', (v) => { if (v === 'export') render(); });
  on('findings', () => { if (state.view === 'export') render(); });
}

async function run(fn) {
  try {
    const r = await fn();
    if (r && r.applied !== undefined) {
      toast('Exportado: ' + r.applied + ' correcciones aplicadas' + (r.comments ? ', ' + r.comments + ' comentarios' : '') +
        (r.skipped && r.skipped.length ? '; ' + r.skipped.length + ' sin aplicar' : '') + '.', 'ok', 6000);
      for (const w of r.warnings || []) toast(String(w), 'warn', 7000);
    } else if (r !== null && r !== false) toast('Exportado.', 'ok');
  } catch (e) { console.error(e); toast('No se pudo exportar: ' + e.message, 'err', 8000); }
}

/** One large option: a title, what it gives and, for the first of a group, the main colour. */
function opt(title, desc, fn, main) {
  return el('button.opt' + (main ? '.main' : ''), { onclick: () => run(fn) },
    el('span.opt-ic', icon('download', 20)),
    el('span.opt-tx', el('b', title), el('span', desc)));
}

function render() {
  clear(toolsHost);
  clear(root);
  if (!state.project) return;
  const acc = state.findings.filter(f => f.state === 'accepted').length;
  const open = state.findings.filter(f => f.state === 'open').length;
  toolsHost.appendChild(el('div.summary',
    el('span.pill.ok', acc + (acc === 1 ? ' aceptado' : ' aceptados')),
    open ? el('span.pill.warn', open + ' por revisar') : null));
  toolsHost.appendChild(el('div.grow'));
  if (open) toolsHost.appendChild(el('button.btn', { onclick: () => emit('goto', 'correct') }, icon('back', 16), 'Volver a Corregir'));
  toolsHost.appendChild(helpBtn('review-export'));
  const kind = state.tgt ? state.tgt.kind : 'docx';
  const K = (kind || 'docx').toUpperCase();
  root.appendChild(el('div.page',
    el('div.page-in',
      el('div.kicker', 'PASO 5 DE 5'),
      el('h2.ptitle', 'Exportar'),
      el('p.lead', kind === 'docx'
        ? 'Lo aceptado va como control de cambios; lo pendiente, o lo que no se pueda aplicar, como comentarios de Word.'
        : K + ' no tiene control de cambios: lo aceptado se aplica directamente.'),
      el('h3.sec', 'Traducci\u00f3n corregida', helpBtn('export-corrected')),
      el('div.opts',
        kind === 'docx' ? opt('DOCX con control de cambios y comentarios', 'Para revisar en Word: cada correcci\u00f3n se acepta o se rechaza all\u00ed.', () => exportCorrected({ tracked: true, comments: true }), true) : null,
        kind === 'docx' ? opt('DOCX con control de cambios, sin comentarios', 'Solo las correcciones aceptadas, sin notas al margen.', () => exportCorrected({ tracked: true, comments: false })) : null,
        opt(K + ' con los cambios aplicados', 'El documento ya corregido, sin marcas.', () => exportCorrected({ tracked: false, comments: false }), kind !== 'docx')),
      el('h3.sec', 'Informes', helpBtn('export-reports')),
      el('div.opts',
        opt('Informe HTML', 'Los hallazgos con su contexto, para leer o imprimir.', () => exportReportHtml(f => f.state !== 'discarded')),
        opt('Informe Excel', 'Una fila por hallazgo, para filtrar y ordenar.', () => exportReportXlsx(f => f.state !== 'discarded')),
        opt('Hallazgos para valorar (Excel)\u2026', 'Con columnas para su valoraci\u00f3n: sirve para ajustar los m\u00f3dulos.', async () => { await feedbackDialog(); return null; }),
        opt('Hallazgos en JSON', 'Los datos tal cual, para otros programas.', exportFindingsJson)),
      el('h3.sec', 'Documentos enmascarados', helpBtn('export-masked')),
      el('div.opts',
        opt('Original enmascarado', 'Mismo formato, con etiquetas en lugar de los datos.', () => exportMasked('src')),
        opt('Traducci\u00f3n enmascarada', 'Mismo formato, con las mismas etiquetas.', () => exportMasked('tgt')),
        opt('Tabla biling\u00fce enmascarada (XLSX)', 'Original y traducci\u00f3n, frase a frase.', exportBilingualXlsx)),
      el('h3.sec', 'Proyecto', helpBtn('project-file')),
      el('p.info', 'Un archivo .umbra guarda los dos documentos, las entidades y los hallazgos para seguir otro d\u00eda o en otro equipo. Contiene el texto REAL: c\u00edfrelo si va a salir de su ordenador. Se abre desde Archivos.'),
      el('div.opts',
        opt('Guardar proyecto (.umbra)', 'Todo el trabajo en un archivo.', () => exportProject(null)),
        opt('Guardar proyecto cifrado', 'Igual, protegido con una contrase\u00f1a.', async () => {
          const p = await promptDialog('Cifrar proyecto', 'Contrase\u00f1a (no se puede recuperar si la olvida)', '', { type: 'password' });
          if (!p) return null;
          return exportProject(p);
        })))));
}
