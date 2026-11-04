"""Fixtures with DELIBERATE errors for the layer-0 test (python3 -I make_e2e_fixtures.py)."""
import os
import docx

HERE = os.path.dirname(os.path.abspath(__file__))

EN = [
    ("h", "Strengthening of the coordination of emergency humanitarian assistance"),
    ("pre", "Recalling its resolution 46/182 of 19 December 1991,"),
    ("op", "1.\tRequests the Secretary-General to submit to the General Assembly at its eightieth session a report on the implementation of the present resolution;"),
    ("op", "2.\tNotes that 1,250 staff members of the United Nations Development Programme were deployed in 2024;"),
    ("op", "3.\tEncourages Member States:"),
    ("li", "(a)\tTo strengthen national preparedness capacities;"),
    ("li", "(b)\tTo promote regional cooperation;"),
    ("li", "(c)\tTo develop early warning systems;"),
    ("li", "(d)\tTo support local communities;"),
    ("p", "The Committee met twice. It adopted its report. It also elected its officers."),
    ("p", "The meeting was attended by representatives of 25 Member States, including France and Brazil."),
    ("p", "This paragraph was left in English by mistake in the translation."),
]
ES = [
    ("h", "Fortalecimiento de la coordinación de la asistencia humanitaria de emergencia"),
    ("pre", "Recordando su resolución 46/182, de 19 de diciembre de 1991,"),
    ("op", "1.\tSolicita al Secretario General que presente a la Asamblea General en su octogésimo período de sesiones un informe sobre la aplicación de la presente resolución en base a los datos;"),
    ("op", "2.\tObserva que en 2024 se desplegaron 1.520 funcionarios del Programa de las Naciones Unidas para el Desarrollo;"),
    ("op", "3.\tAlienta a los Estados Miembros a:"),
    ("li", "a)\tFortalecer la capacidad nacional de preparación;"),
    ("li", "b)\tPromover la cooperación regional;"),
    ("li", "c)\tDesarrollo de sistemas de alerta temprana;"),
    ("li", "d)\tApoyar a las comunidades locales;"),
    ("p", "La Comisión se reunió dos veces."),
    ("p", "Asistieron a la sesión representantes de 25 Estados Miembros, entre ellos Francia y y el Brasil."),
    ("p", "This paragraph was left in English by mistake in the translation."),
]


def build(rows, path):
    d = docx.Document()
    for kind, text in rows:
        if kind == "h":
            d.add_heading(text, level=1)
            continue
        p = d.add_paragraph()
        if kind in ("pre", "op"):
            label = ""
            body = text
            if "\t" in text:
                label, body = text.split("\t", 1)
                p.add_run(label + "\t")
            first, rest = body.split(" ", 1)
            r = p.add_run(first)
            r.italic = True
            p.add_run(" " + rest)
        else:
            p.add_run(text)
    d.save(path)


build(EN, os.path.join(HERE, "e2e_en.docx"))
build(ES, os.path.join(HERE, "e2e_es.docx"))
print("ok")
