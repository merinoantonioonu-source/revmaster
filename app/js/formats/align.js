/**
 * Origin: COMeT modules/final-check/align.js @ 04540f5 (adapted)
 *
 * align.js - Source/target structural alignment for Final Check.
 *
 * Aligns the two document models produced by docx-model.js:
 *   1. Body paragraphs OUTSIDE tables: monotonic banded dynamic-programming
 *      alignment (Needleman-Wunsch style) that allows gaps. A source paragraph
 *      aligned to a gap is a candidate omission.
 *   2. Tables: paired by document order; ROWS aligned with the same banded DP
 *      (a spacer row present on one side only must not shift every row after
 *      it); cells inside a matched row paired by coordinates.
 *   3. Footnotes: their texts are DP-aligned the same way, so a single missing
 *      footnote does not desynchronize all the following ones.
 *
 * The similarity heuristic leans on translation-invariant signals: numbers,
 * acronyms, document symbols, list labels, length ratio and headings.
 *
 * ASCII ONLY: non-ASCII characters in strings are written as \uXXXX escapes.
 */

const GAP_PENALTY = 0.30;   // cost of skipping a paragraph on either side
const BAND = 60;            // half-width of the DP band (paragraphs)
const MIN_PAIR_SCORE = 0.28; // below this, an alignment is treated as a gap

/** Translation-invariant tokens: numbers, acronyms, UN document symbols. */
export function invariantTokens(text) {
  const tokens = new Set();
  if (!text) return tokens;
  for (const m of text.matchAll(/\d[\d.,\u00a0\u202f ]*\d|\d/g)) {
    tokens.add(m[0].replace(/[^\d]/g, ''));
  }
  for (const m of text.matchAll(/\b[A-Z]{2,6}\b/g)) tokens.add(m[0]);
  for (const m of text.matchAll(/[A-Z]+\/[A-Z0-9/.]+/g)) tokens.add(m[0]);
  return tokens;
}

function _tokenOverlap(aTokens, bTokens) {
  if (aTokens.size === 0 || bTokens.size === 0) return null;
  let common = 0;
  for (const t of aTokens) { if (bTokens.has(t)) common++; }
  return common / Math.max(aTokens.size, bTokens.size);
}

/**
 * Similarity score between a source paragraph and a target paragraph, 0..1.
 * Precomputed features are passed in to keep the DP loop cheap.
 */
function _sim(fa, fb) {
  // Two empty paragraphs align perfectly; empty vs non-empty do not.
  if (fa.len === 0 && fb.len === 0) return 0.9;
  if (fa.len === 0 || fb.len === 0) return 0.05;

  let score = 0;

  const overlap = _tokenOverlap(fa.tokens, fb.tokens);
  if (overlap !== null) {
    score += 0.5 * overlap;
  } else {
    // No invariant tokens on one side: redistribute weight to length.
    score += 0.15;
  }

  // Length ratio (ES tends to be 0-35% longer than EN; min/max is tolerant).
  const lenRatio = Math.min(fa.len, fb.len) / Math.max(fa.len, fb.len);
  score += 0.3 * lenRatio;

  // Structural hints.
  if (fa.isHeading && fb.isHeading) score += 0.1;
  else if (fa.isHeading !== fb.isHeading) score -= 0.1;

  if (fa.listLabel && fb.listLabel) {
    if (fa.listLabel === fb.listLabel) score += 0.25;
    else score -= 0.05;
  }

  return Math.max(0, Math.min(1, score));
}

// A leading list marker ("16.", "(a)", "16)") is removed before tokenizing so
// a hand-numbered source and an auto-numbered target align on content alone,
// and a list number never becomes a spurious anchor token.
const _LEADING_MARKER_RE = /^\s*(?:\(?\d{1,3}[.)]|\(?[a-z]\)|\(?[ivxlcdm]{1,6}\))[ \t\u00a0]+/;

