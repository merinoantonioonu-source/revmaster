/**
 * exports.js - Everything UMBRA can write out:
 *   masked documents (same format), masked bilingual table (XLSX / HTML), key map, text for an
 *   external AI, corrected document (DOCX with tracked changes and Word comments; PPTX/XLSX with the
 *   changes applied), reports (HTML / XLSX / JSON) and the .umbra project file.
 */

import { state, importProjectObject } from '../state.js';
import { writeReplacements, writeCorrected } from '../formats/doc-writer.js';
import { download, esc } from '../util/dom.js';
import { encryptJSON, decryptJSON, encryptBytes, decryptBytes } from '../util/crypto.js';
import { unitSrc, unitTgt, unitSrcMasked, unitTgtMasked, reviewableUnits } from '../review/session.js';
import { applyAccepted, STATE_LABELS, SEV_LABELS } from '../review/findings.js';
import { CAT_LABELS } from '../review/prompts.js';
import { mainForm, CAT_SINGULAR } from '../redact/entities.js';
import { moduleById } from '../review/module-list.js';

function _base(name) { return String(name || 'documento').replace(/\.[^.]+$/, ''); }
function _ext(name) { const m = /\.([^.]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : 'docx'; }
function _stamp() { const d = new Date(); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); }

// ------------------------------------------------------------------ masked documents

export async function exportMasked(side) {
  const s = state.session;
  const model = side === 'src' ? s.src : s.tgt;
  const repl = new Map();
  for (const [pid, occs] of s.ent.occ[side]) {
    const list = [];
    for (const o of occs) {
      const e = s.ent.byKey.get(o.key);
      if (!e) continue;
      list.push({ start: o.start, end: o.end, text: side === 'src' ? e.tagSrc : e.tagTgt });
    }
    if (list.length) repl.set(pid, list);
  }
  // Masked copies never keep text deleted under tracked changes nor existing Word comments: both may
  // hold real names or figures.
  const blob = await writeReplacements(model, repl, { acceptRevisions: true, removeComments: true });
  const name = side === 'src' ? state.project.srcName : state.project.tgtName;
  download(blob, _base(name) + '_ENMASCARADO.' + _ext(name));
  return blob;
}

export function maskedRows() {
  const s = state.session;
  return reviewableUnits(s).map(u => ({ n: u.n, src: unitSrcMasked(s, u), tgt: unitTgtMasked(s, u) }));
}

export function exportBilingualXlsx() {
  const rows = [['N.\u00ba', 'Original (enmascarado)', 'Traducci\u00f3n (enmascarada)']].concat(maskedRows().map(r => [r.n, r.src, r.tgt]));
  const ws = window.XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 80 }, { wch: 80 }];
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'UMBRA');
  const out = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    _base(state.project.tgtName) + '_TABLA_ENMASCARADA.xlsx');
}

export function exportBilingualHtml() {
  const rows = maskedRows().map(r => '<tr><td>' + r.n + '</td><td>' + esc(r.src) + '</td><td>' + esc(r.tgt) + '</td></tr>').join('\n');
  const html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>' + esc(state.project.name) + ' (enmascarado)</title>' +
    '<style>body{font-family:Segoe UI,Arial,sans-serif;font-size:13px;margin:24px}table{border-collapse:collapse;width:100%}' +
    'td,th{border:1px solid #ccc;padding:4px 6px;vertical-align:top}th{background:#eef}</style></head><body>' +
    '<h1>' + esc(state.project.name) + ' \u2014 texto enmascarado</h1><table><tr><th>N.\u00ba</th><th>Original</th><th>Traducci\u00f3n</th></tr>' +
    rows + '</table></body></html>';
  download(new Blob([html], { type: 'text/html' }), _base(state.project.tgtName) + '_TABLA_ENMASCARADA.html');
}

