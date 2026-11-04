# UMBRA

**Unified Masking & Bilingual Review Assistant**: una herramienta web de revisión de traducciones
(EN/FR → ES) que complementa a COMeT sin formar parte de él. Se usa desde el navegador, publicada
con GitHub Pages: no se instala nada y los documentos no salen del ordenador.

1. **Enmascarar.** Sustituye cifras, organismos, órganos, nombres propios y cargos de documentos
   DOCX, PPTX o XLSX exportados de eLUNa por etiquetas coherentes entre original y traducción,
   por ejemplo `{la ORGANO2}`. Después exporta el documento censurado para usarlo con cualquier IA
   externa.
2. **Revisar.** Ocho módulos con IA, cada uno con su proveedor, su modelo y sus reglas:
   - ortografía y gramática;
   - fidelidad;
   - omisiones y adiciones;
   - estilo;
   - coherencia;
   - convenciones de la ONU;
   - verificador;
   - lectura en frío.

   Reglas y modelos se guardan en un archivo de sincronización, y el gasto de IA se registra igual
   que en COMeT.

Estado: **propuesta**. Todavía no hay código de la aplicación.

- Propuesta: [`docs/PROPUESTA.md`](docs/PROPUESTA.md)
- Maqueta visual: [`docs/maqueta.html`](docs/maqueta.html). Descárgala y ábrela con doble clic.
- Registro de cambios: [`VERSION.md`](VERSION.md)
