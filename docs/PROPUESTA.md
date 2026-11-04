# UMBRA: propuesta de proyecto

> **UMBRA** (*Unified Masking & Bilingual Review Assistant*) es una herramienta de revisión de
> traducciones que **complementa** a COMeT sin formar parte de él. Hace dos cosas:
>
> 1. **Enmascarar.** Sustituye cifras, organismos, órganos, nombres propios y cargos por etiquetas
>    distinguibles y exporta el documento ya censurado.
> 2. **Revisar.** Pasa el documento censurado por módulos de revisión con IA. Cada módulo es
>    independiente, tiene su propio proveedor y modelo, y admite reglas propias.

Estado: **propuesta para discutir**. Todavía no hay código.

Fecha: 2026-11-04. Referencia de COMeT consultada (solo lectura): `main` en `d6519fa`.

---

## 0. Resumen en diez puntos

1. **Nombre: UMBRA.** La *umbra* es la sombra más oscura de un eclipse. Es justo lo que hace la
   primera parte de la app: deja en sombra lo sensible. El nombre sigue la familia de COMeT y
   eLUNa (cometa y luna).
2. **Plataforma: una extensión de Chrome aparte**, con la misma tecnología que COMeT (Manifest V3,
   JavaScript sin compilación). Se instala con "Cargar descomprimida" y abre una ventana grande,
   como Final Check.
3. **COMeT no se toca.** Las piezas útiles de Final Check (lectura de DOCX, alineación,
   vista previa, exportación con control de cambios) se **copian** a UMBRA y se adaptan allí. No se
   importan desde COMeT: lo que se cambie en UMBRA nunca afecta a COMeT, y al revés.
4. **La privacidad es una regla del código.** Ningún texto sale del ordenador sin pasar antes por
   el enmascaramiento. Lo garantiza una única "puerta de salida" hacia la IA, que rechaza el texto
   sin enmascarar.
5. **Las mismas etiquetas en el original y en la traducción.** "Secretary-General" y "Secretario
   General" reciben la misma etiqueta, `{CARGO_3}`. Si en la traducción aparece `{NUM_8}` donde el
   original tiene `{NUM_7}`, eso ya es un error detectado **sin IA y sin gastar nada**.
6. **Lo local va primero y es gratis.** Todo lo que se puede comprobar con reglas fijas se hace
   en el ordenador: cifras, etiquetas, estructura, puntuación, glosario y paralelismo de listas.
   La IA solo recibe lo que de verdad necesita juicio.
7. **Cinco módulos mínimos más cuatro opcionales:** ortografía y gramática, fidelidad (errores de
   traducción), integridad (omisiones y adiciones), estilo, coherencia, y además terminología,
   convenciones de la ONU, verificador y lectura en frío. Cada uno se puede ejecutar solo.
8. **Proveedor y modelo por módulo**, como "Modelo por función" en COMeT, pero con todos los
   proveedores propios que el usuario quiera añadir.
9. **Un solo sistema de reglas personalizadas para todos los módulos.** Las reglas que se pueden
   comprobar sin IA se comprueban sin IA. Las de expresión solo viajan a la IA cuando su expresión
   aparece en el texto, igual que `selectRules` de COMeT.
10. **Tokens: se recorta la repetición, no la cobertura.** Todos los segmentos se revisan, pero:
    - se agrupan los módulos que necesitan la misma entrada;
    - se reaprovecha el prefijo fijo del prompt (caché);
    - un modelo barato criba y uno potente verifica;
    - la respuesta contiene solo los problemas, nunca el texto reescrito;
    - en una segunda pasada solo se revisa lo que ha cambiado.

    Con un documento de 10.000 palabras, la estimación orientativa es unas **3 veces menos tokens**
    en total y unas **9 veces menos tokens de salida**, que son los caros (detalle en el §10).

---

## 1. El nombre

**UMBRA** es la propuesta principal.

- Encaja con la familia astronómica (COMeT, eLUNa).
- Describe la primera función: poner en sombra.
- Como acrónimo inglés, *Unified Masking & Bilingual Review Assistant*, describe las dos partes.
- Es corto y no choca con nada de la ONU que yo conozca.

Alternativas, por si no convence:

| Nombre | Idea |
|---|---|
| **PARALLAX** | El paralaje es mirar lo mismo desde dos puntos: original y traducción. Hay herramientas de desarrollo con ese nombre. |
| **ECLIPSE** | Muy claro, pero choca con el entorno de programación Eclipse. |
| **ALBEDO** | La luz que refleja un astro: la traducción como reflejo del original. Más poético que descriptivo. |

El repositorio puede seguir llamándose `revmaster`. El nombre visible de la app sería UMBRA.

---

## 2. Principios de diseño

1. **Independiente de COMeT.** No lee ni escribe nada de COMeT, no le envía mensajes y COMeT no
   sabe que UMBRA existe. Las dos pueden estar instaladas a la vez sin interferir: cada extensión
   tiene su propio almacenamiento.
2. **Mismo aspecto que Final Check**, para que el usuario no tenga que aprender otra interfaz.
3. **Primero el ordenador, después la IA.** Si una comprobación se puede hacer con reglas fijas,
   no se paga a una IA para hacerla.
4. **Privacidad por defecto.** Enmascarar es obligatorio antes de usar una IA externa. Solo un
   proveedor marcado como "local o de confianza" (por ejemplo, un modelo en el propio ordenador)
   puede recibir texto sin enmascarar, y únicamente si el usuario lo activa a propósito.
5. **Módulos independientes.** Cada módulo se ejecuta solo, con su modelo y sus reglas.
   Ejecutarlos juntos solo permite ahorrar, nunca es obligatorio.
6. **Coste visible antes y después.** Antes de cada ejecución, la app muestra el plan: cuántas
   llamadas hará, cuántos tokens estima y cuánto costará. Después registra lo realmente gastado,
   como hace la pantalla "Uso de IA" de COMeT.
7. **Mismas normas de trabajo que COMeT:** sin paso de compilación, solo ASCII en el código y en
   los textos de la interfaz (`\uXXXX`), textos de interfaz con mayúscula inicial, un cambio por PR
   y `VERSION.md` solo con añadidos.

---

## 3. Plataforma

| Opción | A favor | En contra | Veredicto |
|---|---|---|---|
| **Extensión de Chrome aparte (MV3)** | Misma tecnología y forma de instalar que COMeT. Puede llamar a cualquier API de IA sin problemas de CORS gracias a `host_permissions`. Permite copiar el código de Final Check casi tal cual. Sin compilación. | Solo Chrome/Edge. | **Recomendada** |
| Web local (PWA o archivo HTML) | Se abre en cualquier navegador. | Algunos proveedores de IA bloquean las llamadas desde una página web (CORS), y guardar claves y proyectos es más frágil. | Descartada por ahora |
| Aplicación de escritorio (Electron o Tauri) | Acceso total a archivos y a modelos locales. | Exige compilación y un instalador. El usuario no programa y el mantenimiento se complica. | Descartada |

