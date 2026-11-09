"""Fixtures for the official names test (python3 -I make_names_fixtures.py): invented sentences with a
name translated wrong (not recognised: "Sin pareja"), an English acronym left as it is, a name well
translated that UMBRA does not recognise, and an ordinary pair."""
import os
import docx

HERE = os.path.dirname(os.path.abspath(__file__))
EN = [
    "The Department of Economic and Social Affairs organized the meeting on water.",
    "UNTSO continued to observe the ceasefire in the area.",
    "The United Nations Volunteers programme sent twenty volunteers to the region.",
    "The Security Council met on the same day to discuss the report.",
]
ES = [
    "El Departamento de Economía y Asuntos Sociales organizó la reunión sobre el agua.",
    "El UNTSO siguió observando el alto el fuego en la zona.",
    "El programa de los Voluntarios de las Naciones Unidas envió a veinte voluntarios a la región.",
    "El Consejo de Seguridad se reunió el mismo día para examinar el informe.",
]
for rows, name in ((EN, "names_en.docx"), (ES, "names_es.docx")):
    d = docx.Document()
    for t in rows:
        d.add_paragraph(t)
    d.save(os.path.join(HERE, name))
# The final, reviewed version of the translation (for "Comparar con la version final").
FINAL = [
    "El Departamento de Asuntos Económicos y Sociales organizó la reunión sobre el agua.",
    "El UNTSO siguió observando el alto el fuego en la región.",
    "El programa de los Voluntarios de las Naciones Unidas envió a veinte voluntarios a la región.",
    "El Consejo de Seguridad se reunió, el mismo día, para examinar el informe.",
]
d = docx.Document()
for t in FINAL:
    d.add_paragraph(t)
d.save(os.path.join(HERE, "names_es_final.docx"))
print("ok")
