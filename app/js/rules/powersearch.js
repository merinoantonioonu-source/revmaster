/* Origin: COMeT modules/qa-checker/powersearch-engine.js @ 04540f5 (adapted: footnote helper stubbed) */

/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
   POWERSEARCH ENGINE (Extracted from QA Checker)
   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */

// UMBRA has no eLUNa footnote-call markup: the helper is a no-op here.
function bareFootnoteCalls(s) { return s; }

const _WC = 'a-zA-Z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc\u00e0\u00e8\u00ec\u00f2\u00f9\u00c0\u00c8\u00cc\u00d2\u00d9\u00e2\u00ea\u00ee\u00f4\u00fb\u00c2\u00ca\u00ce\u00d4\u00db\u00e4\u00eb\u00ef\u00f6\u00fc\u00c4\u00cb\u00cf\u00d6\u00dc\u00e7\u00c7_';
const WB_START = `(?<![${_WC}])`;
const WB_END   = `(?![${_WC}])`;

export function wrapWholeWord(pattern) {
  return WB_START + '(?:' + pattern + ')' + WB_END;
}

// Characters of each POSIX class, for use INSIDE a bracket expression ("[[:alpha:]\u00e1]").
const _POSIX_IN_BRACKETS = {
  alpha: 'a-zA-Z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc\u00e0\u00e8\u00ec\u00f2\u00f9\u00c0\u00c8\u00cc\u00d2\u00d9\u00e2\u00ea\u00ee\u00f4\u00fb\u00c2\u00ca\u00ce\u00d4\u00db\u00e4\u00eb\u00ef\u00f6\u00c4\u00cb\u00cf\u00d6',
  digit: '0-9',
  space: '\\s',
  upper: 'A-Z\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00dc',
  lower: 'a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc'
};
_POSIX_IN_BRACKETS.letter = _POSIX_IN_BRACKETS.alpha;
_POSIX_IN_BRACKETS.alnum = _POSIX_IN_BRACKETS.alpha + '0-9';
_POSIX_IN_BRACKETS.alphanum = _POSIX_IN_BRACKETS.alnum;

// End index (exclusive) of the bracket expression that opens at p[i] === '['. A ']' right after
// '[' or '[^' is literal, a POSIX class "[:x:]" is skipped whole, escapes are skipped.
function _bracketEnd(p, i) {
  let j = i + 1;
  if (p[j] === '^') j++;
  if (p[j] === ']') j++;
  while (j < p.length) {
    if (p[j] === '\\') { j += 2; continue; }
    if (p[j] === '[' && p[j + 1] === ':') {
      const k = p.indexOf(':]', j + 2);
      if (k !== -1) { j = k + 2; continue; }
    }
    if (p[j] === ']') return j + 1;
    j++;
  }
  return p.length;
}

// Xbench extras that JavaScript does not understand, resolved by walking the pattern (escapes and
// bracket expressions are copied as they are, so a literal "\<" or "[<>]" is left alone):
//  - "(...)=N" gives that group the number N for @N: it becomes the named group (?<gN>...), which
//    captureGroups() reads back as @N (JavaScript numbers groups by their opening parenthesis);
//  - "<" and ">" are the start and the end of a word, alone ("<pos", "May>") or around anything
//    ("<[0-9]{4}>"). A formatting tag ("<i>", "</sup>"), a lookbehind "(?<=" / "(?<!" and a named
//    group "(?<name>" keep their angle brackets.
// A POSIX class mixed with other characters inside brackets ("[[:alpha:]\u00e1]") becomes its
// characters. Run FIRST: the standalone conversions of posixToJs would otherwise turn the inner
// "[:alpha:]" into a bracket expression of its own, nested and broken.
function _posixInBrackets(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { out += p.slice(i, i + 2); i++; continue; }
    if (c === '[' && p[i + 1] !== ':') {
      const end = _bracketEnd(p, i);
      let body = p.slice(i, end);
      const inner = body.slice(1, -1);
      if (/\[:[a-z]+:\]/.test(inner) && !/^\[:[a-z]+:\]$/.test(inner)) {
        body = '[' + inner.replace(/\[:([a-z]+):\]/g, (m0, k) => _POSIX_IN_BRACKETS[k] || m0) + ']';
      }
      out += body; i = end - 1; continue;
    }
    out += c;
  }
  return out;
}

