/* Origin: COMeT services/srx-segmenter.js @ 04540f5 (adapted: unchanged logic) */
/**
 * SRX Segmenter \u2014 Splits text into segments based on SRX rules.
 *
 * Replicates eLUNa's segmentation behavior using a rule-based approach.
 *
 * Rules are based on:
 *   1. Non-break rules (exceptions): abbreviations that shouldn't break a sentence.
 *   2. Break rules: punctuation followed by whitespace and a capital letter.
 *
 * This implementation is a "lite" version of SRX, focusing on the most common
 * patterns found in UN documents (EN/ES).
 */

// A Roman numeral written in capitals: "II", "IV", "XII". Used to keep a
// document reference such as "chap. II" or "sect. IV" in one piece even when
// the abbreviation before the dot is not in the exception list below.
const ROMAN_NUMERAL = /^M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

function _isRomanNumeral(token) {
  // Drop trailing punctuation ("II," / "IV)" / "XII.") but nothing else.
  const t = String(token == null ? '' : token).replace(/[^A-Za-z]+$/, '');
  // Two letters minimum: a bare "I" is the English pronoun far more often
  // than it is a numeral, and "I would like..." must still break.
  if (t.length < 2 || t.length > 7) return false;
  // Capitals only, so ordinary capitalized words made of these letters
  // ("Mix", "Did") are not mistaken for numerals.
  if (!/^[IVXLCDM]+$/.test(t)) return false;
  return ROMAN_NUMERAL.test(t);
}

export class SrxSegmenter {
  /**
   * @param {string} lang \u2014 Language code ('EN', 'ES', 'FR', etc.)
   */
  constructor(lang = 'EN') {
    this.lang = lang.toUpperCase();
    this._initRules();
  }