**Cómo se abre:** al pulsar el icono de UMBRA en la barra de Chrome se abre una ventana de unos
1500 x 950 píxeles, como la de Final Check. No hace falta tener eLUNa abierto: UMBRA trabaja con
los archivos exportados.

---

## 4. Qué se aprovecha de COMeT (copiado, no importado)

Cada archivo copiado llevará en la cabecera esta línea: `Origen: COMeT <ruta> @ d6519fa`.
Así, si un arreglo de COMeT interesa también a UMBRA, se puede trasladar a mano sabiendo de dónde
viene. **En COMeT no se añade nada.**

| Pieza de COMeT | Qué hace | Uso en UMBRA |
|---|---|---|
| `modules/final-check/standalone.html` + `final-check-panel.html` (CSS) | Ventana, colores, barra superior, carril de iconos, lista de incidencias y dos hojas tipo Word | Base visual de toda la app |
| `modules/final-check/docx-model.js` (`parseDocxModel`, l. 1187) | Lee el DOCX: párrafos, *runs*, estilos, numeración, tablas, notas y comentarios | Lectura de los documentos |
| `modules/final-check/pptx-model.js` | Lee PPTX con la misma estructura | Fase posterior |
| `modules/final-check/align.js` (`alignModels`, l. 381) | Alinea original y traducción por párrafos con cifras, siglas y símbolos | Emparejar los segmentos que se revisan |
| `modules/final-check/preview-renderer.js` (`renderPreview`) | Dibuja el documento como en Word y resalta tramos | Vista de etiquetas y de hallazgos |
| `modules/final-check/export-docx.js` + `services/docx-track-changes.js` (`applyTrackedEdit`, l. 533) | Exporta parcheando el XML original, con control de cambios | DOCX enmascarado y DOCX con las correcciones aceptadas |
| `modules/final-check/export-verify.js` | Relee el archivo exportado para comprobar que no se ha roto nada | Mismo uso |
| `modules/final-check/checks.js` (`extractNumbers`, `_SYMBOL_RE` l. 298, fechas) | Cifras, símbolos de documentos de la ONU y fechas | Detectores para enmascarar y comprobaciones locales |
| `core/number-format-es.js`, `core/number-words.js` (`spelledNumberFacts`), `core/currency-es.js` (`findCurrencyAmounts`) | Cifras, números en letra y cantidades monetarias EN/ES | Normalizar el valor numérico, para que 1,250 y 1.250 reciban la misma etiqueta |
| `core/section-refs.js`, `core/subsection-marks-es.js`, `core/url-spans.js` | Referencias a secciones, marcas como "(a)" o "(ii)", URL | No enmascarar referencias internas por error y comprobar la estructura |
| `services/srx-segmenter.js` | Divide el texto en oraciones respetando abreviaturas | Segmentar por oraciones dentro de cada párrafo |
| `services/ai-providers/*.js` | Gemini, Azure OpenAI, Mistral y proveedores compatibles con OpenAI, con informe de uso (`onUsage`) | Base de los adaptadores de IA |
| `services/ai-service.js` (`AI_FEATURES`, proveedor por función) | Proveedor y modelo por función, con el general como reserva | Proveedor y modelo por módulo |
| `services/ai-rules.js` (`selectRules` l. 213, `rulesBlock`) | Reglas que solo viajan si su expresión aparece en el texto | Núcleo del sistema de reglas |
| `modules/qa-checker/powersearch-engine.js` | Patrones tipo Xbench: AND/OR/-, `[:digit:]`, capturas `@N` | Reglas deterministas, sin IA |
| `services/ai-usage.js` (`costOf` l. 202, precios de LiteLLM) | Registro de tokens y cálculo del coste | Medidor de coste |
| Patrón de lotes `[[n]]` … `[[END]]` (`buildFuzzyBatchPrompt`, `parseFuzzyBatchAnswer`) | Varios segmentos por llamada y detección de respuestas cortadas | Formato de los lotes |
| `utils/comet-dark.js`, `utils/ctrl-wheel-zoom.js` | Modo oscuro por inversión y Ctrl+rueda por zonas | Mismo comportamiento |

**Lo que no existe en COMeT y habrá que crear:** detectores de nombres propios, organismos,
órganos y cargos (COMeT no tiene ninguno), el enmascarador, los módulos de revisión, el editor de
reglas unificado y la exportación de comentarios de Word.

---

## 5. Flujo general

```
 DOCX original + DOCX traducción         (o PPTX; más adelante, XLIFF/TMX)
            |
            v
   [Lectura]  docx-model  ->  [Alineación]  align  ->  [Segmentación]  srx
            |
            v
   +----------------  PARTE 1: ENMASCARAR (todo local)  ----------------+
   | Detectores -> lista de entidades bilingüe -> revisión humana        |
   | -> texto enmascarado + MAPA DE CLAVES (nunca sale del ordenador)    |
   +-------+--------------------------------------------+---------------+
           |                                            |
           v                                            v
   [Exportar enmascarado]                    PARTE 2: REVISAR
    DOCX / tabla bilingüe /                    Capa 0  comprobaciones locales (gratis)
    texto con instrucciones                    Capa 1  cribado (modelo económico)
    para IA externa                            Capa 2  revisión a fondo (modelo potente)
           |                                   Capa 3  verificador (solo los hallazgos)
           v                                            |
   [Importar respuesta de                               v
    IA externa] -------------------------->  HALLAZGOS (mismo formato)
                                                        |
                                    revisión humana: aceptar / rechazar / editar
                                                        |
                                                        v
                     [Rehidratar etiquetas] -> DOCX con control de cambios y
                                               comentarios, informe HTML, Excel
```

---

## 6. Parte 1: Enmascarar

### 6.1 Qué se detecta y cómo (sin IA)

