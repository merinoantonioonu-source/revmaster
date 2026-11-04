#!/usr/bin/env python3
"""verify_outputs.py - Checks, from outside the browser, the files tests/formats.test.mjs wrote.

  python3 -I tests/verify_outputs.py tests/out [--libreoffice]

Opens every file with python-docx / python-pptx / openpyxl and inspects the raw XML:
masked text present, original text gone, numbers turned into strings, tracked changes and
Word comments (ids consistent between comments.xml and the anchors in document.xml, content
type override, relationship), calcChain removed when formulas were dropped, shared strings
cloned when two cells needed different results. With --libreoffice, every file is also
converted by LibreOffice (headless) to prove an office suite opens it.
Prints PASS/FAIL lines; exits 1 on any failure.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

import docx
import openpyxl
from pptx import Presentation

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
USE_LO = '--libreoffice' in sys.argv
FAILS = []
COUNT = [0]


def check(name, ok, detail=''):
    COUNT[0] += 1
    if ok:
        print('PASS py: ' + name)
    else:
        FAILS.append(name)
        print('FAIL py: ' + name + (': ' + str(detail) if detail else ''))


def strip_tags(text):
    return re.sub(r'\{[^{}]*\}', '', text)


def read(zpath, name):
    with zipfile.ZipFile(zpath) as z:
        return z.read(name).decode('utf-8') if name in z.namelist() else None


def names(zpath):
    with zipfile.ZipFile(zpath) as z:
        return z.namelist()


# ----------------------------------------------------------------------------
# DOCX
# ----------------------------------------------------------------------------

def docx_texts(path):
    d = docx.Document(path)
    out = [p.text for p in d.paragraphs]
    for t in d.tables:
        for row in t.rows:
            for cell in row.cells:
                out.append(cell.text)
    fn = read(path, 'word/footnotes.xml') or ''
    out.append(''.join(re.findall(r'<w:t(?:\s[^>]*)?>([^<]*)</w:t>', fn)))
    return out


def comment_ids(xml, tag):
    return re.findall(r'<w:%s\b[^>]*\bw:id="(\d+)"' % tag, xml)


def check_comments(path, label, expected):
    doc = read(path, 'word/document.xml')
    cxml = read(path, 'word/comments.xml')
    check(label + ': word/comments.xml exists', cxml is not None)
    if cxml is None:
        return []
    ids = comment_ids(cxml, 'comment')
    check(label + ': %d comment(s) in comments.xml' % expected, len(ids) == expected, ids)
    starts = comment_ids(doc, 'commentRangeStart')
    ends = comment_ids(doc, 'commentRangeEnd')
    refs = comment_ids(doc, 'commentReference')
    check(label + ': comment ids match the anchors', sorted(ids) == sorted(starts) == sorted(ends) == sorted(refs),
          (ids, starts, ends, refs))
    for cid in ids:
        s = doc.find('<w:commentRangeStart w:id="%s"/>' % cid)
        e = doc.find('<w:commentRangeEnd w:id="%s"/>' % cid)
        r = doc.find('<w:commentReference w:id="%s"/>' % cid)
        check(label + ': comment %s range is ordered (start < end < reference)' % cid, 0 <= s < e < r, (s, e, r))
    ct = read(path, '[Content_Types].xml')
    check(label + ': [Content_Types].xml has the comments override',
          re.search(r'<Override[^>]*PartName="/word/comments\.xml"[^>]*ContentType="application/vnd\.openxmlformats-'
                    r'officedocument\.wordprocessingml\.comments\+xml"', ct) is not None)
    rels = read(path, 'word/_rels/document.xml.rels')
    check(label + ': document.xml.rels has the comments relationship',
          'relationships/comments"' in rels and 'Target="comments.xml"' in rels)
    d = docx.Document(path)
    try:
        cms = list(d.comments)
        check(label + ': python-docx reads %d comment(s)' % expected, len(cms) == expected, len(cms))
        return [(c.author, c.text) for c in cms]
    except Exception as ex:  # older python-docx
        check(label + ': python-docx reads the comments', False, ex)
        return []


def verify_docx_masked(path):
    label = 'docx masked'
    texts = docx_texts(path)
    joined = '\n'.join(texts)
    check(label + ': opens with python-docx', bool(texts))
    check(label + ': masked tags present', '{la ORGANO2}' in joined and '{NUM1}' in joined)
    check(label + ': "Asamblea General" gone', 'Asamblea General' not in joined)
    check(label + ': no figure left outside the tags', not re.search(r'\d', strip_tags(joined)),
          re.findall(r'.{0,20}\d.{0,20}', strip_tags(joined))[:5])
    doc = read(path, 'word/document.xml')
    check(label + ': no tracked changes', '<w:ins ' not in doc and '<w:del ' not in doc)
    check(label + ': tab, break, note calls and non-breaking hyphen kept',
          doc.count('<w:tab/>') >= 3 and '<w:br/>' in doc and 'w:footnoteReference' in doc and
          '<w:noBreakHyphen/>' in doc and 'w:customMarkFollows="1"' in doc)
    # The split-word run "Asamblea Gen" + "eral": the tag sits in the bold run.
    m = re.search(r'<w:r>(?:(?!</w:r>).)*<w:b/>(?:(?!</w:r>).)*\{la ORGANO2\}', doc, re.S)
    check(label + ': replacement takes the formatting of the run where it starts', m is not None)


def verify_docx_tracked(path):
    label = 'docx tracked'
    d = docx.Document(path)
    check(label + ': opens with python-docx', len(d.paragraphs) > 0)
    doc = read(path, 'word/document.xml')
    check(label + ': w:ins present', '<w:ins ' in doc)
    check(label + ': w:del present', '<w:del ' in doc)
    check(label + ': author on revisions', 'w:author="UMBRA"' in doc)
    check(label + ': revision dates without milliseconds', 'w:date="2026-11-04T10:00:00Z"' in doc)
    fn = read(path, 'word/footnotes.xml')
    accepted = ''.join(re.findall(r'<w:t(?:\s[^>]*)?>([^<]*)</w:t>', re.sub(r'<w:del\b.*?</w:del>', '', fn, flags=re.S)))
    check(label + ': footnote edit tracked', '<w:ins ' in fn and '<w:del ' in fn and 'párrafo 12.' in accepted, accepted)
    cms = check_comments(path, label, 2)
    check(label + ': comment texts and authors',
          ('UMBRA', 'Comprobar el nombre del órgano.') in cms and ('Revisora Uno', 'Revisar la cifra total.') in cms, cms)
    # Quote anchor: the range covers exactly "Asamblea General" (split runs).
    cxml = read(path, 'word/comments.xml')
    first = comment_ids(cxml, 'comment')
    if first:
        cid = [c for c in first if re.search(r'<w:comment\b[^>]*w:id="%s"[^>]*>(?:(?!</w:comment>).)*Comprobar' % c, cxml, re.S)]
        if cid:
            s = doc.find('<w:commentRangeStart w:id="%s"/>' % cid[0])
            e = doc.find('<w:commentRangeEnd w:id="%s"/>' % cid[0])
            covered = ''.join(re.findall(r'<w:t(?:\s[^>]*)?>([^<]*)</w:t>', doc[s:e]))
            check(label + ': quote comment covers exactly the quote', covered == 'Asamblea General', covered)
    # Paragraph comment (quote not found): the range covers the whole "Total ..." paragraph.
    ids = comment_ids(cxml, 'comment')
    other = [c for c in ids if re.search(r'<w:comment\b[^>]*w:id="%s"[^>]*>(?:(?!</w:comment>).)*Revisar la cifra' % c, cxml, re.S)]
    if other:
        s = doc.find('<w:commentRangeStart w:id="%s"/>' % other[0])
        e = doc.find('<w:commentRangeEnd w:id="%s"/>' % other[0])
        covered = ''.join(re.findall(r'<w:t(?:\s[^>]*)?>([^<]*)</w:t>', doc[s:e]))
        check(label + ': paragraph comment covers the whole paragraph', covered == 'Total1.250funcionarios de la Asamblea General', covered)
    check(label + ': settings and styles untouched', read(path, 'word/styles.xml') is not None)


def verify_docx_direct(path):
    label = 'docx direct'
    d = docx.Document(path)
    texts = '\n'.join(p.text for p in d.paragraphs)
    check(label + ': correction present', 'acerca de 15 casos' in texts)
    doc = read(path, 'word/document.xml')
    check(label + ': no tracked changes', '<w:ins ' not in doc and '<w:del ' not in doc)
    cms = check_comments(path, label, 1)
    check(label + ': footnote comment text', bool(cms) and cms[0][1].startswith('[Nota '), cms)
    ids = comment_ids(read(path, 'word/comments.xml') or '', 'comment')
    if ids:
        m = re.search(r'<w:commentRangeStart w:id="%s"/><w:r>(?:(?!</w:r>).)*<w:footnoteReference w:id="2"/></w:r>'
                      r'<w:commentRangeEnd w:id="%s"/>' % (ids[0], ids[0]), doc, re.S)
        check(label + ': footnote comment anchored on the note call', m is not None)


def verify_docx_clean(path):
    label = 'docx clean mask'
    d = docx.Document(path)
    check(label + ': opens with python-docx', len(d.paragraphs) > 0)
    allxml = ''
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith('.xml') or n.endswith('.rels'):
                allxml += z.read(n).decode('utf-8', 'replace')
    doc = read(path, 'word/document.xml') + (read(path, 'word/footnotes.xml') or '')
    check(label + ': no revision markup left', not re.search(r'<w:(ins|del|moveFrom|moveTo|rPrChange)\b', doc))
    check(label + ': deleted text does not travel', 'fueron desplegados' not in allxml and 'Comisi\u00f3n aprob\u00f3 5' not in allxml)
    check(label + ': no comment anchors', not re.search(r'<w:comment(RangeStart|RangeEnd|Reference)\b', doc))
    check(label + ': no comments part, relationship or override',
          'word/comments.xml' not in names(path) and 'comments' not in read(path, 'word/_rels/document.xml.rels') and
          '/word/comments.xml' not in read(path, '[Content_Types].xml'))
    check(label + ': masked tags present', '{la ORGANO2}' in doc and '{NUM' in doc)


# ----------------------------------------------------------------------------
# PPTX
# ----------------------------------------------------------------------------

def pptx_texts(path):
    prs = Presentation(path)
    out = []
    for slide in prs.slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                for p in shape.text_frame.paragraphs:
                    out.append(''.join(r.text for r in p.runs) + '|' + p.text)
            if getattr(shape, 'has_table', False) and shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        out.append(cell.text)
    # Raw a:t text of the slides (fields included).
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if re.match(r'ppt/slides/slide\d+\.xml$', n):
                out.append(''.join(re.findall(r'<a:t>([^<]*)</a:t>', z.read(n).decode('utf-8'))))
    return out


def verify_pptx_masked(path):
    label = 'pptx masked'
    joined = '\n'.join(pptx_texts(path))
    check(label + ': opens with python-pptx', bool(joined))
    check(label + ': masked tags present', '{la ORGANO2}' in joined and '{NUM1}' in joined)
    check(label + ': "Asamblea General" gone', 'Asamblea General' not in joined)
    check(label + ': no figure left outside the tags', not re.search(r'\d', strip_tags(joined)),
          re.findall(r'.{0,20}\d.{0,20}', strip_tags(joined))[:5])
    s2 = read(path, 'ppt/slides/slide2.xml')
    check(label + ': line break and field kept', '<a:br' in s2 and '<a:fld ' in s2)


def verify_pptx_corrected(path):
    joined = '\n'.join(pptx_texts(path))
    check('pptx corrected: corrections present', 'alcanzó a' in joined and 'celebró' in joined)
    check('pptx corrected: old text gone', 'llegó a' not in joined and 'beneplácito' not in joined)


# ----------------------------------------------------------------------------
# XLSX
# ----------------------------------------------------------------------------

def xlsx_cells(path):
    wb = openpyxl.load_workbook(path)
    out = {}
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                if c.value is not None:
                    out[(ws.title, c.coordinate)] = c.value
    return out


def verify_xlsx_masked(path):
    label = 'xlsx masked'
    cells = xlsx_cells(path)
    check(label + ': opens with openpyxl', bool(cells))
    values = [v for v in cells.values()]
    joined = '\n'.join(str(v) for v in values)
    check(label + ': masked tags present', '{la ORGANO2}' in joined and '{NUM1}' in joined)
    check(label + ': "Asamblea General" gone', 'Asamblea General' not in joined)
    check(label + ': no figure left outside the tags', not re.search(r'\d', strip_tags(joined)),
          re.findall(r'.{0,20}\d.{0,20}', strip_tags(joined))[:5])
    numeric = [('Resumen', 'B3'), ('Resumen', 'C3'), ('Resumen', 'B4'), ('Resumen', 'C4'), ('Resumen', 'B6'),
               ('Detalles', 'B1')]
    check(label + ': numeric cells became strings', all(isinstance(cells.get(k), str) for k in numeric),
          {k: cells.get(k) for k in numeric})
    check(label + ': no formula left in the masked cells', not any(str(v).startswith('=') for v in values))
    check(label + ': calcChain removed (part, relationship, content type)',
          'xl/calcChain.xml' not in names(path) and 'calcChain' not in read(path, 'xl/_rels/workbook.xml.rels') and
          'calcChain' not in read(path, '[Content_Types].xml'))
    sst = read(path, 'xl/sharedStrings.xml')
    check(label + ': shared string edited in place (used by two cells, same edit)',
          sst.count('{la ORGANO2}</t></si>') >= 1 and re.search(r'uniqueCount="11"', sst) is not None)
    s1 = read(path, 'xl/worksheets/sheet1.xml')
    check(label + ': merged header kept', '<mergeCell ref="A1:C1"/>' in s1)
    wb = openpyxl.load_workbook(path, rich_text=True)
    a7 = wb['Resumen']['A7'].value
    check(label + ': rich text runs kept (bold run holds the tag)', hasattr(a7, '__iter__') and
          any(getattr(b, 'font', None) is not None and getattr(b.font, 'b', False) and '{la ORGANO2}' in b.text
              for b in a7 if not isinstance(b, str)), repr(a7))


def verify_xlsx_corrected(path):
    label = 'xlsx corrected'
    cells = xlsx_cells(path)
    check(label + ': edited cell', cells.get(('Resumen', 'B5')) == 'Asamblea General (AG)', cells.get(('Resumen', 'B5')))
    check(label + ': other user of the shared string unchanged', cells.get(('Detalles', 'A1')) == 'Asamblea General')
    check(label + ': formula string result rewritten as text', cells.get(('Resumen', 'C5')) == 'Año 2025',
          cells.get(('Resumen', 'C5')))
    sst = read(path, 'xl/sharedStrings.xml')
    check(label + ': shared string cloned (uniqueCount + 1)', 'uniqueCount="12"' in sst, re.findall(r'uniqueCount="\d+"', sst))
    check(label + ': calcChain removed', 'xl/calcChain.xml' not in names(path))
    check(label + ': shared formula untouched', '<f t="shared" ref="C3:C4" si="0">' in read(path, 'xl/worksheets/sheet1.xml'))


def verify_xlsx_partial(path):
    label = 'xlsx partial'
    cells = xlsx_cells(path)
    check(label + ': second user of the shared string masked', cells.get(('Detalles', 'A1')) == '{la ORGANO2}')
    check(label + ': first user unchanged', cells.get(('Resumen', 'B5')) == 'Asamblea General')
    check(label + ': master formula cell masked', cells.get(('Resumen', 'C3')) == '{NUM9}', cells.get(('Resumen', 'C3')))
    check(label + ': dependent of the dropped shared formula keeps its value', cells.get(('Resumen', 'C4')) == 7,
          cells.get(('Resumen', 'C4')))
    check(label + ': other numbers untouched', cells.get(('Resumen', 'B3')) == 1250 and cells.get(('Resumen', 'B4')) == 3.5)
    check(label + ': formula string untouched', str(cells.get(('Resumen', 'C5'))).startswith('=CONCATENATE'))
    check(label + ': calcChain removed', 'xl/calcChain.xml' not in names(path))


# ----------------------------------------------------------------------------
# LibreOffice (optional)
# ----------------------------------------------------------------------------

def libreoffice(paths):
    soffice = shutil.which('soffice') or shutil.which('libreoffice')
    if not soffice:
        check('libreoffice available', False, 'soffice not found')
        return
    with tempfile.TemporaryDirectory() as tmp:
        for p in paths:
            ext = p.rsplit('.', 1)[-1]
            target = {'docx': 'txt:Text', 'pptx': 'pdf', 'xlsx': 'csv'}[ext]
            r = subprocess.run([soffice, '--headless', '-env:UserInstallation=file://' + tmp + '/profile',
                                '--convert-to', target, '--outdir', tmp, p],
                               capture_output=True, text=True, timeout=180)
            base = os.path.splitext(os.path.basename(p))[0]
            out = os.path.join(tmp, base + '.' + target.split(':')[0])
            ok = r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0
            check('libreoffice opens ' + os.path.basename(p), ok, r.stderr[-300:])


def main():
    files = json.load(open(os.path.join(OUT, 'files.json')))
    p = lambda k: os.path.join(OUT, files[k])
    verify_docx_masked(p('docx_masked'))
    verify_docx_tracked(p('docx_tracked'))
    verify_docx_direct(p('docx_direct'))
    verify_docx_clean(p('docx_clean'))
    verify_pptx_masked(p('pptx_masked'))
    verify_pptx_corrected(p('pptx_corrected'))
    verify_xlsx_masked(p('xlsx_masked'))
    verify_xlsx_corrected(p('xlsx_corrected'))
    verify_xlsx_partial(p('xlsx_partial'))
    if USE_LO:
        libreoffice([p(k) for k in files])
    print('%s: %d/%d python checks passed' % ('FAIL' if FAILS else 'PASS', COUNT[0] - len(FAILS), COUNT[0]))
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