const _FMT_TAG_AT = /^<\s*\/?\s*(em|strong|i|b|u|s|del|sup|sub)(\s[^>]*)?>/i;
function _xbenchSyntax(p) {
  // a) (...)=N -> (?<gN>...), first pass: find the groups.
  const named = new Map();   // index of '(' -> N
  const drop = [];           // [start, end) of each "=N" to remove
  const stack = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { i++; continue; }
    if (c === '[') { i = _bracketEnd(p, i) - 1; continue; }
    if (c === '(') { stack.push(i); continue; }
    if (c === ')') {
      const open = stack.pop();
      const m = /^=([1-9])/.exec(p.slice(i + 1));
      if (m) {
        drop.push([i + 1, i + 1 + m[0].length]);
        const n = Number(m[1]);
        const plain = open !== undefined && (p[open + 1] !== '?' || p.slice(open + 1, open + 3) === '?:');
        if (plain && ![...named.values()].includes(n)) named.set(open, n);
      }
    }
  }
  // b) Second pass: rebuild with the named groups, the bracket classes and the word anchors.
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const d = drop.find(r => r[0] === i);
    if (d) { i = d[1] - 1; continue; }
    const c = p[i];
    if (c === '\\') { out += p.slice(i, i + 2); i++; continue; }
    if (c === '[') { const end = _bracketEnd(p, i); out += p.slice(i, end); i = end - 1; continue; }
    if (c === '(' && named.has(i)) {
      out += '(?<g' + named.get(i) + '>';
      if (p.slice(i + 1, i + 3) === '?:') i += 2;
      continue;
    }
    if (c === '(' && p.slice(i + 1, i + 3) === '?<') {
      const nm = /^\(\?<[A-Za-z_][A-Za-z0-9_]*>/.exec(p.slice(i));
      if (nm) { out += nm[0]; i += nm[0].length - 1; continue; }
      out += '(?<'; i += 2; continue;   // lookbehind (?<= / (?<!
    }
    if (c === '<') {
      const tag = _FMT_TAG_AT.exec(p.slice(i));
      if (tag) { out += tag[0]; i += tag[0].length - 1; continue; }
      out += WB_START; continue;
    }
    if (c === '>') { out += WB_END; continue; }
    out += c;
  }
  return out;
}

/**
 * The capture groups of a source match as @1..@9 read them: the groups numbered with Xbench's
 * "(...)=N" (named gN by posixToJs) when the pattern has any, otherwise the groups in order.
 */
export function captureGroups(m) {
  if (!m || !m.groups) return m;
  const keys = Object.keys(m.groups).filter(k => /^g[1-9]$/.test(k));
  if (!keys.length) return m;
  const out = [m[0]];
  for (let n = 1; n <= 9; n++) out[n] = m.groups['g' + n];
  out.index = m.index;
  return out;
}