| Categoría | Etiqueta | Ejemplos | Cómo se detecta |
|---|---|---|---|
| Cifras | `NUM` | 1,250; 3.5%; three; 2030 | `extractNumbers`, `spelledNumberFacts` y `findCurrencyAmounts`, normalizando el **valor** |
| Fechas | `FECHA` | 12 March 2024 / 12 de marzo de 2024 | Detector de fechas de `checks.js` (meses EN/FR/ES) |
| Organismos | `ORG` | UNDP / PNUD, OHCHR / ACNUDH | Lista bilingüe de entidades de la ONU (siglas y nombres completos) y siglas en mayúsculas |
| Órganos | `ORGANO` | General Assembly / Asamblea General; Human Rights Council | Lista bilingüe de órganos principales y subsidiarios; secuencias en mayúscula con "Committee", "Council", "Commission"… |
| Países y territorios | `PAIS` | Bolivia (Plurinational State of) / Bolivia (Estado Plurinacional de) | Lista de Estados Miembros y observadores en EN/FR/ES, sacada de fuentes públicas de la ONU (UNTERM) |
| Lugares | `LUGAR` | Geneva / Ginebra | Lista bilingüe de ciudades sede y regiones y mayúsculas tras "in", "at" |
| Personas | `PER` | Mr. John Smith | Tratamientos (Mr., Ms., H.E., Ambassador, Dr.) seguidos de mayúsculas. Los nombres suelen coincidir en las dos lenguas |
| Cargos | `CARGO` | Secretary-General / Secretario General; Special Rapporteur on… / Relator Especial sobre… | Lista bilingüe de cargos y patrones como "Special Rapporteur on X" o "President of the X" |
| Símbolos de documentos | `SIMB` | A/RES/78/123, E/CN.6/2024/3 | `_SYMBOL_RE` de `checks.js` |
| URL y correos | `URL` | www.un.org | `url-spans.js` y una expresión regular para correos |
| Personalizada | `X` | Cualquier término sensible del proyecto | Lista del usuario |

Cada categoría se activa o desactiva por separado. Por ejemplo, se pueden dejar las cifras sin
enmascarar si no son sensibles en ese documento.

**Ayuda de IA opcional, solo con modelo local.** Para nombres raros que las listas no cubren se
puede activar un detector de entidades con un modelo que funcione **en el propio ordenador**
(Ollama, LM Studio o un modelo NER en el navegador con transformers.js). Nunca con una IA externa,
porque tendría que leer el texto sin censurar.

**Las listas aprenden.** Cada entidad que el usuario añade o corrige a mano entra en un
diccionario personal (original ↔ traducción, categoría y género). Ese diccionario se puede
exportar y compartir con un compañero.

### 6.2 Misma entidad, misma etiqueta, en las dos lenguas

Esta es la clave de la coherencia que pide el proyecto:

```
Original:    The Secretary-General informed the General Assembly that 1,250 staff...
Traducción:  El Secretario General informó a la Asamblea General de que 1.520 funcionarios...

Enmascarado:
Original:    The {CARGO_1} informed the {ORGANO_2} that {NUM_3} staff...
Traducción:  El {CARGO_1:m} informó a la {ORGANO_2:f} de que {NUM_4} funcionarios...
                                                          ^^^^^^^
            NUM_3 (1250) no aparece en la traducción y NUM_4 (1520) no aparece en el original.
            -> Hallazgo CRÍTICO, sin IA y sin coste.
```

- **Cifras:** la etiqueta depende del **valor**, no de cómo está escrita. "1,250", "1.250",
  "1 250" y "one thousand two hundred and fifty" son el mismo `NUM`.
- **Entidades:** la pareja se busca en el párrafo alineado mediante el diccionario bilingüe. Si no
  se encuentra, la entidad queda "sin pareja" y el usuario decide.
- **Una etiqueta por entidad en todo el documento:** `{ORGANO_2}` es siempre la Asamblea General.
  Si la misma entidad del original aparece en la traducción con dos formas distintas (por ejemplo,
  "Asamblea General" y "Asamblea"), la vista de entidades lo señala.

### 6.3 Formato de las etiquetas

| Opción | Ejemplo | Ventaja | Inconveniente |
|---|---|---|---|
| **Etiqueta con tipo y número** (recomendada) | `{ORGANO_2}` | Se distingue a simple vista, cuesta pocos tokens (unos 4 a 6) y permite comprobar la coherencia | La frase queda algo artificial |
| Seudónimo realista | "País Alfa", "Persona B" | El texto se lee natural | Se puede confundir con texto real y la coherencia se ve peor |
| Barra negra | `████` | Máxima opacidad, solo para leer a mano | Se pierde la coherencia y no sirve para revisar con IA |

**Recomendación:** llaves `{ }`, porque casi nunca aparecen en los documentos de la ONU. Los
corchetes `[ ]` sí aparecen, por ejemplo en los borradores, y `< >` choca con el HTML y el XML.
Los códigos van sin tildes (ASCII).

**Rasgo gramatical en la traducción.** En español, "la {ORGANO_2} decidió… reunida" solo se
puede revisar si se sabe que la entidad es femenina. Por eso la etiqueta del lado español lleva,
cuando se conoce, el género y el número: `:m`, `:f`, `:mp` o `:fp`. El diccionario bilingüe lo
sabe para órganos, organismos y cargos. Para las personas se deduce del tratamiento (Sr. o Sra.) o
lo indica el usuario. La comprobación de coherencia ignora este sufijo.

### 6.4 Revisión humana del enmascaramiento (pantalla "Enmascarar")

- **Las dos hojas de Final Check, lado a lado.** Cada tramo enmascarado se ve como una pastilla de
  color según su categoría, con el código visible (`ORG 2`) y una letra para quien no distinga
  bien los colores. Un botón de ojo alterna entre **Ver etiquetas** y **Ver original**, siempre
  en local.
- **Panel lateral "Entidades"** (en el lugar de la lista de incidencias de Final Check): una tabla
  con categoría, forma en el original, forma en la traducción, etiqueta, apariciones O/T y estado
  (`OK`, `Sin pareja`, `Formas distintas`, `Recuento distinto`). Tiene filtros por categoría como
  las burbujas de Final Check.
- **Acciones:**
  - seleccionar texto y pulsar `Alt+E` para enmascarar la selección;
  - quitar una entidad o todas sus apariciones;
  - fusionar dos entidades ("son la misma") o separarlas;
  - cambiar la categoría o el género;
  - enmascarar todas las apariciones de una forma.
- **Contador de coherencia** en la barra superior: "38 entidades · 2 sin pareja · 1 cifra
  distinta".

### 6.5 Mapa de claves

- La correspondencia etiqueta ↔ original se guarda **solo en el ordenador** (IndexedDB), dentro
  del proyecto.
- Se puede exportar aparte, en JSON y cifrado con contraseña (AES-GCM de WebCrypto), para seguir el
  trabajo en otro equipo. **Nunca** viaja dentro del documento enmascarado.
- Sirve para **rehidratar**: los hallazgos vuelven de la IA con etiquetas, y UMBRA los muestra y
  los aplica con los valores reales.

### 6.6 Exportaciones del enmascarado

1. **DOCX enmascarado**, del original y de la traducción, con el mismo formato. Se escribe
   parcheando el XML original, como la exportación de Final Check, y se verifica con
   `export-verify`.
