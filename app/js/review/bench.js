/**
 * bench.js - The test bench ("Banco de pruebas"): a document pair built from the owner's review report
 * (tools/make_bench.py -> app/data/calibration/) with the errors a human reviser found, to measure
 * what each module and model really detects and how much noise it adds.
 *
 * A finding is a HIT for an expected error when it is in that paragraph and its quote, suggestion or
 * reason contains one of the error's keys (accents and case ignored); each finding counts once.
 * Everything else is NOISE (in a correct paragraph, or in a paragraph with an error but about
 * something else).
 */

const BASE = new URL('../../data/calibration/', import.meta.url);

export async function loadBenchSpec() {
  const r = await fetch(new URL('banco.json', BASE));
  if (!r.ok) throw new Error('No se encuentra el banco de pruebas (' + r.status + ').');
  return r.json();
}

/** The two documents of the bench as File objects (to open them as a project). */
export async function benchFiles() {
  const get = async (name) => {
    const r = await fetch(new URL(name, BASE));
    if (!r.ok) throw new Error('No se encuentra ' + name + ' (' + r.status + ').');
    return new File([await r.blob()], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  };
  return { src: await get('banco_en.docx'), tgt: await get('banco_es.docx') };
}

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const textOf = (f) => fold([f.quote, f.suggestion, f.edited, f.reason].join(' '));

/**
 * -> { items:[{ n, module, what, hit (finding|null), other (found by another module), discarded (the
 *       Verifier threw away a right finding) }], noise:[finding], noiseClean, byModule:{ id: { expected,
 *       found, foundOwn, noise } }, expected, found }
 */
export function evaluateBench(session, findings, spec) {
  const unitByEs = new Map();
  for (const u of session.units) if (u.tgtPara !== null && u.tgtPara !== undefined) unitByEs.set(fold(session.tgt.paras[u.tgtPara].text), u);
  const live = findings.filter(f => f.state !== 'discarded');
  const thrown = findings.filter(f => f.state === 'discarded');
  const used = new Set();
  const items = [];
  const errorUnits = new Set(), cleanUnits = new Set();
  for (const p of spec.paragraphs) {
    const u = unitByEs.get(fold(p.es));
    if (u) (p.expect.length ? errorUnits : cleanUnits).add(u.idx);
    for (const ex of p.expect) {
      const keys = ex.keys.map(fold);
      const pick = (list) => {
        const cands = list.filter(f => u && f.unit === u.idx && !used.has(f.id) && keys.some(k => textOf(f).includes(k)));
        return cands.find(f => f.module === ex.module) || cands[0] || null;
      };
      const hit = pick(live);
      if (hit) used.add(hit.id);
      const lost = hit ? null : pick(thrown);
      if (lost) used.add(lost.id);
      items.push({ n: p.n, module: ex.module, what: ex.what, hit, other: !!hit && hit.module !== ex.module, discarded: lost });
    }
  }
  const noise = live.filter(f => !used.has(f.id));
  const byModule = {};
  const slot = (m) => byModule[m] || (byModule[m] = { expected: 0, found: 0, foundOwn: 0, noise: 0 });
  for (const it of items) {
    const b = slot(it.module);
    b.expected++;
    if (it.hit) { b.found++; if (!it.other) b.foundOwn++; }
  }
  for (const f of noise) slot(f.module).noise++;
  return { items, noise, noiseClean: noise.filter(f => cleanUnits.has(f.unit)).length, byModule,
    expected: items.length, found: items.filter(i => i.hit).length };
}