export function posixToJs(p) {
  return _posixInBrackets(p)
    // 0. (moved) Xbench explicit capture numbering (pattern)=N is resolved at the end, in
    //    _xbenchSyntax, together with the other Xbench extras; done here it would leave "=N"
    //    in front of the class conversions below.
    // 1. Quantifier fix: {,N} \u2192 {0,N} (POSIX allows {,N}, JS requires {0,N})
    .replace(/\{,(\d+)\}/g, '{0,$1}')
    // 2. Xbench % word boundary: word% means "word ends here at a boundary"
    //    Convert (pattern)% to (pattern)\b and word%> to word\b
    //    Must be done BEFORE <word> boundary conversion
    .replace(/\)%/g, ')\\b')
    .replace(/(%)(>)/g, '\\b$2')
    .replace(/([a-zA-Z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d10-9])%([^a-zA-Z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d10-9>]|$)/g, '$1\\b$2')
    // 3. POSIX character classes (order matters: compound classes before simple ones)
    // [:num:] \u2014 Xbench "formatted number": digits with optional separators (.,  space)
    // COMeT: a quantified [:num:] (e.g. "[:num:]*" or "[:num:]+") would become a
    // nested quantifier "(?:\d[...]*\d|\d)*", which backtracks exponentially on
    // long runs of digits and spaces (numeric tables) and freezes the panel
    // until Chrome kills it. Since [:num:] already matches a whole run of
    // digits and separators, "[:num:]+" is exactly [:num:] and "[:num:]*" is
    // exactly an optional [:num:], so collapse them before expanding.
    .replace(/(\[\[:num:\]\]|\[:num:\])\+(?![+?])/g, '$1')
    .replace(/(\[\[:num:\]\]|\[:num:\])\*(?![+?])/g, '(?:$1)?')
    .replace(/\[\[:num:\]\]/g, '(?:\\d[\\d.,\\x20\\u00A0]*\\d|\\d)')
    .replace(/\[:num:\]/g, '(?:\\d[\\d.,\\x20\\u00A0]*\\d|\\d)')
    // [:alphanum:] \u2014 same as [:alnum:] in Xbench
    .replace(/\[\[:alphanum:\]\]/g, '[a-zA-Z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc\u00e0\u00e8\u00ec\u00f2\u00f9\u00c0\u00c8\u00cc\u00d2\u00d9]')
    .replace(/\[:alphanum:\]/g, '[a-zA-Z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc\u00e0\u00e8\u00ec\u00f2\u00f9\u00c0\u00c8\u00cc\u00d2\u00d9]')
    // [:space:] \u2014 whitespace
    .replace(/\[\[:space:\]\]/g, '\\s')
    .replace(/\[:space:\]/g, '\\s')
    // [:punct:] \u2014 punctuation (non-word, non-space)
    .replace(/\[\[:punct:\]\]/g, '[^\\w\\s]')
    .replace(/\[:punct:\]/g, '[^\\w\\s]')
    // [:letter:] \u2014 same as [:alpha:] in Xbench
    .replace(/\[\[:letter:\]\]/g, '[a-zA-Z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc\u00e0\u00e8\u00ec\u00f2\u00f9\u00c0\u00c8\u00cc\u00d2\u00d9\u00e2\u00ea\u00ee\u00f4\u00fb\u00c2\u00ca\u00ce\u00d4\u00db\u00e4\u00eb\u00ef\u00f6\u00fc\u00c4\u00cb\u00cf\u00d6\u00dc]')
    .replace(/\[:letter:\]/g, '[a-zA-Z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc\u00e0\u00e8\u00ec\u00f2\u00f9\u00c0\u00c8\u00cc\u00d2\u00d9\u00e2\u00ea\u00ee\u00f4\u00fb\u00c2\u00ca\u00ce\u00d4\u00db\u00e4\u00eb\u00ef\u00f6\u00fc\u00c4\u00cb\u00cf\u00d6\u00dc]')
    // [:digit:]
    .replace(/\[\[:digit:\]\]/g, '\\d')
    .replace(/\[:digit:\]/g, '\\d')
    // [:alpha:]
    .replace(/\[\[:alpha:\]\]/g, '[a-zA-Z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc\u00e0\u00e8\u00ec\u00f2\u00f9\u00c0\u00c8\u00cc\u00d2\u00d9\u00e2\u00ea\u00ee\u00f4\u00fb\u00c2\u00ca\u00ce\u00d4\u00db\u00e4\u00eb\u00ef\u00f6\u00fc\u00c4\u00cb\u00cf\u00d6\u00dc]')
    .replace(/\[:alpha:\]/g, '[a-zA-Z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc\u00e0\u00e8\u00ec\u00f2\u00f9\u00c0\u00c8\u00cc\u00d2\u00d9\u00e2\u00ea\u00ee\u00f4\u00fb\u00c2\u00ca\u00ce\u00d4\u00db\u00e4\u00eb\u00ef\u00f6\u00fc\u00c4\u00cb\u00cf\u00d6\u00dc]')
    // [:alnum:]
    .replace(/\[\[:alnum:\]\]/g, '[a-zA-Z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc]')
    .replace(/\[:alnum:\]/g, '[a-zA-Z0-9\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00d1\u00fc\u00dc]')
    // 4. Xbench <word> boundaries, lone "<" / ">" word anchors, "(...)=N" capture numbering
    //    and POSIX classes inside brackets: see _xbenchSyntax. Formatting tags (<i>, </sup>...)
    //    stay literal for format-aware matching against the segment's HTML.
    .replace(/^[\s\S]*$/, (all) => _xbenchSyntax(all));
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function tokenize(raw) {
  const tokens = [];
  let i = 0;
  const s = raw.trim();

  while (i < s.length) {
    if (s[i] === ' ' || s[i] === '\t') { i++; continue; }

    let negated = false;
    // A leading "-" negates the term whatever character follows it ("-[Ss]e\u00f1or", "-\u00bfQu\u00e9",
    // "-1999", "-\u00fcber"), as in Xbench; a "-" on its own (followed by a space) is literal.
    if (s[i] === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      negated = true;
      i++;
    }

    if (s[i] === '"') {
      i++;
      let content = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) { content += s[i] + s[i + 1]; i += 2; }
        else { content += s[i]; i++; }
      }
      if (i < s.length) i++;
      tokens.push({ type: 'phrase', content, negated });
    } else {
      let word = '';
      while (i < s.length && s[i] !== ' ' && s[i] !== '\t') { word += s[i]; i++; }
      if (word) tokens.push({ type: 'word', content: word, negated });
    }
  }
  return tokens;
}