2. **Tabla bilingüe enmascarada** en DOCX, XLSX o HTML (`id | original | traducción`). Es el
   formato ideal para subir a una IA externa.
3. **Texto listo para pegar.** El botón "Copiar para IA externa" pone en el portapapeles el texto
   enmascarado precedido de unas instrucciones: qué son las etiquetas, que no hay que tocarlas y en
   qué formato devolver los hallazgos (el mismo de §11).
4. **Importar respuesta de IA externa.** Se pega la respuesta de ChatGPT, Gemini u otra IA, y UMBRA
   la convierte en hallazgos que se revisan en la misma pantalla que los de sus propios módulos.
   Así, las IA externas y los módulos internos acaban en el mismo flujo.
5. **Proyecto `.umbra`**, un ZIP con los modelos, el mapa de claves cifrado y los hallazgos, para
   continuar otro día o en otro equipo.

### 6.7 La "puerta de salida" hacia la IA (garantía de privacidad)

Todas las llamadas a IA pasan por un único archivo, `ai/gateway.js`, que:

- **rechaza** cualquier texto que no venga del modelo enmascarado (cada lote lleva una marca
  interna que solo pone el enmascarador);
- solo deja pasar texto sin enmascarar hacia proveedores marcados como **locales o de confianza**,
  y solo si el usuario lo activa en ese proyecto;
- cuenta los tokens y el coste, y respeta el presupuesto máximo de cada ejecución.

**Aviso honesto:** enmascarar reduce el riesgo, pero no lo elimina. El contexto puede seguir
delatando de qué se habla. La pantalla lo recordará la primera vez.

---

## 7. Parte 2: Módulos de revisión

### 7.1 Qué es un módulo

Cada módulo es un archivo en `review/modules/` que declara:

```js
{
  id: 'fidelity',
  label: 'Fidelidad (errores de traducción)',
  input: 'bilingual',          // 'bilingual' | 'target' | 'skeleton'
  local: [checkFn, ...],       // comprobaciones sin IA (Capa 0)
  triage: true,                // admite cribado con modelo económico
  prompt: { system, rules },   // instrucciones fijas (prefijo que se aprovecha en caché)
  output: 'lines',             // formato compacto de §11
  categories: ['MIST', 'TERM', 'UNTR'],
  verify: true,                // sus hallazgos pueden pasar por el verificador
  mergeableWith: ['integrity'] // módulos con la misma entrada que se pueden fusionar
}
```

Cada módulo se puede **ejecutar solo** con el botón "Ejecutar" de su tarjeta, con su proveedor, su
modelo y sus reglas. Al pulsar "Ejecutar seleccionados", el planificador puede fusionar los que
comparten entrada y modelo para ahorrar (§7.4). Si el usuario lo prefiere, la fusión se desactiva.

### 7.2 Los cinco módulos mínimos

#### M1. Ortografía y gramática (solo la traducción)

- **Sin IA:**
  - diccionario español (Hunspell `es_ES` en el navegador) y diccionario personal;
  - palabras repetidas, espacios, signos de apertura (¿, ¡), comillas y paréntesis sin cerrar.
  Las etiquetas evitan los falsos positivos con nombres propios.
- **Con IA:** concordancia (aquí sirve el sufijo de género de las etiquetas), régimen
  preposicional, tiempos verbales, puntuación sintáctica y errores que un diccionario no ve
  ("haber/a ver", "sino/si no").
- **Entrada:** solo el texto español, sin el original. Cuesta la mitad que un módulo bilingüe.

#### M2. Fidelidad: errores de traducción (bilingüe)

- **Sin IA:** cifras y etiquetas (§6.2), segmentos sin traducir (idénticos al original), glosario
  obligatorio y términos prohibidos.
- **Con IA:** sentidos mal trasladados, falsos amigos, cambios de modalidad ("shall" / "should" →
  "deberá" / "debería"), negaciones invertidas, sujeto o agente cambiado, matices de grado
  ("urges" / "encourages" → "insta" / "alienta").
- **Exhaustividad:** se trabaja **segmento por segmento**, con identificador, nunca "busca errores
  en el documento". Al final del lote el modelo declara cuántos segmentos ha revisado, lo que
  permite detectar si se ha saltado alguno (§10).

#### M3. Integridad: omisiones y adiciones (bilingüe)

- **Sin IA (cribado gratis):**
  - proporción de longitud original/traducción fuera de lo normal para el par de lenguas, por
    ejemplo EN→ES de 1,1 a 1,35 en caracteres, calibrada con el propio documento;
  - etiquetas, cifras, paréntesis, incisos, elementos de lista y número de oraciones distintos;
  - párrafos y oraciones sin pareja (las comprobaciones `paragraphs` y `sentences` de Final Check).
- **Opcional, también sin coste de API:** similitud semántica entre oraciones con un modelo de
  *embeddings* multilingüe que funciona en el navegador. Las parejas con poca similitud se marcan
  como sospechosas.
- **Con IA:** cada pareja de oraciones se lee lado a lado buscando información que falta o sobra.
  Las parejas sospechosas van al modelo potente y el resto al económico.

#### M4. Estilo (solo la traducción, con el original opcional)

- **Sin IA:** reglas de estilo deterministas del usuario (patrones prohibidos y su forma
  preferida), anglicismos de una lista y longitud excesiva de oración.
- **Con IA:** calcos sintácticos, pasivas innecesarias, gerundios de posterioridad, nominalización
  excesiva, registro institucional, claridad y naturalidad, y las reglas de estilo del usuario.
- **Modo de entrada:** solo la traducción, que es lo más barato, o bilingüe si el usuario lo pide
  para ver los calcos con su origen.

#### M5. Coherencia (macro)

La mayor parte se hace **en local, sin coste**:

- **Etiquetas:** el mismo conjunto en original y traducción por segmento; la misma entidad
  traducida siempre igual.
- **Estructura:** el mismo número de elementos en listas, filas y columnas de tablas, niveles de
  título y notas (comprobaciones de Final Check).
- **Paralelismo gramatical.** Se agrupan los "hermanos" de una misma estructura: los elementos de
  una lista, las celdas de una columna, los títulos del mismo nivel y los párrafos de la parte
  dispositiva. De cada uno se clasifica el arranque:

  | Patrón | Ejemplo |
  |---|---|
  | `INF` | Fortalecer… |
  | `SUST` | Fortalecimiento… |
  | `GER` | Fortaleciendo… |
  | `PART` | Reconocida… |
  | `PREP` | Para / Con / En… |
  | `PRES` | Decide / Pide… |
  | `OTRO` | Otros arranques |

  Se usa un pequeño léxico español: terminaciones -ar/-er/-ir, -ción/-miento/-dad, -ando/-iendo y
  una lista de verbos frecuentes. Si un hermano rompe el patrón mayoritario, es un hallazgo. El
  mismo análisis sobre el original indica si la divergencia ya venía de allí.