/** The key map (tag -> real forms). Encrypted with a password when one is given. */
export async function exportKeyMap(password) {
  const map = state.session.ent.entities.map(e => ({ tagSrc: e.tagSrc, tagTgt: e.tagTgt, cat: e.cat,
    original: Object.keys(e.srcForms), traduccion: Object.keys(e.tgtForms) }));
  const payload = { kind: 'umbra-keymap', project: state.project.name, at: new Date().toISOString(), map };
  const content = password ? { kind: 'umbra-keymap-encrypted', box: await encryptJSON(payload, password) } : payload;
  download(new Blob([JSON.stringify(content, null, 1)], { type: 'application/json' }), _base(state.project.tgtName) + '_CLAVES.json');
}

// ------------------------------------------------------------------ corrected document

export async function exportCorrected(opts) {
  const o = Object.assign({ tracked: true, comments: true, author: 'UMBRA' }, opts || {});
  const s = state.session;
  const { texts, applied, skipped } = applyAccepted(s, state.findings);
  const comments = [];
  if (o.comments && s.tgt.kind === 'docx') {
    const skippedIds = new Set(skipped.map(x => x.id));
    for (const f of state.findings) {
      const u = s.units[f.unit];
      if (!u || u.tgtPara === null) continue;
      const isOpen = f.state === 'open';
      const notApplied = f.state === 'accepted' && skippedIds.has(f.id);
      if (!isOpen && !notApplied) continue;
      const mod = moduleById(f.module);
      comments.push({
        paraId: u.tgtPara, quote: f.state === 'accepted' ? '' : (f.quote || ''), author: o.author,
        text: '[UMBRA \u00b7 ' + (mod ? mod.short : f.module) + ' \u00b7 ' + (SEV_LABELS[f.sev] || f.sev) + '] ' + (f.reason || '') +
          (f.suggestion ? ' Sugerencia: ' + f.suggestion : '')
      });
    }
  }
  const blob = await writeCorrected(s.tgt, texts, { tracked: o.tracked, author: o.author, date: new Date().toISOString(), comments });
  download(blob, _base(state.project.tgtName) + '_UMBRA.' + _ext(state.project.tgtName));
  return { applied: applied.length, skipped, comments: comments.length, warnings: blob.warnings || [] };
}

// ------------------------------------------------------------------ reports

function _rows(filter) {
  const s = state.session;
  return state.findings.filter(filter || (() => true)).map(f => {
    const u = s.units[f.unit];
    const mod = moduleById(f.module);
    return {
      n: u ? u.n : '', module: mod ? mod.label : f.module, cat: CAT_LABELS[f.cat] || f.cat, sev: SEV_LABELS[f.sev] || f.sev,
      state: STATE_LABELS[f.state] || f.state, quote: f.quote || '', suggestion: (f.edited != null ? f.edited : f.suggestion) || '',
      reason: f.reason || '', src: u ? unitSrc(s, u) : '', tgt: u ? unitTgt(s, u) : '', model: f.model || '', verified: f.verified || ''
    };
  });
}

