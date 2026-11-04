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

   Cada uno se sustituye por una etiqueta: `{CARGO1}` en el original y `{el CARGO1}` en la
   traducción. El artículo de dentro de la llave indica el género y el número.

   La misma entidad lleva la misma etiqueta en las dos lenguas. Por eso, si una cifra no coincide,
   aparece como «Sin pareja».

   Después se puede exportar:
   - el documento censurado, en el mismo formato;
   - una tabla bilingüe;
   - el texto listo para pegar en una IA externa.
2. **Revisar.** Hay una Capa 0 que funciona sin IA y es gratis. Además, hay ocho módulos con IA:
   - ortografía y gramática;
   - fidelidad;
   - integridad (omisiones y adiciones);
   - estilo;
   - coherencia;
   - convenciones de la ONU;
   - lectura en frío;
   - verificador.

   Cada módulo tiene su propio proveedor, su modelo y sus reglas. Antes de gastar nada, UMBRA
   muestra el plan con su coste estimado.

   Además:
   - **Similitud semántica:** compara el sentido de cada oración del original con las de la
     traducción para encontrar omisiones y adiciones. Funciona en tu navegador, sin coste, o con un
     proveedor, con texto enmascarado.
   - **Modo diferido:** la primera pasada va a la API de lotes del proveedor (Gemini, Anthropic,
     Mistral u OpenAI). Cuesta la mitad y responde en minutos u horas.
3. **Exportar.** La traducción revisada sale así:
   - **DOCX:** con control de cambios para lo aceptado y comentarios de Word para lo demás.
   - **PPTX y XLSX:** con los cambios ya aplicados.

   Además, hay informes en HTML y Excel.

## Primeros pasos

1. Abre la dirección de arriba.
2. Ve a **Exportar y ajustes → Proveedores y modelos** y pega la clave de API de un proveedor
   (Gemini, Mistral, Azure OpenAI, Anthropic, o cualquiera compatible con OpenAI que añadas).
   Pulsa **Probar conexión**.
3. Arrastra el original y la traducción a las dos cajas de arriba.
4. **Paso 1 (Enmascarar):** revisa las entidades. Para enmascarar algo más, selecciona el texto y
   pulsa **Alt+E** (o clic derecho › Enmascarar la selección). Para quitar una etiqueta, haz clic derecho sobre ella.
5. **Paso 2 (Revisar):** elige los módulos y pulsa **Ejecutar seleccionados**. Revisa los hallazgos
   con los atajos de teclado:
   - **A** acepta;
   - **R** rechaza;
   - **E** edita;
   - **J** y **K** pasan al siguiente y al anterior.
6. **Paso 3 (Exportar y ajustes):** descarga la traducción revisada o un informe.

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
- [nspell](https://github.com/wooorm/nspell) (MIT).
- [transformers.js](https://github.com/huggingface/transformers.js) 3.7.6 (Apache 2.0), que descarga al usarse
  el modelo [paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2) (Apache 2.0).
- Diccionario español de Hunspell de [dictionary-es](https://github.com/wooorm/dictionaries) (GPL-3.0, LGPL-3.0 o MPL-1.1, a elegir; véase `app/data/hunspell/LICENSE.txt`).
- Partes del código proceden de COMeT (del mismo autor) y se indican en la cabecera de cada archivo.