function _features(para) {
  let text = (para.text || '').trim();
  text = text.replace(_LEADING_MARKER_RE, '');
  return {
    len: text.length,
    tokens: invariantTokens(text),
    isHeading: !!para.isHeading,
    listLabel: para.listLabel || null
  };
}

/**
 * Anchor pairs: paragraphs that share a RARE invariant token (a number,
 * acronym or document symbol that appears in exactly one paragraph of each
 * document). Such pairs are near-certain correspondences: they get a strong
 * similarity bonus and are never demoted afterwards. This is the same
 * anchoring idea the Correction Tracker aligner uses, extended to any rare
 * token instead of only exact text matches.
 */
function _buildAnchorPairs(fa, fb) {
  const srcByToken = new Map(); // token -> paraIdx | -2 (seen in 2+)
  const tgtByToken = new Map();
  const collect = (features, map) => {
    for (let i = 0; i < features.length; i++) {
      for (const t of features[i].tokens) {
        if (t.length < 2) continue; // single digits/letters are not distinctive
        map.set(t, map.has(t) ? -2 : i);
      }
    }
  };
  collect(fa, srcByToken);
  collect(fb, tgtByToken);

  const anchors = new Set(); // 'i:j'
  for (const [token, i] of srcByToken) {
    if (i < 0) continue;
    const j = tgtByToken.get(token);
    if (j === undefined || j < 0) continue;
    anchors.add(i + ':' + j);
  }
  return anchors;
}

/**
 * Monotonic DP alignment of two arrays of paragraphs.
 * Returns an array of moves: { srcIdx|null, tgtIdx|null, score } where a null
 * side is a gap. Indexes are positions in the input arrays.
 */