// Every kind of dash: hyphen, the Unicode hyphens and dashes, minus.
const DASH_CLASS = '[\\-\\u2010-\\u2015\\u2212]';
/**
 * A literal (escaped) pattern in which any dash finds any other: ")-" also finds ")\u2013" (en dash).
 * Only for searches that ask for it (cfg.dashloose: Boolean Search); a QA rule looks for exactly the
 * character it names, since "-" against "\u2013" is often the very thing it checks.
 */
export function dashLoose(p) {
  return String(p).replace(/[-\u2010-\u2015\u2212]/g, DASH_CLASS);
}

export function buildPattern(token, searchmode, wholeword, dashloose) {
  // SIMPLE SEARCH IS LITERAL, quoted or not. Only the PowerSearch operators
  // (space = AND, OR, a leading "-", quotes) mean something there; a dot, a
  // question mark or a bracket is just that character. An UNQUOTED term used
  // to go through as a regular expression even in simple mode, so "para."
  // (dot = any character) also found "paraguas". Regular-expression syntax,
  // including the Xbench extras ([:digit:], <word>, (...)=1), is only read in
  // regexp mode -- which is what every checklist that uses it declares.
  let p = searchmode === 'simple' ? escapeRegex(token.content) : posixToJs(token.content);
  if (dashloose && searchmode === 'simple') p = dashLoose(p);
  // Safety: validate regex before returning. If invalid, escape the whole thing
  // to prevent crashes. This handles cases like bare *, +, or unmatched parens
  // in word tokens (e.g., "-(a quarter)" where "(a" is parsed as a word token).
  try {
    new RegExp(p, 'gi');
  } catch {
    p = escapeRegex(token.content);
  }
  if (wholeword) p = wrapWholeWord(p);
  return p;
}

/* \u2500\u2500 Format-aware matching \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
 * Patterns may include literal formatting tags (<sup>, <em>, <strong>, <u>,
 * <s>, <sub>) to condition the match to a formatted region of the target /
 * source. When any token contains such a tag, the engine evaluates that
 * token against the enriched HTML (sourceHtml / targetHtml) instead of the
 * plain text. Synonyms are normalised so that <i>/<em>, <b>/<strong> and
 * <del>/<s> are interchangeable on both sides of the comparison.
 * \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */

// Tag pairs we recognise as formatting. Order matters \u2014 map all synonyms to
// a single canonical tag before matching so the user can write whichever
// variant they prefer.
const _FMT_TAG_NORMALISE = [
  { from: /<\s*i(\s[^>]*)?>/gi,        to: '<em>' },
  { from: /<\s*\/\s*i\s*>/gi,          to: '</em>' },
  { from: /<\s*b(\s[^>]*)?>/gi,        to: '<strong>' },
  { from: /<\s*\/\s*b\s*>/gi,          to: '</strong>' },
  { from: /<\s*del(\s[^>]*)?>/gi,      to: '<s>' },
  { from: /<\s*\/\s*del\s*>/gi,        to: '</s>' },
  { from: /<\s*em(\s[^>]*)?>/gi,       to: '<em>' },
  { from: /<\s*strong(\s[^>]*)?>/gi,   to: '<strong>' },
  { from: /<\s*u(\s[^>]*)?>/gi,        to: '<u>' },
  { from: /<\s*s(\s[^>]*)?>/gi,        to: '<s>' },
  { from: /<\s*sup(\s[^>]*)?>/gi,      to: '<sup>' },
  { from: /<\s*sub(\s[^>]*)?>/gi,      to: '<sub>' },
];