  /**
   * Segment a paragraph into an array of strings.
   *
   * @param {string} text \u2014 Full paragraph text
   * @returns {string[]} \u2014 Array of segments
   */
  segment(text) {
    if (!text || text.trim().length === 0) return [];

    // 1. Normalize whitespace
    const normalized = text.replace(/\s+/g, ' ').trim();

    // 2. Find all potential break points
    const breakIndices = [];

    // 2a. Standard: punctuation + whitespace + uppercase
    for (const match of normalized.matchAll(/[.!?]\s+(?=[A-Z\u00C0-\u00DC"\u201C\u00AB(])/g)) {
      const index = match.index + 1; // position after the punctuation mark
      if (!this._isException(normalized, index)) {
        breakIndices.push(index);
      }
    }

    // 2b. No-space: period directly followed by uppercase (e.g., "standards.The")
    //     Common in UN DOCX files due to formatting artifacts. Only before a WORD
    //     (a capital followed by a small letter): a period glued to a lone capital
    //     is part of a reference ("sect. 27.F.", "1.A", "IV.B"), and cutting there
    //     left a stray "F." that the aligner then glued to the next sentence.
    for (const match of normalized.matchAll(/\.(?=[A-Z\u00C0-\u00DC][a-z\u00DF-\u00FF])/g)) {
      const index = match.index + 1; // position after the period
      // Only add if not already a break point and not an exception
      if (!breakIndices.includes(index) && !this._isException(normalized, index)) {
        breakIndices.push(index);
      }
    }

    // Sort break indices (since we collected from two passes)
    breakIndices.sort((a, b) => a - b);

    // 3. Split the text at the confirmed break points
    const segments = [];
    let lastIndex = 0;

    for (const idx of breakIndices) {
      segments.push(normalized.substring(lastIndex, idx).trim());
      lastIndex = idx;
    }
    segments.push(normalized.substring(lastIndex).trim());

    return segments.filter(s => s.length > 0);
  }

  /**
   * Validate if a segmentation matches a reference array of segments.
   *
   * @param {string} text \u2014 Full paragraph text
   * @param {string[]} referenceSegments \u2014 The segments we expect to get
   * @returns {{ match: boolean, discrepancies: number }}
   */
  validate(text, referenceSegments) {
    const srxSegments = this.segment(text);

    if (srxSegments.length !== referenceSegments.length) {
      return {
        match: false,
        discrepancies: Math.abs(srxSegments.length - referenceSegments.length)
      };
    }

    for (let i = 0; i < srxSegments.length; i++) {
      if (srxSegments[i].replace(/\s/g, '') !== referenceSegments[i].replace(/\s/g, '')) {
        return { match: false, discrepancies: 1 };
      }
    }

    return { match: true, discrepancies: 0 };
  }

  // \u2500\u2500\u2500 PRIVATE METHODS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  _initRules() {
    const common = [
      'Mr', 'Ms', 'Mrs', 'Dr', 'Prof', 'Sr', 'Sra', 'Srta', 'Jr', 'St', 'No', 'Vol', 'cf', 'vs', 'etc'
    ];

    // Abbreviations used in UN DOCUMENT REFERENCES ("A/80/5/Add.12, chap. II,
    // sect. B"). They are shared by ALL languages on purpose: a symbol reads
    // the same in every language version, so if one language broke after
    // "chap." and another did not, the same table cell ended up with a
    // different number of sentences on each side, and the aligner then had to
    // re-cut the other side to make the counts match. Language-specific words
    // ("para" in EN, "parr" in ES) stay in their own list below, because they
    // are ordinary words in the other language.
    // NOTE: "Add.", "Corr.", "Rev." and "Amend." are deliberately NOT here.
    // Inside a symbol they are always glued to a figure ("A/80/5/Add.12"), and
    // a figure never triggers a break, so listing them would gain nothing --
    // while "add" and "amend" are ordinary English verbs that DO end
    // sentences ("...what value it can add. The Board noted..."), and listing
    // them would glue two real sentences together.
    const docRef = [
      'suppl', 'sect', 'sects', 'sec', 'secs',
      'chap', 'chaps', 'ch', 'art', 'arts', 'fig', 'figs', 'doc', 'docs',
      'vol', 'vols', 'no', 'nos', 'pt', 'pts', 'p', 'pp'
    ];

    const en = [
      ...common, ...docRef,
      'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
      'e.g', 'i.e', 'U.N', 'U.S', 'para', 'paras'
    ];

    // Accented forms are written as escapes (ASCII-only source). The
    // unaccented spellings are kept too: they are typed that way often.
    const es = [
      ...common, ...docRef, 'Ud', 'Uds',
      'p\u00e1g', 'p\u00e1gs', 'pag', 'pags',
      'p\u00e1rr', 'p\u00e1rrs', 'parr', 'parrs',
      'n\u00fam', 'n\u00fams', 'num', 'nums',
      'cap', 'caps', 'secc', 'seccs', 'ej', 'EE.UU', 'N.U',
      'ib\u00edd', 'ibid', 'sig', 'sigs'
    ];

    const fr = [
      ...common, ...docRef, 'M', 'Mme', 'Mlle', 'Pr',
      'par', 'pars', 'ann', 'ibid'
    ];

    const rulesMap = { EN: en, ES: es, FR: fr };
    this.exceptions = (rulesMap[this.lang] || en).map(e => e.toLowerCase());
  }

  _isException(text, breakIndex) {
    const lookback = text.substring(Math.max(0, breakIndex - 15), breakIndex - 1);
    const words = lookback.split(/\s+/);
    const rawWord = words[words.length - 1];
    // Strip leading AND trailing punctuation from the last word
    // This handles cases like "(Vol" \u2192 "Vol", "'Dr" \u2192 "Dr", etc.
    const lastWord = rawWord
      .toLowerCase()
      .replace(/^[^a-z\u00C0-\u00FF]+/i, '')  // strip leading non-alpha
      .replace(/[^a-z\u00C0-\u00FF]+$/i, '');  // strip trailing non-alpha

    if (this.exceptions.includes(lastWord)) return true;
    // Single letter = abbreviation ONLY if the raw word is purely a letter
    // (e.g., "p." or "A."), NOT if it contains digits/hyphens (e.g., "(P-3)")
    if (/^[a-z]$/i.test(lastWord) && /^[^a-z]*[a-z][^a-z]*$/i.test(rawWord) && !/\d/.test(rawWord)) return true;
    if (/^\d+$/.test(lastWord)) return true;
    if (text[breakIndex - 2] === '.') return true;

    // "<short word>. <Roman numeral>" is a document reference ("sect. II",
    // "chap. IV", "ann. VII"), never the end of a sentence. This catches the
    // abbreviations that are missing from the lists above, which is what made
    // EN and ES split the same reference differently. Guarded twice so real
    // sentences still break: the word before the dot has to be short enough
    // to be an abbreviation, and the numeral has to be in capitals.
    if (/^[a-z\u00c0-\u00ff]{2,6}$/i.test(lastWord)) {
      const nextToken = text.substring(breakIndex).replace(/^\s+/, '').split(/\s+/)[0];
      if (_isRomanNumeral(nextToken)) return true;
    }

    return false;
  }
}
