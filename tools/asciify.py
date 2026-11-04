#!/usr/bin/env python3
"""asciify.py - Enforce the ASCII-only rule on the published app (and tests).

  python3 -I tools/asciify.py           # convert every non-ASCII character in place
  python3 -I tools/asciify.py --check   # list offending files and exit 1 (CI / pre-commit)

Conversion by file type:
  .js / .mjs / .json -> \\uXXXX (surrogate pairs for characters beyond U+FFFF)
  .html              -> &#xXXXX; outside <script>; \\uXXXX inside <script> blocks
  .css               -> \\XXXXXX (CSS escape, 6 hex digits)
"""
import os
import re
import sys

ROOTS = ['app', 'tests']
EXTS = ('.js', '.mjs', '.json', '.html', '.css')
SKIP_DIRS = {'libs', 'node_modules', 'fixtures', 'out'}


def js_escape(text):
    out = []
    for ch in text:
        o = ord(ch)
        if o < 128:
            out.append(ch)
        elif o <= 0xFFFF:
            out.append('\\u%04x' % o)
        else:
            v = o - 0x10000
            out.append('\\u%04x\\u%04x' % (0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF)))
    return ''.join(out)


def html_escape(text):
    return ''.join(ch if ord(ch) < 128 else '&#x%X;' % ord(ch) for ch in text)


def css_escape(text):
    return ''.join(ch if ord(ch) < 128 else '\\%06X' % ord(ch) for ch in text)


def convert_html(text):
    parts = re.split(r'(<script\b[^>]*>.*?</script>)', text, flags=re.S | re.I)
    out = []
    for p in parts:
        if p.lower().startswith('<script'):
            out.append(js_escape(p))
        else:
            out.append(html_escape(p))
    return ''.join(out)


def files():
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for root in ROOTS:
        top = os.path.join(base, root)
        for dirpath, dirnames, filenames in os.walk(top):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for fn in filenames:
                if fn.endswith(EXTS):
                    yield os.path.join(dirpath, fn)


def main():
    check = '--check' in sys.argv
    bad = []
    for path in files():
        with open(path, encoding='utf-8') as f:
            text = f.read()
        if all(ord(c) < 128 for c in text):
            continue
        if check:
            n = sum(1 for c in text if ord(c) >= 128)
            bad.append('%s (%d)' % (path, n))
            continue
        if path.endswith('.html'):
            new = convert_html(text)
        elif path.endswith('.css'):
            new = css_escape(text)
        else:
            new = js_escape(text)
        with open(path, 'w', encoding='ascii') as f:
            f.write(new)
        print('asciified', path)
    if check:
        if bad:
            print('Non-ASCII characters found in:')
            print('\n'.join(bad))
            sys.exit(1)
        print('ASCII check OK')


if __name__ == '__main__':
    main()