export function alignSequences(srcParas, tgtParas) {
  const n = srcParas.length;
  const m = tgtParas.length;
  if (n === 0 && m === 0) return [];

  const fa = srcParas.map(_features);
  const fb = tgtParas.map(_features);
  const ratio = n > 0 ? m / n : 1;
  const anchors = _buildAnchorPairs(fa, fb);
  // Positional prior: paragraphs near the expected diagonal are more likely
  // matches. Small weight so a real omission (diagonal shift) still loses to
  // token evidence, but translated headings / renamed acronyms with no shared
  // tokens keep their natural 1:1 pairing. When the two documents differ a lot
  // in size (one is a PART of the other), the scaled diagonal is a misleading
  // prior, so its weight fades with the size mismatch.
  const sizeSim = Math.max(n, m) > 0 ? Math.min(n, m) / Math.max(n, m) : 1;
  const posBonus = (i, j) => {
    const dist = Math.abs(j - i * ratio);
    return dist >= 6 ? 0 : 0.12 * sizeSim * (1 - dist / 6);
  };
  const pairSim = (i, j) => {
    let s = _sim(fa[i], fb[j]) + posBonus(i, j);
    if (anchors.has(i + ':' + j)) s += 0.45;
    return Math.min(1.2, s);
  };

  // Banded DP. Cell (i,j) = best score aligning first i src with first j tgt.
  // Stored sparsely per row within the band. The band is centred on the SCALED
  // diagonal, but when one document is only a PART of the other (sizes far
  // apart) the true path hugs j ~ i, up to |m - n| away from that diagonal --
  // widen the band to cover the whole skew envelope, or the aligner literally
  // cannot see the correct pairs (a real-world Part-E source vs full target
  // derailed after ~35 paragraphs with the fixed band).
  const band = BAND + Math.abs(m - n);
  const lo = new Array(n + 1);
  const hi = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const center = Math.round(i * ratio);
    lo[i] = Math.max(0, center - band);
    hi[i] = Math.min(m, center + band);
  }
  // Ensure connectivity of the band between consecutive rows.
  for (let i = 1; i <= n; i++) {
    if (lo[i] > hi[i - 1]) lo[i] = hi[i - 1];
    if (hi[i] < lo[i - 1]) hi[i] = lo[i - 1];
  }

  const score = new Array(n + 1);
  const back = new Array(n + 1); // 0=diag, 1=up(src gap... src consumed), 2=left(tgt consumed)
  for (let i = 0; i <= n; i++) {
    score[i] = new Float64Array(hi[i] - lo[i] + 1);
    back[i] = new Int8Array(hi[i] - lo[i] + 1);
  }
  const at = (i, j) => score[i][j - lo[i]];
  const setCell = (i, j, v, b) => { score[i][j - lo[i]] = v; back[i][j - lo[i]] = b; };
  const inBand = (i, j) => j >= lo[i] && j <= hi[i];

  const NEG = -1e9;
  for (let i = 0; i <= n; i++) {
    for (let j = lo[i]; j <= hi[i]; j++) {
      if (i === 0 && j === 0) { setCell(0, 0, 0, 0); continue; }
      let best = NEG, bestB = 0;
      if (i > 0 && j > 0 && inBand(i - 1, j - 1)) {
        const s = at(i - 1, j - 1) + pairSim(i - 1, j - 1);
        if (s > best) { best = s; bestB = 0; }
      }
      if (i > 0 && inBand(i - 1, j)) {
        const s = at(i - 1, j) - GAP_PENALTY;
        if (s > best) { best = s; bestB = 1; }
      }
      if (j > 0 && inBand(i, j - 1)) {
        const s = at(i, j - 1) - GAP_PENALTY;
        if (s > best) { best = s; bestB = 2; }
      }
      setCell(i, j, best, bestB);
    }
  }

  // Traceback.
  const moves = [];
  let i = n, j = Math.min(m, hi[n]);
  // If m is outside the last band (extreme size mismatch), clamp: remaining
  // target paragraphs are reported as unmatched additions.
  for (let k = m; k > j; k--) moves.push({ srcIdx: null, tgtIdx: k - 1, score: 0 });
  while (i > 0 || j > 0) {
    const b = back[i][j - lo[i]];
    if (i > 0 && j > 0 && b === 0) {
      const s = pairSim(i - 1, j - 1);
      moves.push({ srcIdx: i - 1, tgtIdx: j - 1, score: s });
      i--; j--;
    } else if (i > 0 && (b === 1 || j === 0)) {
      moves.push({ srcIdx: i - 1, tgtIdx: null, score: 0 });
      i--;
    } else {
      moves.push({ srcIdx: null, tgtIdx: j - 1, score: 0 });
      j--;
    }
  }
  moves.reverse();

  // Demote weak pairs to double gaps - but ONLY when there is no structural
  // evidence backing the pair. A low-similarity pair is KEPT when:
  //   (a) it is an anchor pair (shares a rare invariant token), or
  //   (b) it is "sandwiched": its immediate neighbors on both sides are also
  //       1:1 pairs (a translated heading or a renamed acronym sitting inside
  //       a consistent 1:1 run is almost surely a correct correspondence).
  // This is what prevents false "missing paragraph" reports for paragraphs
  // whose only content changes completely in translation (UNDESA -> DAES).
  const isPair = (mv) => mv && mv.srcIdx !== null && mv.tgtIdx !== null;
  const out = [];
  for (let k = 0; k < moves.length; k++) {
    const mv = moves[k];
    if (!isPair(mv) || mv.score >= MIN_PAIR_SCORE) { out.push(mv); continue; }
    if (anchors.has(mv.srcIdx + ':' + mv.tgtIdx)) { out.push(mv); continue; }

    const prev = moves[k - 1];
    const next = moves[k + 1];
    const prevOk = k === 0 || (isPair(prev) && prev.srcIdx === mv.srcIdx - 1 && prev.tgtIdx === mv.tgtIdx - 1);
    const nextOk = k === moves.length - 1 || (isPair(next) && next.srcIdx === mv.srcIdx + 1 && next.tgtIdx === mv.tgtIdx + 1);
    if (prevOk && nextOk) { out.push(mv); continue; }

    out.push({ srcIdx: mv.srcIdx, tgtIdx: null, score: 0 });
    out.push({ srcIdx: null, tgtIdx: mv.tgtIdx, score: 0 });
  }
  return out;
}

