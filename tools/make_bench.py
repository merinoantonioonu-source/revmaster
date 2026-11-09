#!/usr/bin/env python3
"""
make_bench.py - Builds UMBRA's test bench ("Banco de pruebas") from the owner's review report
(2026-11-05): a small EN/ES document pair with the errors a reviser found, and the list of what each
module is expected to find. The app loads it from app/data/calibration/.

    python3 -I tools/make_bench.py

Writes app/data/calibration/banco.json (ASCII), banco_en.docx and banco_es.docx.
Each paragraph: en, es and expect = [{ module, keys, what }]. A finding counts as a hit when it is
in that paragraph and its quote, suggestion or reason contains one of the keys (accents and case
ignored). Paragraphs without "expect" are correct: whatever is reported there is noise.
"""
import json
import os
import sys

import docx

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'app', 'data', 'calibration')

P = [
    {'en': 'UMBRA test bench', 'es': 'Banco de pruebas de UMBRA'},
    # ---- 1. Meaning (Fidelidad)
    {'en': 'The Council encouraged other Member States to support and inform efforts to implement the arms and oil embargoes.',
     'es': 'El Consejo alentó a otros Estados Miembros a que apoyaran los esfuerzos para aplicar los embargos de armas y petróleo e informaran sobre ellos.',
     'expect': [{'module': 'meaning', 'keys': ['informaran', 'informar sobre', 'informacion'], 'what': 'support and inform efforts: «efforts» es complemento de los dos verbos (aportar información para orientarlos), no «informaran sobre ellos».'}]},
    {'en': 'The Council received briefings on maritime enforcement actions undertaken further to relevant resolutions of the Council.',
     'es': 'El Consejo recibió exposiciones informativas sobre las medidas coercitivas marítimas adoptadas después de las resoluciones pertinentes del Consejo.',
     'expect': [{'module': 'meaning', 'keys': ['despues de', 'en virtud de', 'further to'], 'what': 'further to = «en virtud de», no «después de» (valor normativo, no temporal).'}]},
    {'en': 'Since the issuance in 2012 of a note by the President of the Security Council on the matter, the process for the appointment of Chairs and Vice-Chairs is conducted with the participation of all Council members.',
     'es': 'Desde 2012, año en que se emitió una nota de la Presidencia del Consejo de Seguridad sobre el particular, el proceso de nombramiento de las Presidencias y las Vicepresidencias se llevaba a cabo con la participación de todos los miembros del Consejo.',
     'expect': [{'module': 'meaning', 'keys': ['llevaba', 'se lleva'], 'what': 'is conducted (sigue vigente) ≠ «se llevaba a cabo» (sugiere que dejó de aplicarse).'}]},
    {'en': 'On 16 April, the Committee approved its report to the Council, in which the Committee stated that it had been unable to make a unanimous recommendation.',
     'es': 'El 16 de abril, el Comité aprobó el informe presentado al Consejo, en el que señaló que era incapaz de hacer una recomendación unánime.',
     'expect': [{'module': 'meaning', 'keys': ['presentado', 'su informe'], 'what': '«el informe presentado al Consejo» presupone que ya se había presentado: «su informe al Consejo».'},
                {'module': 'meaning', 'keys': ['incapaz', 'no habia podido'], 'what': 'unable ≠ «era incapaz» (connota incompetencia): «no había podido».'}]},
    {'en': 'The role of the Committee with regard to the disposal of items seized during the vessel inspections pursuant to resolution 2292 (2016) was further elaborated.',
     'es': 'Se explicó con mayor detalle la función del Comité en lo concerniente a la liquidación de los artículos confiscados durante las inspecciones de buques prevista en la resolución 2292 (2016).',
     'expect': [{'module': 'meaning', 'keys': ['prevista', 'realizadas'], 'what': '«prevista» concuerda con «la liquidación»; pursuant to modifica a las inspecciones: «realizadas en virtud de».'}]},
    {'en': 'More information on the work of the Monitoring Team can be found in its fifteenth report.',
     'es': 'Se podía encontrar más información sobre la labor del Equipo de Vigilancia en su 15.º informe.',
     'expect': [{'module': 'meaning', 'keys': ['podia', 'puede encontrarse', 'puede'], 'what': 'can be found (presente) ≠ «se podía encontrar».'}]},
    {'en': 'As in the case of the committees, the working groups were composed of all 15 members of the Council and meetings were held in private unless otherwise decided.',
     'es': 'Como en el caso de los comités, salvo decisión en contrario, los grupos de trabajo se formaron con representantes de los 15 miembros del Consejo y celebraron sus reuniones a puerta cerrada.',
     'expect': [{'module': 'meaning', 'keys': ['salvo decision', 'contrario'], 'what': '«salvo decisión en contrario» desplazado: modifica la composición en lugar del carácter privado de las reuniones.'},
                {'module': 'meaning', 'keys': ['se formaron', 'integrados', 'compuestos'], 'what': 'were composed of (composición) ≠ «se formaron» (creación).'}]},
    {'en': 'The Working Group was to consider practical measures to be imposed upon individuals, groups or entities involved in or associated with terrorist activities, other than those designated by the Committee established pursuant to resolution 1267 (1999), including more effective procedures considered to be appropriate.',
     'es': 'El Grupo de Trabajo debía examinar las medidas prácticas que se han de imponer contra las personas, los grupos y las entidades involucrados en actividades terroristas o asociados con ellas, además de las ya enunciadas por el Comité establecido en virtud de la resolución 1267 (1999), entre ellas establecer los procedimientos más eficaces que se consideren adecuados.',
     'expect': [{'module': 'meaning', 'keys': ['ademas de', 'salvo', 'enunciadas'], 'what': 'other than those designated = «salvo los designados» (personas, excluyente), no «además de las ya enunciadas» (medidas, aditivo).'},
                {'module': 'meaning', 'keys': ['los procedimientos mas eficaces', 'mas eficaces', 'comparativo', 'superlativo'], 'what': 'more effective procedures (comparativo) ≠ «los procedimientos más eficaces» (superlativo).'}]},
    {'en': 'The Council also addressed other aspects regarding the management, reporting and completion of functions of the Tribunal.',
     'es': 'El Consejo también se refirió a otros aspectos relacionados con la gestión, la presentación de informes y el desempeño de las funciones del Tribunal.',
     'expect': [{'module': 'meaning', 'keys': ['desempeno', 'conclusion', 'terminacion'], 'what': 'completion of functions = «conclusión de las funciones», no «desempeño».'}]},
    # ---- 2. Omissions (Integridad)
    {'en': 'The Council requested the Secretary-General to articulate clearly a range of options for financing the Mission, including, but not limited to, support by international partners.',
     'es': 'El Consejo solicitó al Secretario General que expusiera claramente una serie de opciones para la financiación de la Misión, por ejemplo, el apoyo de los asociados internacionales.',
     'expect': [{'module': 'meaning', 'keys': ['por ejemplo', 'sin caracter restrictivo', 'entre otros', 'not limited'], 'what': 'including, but not limited to ≠ «por ejemplo» (rebaja una inclusión obligatoria).'}]},
    {'en': 'The Council expressed its intention to convene a private (closed) meeting in October.',
     'es': 'El Consejo expresó su intención de convocar una reunión privada en octubre.',
     'expect': [{'module': 'meaning', 'keys': ['cerrada', 'closed'], 'what': 'Falta la aclaración entre paréntesis (closed): «(a puerta cerrada)».'}]},
    {'en': 'The Council requested the Secretary-General to enable the potential implementation of the framework established under resolution 2719 (2023) with regard to AUSSOM from 1 July 2025 from within existing resources made available by the rightsizing of UNSOS.',
     'es': 'El Consejo solicitó al Secretario General que hiciera posible implementar en la AUSSOM el marco establecido por la resolución 2719 (2023) a partir del 1 de julio de 2025 con los recursos que quedaran disponibles tras ajustar el tamaño de la UNSOS.',
     'expect': [{'module': 'meaning', 'keys': ['eventual', 'potential', 'posible implementacion'], 'what': 'Falta potential («eventual»).'},
                {'module': 'meaning', 'keys': ['existentes', 'existing'], 'what': 'Falta existing («existentes»).'}]},
    {'en': 'The Council requested them to report to the Security Council by 30 September 2025, including on an updated exit strategy for AUSSOM.',
     'es': 'El Consejo les solicitó que lo informaran a más tardar el 30 de septiembre de 2025, presentando una estrategia de salida actualizada para la AUSSOM.',
     'expect': [{'module': 'meaning', 'keys': ['presentando', 'en particular', 'incluida', 'including on'], 'what': 'including on restringido a «presentando»: el informe incluye la estrategia, no se limita a ella.'},
                {'module': 'writing', 'keys': ['lo informaran', 'le informaran', 'informaran al'], 'what': '«lo informaran» referido al Consejo: «informaran al Consejo de Seguridad».'}]},
    {'en': 'The Council amended the name of the Security Council Committee established pursuant to resolution 2127 (2013) concerning the Central African Republic to "Security Council Committee pursuant to resolution 2745 (2024)".',
     'es': 'El Consejo modificó el nombre del Comité del Consejo de Seguridad establecido en virtud de la resolución 2127 (2013) relativa a la República Centroafricana por "Comité dimanante de la resolución 2745 (2024)".',
     'expect': [{'module': 'meaning', 'keys': ['consejo de seguridad', 'security council'], 'what': 'En el nuevo nombre falta «del Consejo de Seguridad».'},
                {'module': 'writing', 'keys': ['modifico', 'cambio', 'por el de'], 'what': 'Régimen: no «modificar algo por», sino «cambiar algo por (el de)».'}]},
    {'en': 'Any such request would be subject to any extension to that period agreed upon by the Committee, and following any such lack of approval, the relevant State may submit an updated request.',
     'es': 'Con sujeción a cualquier prórroga de ese período que acordara el Comité, el Estado pertinente podría presentar una solicitud actualizada.',
     'expect': [{'module': 'meaning', 'keys': ['falta de aprobacion', 'lack of approval'], 'what': 'Falta el inciso and following any such lack of approval.'}]},
    {'en': 'The Council encouraged the Committee to consider, where and when appropriate, visits to selected countries.',
     'es': 'El Consejo alentó al Comité a que, cuando procediera, considerara la posibilidad de realizar visitas a determinados países.',
     'expect': [{'module': 'meaning', 'keys': ['donde', 'where'], 'what': 'Falta where: «donde y cuando procediera».'}]},
    # ---- 3. Additions (Integridad)
    {'en': 'The Council authorized inspections in order to ensure implementation of the arms embargo on the high seas off the coast of Libya.',
     'es': 'El Consejo autorizó inspecciones a fin de asegurar la estricta aplicación del embargo de armas en alta mar frente a las costas de Libia.',
     'expect': [{'module': 'meaning', 'keys': ['estricta'], 'what': 'Adición: «estricta» no está en el original.'}]},
    {'en': 'Other subsidiary bodies, including the Office of the Ombudsperson, the Counter-Terrorism Committee Executive Directorate and expert groups, are discussed together with the relevant committees.',
     'es': 'Asimismo, se examinan otros órganos subsidiarios, como la Oficina del Ómbudsman, la Dirección Ejecutiva del Comité contra el Terrorismo y algunos grupos de expertos, junto con los comités correspondientes.',
     'expect': [{'module': 'meaning', 'keys': ['algunos'], 'what': 'Adición: «algunos» restringe a una parte de los grupos de expertos.'}]},
    {'en': 'In 2024, the mandate of the Committee established pursuant to resolution 1591 (2005) remained unchanged.',
     'es': 'En 2024, el mandato del Comité establecido en virtud de la resolución 1591 (2005) se mantuvo en su mayor parte sin cambios.',
     'expect': [{'module': 'meaning', 'keys': ['en su mayor parte', 'mayor parte'], 'what': 'Adición: «en su mayor parte» sugiere cambios que no hubo.'}]},
    {'en': 'The report drew on a series of consultations with Member States, parts of the United Nations system and civil society representatives.',
     'es': 'El informe se basó en una serie de consultas con los Estados Miembros, las partes pertinentes del sistema de las Naciones Unidas y representantes de la sociedad civil.',
     'expect': [{'module': 'meaning', 'keys': ['pertinentes'], 'what': 'Adición: «pertinentes» no está en el original.'}]},
    # ---- 4. Official names (Nombres oficiales)
    {'en': 'The Council heard a briefing by the Assistant Secretary-General for Peacebuilding Support in the Departments of Political and Peacebuilding Affairs and Peace Operations.',
     'es': 'El Consejo escuchó una exposición informativa de la Subsecretaria General de Apoyo a la Consolidación de la Paz del Departamento de Asuntos Políticos y de Consolidación de la Paz y Operaciones de Paz.',
     'expect': [{'module': 'names', 'keys': ['departamentos', 'departamento', 'departments'], 'what': 'Departments (dos departamentos) fundidos en un «Departamento» inexistente.'}]},
    {'en': 'The Council established the United Nations Transitional Assistance Mission in Somalia.',
     'es': 'El Consejo estableció la Misión de Asistencia Transicional de las Naciones Unidas en Somalia.',
     'expect': [{'module': 'names', 'keys': ['transicional', 'de transicion'], 'what': 'Nombre oficial: «Misión de Asistencia de las Naciones Unidas de Transición en Somalia», sin «Transicional».'}]},
    # ---- 5. Grammar and syntax (Gramática)
    {'en': 'The Council requested the Secretary-General to provide integrated analyses to describe the impact of the mission, to facilitate the reassessment of the mandate and to continue informing it of progress, and to include information in the combined reports.',
     'es': 'El Consejo solicitó al Secretario General que le proporcionara análisis integrados para describir el impacto de la misión, facilitar la reevaluación del mandato y seguir comunicándole los progresos, e incluyera información en los informes combinados.',
     'expect': [{'module': 'writing', 'keys': ['incluyera', 'y que'], 'what': 'Paralelismo roto: «e incluyera» tras tres infinitivos, sin repetir «que».'}]},
    {'en': 'Make recommendations to the Council on possible measures to promote the protection of children affected by armed conflict, including recommendations on appropriate mandates.',
     'es': 'Hacer recomendaciones al Consejo sobre posibles medidas para promover la protección de los niños afectados por conflictos armados, que se refirieran también a los mandatos apropiados.',
     'expect': [{'module': 'writing', 'keys': ['refirieran', 'refieran'], 'what': 'Correlación de tiempos: «refirieran» rompe el presente de la serie («que se refieran»).'}]},
    {'en': 'He recalled in that regard that Article 52, paragraph 1, presumed the existence of regional arrangements.',
     'es': 'Recordó a ese respecto que en el Artículo 52, párrafo 1 se presumía la existencia de acuerdos regionales.',
     'expect': [{'module': 'writing', 'keys': ['parrafo 1,', 'coma'], 'what': 'Falta la coma que cierra el inciso: «en el Artículo 52, párrafo 1, se presumía».'}]},
    # ---- Correct paragraphs: whatever is reported here is noise
    {'en': 'The Committee held three informal consultations during the period under review.',
     'es': 'El Comité celebró tres consultas oficiosas durante el período que se examina.'},
    {'en': 'The Council extended the mandate of the Panel of Experts until 15 December 2025.',
     'es': 'El Consejo prorrogó el mandato del Grupo de Expertos hasta el 15 de diciembre de 2025.'},
    {'en': 'In a letter dated 10 May 2024, the Secretary-General informed the Council of his intention to appoint the members of the Group.',
     'es': 'En una carta de fecha 10 de mayo de 2024, el Secretario General informó al Consejo de su intención de nombrar a los miembros del Grupo.'},
    {'en': 'The Council decided to remain actively seized of the matter.',
     'es': 'El Consejo decidió seguir ocupándose activamente de la cuestión.'},
    {'en': 'The working groups met regularly and reported to the Council on their activities.',
     'es': 'Los grupos de trabajo se reunieron periódicamente e informaron al Consejo sobre sus actividades.'},
]


def main():
    os.makedirs(OUT, exist_ok=True)
    for lang in ('en', 'es'):
        d = docx.Document()
        for p in P:
            d.add_paragraph(p[lang])
        d.save(os.path.join(OUT, 'banco_' + lang + '.docx'))
    spec = {'kind': 'umbra-bench', 'version': 1, 'source': 'Informe de revisión del usuario (2026-11-05)',
            'paragraphs': [{'n': i + 1, 'es': p['es'], 'expect': p.get('expect', [])} for i, p in enumerate(P)]}
    with open(os.path.join(OUT, 'banco.json'), 'w', encoding='ascii') as f:
        json.dump(spec, f, ensure_ascii=True, indent=1)
    n = sum(len(p.get('expect', [])) for p in P)
    print('Banco: %d parrafos, %d errores esperados, %d parrafos correctos' % (len(P), n, sum(1 for p in P if not p.get('expect'))))


if __name__ == '__main__':
    sys.exit(main())
