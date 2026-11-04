#!/usr/bin/env python3
"""make_fixtures.py - Build the source/target fixture pairs of the formats tests.

  python3 -I tests/fixtures/make_fixtures.py

Writes, next to this script:
  doc_en.docx / doc_es.docx    heading with a custom-marked footnote (*), preambular paragraphs
                               with italic opening words, numbered operative paragraphs, a bulleted
                               list, a 2x3 table, a numbered footnote, a tab, a soft line break, a
                               paragraph split by a manual line break before "13.", runs that split
                               words, a non-breaking hyphen.
  deck_en.pptx / deck_es.pptx  3 slides, several text boxes, a table, a line break, a field.
  book_en.xlsx / book_es.xlsx  2 sheets: text, numbers (1250, 3.5, 2024), a shared formula (=B3*2),
                               a formula string, an inline string, rich text, a merged header,
                               a shared string used by two cells, and a calcChain part.

Requires python-docx, python-pptx and openpyxl.
"""
import io
import os
import re
import zipfile

import docx
from docx.enum.text import WD_BREAK
from pptx import Presentation
from pptx.util import Inches, Pt
import openpyxl
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont

HERE = os.path.dirname(os.path.abspath(__file__))

W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

TEXT = {
    'en': {
        'title': 'Report of the Secretary-General',
        'pre': [('Recalling', ' its resolution 77/123 of 12 December 2022,'),
                ('Noting with concern', ' the report of the General Assembly on 15 cases,')],
        'ops': [('Requests', ' the Secretary-General to submit a report to the General Assembly at its seventy-ninth session;'),
                ('Decides', ' to allocate 3.5 million dollars to the programme in 2025;'),
                ('Invites', ' Member States to contribute to the fund established in 2019;')],
        'bullets': ['Africa: 450 staff members', 'Asia and the Pacific: 300 staff members',
                    'Latin America: 500 staff members'],
        'table': [['Region', 'Staff', 'Year'], ['Africa', '1,250', '2024']],
        'tab': ['Total', '1,250', 'staff members of the General Assembly'],
        'soft': ['First line of the address', 'United Nations, New York 10017'],
        'split': ['12.\tThe General Assembly met 3 times.', '13.\tThe Committee adopted 5 decisions.'],
        'runs': [('The Secretary-General informed the ', ''), ('General Ass', 'b'), ('embly', 'i'),
                 (' that 1,2', ''), ('50', 'b'), (' staff of the Uni', ''),
                 ('ted Nations Development Programme', 'b'), (' were deployed in 2024.', '')],
        'fncall': 'The General Assembly adopted resolution 78/245 for the period 2023',
        'fncall2': '2024.',
        'fn1': ' Reissued for technical reasons on 3 March 2024.',
        'fn2': ' See resolution 78/245 of the General Assembly, para. 12.',
    },
    'es': {
        'title': 'Informe del Secretario General',
        'pre': [('Recordando', ' su resolución 77/123, de 12 de diciembre de 2022,'),
                ('Observando con preocupación', ' el informe de la Asamblea General sobre 15 casos,')],
        'ops': [('Solicita', ' al Secretario General que presente un informe a la Asamblea General en su septuagésimo noveno período de sesiones;'),
                ('Decide', ' asignar 3,5 millones de dólares al programa en 2025;'),
                ('Invita', ' a los Estados Miembros a que contribuyan al fondo establecido en 2019;')],
        'bullets': ['África: 450 funcionarios', 'Asia y el Pacífico: 300 funcionarios',
                    'América Latina: 500 funcionarios'],
        'table': [['Región', 'Personal', 'Año'], ['África', '1.250', '2024']],
        'tab': ['Total', '1.250', 'funcionarios de la Asamblea General'],
        'soft': ['Primera línea de la dirección', 'Naciones Unidas, Nueva York 10017'],
        'split': ['12.\tLa Asamblea General se reunió 3 veces.', '13.\tLa Comisión aprobó 5 decisiones.'],
        'runs': [('El Secretario General informó a la ', ''), ('Asamblea Gen', 'b'), ('eral', 'i'),
                 (' de que 1.2', ''), ('50', 'b'), (' funcionarios del Pro', ''),
                 ('grama de las Naciones Unidas para el Desarrollo', 'b'), (' fueron desplegados en 2024.', '')],
        'fncall': 'La Asamblea General aprobó la resolución 78/245 para el período 2023',
        'fncall2': '2024.',
        'fn1': ' Publicado nuevamente por razones técnicas el 3 de marzo de 2024.',
        'fn2': ' Véase la resolución 78/245 de la Asamblea General, párr. 12.',
    },
}


# ----------------------------------------------------------------------------
# DOCX
# ----------------------------------------------------------------------------