- **Patrones de forma:** mayúsculas iniciales de los títulos, puntuación final de los elementos de
  lista (`;` o `.` o nada) y estilo de numeración.

**Solo va a la IA lo ambiguo.** Al modelo se le envía un **esqueleto** (§10.6), no el texto
entero: por ejemplo, un elemento que el léxico no sabe clasificar, o un patrón que difiere a
propósito porque el original también difiere. También la **coherencia terminológica** de los
términos que no están en el glosario: la misma expresión del original traducida de varias formas.
UMBRA agrupa localmente las traducciones de cada expresión repetida, y la IA solo dice si la
variación está justificada.

### 7.3 Módulos adicionales propuestos

| Módulo | Qué aporta | IA |
|---|---|---|
| **M6. Terminología** | Glosario del usuario, TBX o glosarios exportados: comprueba que, cuando aparece el término del original, se usa el de destino. La IA solo interviene para variantes flexionadas dudosas. | Mínima |
| **M7. Convenciones de la ONU** | Resoluciones: los párrafos del preámbulo empiezan por gerundio o adjetivo en cursiva (*Recordando*, *Reafirmando*) y los dispositivos por verbo en presente en cursiva (*Decide*, *Exhorta*). También fórmulas fijas, nombres oficiales de países (lista), formato de cifras y fechas en español (reutiliza `number-format-es.js`) y símbolos de documentos. | Casi nula |
| **M8. Verificador** | Un segundo modelo, potente, revisa **solo los hallazgos** de los demás módulos y descarta los falsos positivos. Es la forma más barata de ganar precisión. | Sí, pero poca entrada |
| **M9. Lectura en frío** | Lee la traducción como un lector que no conoce el original y señala las frases que no se entienden, son ambiguas o suenan a traducción. Complementa a Estilo. | Sí, solo español |
| *Tal vez:* M10. Consenso | Ejecuta Fidelidad con dos proveedores distintos y cruza los resultados: lo que ven los dos tiene alta confianza. Duplica el coste de ese módulo, así que solo conviene para documentos críticos. | Doble |

Además, una **"Capa 0" sin IA** reúne todas las comprobaciones locales: las de Final Check, las de
§6.2 y las reglas deterministas. Se ejecuta automáticamente, gratis, antes de cualquier módulo.

### 7.4 Propuesta de organización mejorada: capas y fusión

Para ser **exhaustiva y barata a la vez**, la revisión se organiza en **capas** además de en
módulos:

| Capa | Quién | Qué | Coste |
|---|---|---|---|
| 0. Local | El ordenador | Cifras, etiquetas, estructura, paralelismo, glosario, reglas deterministas, ortografía de diccionario y cribado de omisiones por longitud y similitud | 0 |
| 1. Cribado | Modelo económico, razonamiento mínimo | **Todos** los segmentos, con instrucción de "señalar ante la duda" (alta exhaustividad) | Bajo |
| 2. A fondo | Modelo potente | Solo los segmentos marcados por las capas 0 y 1, más los que el usuario elija | Medio, sobre pocos segmentos |
| 3. Verificación | Modelo potente | Solo los **hallazgos** (cita + contexto mínimo): confirma, corrige la sugerencia o descarta | Bajo |

**Fusión opcional por tipo de entrada.** Fidelidad (M2) e Integridad (M3) necesitan exactamente la
misma entrada (original + traducción). Si se ejecutan juntas y usan el mismo modelo, se hace **una
sola llamada por lote** con las dos instrucciones, y la entrada se paga una vez en lugar de dos.
Lo mismo vale para Ortografía y gramática (M1) y Estilo (M4) sobre el texto español. Cada hallazgo
sigue llevando su módulo de origen, así que en la lista se ven por separado. Si los módulos tienen
modelos distintos, no se fusionan.

---

## 8. Proveedores y modelos por módulo

Se parte del modelo de COMeT ("Modelo por función", `ai_feature_models`) y se amplía.

**Perfiles de proveedor, todos los que se quiera:**

```js
{
  id: 'p_openrouter_1',
  name: 'OpenRouter (personal)',
  adapter: 'openai-compatible',    // 'gemini' | 'anthropic' | 'azure-openai' | 'mistral' | 'openai-compatible'
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '...',                   // en chrome.storage.local; contraseña maestra opcional
  models: [ { id: 'deepseek/deepseek-chat', label: 'DeepSeek V3',
              price: { in: 0.27, cached: 0.07, out: 1.10 },   // US$ por millón (editable)
              context: 128000, json: true, caching: 'auto' } ],
  trust: 'external'                // 'external' | 'local' (solo 'local' puede ver texto sin enmascarar)
}
```

- **Adaptadores de serie:** Gemini, Mistral y Azure OpenAI (copiados de COMeT), más uno compatible
  con OpenAI. Este último sirve para OpenAI, OpenRouter, DeepSeek, Groq, xAI y modelos locales
  (Ollama, LM Studio, llama.cpp). Se añade también un adaptador de Anthropic.
- **"Probar conexión"** en cada perfil, como en COMeT.
- **Precios:** se rellenan solos desde la lista pública de LiteLLM, como hace `lookupPrices` en
  COMeT, y se pueden corregir a mano.

**Configuración de cada módulo** (pantalla "Módulos"):

| Campo | Ejemplo |
|---|---|
| Activado | Sí |
| Proveedor y modelo | `General` o un modelo concreto. Se pueden elegir dos: **cribado** (económico) y **a fondo** (potente) |
| Razonamiento | Mínimo, bajo o alto (como `thinking` en COMeT) |
| Tamaño de lote | Automático (por secciones, de 1.500 a 3.000 palabras) o manual |
| Ámbito | Todo, una selección, unas secciones o solo lo cambiado desde la última vez |
| Fusión | Permitir o no |
| Verificar hallazgos | Sí o no |
| Presupuesto máximo por ejecución | 0,50 US$ |
| Reglas | 7 activas (enlace al editor) |

Si el proveedor de un módulo no tiene clave, ese módulo usa el general y lo dice, como hace
`featureFallbacks` en COMeT.

---

## 9. Reglas personalizadas (todos los módulos)

Un **único editor** con un esquema común. Amplía el de COMeT (`ai-rules.js`) con lo que aporta
el QA Checker (`powersearch-engine.js`):

