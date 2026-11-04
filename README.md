# UMBRA

**Unified Masking & Bilingual Review Assistant**: una herramienta de revisión de traducciones que
complementa a COMeT sin formar parte de él.

1. **Enmascarar.** Sustituye cifras, organismos, órganos, nombres propios y cargos por etiquetas
   coherentes entre original y traducción, por ejemplo `{ORGANO_2}`. Después exporta el documento
   censurado para usarlo con cualquier IA externa.
2. **Revisar.** Pasa el documento por módulos de revisión con IA: ortografía y gramática,
   fidelidad, omisiones y adiciones, estilo y coherencia. Cada módulo es independiente, tiene su
   propio proveedor y modelo, y admite reglas personalizadas.

Estado: **propuesta**. Todavía no hay código de la aplicación.

- Propuesta completa: [`docs/PROPUESTA.md`](docs/PROPUESTA.md)
- Maqueta visual: [`docs/maqueta.html`](docs/maqueta.html). Descárgala y ábrela con doble clic en
  el navegador.
- Registro de cambios: [`VERSION.md`](VERSION.md)