def _rewrite_zip(path, edits, additions):
    """Rewrite a zip: edits = {name: fn(text) -> text}; additions = {name: text}."""
    with zipfile.ZipFile(path) as z:
        items = [(i, z.read(i.filename)) for i in z.infolist()]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
        for info, data in items:
            if info.filename in edits:
                data = edits[info.filename](data.decode('utf-8')).encode('utf-8')
            out.writestr(info.filename, data)
        for name, text in additions.items():
            out.writestr(name, text.encode('utf-8'))
    with open(path, 'wb') as f:
        f.write(buf.getvalue())


def make_docx(lang):
    t = TEXT[lang]
    d = docx.Document()
    h = d.add_heading(t['title'], level=1)
    h.add_run('@@FN1@@')

    for first, rest in t['pre']:
        p = d.add_paragraph()
        r = p.add_run(first)
        r.italic = True
        p.add_run(rest)

    for first, rest in t['ops']:
        p = d.add_paragraph(style='List Number')
        r = p.add_run(first)
        r.italic = True
        p.add_run(rest)

    for b in t['bullets']:
        d.add_paragraph(b, style='List Bullet')

    table = d.add_table(rows=2, cols=3)
    table.style = 'Table Grid'
    for ri, row in enumerate(t['table']):
        for ci, val in enumerate(row):
            table.cell(ri, ci).text = val

    p = d.add_paragraph()
    p.add_run('\t'.join(t['tab']))

    p = d.add_paragraph()
    r = p.add_run(t['soft'][0])
    r.add_break(WD_BREAK.LINE)
    p.add_run(t['soft'][1])

    p = d.add_paragraph()
    r = p.add_run(t['split'][0])
    r.add_break(WD_BREAK.LINE)
    p.add_run(t['split'][1])

    p = d.add_paragraph()
    for text, fmt in t['runs']:
        r = p.add_run(text)
        if fmt == 'b':
            r.bold = True
        elif fmt == 'i':
            r.italic = True

    p = d.add_paragraph()
    p.add_run(t['fncall'] + '@@NBH@@' + t['fncall2'])
    p.add_run('@@FN2@@')

    path = os.path.join(HERE, 'doc_%s.docx' % lang)
    d.save(path)

    def fix_doc(xml):
        xml = xml.replace('<w:t>@@FN1@@</w:t>',
                          '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
                          '<w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>*</w:t>')
        xml = xml.replace('<w:t>@@FN2@@</w:t>',
                          '<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
                          '<w:footnoteReference w:id="2"/>')
        xml = xml.replace('@@NBH@@', '</w:t><w:noBreakHyphen/><w:t xml:space="preserve">')
        assert '@@' not in xml
        return xml

    def fix_rels(xml):
        rel = ('<Relationship Id="rIdFn1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
               'relationships/footnotes" Target="footnotes.xml"/>')
        return xml.replace('</Relationships>', rel + '</Relationships>')

    def fix_ct(xml):
        ov = ('<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-'
              'officedocument.wordprocessingml.footnotes+xml"/>')
        return xml.replace('</Types>', ov + '</Types>')

    def esc(s):
        return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    footnotes = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:footnotes xmlns:w="%s" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
        '<w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>*</w:t></w:r>'
        '<w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p></w:footnote>'
        '<w:footnote w:id="2"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>'
        '<w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p></w:footnote>'
        '</w:footnotes>' % (W_NS, esc(t['fn1']), esc(t['fn2'])))

    _rewrite_zip(path, {
        'word/document.xml': fix_doc,
        'word/_rels/document.xml.rels': fix_rels,
        '[Content_Types].xml': fix_ct,
    }, {'word/footnotes.xml': footnotes})
    return path


# ----------------------------------------------------------------------------
# PPTX
# ----------------------------------------------------------------------------

DECK = {
    'en': {
        's1': ('Report of the General Assembly', 'Session 2024: 1,250 participants'),
        's2_title': 'Main results',
        's2_box1': ['The programme reached 3.5 million people in 2024.', 'Funding grew by 12 per cent.'],
        's2_box2': [('The General Ass', True), ('embly welcomed the results', False)],
        's2_box3': ('First line', 'Second line with 2023 figures'),
        's2_fld': 'Page ',
        's3_title': 'Staff by region',
        's3_table': [['Region', 'Staff', 'Year'], ['Africa', '1,250', '2024'], ['Asia', '300', '2023']],
        's3_box': 'Source: United Nations Development Programme, 2024.',
    },
    'es': {
        's1': ('Informe de la Asamblea General', 'Período de sesiones 2024: 1.250 participantes'),
        's2_title': 'Resultados principales',
        's2_box1': ['El programa llegó a 3,5 millones de personas en 2024.', 'La financiación aumentó un 12 %.'],
        's2_box2': [('La Asamblea Gen', True), ('eral acogió con beneplácito los resultados', False)],
        's2_box3': ('Primera línea', 'Segunda línea con cifras de 2023'),
        's2_fld': 'Diapositiva ',
        's3_title': 'Personal por región',
        's3_table': [['Región', 'Personal', 'Año'], ['África', '1.250', '2024'], ['Asia', '300', '2023']],
        's3_box': 'Fuente: Programa de las Naciones Unidas para el Desarrollo, 2024.',
    },
}