```js
{
  id, on: true,
  modules: ['style', 'grammar'],   // a qué módulos se aplica
  kind: 'expr' | 'forbid' | 'pattern' | 'style' | 'structure' | 'ignore',
  src: 'stakeholder*|interested part*',  // expresión del original ('*' = cualquier final; '|' = alternativas)
  es: 'partes interesadas',              // forma correcta en español
  avoid: 'actores',                      // forma que no se debe usar
  regex: null,                           // para 'pattern': patrón tipo PowerSearch (con @N)
  note: 'Uso consolidado en la AG.',     // explicación o ejemplo, breve
  severity: 'MAY',                       // CRI | MAY | MEN | SUG
  profile: ['Resoluciones AG']           // perfiles en los que está activa
}
```

| Tipo | Qué hace | ¿Va a la IA? |
|---|---|---|
| `expr` | Si el original dice X, la traducción debe decir Y | Primero se comprueba **en local**. A la IA solo va si aparece X y no se encuentra Y en una forma reconocible, para que juzgue variantes flexionadas |
| `forbid` | La forma Z no debe aparecer en la traducción | No. Es local y exacto |
| `pattern` | Patrón libre (regex o PowerSearch) sobre original y traducción | No |
| `style` | Instrucción libre ("Evitar la pasiva perifrástica") | Sí, siempre que el módulo esté activo. Conviene tener pocas y cortas |
| `structure` | Instrucción macro ("Los elementos de las listas con viñetas empiezan por sustantivo") | Local cuando se puede expresar como patrón de arranque (§7.2 M5); si no, a la IA en el esqueleto |
| `ignore` | "No señales X": falso positivo conocido | No. Filtra los hallazgos después |

- **Solo viaja lo relevante.** Igual que `selectRules` de COMeT, una regla de expresión solo entra
  en el prompt del lote donde aparece su expresión. Así, cien reglas de expresión no cuestan nada
  hasta que una importa.
- **Contador de coste de las reglas.** El editor muestra cuántos tokens añaden las reglas `style`
  a cada llamada, por ejemplo "Sus reglas de estilo añaden unos 420 tokens a cada lote", para que
  el usuario sepa lo que cuestan.
- **Perfiles:** juegos de reglas por tipo de documento ("Resoluciones AG", "Informes del SG",
  "Cartas"). Se elige el perfil al abrir el proyecto.
- **Aprender del rechazo.** Al rechazar un hallazgo como falso positivo, UMBRA ofrece "Crear regla
  para no volver a señalarlo" (`ignore`). Al aceptar uno editando la sugerencia, ofrece "Crear
  regla con esta corrección" (`expr` o `forbid`).
- **Importar y exportar** las reglas en JSON. Se pueden importar listas de comprobación de Xbench
  (`.xbckl`) como reglas `pattern`, reutilizando `parseXBCKL` del QA Checker.
- **Probar regla:** como el botón "Test" del QA Checker, aplica la regla al documento cargado y
  muestra las coincidencias.

---

## 10. Optimización de tokens sin perder exhaustividad

El principio es este: **cada segmento se revisa al menos una vez por una IA. Lo que se recorta es
la repetición y lo que el modelo escribe, no lo que mira.**

### 10.1 No pagar por lo que hace el ordenador
La Capa 0 resuelve sin IA las cifras, las etiquetas, la estructura, el glosario, las reglas
deterministas, la ortografía de diccionario y el paralelismo de listas. Esos hallazgos **no se
piden a la IA**, y en el prompt se le dice que no los busque, para que no los repita.

### 10.2 Salida mínima (lo más importante)
Los tokens de salida cuestan bastante más que los de entrada, a menudo varias veces más. Por eso:

- **Nunca** se pide el texto corregido entero, solo los problemas.
- Los segmentos correctos **no generan nada**.
- Se usa un formato de una línea por hallazgo, sin claves JSON repetidas (§11).
- La explicación se limita a unas 15 palabras.

### 10.3 Entrada sin repeticiones
- **Segmentos repetidos:** un mismo par original/traducción se revisa una vez y el resultado se
  copia a las demás apariciones.
- **Sin texto que traducir:** los segmentos que solo contienen cifras, símbolos o etiquetas no se
  envían.
- **Etiquetas:** "Office of the United Nations High Commissioner for Human Rights" pasa a ser
  `{ORG_5}`. El enmascaramiento, además de proteger, ahorra tokens.
- **Sin formato:** se envía texto plano con identificadores cortos (`12`), no HTML.

### 10.4 Prefijo fijo y caché
Cada llamada se ordena siempre así:

```
[FIJO]  instrucciones del módulo + reglas de estilo + resumen del documento (150 tokens)
[VARIABLE]  reglas de expresión de este lote + lote de segmentos
```

Lo primero es agrupar varios segmentos bajo **una sola copia** de las instrucciones. COMeT ya lo
comprobó en el informe Fuzzy (`fuzzy-batch.js`): cada llamada lleva unos 13.000 caracteres de
reglas, y agrupar los segmentos ahorra alrededor de un 80 % de caracteres (23 segmentos pasan de
23 llamadas a 3).

Además, la mayoría de proveedores (Gemini, OpenAI, Anthropic, DeepSeek…) cobran mucho menos por un
prefijo repetido que ya han visto hace poco. Unos lo hacen solos y otros cuando se marca. Con un
prefijo estable en todos los lotes de un módulo, se paga entero una vez y con descuento el resto.

### 10.5 Cascada de modelos: criba barata, verificación potente
- **Capa 1:** un modelo económico revisa **todos** los segmentos con instrucción de alta
  sensibilidad. Es preferible que sobre algo a que falte.
- **Capa 2:** el modelo potente revisa solo los segmentos señalados, normalmente una cuarta parte
  o menos.
- **Capa 3:** el verificador recibe solo los hallazgos (cita, sugerencia y la pareja de oraciones)
  y elimina los falsos positivos.

Así, la exhaustividad la da la criba y la precisión la da el verificador, pero el modelo caro solo
lee una fracción del texto.

### 10.6 Esqueleto para la coherencia macro
Para M5 no se envía el documento, sino algo así:

```
L3 (lista, 6 elementos, sección 2.1):
  1 INF  "Fortalecer la capacidad…"
  2 INF  "Promover la cooperación…"
  3 SUST "Elaboración de…"          <- distinto
  ...
  original: 1 INF 2 INF 3 INF ...
```

Basta con las primeras 5 a 8 palabras de cada hermano y la etiqueta de patrón calculada en local.
Son cientos de tokens en lugar de decenas de miles.

### 10.7 Lotes de tamaño justo, con control de saltos
- Los lotes se cortan **por secciones**, de unas 1.500 a 3.000 palabras. Si son demasiado
  grandes, los modelos "se saltan" segmentos del medio y la revisión deja de ser exhaustiva. Si
  son demasiado pequeños, se paga demasiadas veces el prefijo.