/**
 * Pseudo-paragraph standing for a whole table row, so rows can go through the
 * same DP as body paragraphs. The signature is the row's non-empty cell texts
 * joined by a separator that no number can span, which keeps each cell's
 * figures as their own invariant token. A row with no text at all yields an
 * empty signature: two of those align with each other, and one facing a row
 * with content aligns to a gap -- which is exactly a spacer row appearing on
 * one side only.
 * @param {Object} model  the document model the row belongs to
 * @returns {Function} (row) => pseudo-paragraph for alignSequences
 */
function _rowSignature(model) {
  return (row) => {
    const parts = [];
    for (const cell of row) {
      for (const pid of cell.paraIds) {
        const t = (model.paras[pid].text || '').trim();
        if (t) parts.push(t);
      }
    }
    return { id: -1, text: parts.join(' | '), isHeading: false, listLabel: null };
  };
}

/**
 * Full model alignment.
 * Returns:
 * {
 *   srcToTgt: Map paraId -> paraId|null   (source body/footnote paragraphs)
 *   tgtToSrc: Map paraId -> paraId|null
 *   pairScores: Map srcParaId -> score
 *   footnotePairs: [ { srcFn, tgtFn|null } ]  (model.footnotes entries)
 *   tablePairs: [ { srcTable, tgtTable|null, rowPairs } ]
 *     rowPairs: [ { srcRow:idx|null, tgtRow:idx|null, score } ] in document
 *     order; a null side is a row with no counterpart. Empty on a table that
 *     exists on one side only.
 * }
 */
/**
 * SPLIT PARAGRAPHS: one paragraph on one side, several on the other.
 *
 * The DP above is monotonic and 1:1, so it can pair a paragraph with exactly
 * one counterpart. That is wrong for a layout the UN uses on every cover page:
 * the English masthead is ONE paragraph with hard line breaks inside it --
 * "Official Records / Eighty-first Session / Supplement No. 5L" -- while the
 * Spanish is THREE separate paragraphs. The DP paired the one that shares the
 * "5L" and reported the other two as text added in translation, which is the
 * opposite of the truth: nothing was added, the same content is simply laid
 * out differently.
 *
 * This pass looks for a run of paragraphs with no counterpart sitting next to
 * an aligned one, and asks a single question: does the counterpart match the
 * run and its neighbour TOGETHER better than it matches the neighbour alone?
 * If it does, the whole run belongs to that counterpart and is mapped to it.
 *
 * The length ratio inside _sim is what makes this safe. Merging a real
 * addition (a translator's note next to a translated paragraph) makes the
 * merged text LONGER than its counterpart and the score WORSE, so the run is
 * left reported. Merging a real split brings the two lengths together and the
 * score up. Nothing is merged unless it improves the match by a clear margin.
 *
 * Only the many-to-one map is written. The one-to-one map keeps pointing at
 * the single best counterpart, so every check that walks it (figures, number
 * format, sentence counts) sees exactly the pairs it saw before and cannot
 * gain a new false positive from this.
 */
const SPLIT_MIN_GAIN = 0.06;   // the merge has to be clearly better, not equal
const SPLIT_MAX_RUN = 4;       // a whole page of orphans is not a split

