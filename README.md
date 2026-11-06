# UMBRA

**Unified Masking & Bilingual Review Assistant**: una herramienta web para revisar traducciones de
las Naciones Unidas (inglés o francés → español). Complementa a COMeT, pero no forma parte de él.

**Dirección:** https://merinoantonioonu-source.github.io/revmaster/

Se abre en Chrome o Edge y no hay que instalar nada. Los documentos se procesan en tu propio
navegador: no se suben a GitHub ni a ningún servidor. A una IA solo llega texto enmascarado.

## Qué hace

1. **Enmascarar.** Detecta en documentos DOCX, PPTX o XLSX exportados de eLUNa:
   - cifras;
   - fechas;
   - organismos y órganos;
   - países y lugares;
   - personas y cargos;
   - símbolos de documentos;
   - direcciones web y de correo.

   Cada uno se sustituye por una etiqueta, como `{CARGO1}`, que es la misma en el original y en la
   traducción. Al pasar el ratón por una etiqueta se ve lo que oculta.

   La misma entidad lleva la misma etiqueta en las dos lenguas. Por eso, si una cifra no coincide,
   aparece como «Sin pareja».

   Después se puede exportar:
   - el documento censurado, en el mismo formato;
   - una tabla bilingüe;
   - el texto listo para pegar en una IA externa.
2. **Revisar.** Una revisión de fondo, del contenido, hecha por IA como la haría un revisor humano.
   No repite lo que ya hacen el QA Checker y el Final Check de COMeT (cifras, ortografía, reglas fijas).
   Cada módulo es un revisor especializado que solo busca lo que le compete:
   - gramática (la ortografía la corrige Word);
   - fidelidad de sentido;
   - nombres oficiales (solo envía la lista de nombres de organismos, órganos, cargos, países y
     lugares, nunca el texto);
   - integridad (omisiones y adiciones);
   - estilo;
   - coherencia;
   - convenciones de la ONU;
   - lectura en frío;
   - verificador.

   Cada módulo tiene su propio proveedor, su modelo y su **exigencia** (solo lo importante, normal o
   exhaustiva). Antes de gastar nada, UMBRA muestra el plan con su coste estimado.

   Además:
   - **Navegación por oraciones, como en Final Check:** al pulsar una oración se resalta con su
     pareja en la otra hoja; al pulsar un hallazgo, las dos hojas van a su oración.
   - **Tabla de hallazgos** en una ventana aparte, y un **Excel para valorar** los hallazgos.
   - **Banco de pruebas:** un documento hecho con un informe de revisión real para medir cuántos
     errores detecta cada módulo y cuánto ruido mete (en Archivos, o en Más de Revisar y Corregir).
   - **Modo diferido:** la primera pasada va a la API de lotes del proveedor (Gemini, Anthropic,
     Mistral u OpenAI). Cuesta la mitad y responde en minutos u horas.
3. **Exportar.** La traducción revisada sale así:
   - **DOCX:** con control de cambios para lo aceptado y comentarios de Word para lo demás.
   - **PPTX y XLSX:** con los cambios ya aplicados.

   Además, hay informes en HTML y Excel.

## Primeros pasos

1. Abre la dirección de arriba.
2. Ve a **Ajustes y proveedores** (al pie de la barra de la izquierda) › **Proveedores y modelos** y
   pega la clave de API de un proveedor (Gemini, Mistral, Azure OpenAI, Anthropic, o cualquiera
   compatible con OpenAI que añadas). Pulsa **Probar conexión**.

La barra de la izquierda tiene los cinco pasos y dice en qué punto está cada uno:

1. **Archivos:** arrastra el original y la traducción a sus dos casillas.
2. **Enmascarar:** revisa las entidades. Para enmascarar algo más, selecciona el texto y pulsa
   **Alt+E** (o clic derecho › Enmascarar la selección). Para quitar una etiqueta, haz clic derecho
   sobre ella.
3. **Revisar:** marca los revisores (cada uno en su tarjeta, con su exigencia) y pulsa
   **Revisar ahora**.
4. **Corregir:** una fila por segmento con hallazgos (original y traducción lado a lado) y, a la
   derecha, el hallazgo elegido con su propuesta, que puedes cambiar. Atajos:
   - **A** acepta;
   - **R** rechaza;
   - **E** edita la propuesta;
   - **J** y **K** pasan al siguiente y al anterior.

   **Documento** muestra las dos hojas completas, con la navegación por oraciones de Final Check.
5. **Exportar:** descarga la traducción revisada, un informe o el proyecto (.umbra).

¿Dudas sobre algo? Junto a cada función hay un botón **?** que explica al momento cómo se usa, y
**F1** abre la ayuda de la pantalla (o del diálogo) en la que estés.

En **Sincronización** puedes guardar en un archivo (por ejemplo, en OneDrive):
- los proveedores y modelos;
- las reglas;
- las listas de entidades;
- el gasto de IA.

Es el mismo sistema que COMeT, pero con un archivo propio, `umbra-sync.json`.

## Para quien programe

- Normas del proyecto: [`CLAUDE.md`](CLAUDE.md).
- Arquitectura y contratos: [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).
- Diseño funcional: [`docs/PROPUESTA.md`](docs/PROPUESTA.md).
- Pruebas: `node tests/run-all.mjs`.
- Registro de cambios: [`VERSION.md`](VERSION.md).

La carpeta `app/` es lo único que se publica. GitHub Actions la publica en Pages cada vez que se
fusiona un cambio en `main`.

## Créditos de terceros

- [JSZip](https://stuk.github.io/jszip/) (MIT o GPLv3) y [SheetJS](https://sheetjs.com/) (Apache 2.0), copiados de COMeT.
- [transformers.js](https://github.com/huggingface/transformers.js) 3.7.6 (Apache 2.0), que descarga al usarse
  el modelo [paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) (Apache 2.0).
- Partes del código proceden de COMeT (del mismo autor) y se indican en la cabecera de cada archivo.