export function exportReportHtml(filter) {
  const rows = _rows(filter);
  const by = {};
  for (const r of rows) by[r.sev] = (by[r.sev] || 0) + 1;
  const sevColor = { 'Cr\u00edtica': '#dc2626', 'Mayor': '#d97706', 'Menor': '#2563eb', 'Sugerencia': '#6b7280' };
  const html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Informe UMBRA \u2014 ' + esc(state.project.name) + '</title>' +
    '<style>body{font-family:Segoe UI,Arial,sans-serif;font-size:13px;margin:24px;color:#1f2937}h1{font-size:18px}' +
    'table{border-collapse:collapse;width:100%}td,th{border:1px solid #d1d5db;padding:5px 7px;vertical-align:top;text-align:left}' +
    'th{background:#eef2ff;font-size:11px;text-transform:uppercase}.sev{color:#fff;border-radius:6px;padding:0 6px;font-size:11px;font-weight:700}' +
    'del{background:#fee2e2}ins{background:#dcfce7}.muted{color:#64748b;font-size:12px}</style></head><body>' +
    '<h1>Informe de revisi\u00f3n UMBRA \u2014 ' + esc(state.project.name) + '</h1>' +
    '<p class="muted">' + esc(state.project.srcName) + ' \u2192 ' + esc(state.project.tgtName) + ' \u00b7 ' + new Date().toLocaleString('es') +
    ' \u00b7 ' + rows.length + ' hallazgos (' + Object.keys(by).map(k => by[k] + ' ' + k.toLowerCase()).join(', ') + ')' +
    (state.project.unmasked ? ' \u00b7 <b>revisado sin enmascarar</b> (texto ya publicado)' : '') + '</p>' +
    '<table><tr><th>P\u00e1rr.</th><th>M\u00f3dulo</th><th>Gravedad</th><th>Categor\u00eda</th><th>Cita \u2192 sugerencia</th><th>Motivo</th><th>Estado</th></tr>' +
    rows.map(r => '<tr><td>' + r.n + '</td><td>' + esc(r.module) + '</td><td><span class="sev" style="background:' + (sevColor[r.sev] || '#6b7280') + '">' +
      esc(r.sev) + '</span></td><td>' + esc(r.cat) + '</td><td>' + (r.quote ? '<del>' + esc(r.quote) + '</del> ' : '') +
      (r.suggestion ? '<ins>' + esc(r.suggestion) + '</ins>' : '') + '<div class="muted">' + esc(r.tgt.slice(0, 220)) + '</div></td><td>' +
      esc(r.reason) + '</td><td>' + esc(r.state) + (r.verified ? ' \u00b7 verificado' : '') + '</td></tr>').join('') +
    '</table></body></html>';
  download(new Blob([html], { type: 'text/html' }), _base(state.project.tgtName) + '_INFORME_UMBRA.html');
}

export function exportReportXlsx(filter) {
  const rows = _rows(filter);
  const aoa = [['P\u00e1rrafo', 'M\u00f3dulo', 'Gravedad', 'Categor\u00eda', 'Cita', 'Sugerencia', 'Motivo', 'Estado', 'Verificado', 'Modelo', 'Original', 'Traducci\u00f3n']]
    .concat(rows.map(r => [r.n, r.module, r.sev, r.cat, r.quote, r.suggestion, r.reason, r.state, r.verified, r.model, r.src, r.tgt]));
  const ws = window.XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [6, 18, 10, 16, 30, 30, 40, 12, 10, 18, 60, 60].map(w => ({ wch: w }));
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Hallazgos');
  const out = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), _base(state.project.tgtName) + '_INFORME_UMBRA.xlsx');
}

/**
 * Findings to be judged by the translator (and sent back to whoever tunes the rules and prompts):
 * one row per finding with its context, plus empty columns "Valoracion" (a drop-down list),
 * "Gravedad correcta" and "Comentario". opts = { masked: bool, filter: fn, segText: fn(f) -> {src, tgt} }
 */
export const FEEDBACK_VERDICTS = ['Correcto', 'Falso positivo', 'Gravedad excesiva', 'Gravedad insuficiente', 'Propuesta mejorable', 'Dudoso'];