def make_pptx(lang):
    t = DECK[lang]
    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[0])
    s1.shapes.title.text = t['s1'][0]
    s1.placeholders[1].text = t['s1'][1]

    s2 = prs.slides.add_slide(prs.slide_layouts[5])   # title only
    s2.shapes.title.text = t['s2_title']
    tb = s2.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(4), Inches(1.5))
    tf = tb.text_frame
    tf.text = t['s2_box1'][0]
    tf.add_paragraph().text = t['s2_box1'][1]
    tb2 = s2.shapes.add_textbox(Inches(5), Inches(1.5), Inches(4), Inches(1))
    p = tb2.text_frame.paragraphs[0]
    for text, bold in t['s2_box2']:
        r = p.add_run()
        r.text = text
        r.font.bold = bold
    tb3 = s2.shapes.add_textbox(Inches(0.5), Inches(3.5), Inches(4), Inches(1))
    p = tb3.text_frame.paragraphs[0]
    r = p.add_run()
    r.text = t['s2_box3'][0]
    p.add_line_break()
    r = p.add_run()
    r.text = t['s2_box3'][1]
    tb4 = s2.shapes.add_textbox(Inches(5), Inches(3.5), Inches(4), Inches(1))
    p = tb4.text_frame.paragraphs[0]
    r = p.add_run()
    r.text = t['s2_fld']
    # A slide-number field: <a:fld type="slidenum"><a:t>2</a:t></a:fld>
    from lxml import etree
    a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    fld = etree.SubElement(p._p, '{%s}fld' % a)
    fld.set('id', '{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}')
    fld.set('type', 'slidenum')
    rpr = etree.SubElement(fld, '{%s}rPr' % a)
    rpr.set('lang', 'en-US' if lang == 'en' else 'es-ES')
    ft = etree.SubElement(fld, '{%s}t' % a)
    ft.text = '2'

    s3 = prs.slides.add_slide(prs.slide_layouts[5])
    s3.shapes.title.text = t['s3_title']
    rows = t['s3_table']
    gf = s3.shapes.add_table(len(rows), 3, Inches(0.5), Inches(1.5), Inches(8), Inches(1.5))
    for ri, row in enumerate(rows):
        for ci, val in enumerate(row):
            gf.table.cell(ri, ci).text = val
    tb5 = s3.shapes.add_textbox(Inches(0.5), Inches(4), Inches(8), Inches(0.6))
    tb5.text_frame.text = t['s3_box']
    tb5.text_frame.paragraphs[0].runs[0].font.size = Pt(12)

    path = os.path.join(HERE, 'deck_%s.pptx' % lang)
    prs.save(path)
    return path


# ----------------------------------------------------------------------------
# XLSX
# ----------------------------------------------------------------------------

BOOK = {
    'en': {
        'header': 'Report of the General Assembly 2024',
        'cols': ['Region', 'Staff', 'Double'],
        'rows': [('Africa', 1250), ('Asia', 3.5)],
        'total': 'Total', 'ga': 'General Assembly', 'year_label': 'Year ',
        'inline': 'Inline note on the 2024 budget',
        'rich': ('General Assembly', ' of the United Nations'),
        'sheet2': 'Details', 'prog': 'Programme', 'undp': 'United Nations Development Programme',
    },
    'es': {
        'header': 'Informe de la Asamblea General 2024',
        'cols': ['Región', 'Personal', 'Doble'],
        'rows': [('África', 1250), ('Asia', 3.5)],
        'total': 'Total', 'ga': 'Asamblea General', 'year_label': 'Año ',
        'inline': 'Nota sobre el presupuesto de 2024',
        'rich': ('Asamblea General', ' de las Naciones Unidas'),
        'sheet2': 'Detalles', 'prog': 'Programa', 'undp': 'Programa de las Naciones Unidas para el Desarrollo',
    },
}