// Regex that detects ANY supported formatting tag in a string.
// Used to decide whether a token must be evaluated against HTML or plain text.
const _FMT_TAG_DETECT = /<\s*\/?\s*(em|strong|i|b|u|s|del|sup|sub)(\s[^>]*)?>/i;

/**
 * Returns true if the string contains any formatting tag recognised by the
 * QA Checker. Used to route a token to HTML-matching vs plain-text matching.
 */
export function containsFormatTags(s) {
  if (!s) return false;
  return _FMT_TAG_DETECT.test(s);
}

/**
 * Canonicalises formatting tag variants (<i>\u2192<em>, <b>\u2192<strong>, <del>\u2192<s>).
 * Applied to BOTH the user pattern and the segment HTML before matching so
 * the user can write whichever variant feels natural.
 */
export function normaliseFormatTags(s) {
  if (!s) return s;
  // A footnote call is searched as it always was: without the note it carries.
  let out = bareFootnoteCalls(s);
  for (const rule of _FMT_TAG_NORMALISE) {
    out = out.replace(rule.from, rule.to);
  }
  return out;
}

/**
 * Removes ALL supported formatting tags from a string, leaving only the
 * textual content. Used to compute highlight positions against plain text
 * when the user pattern contained tags.
 */
export function stripFormatTags(s) {
  if (!s) return s;
  return s.replace(/<\s*\/?\s*(em|strong|i|b|u|s|del|sup|sub)(\s[^>]*)?>/gi, '');
}

/**
 * COMeT: every place where a rule matches in `text`, pushed onto `hl`.
 * A pattern that can match the EMPTY string (".*", "x?", "\\b"...) returns a
 * zero-length match that does not move `lastIndex`, so the classic
 * `while (rx.exec(text))` loop found it again forever, piling up highlights
 * until the panel ran out of memory and Chrome killed it. An empty match now
 * steps one character forward, and the list is capped, since nobody reads
 * more than a few hundred highlights in one segment.
 */
const MAX_HIGHLIGHTS = 500;
function _collectHighlights(rx, text, hl) {
  let m;
  while ((m = rx.exec(text)) !== null) {
    if (m[0].length > 0) hl.push({ start: m.index, end: m.index + m[0].length });
    if (!rx.global || hl.length >= MAX_HIGHLIGHTS) break;
    if (m[0].length === 0) rx.lastIndex = m.index + 1;
  }
}