- Cada lote termina con `FIN <n>`, el número de segmentos revisados. Si falta o no cuadra, el
  lote está cortado y **solo se reenvía la parte que falta**, como hace COMeT con `[[END]]`.
- Se añade el segmento anterior y el siguiente **solo como contexto**, marcados "no revisar".

### 10.8 Caché de resultados: solo se revisa lo que cambió
Cada resultado se guarda con una huella de (original, traducción, módulo, versión del prompt,
reglas, modelo). Al volver a ejecutar un módulo después de corregir, solo se envían los segmentos
cuya huella ha cambiado. En una segunda vuelta, el coste suele ser una fracción pequeña del
primero.

### 10.9 Modo diferido (lotes asíncronos)
Gemini, OpenAI, Anthropic y Mistral tienen APIs de "lotes" que devuelven el resultado en horas y
suelen costar **la mitad**. UMBRA puede ofrecer "Revisión diferida (−50 %)" para documentos largos
que no corren prisa. Esto es para una fase posterior.

### 10.10 Razonamiento a la medida
El razonamiento interno ("thinking") se cobra como salida. Por eso va en **mínimo** en el cribado
y en Ortografía, y en **bajo o alto** solo en Fidelidad a fondo y en el verificador. COMeT ya maneja
estos niveles en `gemini-provider.js`.

### 10.11 Estimación orientativa (10.000 palabras EN → ES)

Las cifras son aproximadas. UMBRA medirá las reales igual que la pantalla "Uso de IA" de COMeT.

Supuestos: original de unos 12.000 tokens y traducción de unos 16.000, ya enmascarados. Cinco
módulos.

| Enfoque | Entrada | Salida | Total |
|---|---|---|---|
| **Ingenuo:** cada módulo recibe el documento bilingüe completo y devuelve el texto corregido | ~150.000 | ~80.000 | **~230.000** |
| **UMBRA:** capa 0 local; M2+M3 fusionados con cribado y a fondo sobre el 25 %; M1+M4 fusionados sobre el español; M5 con esqueleto; verificador; repeticiones fuera; prefijo en caché | ~65.000 (gran parte con descuento de caché o en modelo económico) | ~9.000 | **~74.000** |

Resultado: unas **3 veces menos tokens en total** y unas **9 veces menos de salida**. Como la
mayor parte la procesa un modelo económico, el ahorro en **dinero** es mayor que el ahorro en
tokens. En la segunda vuelta, gracias a §10.8, el coste baja otra vez de forma drástica.

---

## 11. Hallazgos: formato, clasificación y revisión

### 11.1 Formato que devuelve la IA (compacto)
```
12 | OMI | MAY | y su anexo | ...el informe y su anexo | Falta "and its annex" del original.
15 | GRA | MEN | reunido | reunida | Concuerda con {ORGANO_2:f}.
FIN 34
```

Los campos son: `segmento | categoría | severidad | cita exacta de la traducción (vacía si es una
omisión) | sugerencia | motivo`.

- Es **el mismo formato** que se pide a una IA externa (§6.6), así que las dos fuentes se
  importan igual.
- Donde el proveedor admite "salida estructurada" (JSON con esquema), se puede usar como
  alternativa más robusta, al precio de algunos tokens más.

### 11.2 Clasificación
Se sigue una taxonomía tipo **MQM** (*Multidimensional Quality Metrics*, el estándar del sector):

- **Precisión:** `MIST` traducción errónea, `OMI` omisión, `ADD` adición, `UNTR` sin traducir.
- **Fluidez:** `ORT` ortografía, `GRA` gramática, `PUNT` puntuación.
- **Terminología:** `TERM`.
- **Estilo:** `EST`.
- **Coherencia:** `COH`.
- **Convenciones:** `CONV`.

Severidad:

| Código | Severidad | Color |
|---|---|---|
| `CRI` | Crítica | Rojo #dc2626, como los errores de Final Check |
| `MAY` | Mayor | Ámbar #d97706, como los avisos de Final Check |
| `MEN` | Menor | Azul |
| `SUG` | Sugerencia | Gris |

Con esto se puede dar, opcionalmente, una **puntuación de calidad** por documento.

### 11.3 Anclaje
La cita exacta se busca en el segmento, primero de forma literal y luego aproximada. Si no
aparece, el hallazgo se marca "sin ancla" y no se puede aplicar automáticamente, aunque se muestra.
Esto evita que un error de la IA acabe aplicado en el lugar equivocado.

### 11.4 Revisión humana
- **Lista de hallazgos** como la de incidencias de Final Check: burbujas de filtro por módulo,
  categoría y severidad, y tarjetas con el distintivo del módulo, la cita, la sugerencia como
  diferencia (tachado y subrayado) y el motivo.
- **Botones:** **Aceptar** (aplica la sugerencia), **Editar**, **Rechazar** (falso positivo, con
  la opción de crear una regla `ignore`) e **Ignorar**.
- **Atajos:** `J`/`K` para el siguiente y el anterior, `A` aceptar, `R` rechazar, `E` editar.
- Al pulsar una tarjeta, se desplazan las dos hojas y se centra el tramo, como hace `_selectIssue`
  en Final Check.
- **Vista de grupo** para la coherencia: muestra todos los hermanos de la lista con su patrón y
  resalta el distinto.

### 11.5 Exportación del resultado
- **DOCX de la traducción con control de cambios** para lo aceptado (reutiliza `applyTrackedEdit`)
  **y comentarios de Word** para lo no aplicado o para las notas. Esto último es nuevo: COMeT lee
  `comments.xml`, pero no lo escribe. Al traductor le basta abrirlo en Word.
- **Informe HTML** autocontenido (como `export-changes-html.js`) y **Excel** (con
  `xlsx.mini.min.js`, que COMeT ya incluye).
- **JSON** de hallazgos, para reimportarlos.

---

## 12. Diseño de la interfaz

Hay una **maqueta estática** en [`docs/maqueta.html`](maqueta.html): se abre con doble clic en el
navegador. Sus elementos principales son:

- **Misma estructura que Final Check:**
  - barra de cabecera;
  - barra superior con las dos zonas de carga ("1 · ORIGINAL" y "2 · TRADUCCIÓN");
  - carril de iconos a la izquierda;
  - lista lateral de 280 px;
  - dos hojas tipo Word.

  Se usan los mismos tokens de color (`--bg-app #F4F6F8`, `--primary #0277BD`, `--border
  #d1d5db`…), las mismas fuentes y el mismo modo oscuro por inversión.