export async function exportFeedbackXlsx(opts) {
  const o = opts || {};
  const s = state.session;
  const list = state.findings.filter(o.filter || (() => true))
    .sort((a, b) => (a.unit - b.unit) || ((a.start == null ? 1e9 : a.start) - (b.start == null ? 1e9 : b.start)));
  const head = ['ID', '\u00a7', 'M\u00f3dulo', 'Comprobaci\u00f3n', 'Categor\u00eda', 'Gravedad', 'Estado', 'Origen', 'Cita', 'Propuesta', 'Motivo',
    'Verificador', 'Original', 'Traducci\u00f3n', 'Su valoraci\u00f3n', 'Gravedad correcta', 'Comentario'];
  const rows = list.map(f => {
    const u = s.units[f.unit];
    const mod = moduleById(f.module);
    const ctx = (o.segText && o.segText(f, !!o.masked)) || null;
    const src = ctx ? ctx.src : (u ? (o.masked ? unitSrcMasked(s, u) : unitSrc(s, u)) : '');
    const tgt = ctx ? ctx.tgt : (u ? (o.masked ? unitTgtMasked(s, u) : unitTgt(s, u)) : '');
    const sug = (f.edited != null ? f.edited : (o.masked ? (f.suggestionMasked != null ? f.suggestionMasked : f.suggestion) : f.suggestion)) || '';
    const origin = f.source === 'local' ? 'Sin IA' : f.source === 'rule' ? 'Regla' : f.source === 'external' ? 'IA externa'
      : (f.model || 'IA') + (f.role === 'deep' ? ' (a fondo)' : f.role === 'cache' ? ' (cach\u00e9)' : '');
    return [f.id, (ctx && ctx.label) || (u ? u.n : ''), mod ? mod.label : f.module, f.sub ? (o.subLabels && o.subLabels[f.sub]) || f.sub : '',
      CAT_LABELS[f.cat] || f.cat, SEV_LABELS[f.sev] || f.sev, STATE_LABELS[f.state] || f.state, origin,
      (o.masked ? (f.quoteMasked != null ? f.quoteMasked : f.quote) : f.quote) || '', sug, f.reason || '',
      f.verified ? (f.verified === 'no' ? 'Descartado' : f.verified === 'edit' ? 'Corregido' : 'Confirmado') + (f.verifierReason ? ': ' + f.verifierReason : '') : '',
      src, tgt, '', '', ''];
  });
  const XLSX = window.XLSX;
  const ws = XLSX.utils.aoa_to_sheet([head].concat(rows));
  ws['!cols'] = [12, 7, 14, 14, 16, 10, 11, 18, 30, 30, 40, 24, 60, 60, 18, 16, 40].map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: 'A1:Q' + (rows.length + 1) };
  const info = [['Hallazgos de UMBRA para valorar'], [],
    ['Proyecto', state.project.name], ['Original', state.project.srcName], ['Traducci\u00f3n', state.project.tgtName],
    ['Fecha', new Date().toLocaleString('es')], ['Texto', o.masked ? 'Enmascarado (sin datos reales)' : 'Real'], ['Revisi\u00f3n', state.project.unmasked ? 'Sin enmascarar (texto ya publicado)' : 'Con el texto enmascarado'],
    ['Perfil de reglas', state.project.profile || 'Todas las reglas'], ['Hallazgos', rows.length], [],
    ['C\u00f3mo rellenarlo'],
    ['Su valoraci\u00f3n', 'Elija en la lista: ' + FEEDBACK_VERDICTS.join(', ') + '.'],
    ['Gravedad correcta', 'Si la gravedad no es la adecuada: Cr\u00edtica, Mayor, Menor o Sugerencia.'],
    ['Comentario', 'Lo que haya que cambiar: por qu\u00e9 es un falso positivo, qu\u00e9 regla falta, qu\u00e9 propuesta ser\u00eda la buena...'],
    [], ['No cambie las columnas ID ni \u00a7: sirven para encontrar cada hallazgo.']];
  const wsInfo = XLSX.utils.aoa_to_sheet(info);
  wsInfo['!cols'] = [{ wch: 20 }, { wch: 100 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Hallazgos');
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Instrucciones');
  let out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  // SheetJS (community) writes no drop-down lists: add the one of "Su valoracion" to the first sheet.
  try {
    const zip = await window.JSZip.loadAsync(out);
    const path = 'xl/worksheets/sheet1.xml';
    let xml = await zip.file(path).async('string');
    const dv = '<dataValidations count="2"><dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="O2:O' + (rows.length + 200) + '">' +
      '<formula1>"' + FEEDBACK_VERDICTS.join(',') + '"</formula1></dataValidation>' +
      '<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="P2:P' + (rows.length + 200) + '"><formula1>"Cr\u00edtica,Mayor,Menor,Sugerencia"</formula1></dataValidation></dataValidations>';
    // Schema order (CT_Worksheet): dataValidations goes before all of these, ignoredErrors included
    // (SheetJS writes it; putting the list after it makes Excel "repair" the file).
    const at = xml.search(/<(hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
    xml = at >= 0 ? xml.slice(0, at) + dv + xml.slice(at) : xml.replace('</worksheet>', dv + '</worksheet>');
    zip.file(path, xml);
    out = await zip.generateAsync({ type: 'uint8array' });
  } catch (e) { console.warn('feedback drop-down', e); }
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    _base(state.project.tgtName) + '_HALLAZGOS_PARA_VALORAR' + (o.masked ? '_ENMASCARADO' : '') + '.xlsx');
  return rows.length;
}

export function exportFindingsJson() {
  const payload = { kind: 'umbra-findings', project: state.project.name, at: new Date().toISOString(), findings: state.findings };
  download(new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' }), _base(state.project.tgtName) + '_HALLAZGOS.json');
}

// ------------------------------------------------------------------ project file (.umbra)

function _b64(buf) {
  let s = '';
  const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
function _unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

export async function exportProject(password) {
  const p = state.project;
  const zip = new window.JSZip();
  const meta = Object.assign({}, p, { srcBytes: undefined, tgtBytes: undefined, findings: state.findings, kind: 'umbra-project', v: 1 });
  if (password) {
    const box = await encryptBytes(new TextEncoder().encode(JSON.stringify({ meta, src: _b64(p.srcBytes), tgt: _b64(p.tgtBytes) })), password);
    zip.file('umbra.json', JSON.stringify({ kind: 'umbra-project', v: 1, encrypted: true }));
    zip.file('salt.bin', box.salt); zip.file('iv.bin', box.iv); zip.file('data.bin', box.data);
  } else {
    zip.file('umbra.json', JSON.stringify(meta));
    zip.file('original/' + p.srcName, p.srcBytes);
    zip.file('traduccion/' + p.tgtName, p.tgtBytes);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  download(blob, _base(p.name) + '_' + _stamp() + '.umbra');
}

export async function importProjectFile(file, askPassword) {
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const head = JSON.parse(await zip.file('umbra.json').async('string'));
  if (head.kind !== 'umbra-project') throw new Error('No es un proyecto de UMBRA.');
  let p;
  if (head.encrypted) {
    const pwd = await askPassword();
    if (!pwd) return null;
    const bytes = await decryptBytes({ salt: await zip.file('salt.bin').async('uint8array'), iv: await zip.file('iv.bin').async('uint8array'),
      data: await zip.file('data.bin').async('uint8array') }, pwd);
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    p = Object.assign({}, obj.meta, { srcBytes: _unb64(obj.src), tgtBytes: _unb64(obj.tgt) });
  } else {
    p = head;
    p.srcBytes = await zip.file('original/' + p.srcName).async('arraybuffer');
    p.tgtBytes = await zip.file('traduccion/' + p.tgtName).async('arraybuffer');
  }
  delete p.kind; delete p.v;
  await importProjectObject(p);
  return p;
}

export async function readKeyMap(file, askPassword) {
  const j = JSON.parse(await file.text());
  if (j.kind === 'umbra-keymap-encrypted') {
    const pwd = await askPassword();
    if (!pwd) return null;
    return decryptJSON(j.box, pwd);
  }
  return j;
}

export function entitySummary(e) {
  return (CAT_SINGULAR[e.cat] || e.cat) + ': ' + (mainForm(e.srcForms) || '\u2014') + ' \u2192 ' + (mainForm(e.tgtForms) || '\u2014');
}