export function evalPowerSearch(text, cfg, srcCaptures, html) {
  const { raw, casecheck, wholeword, powersearch, searchmode, dashloose } = cfg;
  if (!raw || !raw.trim()) return { matches: true, highlights: [] };

  const flags = casecheck ? 'g' : 'gi';

  // Segment HTML normalised ONCE up-front so every token that needs it
  // compares against the same canonical form. Falls back to empty when the
  // caller doesn't pass HTML (e.g. manual-paste / bitext-file segments): in
  // that case, any token containing format tags will simply fail to match,
  // which is the right semantics \u2014 we have no formatting info to check.
  const htmlCanon = normaliseFormatTags(html || '');

  if (!powersearch) {
    // Decide search surface: if the pattern contains any format tag, match
    // against the enriched HTML. Otherwise match against plain text (legacy).
    const patternHasTags = containsFormatTags(raw);
    const searchSurface = patternHasTags ? htmlCanon : text;

    let pattern = raw;
    if (patternHasTags) pattern = normaliseFormatTags(pattern);
    if (searchmode === 'simple') pattern = escapeRegex(pattern);
    else pattern = posixToJs(pattern);
    if (dashloose && searchmode === 'simple') pattern = dashLoose(pattern);
    if (wholeword) pattern = wrapWholeWord(pattern);
    try {
      const rx = new RegExp(pattern, flags);
      const found = rx.test(searchSurface);
      const hl = [];
      if (found) {
        if (patternHasTags) {
          // Compute highlights on plain text using the tag-stripped pattern,
          // so the UI can underline the right span of characters. This is a
          // best-effort approximation: if the same plain-text sequence
          // appears multiple times with different formatting, all of them
          // will be highlighted. The rule's fire/no-fire decision, however,
          // is taken strictly against the HTML surface above.
          let stripped = stripFormatTags(raw);
          if (searchmode === 'simple') stripped = escapeRegex(stripped);
          else stripped = posixToJs(stripped);
          if (dashloose && searchmode === 'simple') stripped = dashLoose(stripped);
          if (wholeword) stripped = wrapWholeWord(stripped);
          try {
            const rxH = new RegExp(stripped, flags);
            _collectHighlights(rxH, text, hl);
          } catch { /* invalid stripped pattern \u2014 no highlights, but match still stands */ }
        } else {
          const rx2 = new RegExp(pattern, flags);
          _collectHighlights(rx2, text, hl);
        }
      }
      return { matches: found, highlights: hl };
    } catch { return { matches: false, highlights: [] }; }
  }

  // COMeT: soporte del operador OR (grupos). Si hay " OR " (mayusculas) fuera de
  // comillas, se evalua cada grupo (AND interno) y la regla casa si casa ALGUN grupo.
  const _orGroups = raw.split(/\s+OR\s+(?=(?:(?:[^"]*"){2})*[^"]*$)/);
  const _evalGroup = (groupRaw) => {
  const tokens = tokenize(groupRaw);
  let ok = true;
  const hl = [];

  for (const tk of tokens) {
    const tokenHasTags = containsFormatTags(tk.content);
    const searchSurface = tokenHasTags ? htmlCanon : text;

    // Build pattern. For tagged tokens we normalise variants first, then run
    // the standard buildPattern pipeline (posixToJs, escapeRegex if simple,
    // whole-word wrapping). The tags themselves survive escaping because
    // '<' and '>' are not regex metacharacters.
    const tkForBuild = tokenHasTags
      ? { ...tk, content: normaliseFormatTags(tk.content) }
      : tk;
    let pattern = buildPattern(tkForBuild, searchmode, wholeword, dashloose);

    if (srcCaptures) {
      // Support @1 through @9 (Xbench-style capture variable backreferences)
      for (let n = 1; n <= 9; n++) {
          if (pattern.includes(`@${n}`)) {
              const val = (srcCaptures && srcCaptures[n]) ? srcCaptures[n] : '';
              // Escape the captured value for use in regex (if searchmode is regexp)
              const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              pattern = pattern.replace(new RegExp(`@${n}`, 'g'), escaped);
          }
      }
    }

    try {
      const rx = new RegExp(pattern, flags);
      const found = rx.test(searchSurface);

      if (tk.negated) {
        if (found) { ok = false; break; }
      } else {
        if (!found) { ok = false; break; }
        // Highlights: always computed against plain text so the UI can
        // underline the correct characters. For tagged tokens, strip tags
        // first and rebuild a plain-text pattern.
        if (tokenHasTags) {
          const tkStripped = { ...tk, content: stripFormatTags(tk.content) };
          let plainPattern = buildPattern(tkStripped, searchmode, wholeword, dashloose);
          if (srcCaptures) {
            for (let n = 1; n <= 9; n++) {
              if (plainPattern.includes(`@${n}`)) {
                const val = (srcCaptures && srcCaptures[n]) ? srcCaptures[n] : '';
                const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                plainPattern = plainPattern.replace(new RegExp(`@${n}`, 'g'), escaped);
              }
            }
          }
          try {
            const rxH = new RegExp(plainPattern, flags);
            _collectHighlights(rxH, text, hl);
          } catch { /* ignore \u2014 token decided match, highlights are best-effort */ }
        } else {
          const rx2 = new RegExp(pattern, flags);
          _collectHighlights(rx2, text, hl);
        }
      }
    } catch { continue; }
  }

  return { matches: ok, highlights: hl };
  };
  if (_orGroups.length <= 1) return _evalGroup(raw);
  const _hlAll = [];
  let _any = false;
  for (const _g of _orGroups) {
    const _r = _evalGroup(_g);
    if (_r.matches) { _any = true; for (const h of _r.highlights) _hlAll.push(h); }
  }
  return { matches: _any, highlights: _hlAll };
}
