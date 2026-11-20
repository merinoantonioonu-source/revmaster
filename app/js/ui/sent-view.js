/**
 * sent-view.js - "Lo enviado a la IA": what really left this browser, as the gateway recorded it
 * (ai/leak-guard.js), and the warning of the gateway's safety net.
 *   sentDialog()        every call since the project was opened: time, reviewer, model, size, what the
 *                       net masked; each one opens to its text (and its instructions, folded).
 *   sentForFinding(f)   the paragraph of a finding as it was sent (with no record - the page was
 *                       reloaded, the answer came from the cache, an external AI - as it is sent now).
 *   initLeakNotice()    one warning on screen when the net masks something.
 * The record lives in memory only: it is cleared when the page is reloaded or another project opens.
 */

import { helpBtn } from './help.js';
import { el, toast, modal, fmtInt } from '../util/dom.js';
import { state, emit } from '../state.js';
import { sentLog, onLeak } from '../ai/leak-guard.js';
import { moduleById } from '../review/module-list.js';
import { unitSrcMasked, unitTgtMasked } from '../review/session.js';
import { TAG_RE } from '../redact/entities.js';

const _label = (id) => (id === 'verifier' ? 'Verificador' : ((moduleById(id) || { label: id || 'IA' }).label));
const _time = (at) => new Date(at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A text with its tags shown as the coloured labels of Enmascarar. */
function _withTags(text) {
  const out = [];
  const re = new RegExp(TAG_RE.source, 'g');
  let pos = 0, m;
  const s = String(text || '');
  while ((m = re.exec(s)) !== null) {
    if (m.index > pos) out.push(document.createTextNode(s.slice(pos, m.index)));
    out.push(el('span.tk.' + m[2], m[0].replace(/[{}]/g, '')));
    pos = m.index + m[0].length;
  }
  if (pos < s.length) out.push(document.createTextNode(s.slice(pos)));
  return out;
}

function _leakNote(leaks) {
  if (!leaks || !leaks.length) return null;
  return el('div.note.warn', 'Red de seguridad: en esta llamada se enmascararon antes de salir ' +
    leaks.map(h => '\u00ab' + h.form + '\u00bb' + (h.count > 1 ? ' (' + h.count + ')' : '')).join(', ') + '.');
}

/** The lines of paragraph n in a batch: "[n]" + "O: ..." + "T: ...", or "[n] text". */
function _unitLines(prompt, n) {
  const lines = String(prompt || '').split('\n');
  const head = '[' + n + ']';
  const i = lines.findIndex(l => l === head || l.startsWith(head + ' '));
  if (i < 0) return null;
  if (lines[i] !== head) return { tgt: lines[i].slice(head.length + 1) };
  const out = {};
  for (let k = i + 1; k < lines.length && /^[OT]: /.test(lines[k]); k++) out[lines[k][0] === 'O' ? 'src' : 'tgt'] = lines[k].slice(3);
  return out;
}

function _block(label, text) {
  return el('div',
    el('div.lbl', label),
    el('div.sentbox', text ? _withTags(text) : el('span.muted', '(vac\u00edo)')));
}

/** The paragraph of a finding as it was sent. */
export function sentForFinding(f) {
  const s = state.session;
  const u = s && s.units[f.unit];
  if (!u) return;
  const um = !!s.unmasked;
  const body = el('div');
  const log = sentLog().slice().reverse();
  if (f.module === 'names') {
    const e = log.find(x => x.names);
    body.appendChild(el('p.info', e
      ? 'Nombres oficiales no env\u00eda el texto: solo esta tabla de nombres, a las ' + _time(e.at) + ' (' + e.modelId + ').'
      : 'Nombres oficiales no env\u00eda el texto, solo la tabla de nombres. No hay registro de ella en esta sesi\u00f3n (se borra al recargar la p\u00e1gina).'));
    if (e) body.appendChild(el('div.sentbox', e.prompt));
  } else {
    const e = log.find(x => !x.names && x.module === f.module && _unitLines(x.prompt, u.n)) ||
      log.find(x => !x.names && _unitLines(x.prompt, u.n));
    const parts = e ? _unitLines(e.prompt, u.n) : null;
    if (e && parts) {
      body.appendChild(el('p.info', 'P\u00e1rrafo \u00a7' + u.n + ', tal como sali\u00f3 a las ' + _time(e.at) + ' hacia ' + _label(e.module) + ' (' + e.modelId + ').' +
        (e.unmasked ? ' Proyecto sin enmascarar: se envi\u00f3 el texto real.' : '')));
      const leak = _leakNote(e.leaks);
      if (leak) body.appendChild(leak);
      if (parts.src !== undefined) body.appendChild(_block('ORIGINAL', parts.src));
      body.appendChild(_block('TRADUCCI\u00d3N', parts.tgt || ''));
    } else {
      body.appendChild(el('p.info', 'No hay registro de este p\u00e1rrafo en esta sesi\u00f3n: el registro se borra al recargar la p\u00e1gina, y lo que sale de la cach\u00e9 o de una IA externa no pasa por aqu\u00ed. As\u00ed se env\u00eda hoy el p\u00e1rrafo \u00a7' + u.n + (um ? ' (proyecto sin enmascarar: el texto real)' : '') + ':'));
      if (f.module !== 'writing') body.appendChild(_block('ORIGINAL', unitSrcMasked(s, u)));
      body.appendChild(_block('TRADUCCI\u00d3N', unitTgtMasked(s, u)));
    }
  }
  return modal({ title: 'Lo enviado a la IA', help: helpBtn('sent'), width: '760px', body, buttons: [
    { label: 'Todas las llamadas\u2026', onClick: () => { setTimeout(sentDialog, 0); } },
    { label: 'Cerrar', kind: 'primary', value: null }] });
}

/** Every call of this session, newest first. */
export function sentDialog() {
  const log = sentLog().slice().reverse();
  const body = el('div');
  if (!log.length) {
    body.appendChild(el('p.muted', 'Todav\u00eda no se ha enviado nada a la IA desde que abri\u00f3 este proyecto. El registro se guarda solo mientras la p\u00e1gina est\u00e1 abierta.'));
  } else {
    const leaks = log.reduce((n, e) => n + (e.leaks || []).length, 0);
    body.appendChild(el('p.info', log.length + (log.length === 1 ? ' llamada' : ' llamadas') + ' desde que abri\u00f3 el proyecto (las m\u00e1s recientes, primero). Pulse una para ver el texto exacto que sali\u00f3.' +
      (leaks ? ' La red de seguridad actu\u00f3 en ' + log.filter(e => (e.leaks || []).length).length + '.' : '')));
    const list = el('div.sentlist');
    for (const e of log) {
      const words = (String(e.prompt || '').match(/\S+/g) || []).length;
      const d = el('details',
        el('summary',
          el('span.st', _time(e.at)),
          el('b', e.names ? 'Nombres oficiales (tabla)' : _label(e.module)),
          el('span.muted', e.modelId + (e.deferred ? ' \u00b7 lote diferido' : '')),
          el('span.grow'),
          (e.leaks || []).length ? el('span.pill.warn', 'Red de seguridad') : null,
          e.unmasked ? el('span.pill.gray', 'Sin enmascarar') : null,
          el('span.muted', fmtInt(words) + ' palabras')));
      d.addEventListener('toggle', () => {
        if (!d.open || d.dataset.filled) return;
        d.dataset.filled = '1';
        const leak = _leakNote(e.leaks);
        if (leak) d.appendChild(leak);
        d.appendChild(el('div.sentbox', _withTags(e.prompt)));
        if (e.system) d.appendChild(el('details.sys', el('summary', 'Instrucciones que acompa\u00f1an al texto'), el('div.sentbox', e.system)));
      });
      list.appendChild(d);
    }
    body.appendChild(list);
  }
  return modal({ title: 'Lo enviado a la IA', help: helpBtn('sent'), width: '860px', body, buttons: [{ label: 'Cerrar', kind: 'primary', value: null }] });
}

let _pending = new Map();
let _timer = null;

/** One warning on screen (gathered over a run) each time the safety net masks something. */
export function initLeakNotice() {
  onLeak((hits) => {
    for (const h of hits) _pending.set(h.form, (_pending.get(h.form) || 0) + h.count);
    clearTimeout(_timer);
    _timer = setTimeout(() => {
      const forms = Array.from(_pending.keys());
      _pending = new Map();
      if (!forms.length) return;
      toast('Red de seguridad: ' + forms.slice(0, 5).map(f => '\u00ab' + f + '\u00bb').join(', ') + (forms.length > 5 ? ' y ' + (forms.length - 5) + ' m\u00e1s' : '') +
        (forms.length === 1 ? ' iba' : ' iban') + ' a salir sin enmascarar y se enmascar' + (forms.length === 1 ? '\u00f3' : 'aron') +
        ' antes de enviar. Revise Enmascarar; el detalle est\u00e1 en M\u00e1s \u203a Lo enviado a la IA.', 'warn', 12000);
      emit('leak-guard', forms);
    }, 800);
  });
}