function _reconcileSplits(aParas, bParas, aToB, bToA) {
  const bFeat = bParas.map(_features);
  const aById = new Map(aParas.map(p => [p.id, p]));
  const aFeatById = new Map(aParas.map(p => [p.id, _features(p)]));

  const unaligned = (i) => {
    const v = bToA.get(bParas[i].id);
    return (v === null || v === undefined) && (bParas[i].text || '').trim().length > 0;
  };

  let i = 0;
  while (i < bParas.length) {
    if (!unaligned(i)) { i++; continue; }
    let end = i;
    while (end + 1 < bParas.length && unaligned(end + 1)) end++;
    const runLen = end - i + 1;
    if (runLen > SPLIT_MAX_RUN) { i = end + 1; continue; }

    // The aligned paragraph on either side of the run is the only candidate:
    // a split leaves its pieces touching the piece that did get paired.
    const candidates = [];
    if (i - 1 >= 0) candidates.push(i - 1);
    if (end + 1 < bParas.length) candidates.push(end + 1);

    let best = null;
    for (const anchor of candidates) {
      const aId = bToA.get(bParas[anchor].id);
      if (aId === null || aId === undefined) continue;
      const aPara = aById.get(aId);
      const fa = aFeatById.get(aId);
      if (!aPara || !fa) continue;
      const alone = _sim(fa, bFeat[anchor]);
      const from = Math.min(i, anchor), to = Math.max(end, anchor);
      const mergedText = bParas.slice(from, to + 1).map(p => (p.text || '').trim())
        .filter(Boolean).join(' ');
      const merged = _sim(fa, _features({
        text: mergedText,
        isHeading: bParas[anchor].isHeading,
        listLabel: bParas[anchor].listLabel
      }));
      if (merged < MIN_PAIR_SCORE || merged < alone + SPLIT_MIN_GAIN) continue;
      if (!best || merged > best.merged) best = { aId, from, to, merged };
    }
    if (best) {
      for (let k = best.from; k <= best.to; k++) {
        if (bToA.get(bParas[k].id) === null || bToA.get(bParas[k].id) === undefined) {
          bToA.set(bParas[k].id, best.aId);
        }
      }
    }
    i = end + 1;
  }
}