- **Sugerencia de identidad propia:** todo igual excepto el color de la cabecera, que pasaría a
  añil (#3949AB) en lugar del azul cielo de COMeT (#3CA9E2). Así, con las dos ventanas abiertas, se
  distingue de un vistazo cuál es cuál. Es opcional.
- **Tres pasos en la cabecera:** `1 Enmascarar` → `2 Revisar` → `3 Exportar`, siempre visibles.
- **Carril de iconos:** Entidades, Hallazgos, Módulos, Reglas y Coste.
- **Tarjetas de módulo** (paso 2), como la cuadrícula de módulos del panel de COMeT. Cada tarjeta
  muestra:
  - nombre y una línea de descripción;
  - icono del tipo de entrada (⇄ bilingüe, ¶ solo español, ⌗ esqueleto);
  - pastilla con el modelo, que se cambia con un clic;
  - número de reglas activas;
  - **estimación previa** de tokens y coste;
  - botón **Ejecutar**;
  - progreso por lotes y número de hallazgos.
- **Plan antes de gastar.** "Ejecutar seleccionados" muestra el resumen ("Se harán 14 llamadas ·
  unos 62.000 tokens · unos 0,09 US$") y pide confirmación.
- **Medidor de coste** en la cabecera: "Sesión: 48.210 tokens · 0,07 US$".
- **Accesibilidad:** cada categoría y cada severidad tiene color **y** letra o icono, nunca solo
  color.
- **Ctrl+rueda por zonas**, como en COMeT: la cabecera y las hojas por separado.

---

## 13. Estructura propuesta del repositorio

```
revmaster/
  manifest.json              Extensión MV3 "UMBRA"
  background.js              Abre la ventana al pulsar el icono
  app/                       Ventana principal (HTML, CSS y orquestador)
  core/                      Copias adaptadas de COMeT: docx-model, pptx-model, align,
                             preview-renderer, srx-segmenter, number-*, currency, section-refs
  redact/
    detectors/               numbers, dates, symbols, gazetteer, persons, titles, custom
    gazetteers/              JSON bilingües: países, órganos, organismos, cargos, lugares
    entity-store.js          Entidades del proyecto, fusión y separación, género
    masker.js                Enmascara los modelos y crea el mapa de claves
    rehydrate.js             Etiqueta -> valor real (hallazgos y exportación)
  review/
    modules/                 grammar, fidelity, integrity, style, coherence, terminology,
                             un-conventions, verifier, cold-read
    local-checks/            Capa 0
    planner.js               Lotes, fusión, caché de resultados, estimación de coste
    prompt-kit.js            Prefijo fijo + parte variable; reglas relevantes
    parse.js                 Formato de líneas, FIN <n>, anclaje
  ai/
    gateway.js               ÚNICA salida a la IA: privacidad, presupuesto, registro
    adapters/                gemini, mistral, azure-openai, openai-compatible, anthropic
    usage.js, pricing.js     Tokens y coste (a partir de ai-usage.js de COMeT)
  rules/                     Almacén, editor y prueba de reglas, importación de Xbench
  export/                    DOCX enmascarado, DOCX con cambios y comentarios, HTML, XLSX, .umbra
  settings/                  Proveedores, Módulos, Reglas, Diccionarios, Privacidad
  libs/                      jszip, xlsx (copias)
  utils/                     umbra-dark.js, ctrl-wheel-zoom.js (copias)
  docs/                      Esta propuesta y la maqueta
  CLAUDE.md                  Normas del proyecto para futuras sesiones (Fase 0)
  VERSION.md                 Registro de cambios, solo con añadidos
```

**Almacenamiento:**

- `chrome.storage.local`: ajustes, perfiles de proveedor, reglas y diccionarios personales.
- IndexedDB `umbraProjects`: documentos, mapas de claves, hallazgos y caché de resultados.

Ninguna clave coincide con las de COMeT. Aunque cada extensión tiene su propio almacenamiento, se
usa además el prefijo `umbra_` para que no haya confusión.

---

## 14. Hoja de ruta por fases (PR pequeños)

| Fase | Contenido | Resultado útil |
|---|---|---|
| **0. Esqueleto** | `manifest.json`, ventana con el diseño de Final Check, carga de los dos DOCX, alineación y vista previa (copiadas de COMeT), `CLAUDE.md` del proyecto | Ver los dos documentos lado a lado |
| **1. Enmascarar** | Detectores de cifras, fechas y símbolos → diccionarios bilingües (países, órganos, organismos, cargos) → personas → panel de Entidades → exportaciones (DOCX, tabla y "Copiar para IA externa") | **Ya útil por sí sola** con cualquier IA externa |
| **2. Primera revisión con IA** | `gateway.js`, perfiles de proveedor, adaptadores, Capa 0 y **un** módulo completo de punta a punta (Integridad, por ser el más medible), lista de hallazgos e importación de respuestas externas | Flujo completo con un módulo |
| **3. Resto de módulos** | M1, M2, M4 y M5 (con paralelismo local), reglas unificadas y editor | Los cinco mínimos |
| **4. Optimización** | Fusión, cascada, verificador, caché de resultados, estimación previa, presupuesto y razonamiento por módulo | Coste reducido |
| **5. Exportación final** | DOCX con control de cambios y comentarios, informe HTML y Excel, proyecto `.umbra` | Entrega al cliente o a Word |
| **6. Extras** | M6 a M9, *embeddings* locales, modo diferido (−50 %), PPTX, XLIFF/TMX | Más exhaustividad y menos coste |

---

## 15. Riesgos y decisiones que necesito del usuario

1. **Formatos de entrada.** ¿Trabajarás con los DOCX exportados de eLUNa (como Final Check), o
   también con XLIFF, TMX o tablas bilingües?
2. **Lenguas de origen.** ¿Solo EN y FR → ES, o también RU, AR o ZH? Esto cambia los diccionarios
   y los detectores de nombres.
3. **Proveedores permitidos.** ¿Qué IA puedes usar con documentos de la ONU, incluso enmascarados?
   ¿Hay algún modelo local o institucional (Azure de la ONU, por ejemplo)?
4. **Formato de etiqueta.** ¿Te sirve `{ORGANO_2:f}`, o prefieres seudónimos o algo más corto?
5. **Nombre.** ¿UMBRA te convence, o prefieres una de las alternativas?
6. **Color de cabecera.** ¿Idéntico a Final Check, o con su propio color para distinguirlo?
7. **Riesgo principal:** los detectores de nombres sin IA nunca serán perfectos. La revisión humana
   de la pantalla "Enmascarar" es imprescindible y por eso está diseñada para ser rápida: todas
   las apariciones de una vez, fusión y aprendizaje.
8. **Riesgo técnico:** el código de Final Check es grande (unas 14.500 líneas en `final-check.js`).
   Se copiarán **solo** las piezas de §4, no el módulo entero, para que UMBRA sea mantenible.
