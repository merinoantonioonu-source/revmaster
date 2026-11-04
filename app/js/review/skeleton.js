/**
 * skeleton.js - The compact digest that the Coherence and UN Conventions modules send instead of the
 * whole document (hundreds of tokens instead of tens of thousands).
 *
 * buildSkeleton(session, moduleId) -> { text, count, units:Set(n) }
 */

import { unitSrcMasked, unitTgtMasked } from './session.js';
import { patternOf } from './parallel.js';

function _head(s, n) {
  const words = String(s || '').replace(/[\t\r\n]+/g, ' ').trim().split(/\s+/);
  return words.slice(0, n).join(' ') + (words.length > n ? ' \u2026' : '');
}

function _italicOpening(p) {
  const runs = (p && p.runs) || [];
  const label = (p.text.match(/^[\s\t]*(?:\d{1,3}\.)?[\s\t]*/) || [''])[0].length;
  let pos = 0;
  for (const r of runs) {
    const t = r.t || '';
    if (pos + t.length > label && /\p{L}/u.test(t.slice(Math.max(0, label - pos)))) return !!r.i;
    pos += t.length;
  }
  return false;
}

export function buildSkeleton(session, moduleId) {
  const lines = [];
  const units = new Set();
  let count = 0;
  if (moduleId === 'coherence') {
    const groups = new Map();
    for (const u of session.units) {
      if (!u.group || u.tgtPara === null) continue;
      if (!groups.has(u.group)) groups.set(u.group, []);
      groups.get(u.group).push(u);
    }
    let gi = 0;
    for (const [g, list] of groups) {
      if (gi++ >= 60) break;
      const kind = g[0] === 'L' ? 'lista' : (g[0] === 'T' ? 'columna de tabla' : 't\u00edtulos');
      lines.push('GRUPO ' + g + ' (' + kind + ', ' + list.length + ' elementos):');
      for (const u of list.slice(0, 40)) {
        const t = unitTgtMasked(session, u), s = unitSrcMasked(session, u);
        const last = t.trim().slice(-1);
        lines.push('  [' + u.n + '] ' + patternOf(t, 'es') + ' \u00ab' + _head(t, 8) + '\u00bb final: ' + JSON.stringify(last) +
          (s ? ' | original: ' + patternOf(s, session.srcLang) + ' \u00ab' + _head(s, 6) + '\u00bb' : ''));
        units.add(u.n);
        count++;
      }
    }
  } else if (moduleId === 'conventions') {
    for (const u of session.units) {
      if (!u.part || u.tgtPara === null) continue;
      const p = session.tgt.paras[u.tgtPara];
      let t = unitTgtMasked(session, u);
      const label = (t.match(/^[\s\t]*(?:\d{1,3}\.)?[\s\t]*/) || [''])[0];
      const body = t.slice(label.length);
      const first = (body.match(/^[\p{L}'-]+(?:\s+(?:con\s+benepl\u00e1cito|nota|presente|de\s+relieve|suya|un\s+llamamiento)\b)?/u) || [''])[0];
      const shown = _italicOpening(p) && first ? '*' + first + '*' + body.slice(first.length) : body;
      const last = t.trim().slice(-1);
      lines.push('[' + u.n + '] (' + (u.part === 'pre' ? 'pre\u00e1mbulo' : 'dispositiva') + ') ' + label.trim() + ' ' +
        _head(shown, 12) + ' [final: ' + JSON.stringify(last) + ']');
      units.add(u.n);
      count++;
    }
    if (count) {
      const org = /Consejo de Seguridad|\{el ORGANO\d+\}/.test(session.units.map(u => unitTgtMasked(session, u)).slice(0, 8).join(' ')) ? '' : '';
      lines.unshift('DOCUMENTO: resoluci\u00f3n o decisi\u00f3n.' + org);
    }
  }
  return { text: lines.length ? lines.join('\n') + '\n\nRecuerda: una l\u00ednea por problema y, al final, FIN ' + count + '.' : '', count, units };
}