export function alignModels(src, tgt) {
  const srcToTgt = new Map();
  const tgtToSrc = new Map();
  const pairScores = new Map();

  const record = (sPara, tPara, score) => {
    if (sPara && tPara) {
      srcToTgt.set(sPara.id, tPara.id);
      tgtToSrc.set(tPara.id, sPara.id);
      pairScores.set(sPara.id, score);
    } else if (sPara) {
      srcToTgt.set(sPara.id, null);
    } else if (tPara) {
      tgtToSrc.set(tPara.id, null);
    }
  };

  // 1. Body paragraphs outside tables.
  const srcBody = src.paras.filter(p => p.loc.area === 'body' && p.loc.table === null);
  const tgtBody = tgt.paras.filter(p => p.loc.area === 'body' && p.loc.table === null);
  for (const mv of alignSequences(srcBody, tgtBody)) {
    record(mv.srcIdx !== null ? srcBody[mv.srcIdx] : null,
           mv.tgtIdx !== null ? tgtBody[mv.tgtIdx] : null,
           mv.score);
  }
  // One paragraph on one side, several on the other: give the pieces their
  // counterpart back. Run in both directions, because either document can be
  // the one that splits.
  _reconcileSplits(srcBody, tgtBody, srcToTgt, tgtToSrc);
  _reconcileSplits(tgtBody, srcBody, tgtToSrc, srcToTgt);

  // 2. Tables: pair by document order, ROWS by DP, cells by coordinates.
  const tablePairs = [];
  const tMax = Math.max(src.tables.length, tgt.tables.length);
  for (let t = 0; t < tMax; t++) {
    const st = src.tables[t] || null;
    const tt = tgt.tables[t] || null;
    const tablePair = { srcTable: st, tgtTable: tt, rowPairs: [] };
    tablePairs.push(tablePair);
    if (!st || !tt) {
      // Whole table missing on one side: paragraphs of the other side unmatched.
      const solo = st || tt;
      const isSrc = !!st;
      for (const row of solo.rows) {
        for (const cell of row) {
          for (const pid of cell.paraIds) {
            const para = (isSrc ? src : tgt).paras[pid];
            record(isSrc ? para : null, isSrc ? null : para, 0);
          }
        }
      }
      continue;
    }
    // Rows used to be paired by INDEX. One spacer row present on a single side
    // then shifted every following row, and each shifted pair produced its own
    // false report -- an extra empty row under a table caption turned into
    // dozens of "no counterpart" / numbering / figure issues. Rows are aligned
    // with the same DP as body paragraphs instead, over a signature built from
    // the row's cell texts: the figures of a budget table are identical on both
    // sides, so they act as strong anchors and the asymmetry stays where it
    // really is.
    for (const rmv of alignSequences(st.rows.map(_rowSignature(src)),
                                     tt.rows.map(_rowSignature(tgt)))) {
      tablePair.rowPairs.push({ srcRow: rmv.srcIdx, tgtRow: rmv.tgtIdx, score: rmv.score });
      const sRow = rmv.srcIdx !== null ? st.rows[rmv.srcIdx] : [];
      const tRow = rmv.tgtIdx !== null ? tt.rows[rmv.tgtIdx] : [];
      const cMax = Math.max(sRow.length, tRow.length);
      for (let c = 0; c < cMax; c++) {
        const sCell = sRow[c] || null;
        const tCell = tRow[c] || null;
        const sParas = sCell ? sCell.paraIds.map(id => src.paras[id]) : [];
        const tParas = tCell ? tCell.paraIds.map(id => tgt.paras[id]) : [];
        if (sParas.length === tParas.length) {
          // Same cell coordinates + same paragraph count: the STRUCTURE is the
          // alignment. Content similarity is irrelevant here (a cell whose only
          // content is a translated acronym must still pair with its cell).
          for (let k = 0; k < sParas.length; k++) record(sParas[k], tParas[k], 1);
        } else {
          for (const mv of alignSequences(sParas, tParas)) {
            record(mv.srcIdx !== null ? sParas[mv.srcIdx] : null,
                   mv.tgtIdx !== null ? tParas[mv.tgtIdx] : null,
                   mv.score);
          }
        }
      }
    }
  }

  // 3. Footnotes: DP-align note texts (as pseudo-paragraphs).
  const srcFnParas = src.footnotes.map(fn => ({ id: -1, text: fn.text, isHeading: false, listLabel: null, _fn: fn }));
  const tgtFnParas = tgt.footnotes.map(fn => ({ id: -1, text: fn.text, isHeading: false, listLabel: null, _fn: fn }));
  const footnotePairs = [];
  for (const mv of alignSequences(srcFnParas, tgtFnParas)) {
    const sFn = mv.srcIdx !== null ? src.footnotes[mv.srcIdx] : null;
    const tFn = mv.tgtIdx !== null ? tgt.footnotes[mv.tgtIdx] : null;
    footnotePairs.push({ srcFn: sFn, tgtFn: tFn, score: mv.score });
    // Also record paragraph-level pairing inside matched notes.
    if (sFn && tFn) {
      const sParas = sFn.paraIds.map(id => src.paras[id]);
      const tParas = tFn.paraIds.map(id => tgt.paras[id]);
      for (const pmv of alignSequences(sParas, tParas)) {
        record(pmv.srcIdx !== null ? sParas[pmv.srcIdx] : null,
               pmv.tgtIdx !== null ? tParas[pmv.tgtIdx] : null,
               pmv.score);
      }
    } else if (sFn) {
      for (const id of sFn.paraIds) record(src.paras[id], null, 0);
    } else if (tFn) {
      for (const id of tFn.paraIds) record(null, tgt.paras[id], 0);
    }
  }

  return { srcToTgt, tgtToSrc, pairScores, footnotePairs, tablePairs };
}
