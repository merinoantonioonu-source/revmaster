/**
 * parse.js - Entry point of the formats layer: reads a DOCX, PPTX or XLSX file
 * into the shared document model (docs/ARQUITECTURA.md section 2), choosing
 * the parser by the file extension.
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 */

import { parseDocxModel } from './docx-model.js';
import { parsePptxModel } from './pptx-model.js';
import { parseXlsxModel } from './xlsx-model.js';

/** 'docx' | 'pptx' | 'xlsx' | null, from a file name. */
export function kindOfName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  return (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') ? ext : null;
}

/**
 * @param {File|{name:string, arrayBuffer:Function}} file
 * @returns {Promise<Object>} the document model (model.kind = 'docx'|'pptx'|'xlsx')
 */
export async function parseDocument(file) {
  const kind = kindOfName(file && file.name);
  if (!kind) throw new Error('Formato no admitido: use DOCX, PPTX o XLSX.');
  let model;
  try {
    if (kind === 'docx') model = await parseDocxModel(file);
    else if (kind === 'pptx') model = await parsePptxModel(file);
    else model = await parseXlsxModel(file);
  } catch (e) {
    // A ZIP that is not one (renamed file, damaged download) surfaces as a
    // JSZip error in English: say it in the user's language.
    const msg = (e && e.message) || String(e);
    if (/zip|central directory|end of data|signature/i.test(msg) && !/[\u00c0-\u024f]/.test(msg)) {
      throw new Error('No se pudo abrir el archivo: no es un ' + kind.toUpperCase() + ' v\u00e1lido o est\u00e1 da\u00f1ado.');
    }
    throw e;
  }
  model.kind = kind;
  if (!model.fileName) model.fileName = file.name || '';
  return model;
}