def make_xlsx(lang):
    t = BOOK[lang]
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Summary' if lang == 'en' else 'Resumen'
    ws['A1'] = t['header']
    ws.merge_cells('A1:C1')
    for ci, name in enumerate(t['cols']):
        ws.cell(row=2, column=ci + 1, value=name)
    ws['A3'], ws['B3'], ws['C3'] = t['rows'][0][0], t['rows'][0][1], '=B3*2'
    ws['A4'], ws['B4'], ws['C4'] = t['rows'][1][0], t['rows'][1][1], '=B4*2'
    ws['A5'], ws['B5'], ws['C5'] = t['total'], t['ga'], '=CONCATENATE("x",2024)'
    ws['A6'], ws['B6'] = 999999, 2024
    ws['A7'] = CellRichText([TextBlock(InlineFont(b=True), t['rich'][0]), t['rich'][1]])
    ws2 = wb.create_sheet(t['sheet2'])
    ws2['A1'], ws2['B1'] = t['ga'], 2024
    ws2['A2'], ws2['B2'] = t['prog'], t['undp']
    path = os.path.join(HERE, 'book_%s.xlsx' % lang)
    wb.save(path)

    def esc(s):
        return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    # openpyxl writes every string as an INLINE string; Excel (and eLUNa) use
    # the shared string table. Move them there (deduplicated, so the same
    # text in two cells shares one <si>), then add the special cells.
    sst = []
    sst_index = {}

    def to_shared(xml):
        def repl(m):
            body = m.group(2)
            if body not in sst_index:
                sst_index[body] = len(sst)
                sst.append(body)
            return '<c%s t="s"><v>%d</v></c>' % (m.group(1), sst_index[body])
        return re.sub(r'<c([^>]*?) t="inlineStr"><is>(.*?)</is></c>', repl, xml, flags=re.S)

    def set_cell(xml, ref, body, t_attr=None):
        m = re.search(r'<c r="%s"([^>]*?)(/>|>.*?</c>)' % ref, xml, re.S)
        assert m, ref
        attrs = re.sub(r'\st="[^"]*"', '', m.group(1))
        if t_attr:
            attrs += ' t="%s"' % t_attr
        return xml[:m.start()] + '<c r="%s"%s>%s</c>' % (ref, attrs, body) + xml[m.end():]

    with zipfile.ZipFile(path) as z:
        entries = [(i.filename, z.read(i.filename)) for i in z.infolist()]
    files = dict(entries)
    s1 = to_shared(files['xl/worksheets/sheet1.xml'].decode('utf-8'))
    s2 = to_shared(files['xl/worksheets/sheet2.xml'].decode('utf-8'))
    # A shared formula (master C3, dependent C4) with cached values.
    s1 = set_cell(s1, 'C3', '<f t="shared" ref="C3:C4" si="0">B3*2</f><v>2500</v>')
    s1 = set_cell(s1, 'C4', '<f t="shared" si="0"/><v>7</v>')
    # A formula string result.
    s1 = set_cell(s1, 'C5', '<f>CONCATENATE("%s",2024)</f><v>%s2024</v>' % (esc(t['year_label']), esc(t['year_label'])), 'str')
    # An inline string.
    s1 = set_cell(s1, 'A6', '<is><t>%s</t></is>' % esc(t['inline']), 'inlineStr')
    files['xl/worksheets/sheet1.xml'] = s1.encode('utf-8')
    files['xl/worksheets/sheet2.xml'] = s2.encode('utf-8')

    refs = len(re.findall(r't="s"', s1 + s2))
    files['xl/sharedStrings.xml'] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">'
        % (refs, len(sst)) + ''.join('<si>%s</si>' % b for b in sst) + '</sst>').encode('utf-8')
    files['xl/calcChain.xml'] = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<c r="C3" i="1"/><c r="C4"/><c r="C5"/></calcChain>').encode('utf-8')
    rels = files['xl/_rels/workbook.xml.rels'].decode('utf-8')
    rels = rels.replace('</Relationships>',
        '<Relationship Id="rIdSst1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        'relationships/sharedStrings" Target="sharedStrings.xml"/>'
        '<Relationship Id="rIdCc1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        'relationships/calcChain" Target="calcChain.xml"/></Relationships>')
    files['xl/_rels/workbook.xml.rels'] = rels.encode('utf-8')
    ct = files['[Content_Types].xml'].decode('utf-8')
    if '/xl/sharedStrings.xml' not in ct:
        ct = ct.replace('</Types>', '<Override PartName="/xl/sharedStrings.xml" ContentType="application/'
                        'vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
    ct = ct.replace('</Types>', '<Override PartName="/xl/calcChain.xml" ContentType="application/'
                    'vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>')
    files['[Content_Types].xml'] = ct.encode('utf-8')

    order = [n for n, _ in entries] + [n for n in ('xl/sharedStrings.xml', 'xl/calcChain.xml')
                                       if n not in dict(entries)]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
        for name in order:
            out.writestr(name, files[name])
    with open(path, 'wb') as f:
        f.write(buf.getvalue())
    return path


def main():
    for lang in ('en', 'es'):
        for fn in (make_docx, make_pptx, make_xlsx):
            print('wrote', os.path.relpath(fn(lang)))


if __name__ == '__main__':
    main()
