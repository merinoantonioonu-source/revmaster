/**
 * formats/bitext-txt.js - A BITEXT in TXT, as COMeT's Editor exports it (Export > bitext: UTF-8 with a
 * BOM, one segment per line, the original, a tab and the translation), opened as a project: the two
 * sides become two minimal DOCX (review/compare.js simpleDocx, one paragraph per segment, in the same
 * order), and from there UMBRA reads, masks, aligns and reviews them as any pair of documents. A
 * segment with one side empty keeps its place (an empty paragraph), so the pairs stay together.
 */

import { simpleDocx } from '../review/compare.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The pairs of a bitext text: [{ src, tgt }] (lines with no tab and no text are left out). */
export function parseBitextTxt(text) {
  const out = [];
  for (const line of String(text || '').replace(/^\ufeff/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const k = line.indexOf('\t');
    if (k < 0) continue;
    const src = line.slice(0, k).trim(), tgt = line.slice(k + 1).replace(/\t/g, ' ').trim();
    if (src || tgt) out.push({ src, tgt });
  }
  return out;
}

/** True when a text reads as a bitext: most of its lines carry a tab. */
export function looksLikeBitext(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  return lines.length > 0 && lines.filter(l => l.indexOf('\t') >= 0).length >= Math.max(1, Math.ceil(lines.length * 0.6));
}

/**
 * The two documents of a bitext file: { src: File, tgt: File, pairs: n } - named after the file
 * ("A_C.5_78_SR.12.txt" -> "A_C.5_78_SR.12 (original).docx" and "A_C.5_78_SR.12.docx"), so that the type
 * of document is still guessed from its symbol.
 */
export async function bitextFiles(file) {
  const text = await file.text();
  if (!looksLikeBitext(text)) throw new Error('\u00ab' + file.name + '\u00bb no es un bitexto: cada l\u00ednea debe tener el original, un tabulador y la traducci\u00f3n.');
  const pairs = parseBitextTxt(text);
  if (!pairs.length) throw new Error('\u00ab' + file.name + '\u00bb no tiene segmentos.');
  const base = file.name.replace(/\.[^.]+$/, '');
  const src = new File([await simpleDocx(pairs.map(p => p.src))], base + ' (original).docx', { type: DOCX });
  const tgt = new File([await simpleDocx(pairs.map(p => p.tgt))], base + '.docx', { type: DOCX });
  return { src, tgt, pairs: pairs.length };
}
