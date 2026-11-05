# UMBRA: propuesta de proyecto (v2)

> **UMBRA** (*Unified Masking & Bilingual Review Assistant*) es una herramienta de revisión de
> traducciones que **complementa** a COMeT sin formar parte de él. Es una **página web publicada
> con GitHub Pages**: se abre en el navegador, sin instalar nada. Hace dos cosas:
>
> 1. **Enmascarar.** Sustituye cifras, organismos, órganos, nombres propios y cargos por etiquetas
>    distinguibles y exporta el documento ya censurado.
> 2. **Revisar.** Pasa el documento censurado por módulos de revisión con IA. Cada módulo es
>    independiente, tiene su propio proveedor y modelo, y admite reglas propias.

Estado: **propuesta aprobada en lo esencial**. Todavía no hay código de la aplicación.

COMeT, consultado en modo de solo lectura: `main` en `04540f5` (2026-11-04).

---

## Estado de la implementación (versión 1, 2026-11-04)

Están hechas todas las fases, de la 0 a la 6. La fase 6 incluye:
- el corrector ortográfico local (Hunspell), retirado después (2026-11-05): la ortografía la corrige Word;
- el «puente» para proveedores sin CORS (campo `relayUrl`);
- la **similitud semántica**, en el navegador o con un proveedor;
- el **modo diferido** de lotes (−50 %) con Gemini, Anthropic, Mistral y OpenAI.

Los detalles técnicos están en `docs/ARQUITECTURA.md`, §9 y §10.

**Cambio de rumbo (2026-11-05):** la revisión es solo con IA y de fondo. Se retiraron las comprobaciones sin IA, las reglas y la similitud semántica, y las etiquetas ya no llevan artículo. Véase `docs/ARQUITECTURA.md`, §12.

## 0. Decisiones tomadas (2026-11-04)

| Tema | Decisión |
|---|---|
| Nombre | **UMBRA** |
| Plataforma | **Web en GitHub Pages**, a la que se accede desde el navegador. No es una extensión ni se descarga |
| Formatos | **DOCX, PPTX y XLSX** exportados de eLUNa (original y traducción) |
| Lenguas | **Inglés y francés → español** |
| Proveedores | Los mismos de COMeT (Gemini, Mistral, Azure OpenAI y compatible con OpenAI). El usuario puede **añadir proveedores y modelos sobre la marcha** |
| Etiquetas | **`{la ORGANO2}`, `{el CARGO1}`**: el artículo da el género y el número, y el número va pegado a la palabra |
| Módulos | Los cinco mínimos más **Convenciones de la ONU, Verificador y Lectura en frío**. **No** se hace el de Terminología |
| Reglas | Todas las reglas **de serie son editables**, además de las del usuario |
| Sincronización | Reglas, proveedores, modelos y demás ajustes van en un **archivo de sincronización copiado del de COMeT** |
| Gasto | **Seguimiento del gasto de IA** como en COMeT |
| Repositorio | Rama `main` creada |

---

## 1. Resumen

1. **UMBRA es una web** en `https://merinoantonioonu-source.github.io/revmaster/`. La dirección
   cambiaría a `…/umbra/` si se renombra el repositorio. Se abre en Chrome o Edge.
2. **Los documentos no salen del navegador.** GitHub Pages solo sirve el programa. Los DOCX, PPTX
   y XLSX se leen y se procesan en el propio ordenador y nunca se suben a GitHub.
3. **COMeT no se toca.** Las piezas útiles se **copian** a UMBRA: la lectura de documentos, la
   alineación, la vista previa, la exportación con control de cambios, la sincronización y el
   registro de gasto. Lo que cambie en una nunca afecta a la otra.
4. **La privacidad es una regla del código.** Ninguna IA recibe texto sin enmascarar. Una única
   "puerta de salida" lo comprueba.
5. **Mismas etiquetas en el original y en la traducción.** "Secretary-General" es `{CARGO1}` y
   "Secretario General" es `{el CARGO1}`. Si una cifra no coincide, sale un error **sin IA y gratis**.
6. **Lo que se puede comprobar con reglas fijas se comprueba en el ordenador.** La IA solo recibe
   lo que necesita juicio.
7. **Ocho módulos, cada uno ejecutable por separado:**
   - ortografía y gramática;
   - fidelidad;
   - integridad (omisiones y adiciones);
   - estilo;
   - coherencia;
   - convenciones de la ONU;
   - verificador;
   - lectura en frío.
8. **Proveedor y modelo por módulo.** Se pueden añadir proveedores y modelos en cualquier momento,
   incluso desde la tarjeta del propio módulo.
9. **Un solo sistema de reglas.** Las reglas de serie también se editan y se pueden restaurar.
10. **Ahorro de tokens sin revisar menos.** Para 10.000 palabras, una estimación hecha a mano da
    unas 3 veces menos tokens en total y unas 9 veces menos de salida, que son los caros (§11).

---

## 2. Principios de diseño

1. **Independiente de COMeT.** No lee ni escribe nada de COMeT, ni sus datos ni su archivo de
   sincronización. COMeT no sabe que UMBRA existe.
2. **Mismo aspecto que Final Check**, para no tener que aprender otra interfaz.
3. **Primero el ordenador, después la IA.**
4. **Privacidad por defecto.** Enmascarar es obligatorio antes de usar una IA externa.
5. **Módulos independientes.** Ejecutarlos juntos solo sirve para ahorrar, no es obligatorio.
6. **Coste visible antes y después:** un plan con la estimación antes de ejecutar y el registro de
   lo gastado después, como "Uso de IA" en COMeT.
7. **Mismas normas de trabajo que COMeT:**
   - sin paso de compilación;
   - solo ASCII en el código y en los textos de la interfaz (`\uXXXX`);
   - textos de interfaz con mayúscula inicial;
   - un cambio por PR;
   - `VERSION.md` solo con añadidos.

---

## 3. Plataforma: web en GitHub Pages

### 3.1 Cómo funciona
- El repositorio guarda el programa: HTML, CSS y JavaScript sin compilar, igual que COMeT.
- **GitHub Pages lo publica** como página web. Cada vez que se fusiona un PR en `main`, una
  pequeña automatización de GitHub (*GitHub Actions*) vuelve a publicar la web en uno o dos
  minutos. Se publica **solo la carpeta `app/`**, no la documentación ni la maqueta.
- Para usarla, se abre la dirección en Chrome o Edge. Conviene añadirla a favoritos.

### 3.2 Lo que hay que activar en GitHub (lo haces tú, una vez)
1. **El repositorio es privado.** En una cuenta gratuita de GitHub, Pages solo funciona con
   repositorios **públicos**; con privados hace falta **GitHub Pro**. Las opciones son:
   - **hacerlo público**: el código queda a la vista, pero no contiene ningún dato, clave ni
     documento;
   - **contratar Pro**.

   Aun con Pro, **la web publicada es accesible** para quien tenga la dirección. No es un problema,
   porque la web no guarda nada: tus datos viven en tu navegador y en tu archivo de sincronización.
2. **Settings → Pages → Source: "GitHub Actions".**
3. **Settings → General → Default branch: `main`.** Ahora mismo la rama por defecto es la de
   trabajo, porque fue la primera que se subió.

### 3.3 Qué cambia respecto a una extensión
| Tema | Extensión (COMeT) | Web (UMBRA) |
|---|---|---|
| Instalación | Descargar y "Cargar descomprimida" | Ninguna: abrir la dirección |
| Actualizaciones | Descargar el ZIP otra vez | Automáticas al fusionar el PR, más `Ctrl+Shift+R` en la página |
| Almacenamiento | `chrome.storage.local` | `localStorage` + IndexedDB del navegador, con un adaptador que imita a `chrome.storage` para poder copiar el código de COMeT casi tal cual |
| Archivo de sincronización | File System Access API | **La misma API**. Funciona igual en una web segura (https) de Chrome o Edge |
| Llamadas a la IA | Sin restricciones (permisos de la extensión) | El proveedor debe **aceptar llamadas desde páginas web** (CORS). Ver §3.4 |

**Detalle técnico importante:** todas las webs de GitHub Pages de una misma cuenta comparten el
mismo "origen" (`merinoantonioonu-source.github.io`) y, por tanto, el mismo almacenamiento del
navegador. Por eso todas las claves de UMBRA llevan el prefijo `umbra_`, y las claves de API
pueden protegerse con una contraseña maestra (cifrado AES-GCM de WebCrypto).

### 3.4 Proveedores y llamadas desde una web (CORS)
Comprobado el 2026-11-04 desde el entorno de esta sesión, simulando una llamada desde
`merinoantonioonu-source.github.io`:

| Proveedor | ¿Acepta llamadas desde la web? |
|---|---|
| **Google Gemini** | **Sí**. Responde con permiso explícito para el origen de GitHub Pages |
| **Anthropic (Claude)** | **Sí**. Exige una cabecera especial que el adaptador añadirá |
| Lista de precios (LiteLLM, la que usa COMeT) | **Sí** |
| Mistral, OpenAI, OpenRouter, DeepSeek, Groq | **Sin comprobar**: este entorno bloquea esas direcciones. Se comprobará en la Fase 2 con el botón "Probar conexión" |
| Azure OpenAI | Sin comprobar: depende de cada recurso de Azure |

**Si un proveedor rechaza las llamadas desde la web**, el botón "Probar conexión" lo dirá
claramente. Hay dos salidas:
- usar ese modelo a través de otro proveedor que sí las acepte;
- montar un pequeño "puente" propio y gratuito, por ejemplo un Cloudflare Worker de diez líneas.
  Solo le pasaría texto ya enmascarado.

---

## 4. Qué se aprovecha de COMeT (copiado, no importado)

Cada archivo copiado llevará en la cabecera la línea `Origen: COMeT <ruta> @ <commit>`, para poder
trasladar a mano los arreglos futuros. **En COMeT no se añade nada.**

| Pieza de COMeT | Qué hace | Uso en UMBRA |
|---|---|---|
| `modules/final-check/standalone.html` + `final-check-panel.html` (CSS) | Ventana, colores, barra superior, carril de iconos, lista de incidencias y dos hojas tipo Word | Base visual |
| `modules/final-check/docx-model.js` (`parseDocxModel`) | Lee el DOCX: párrafos, *runs*, estilos, numeración, tablas, notas y comentarios | Lectura de DOCX |
| `modules/final-check/pptx-model.js` | Lee PPTX con la misma estructura | Lectura de PPTX. La escritura es nueva |
| `modules/final-check/align.js` (`alignModels`) | Alinea original y traducción por párrafos | Emparejar segmentos |
| `modules/final-check/preview-renderer.js` (`renderPreview`) | Dibuja el documento como en Word | Vista de etiquetas y de hallazgos |
| `modules/final-check/export-docx.js` + `services/docx-track-changes.js` (`applyTrackedEdit`) | Exporta parcheando el XML original, con control de cambios | DOCX enmascarado y DOCX con las correcciones |
| `modules/final-check/export-verify.js` | Relee lo exportado para comprobar que no se ha roto nada | Mismo uso |
| `modules/final-check/checks.js` (`extractNumbers`, `_SYMBOL_RE`, fechas) | Cifras, símbolos de documentos de la ONU y fechas | Detectores y comprobaciones locales |
| `core/number-format-es.js`, `core/number-words.js`, `core/currency-es.js` | Cifras, números en letra y monedas EN/ES | Normalizar el valor de las cifras. **El francés hay que añadirlo** |
| `core/section-refs.js`, `core/subsection-marks-es.js`, `core/url-spans.js` | Referencias, marcas "(a)" y URL | No enmascarar por error; comprobar la estructura |
| `services/srx-segmenter.js` | Divide en oraciones | Segmentación |
| `services/ai-providers/*.js` + `services/ai-service.js` | Gemini, Azure, Mistral y compatible con OpenAI; proveedor por función | Adaptadores y proveedor por módulo |
| `services/ai-rules.js` (`selectRules`, `rulesBlock`) | Reglas que solo viajan si su expresión aparece | Núcleo de las reglas |
| `modules/qa-checker/powersearch-engine.js` + `qa-parsers.js` (`parseXBCKL`) | Patrones tipo Xbench e importación de `.xbckl` | Reglas deterministas |
| **`services/ai-usage.js` + `settings/tabs/ai-usage-tab.js`** | Registro del gasto y pantalla "Uso de IA" | **Seguimiento del gasto (§10)** |
| **`services/sync-fs.js`, `sync-autosave.js`, `sync-device.js`** | Archivo de sincronización | **Archivo de sincronización de UMBRA (§9)** |
| Patrón de lotes `[[n]]` … `[[END]]` (`buildFuzzyBatchPrompt`, `parseFuzzyBatchAnswer`) | Varios segmentos por llamada y detección de respuestas cortadas | Lotes |
| `utils/comet-dark.js`, `utils/ctrl-wheel-zoom.js` | Modo oscuro y Ctrl+rueda por zonas | Mismo comportamiento |

**Lo que hay que crear desde cero:**
- detectores de nombres propios, organismos, órganos y cargos (COMeT no tiene ninguno);
- lectura de XLSX y escritura de PPTX y XLSX;
- el enmascarador;
- los módulos;
- el editor de reglas unificado;
- la exportación de comentarios de Word;
- el adaptador de almacenamiento de la web.

---

## 5. Flujo general

```
 Original + traducción exportados de eLUNa: DOCX, PPTX o XLSX (el mismo formato a cada lado)
            |
            v
   [Lectura]  docx / pptx / xlsx  ->  [Alineación]  ->  [Segmentación]
            |
            v
   +----------------  PARTE 1: ENMASCARAR (todo en el navegador)  -------+
   | Detectores -> lista de entidades bilingüe -> revisión humana        |
   | -> texto enmascarado + MAPA DE CLAVES (nunca sale del ordenador)    |
   +-------+--------------------------------------------+---------------+
           |                                            |
           v                                            v
   [Exportar enmascarado]                    PARTE 2: REVISAR
    mismo formato / tabla bilingüe /           Capa 0  comprobaciones locales (gratis)
    texto con instrucciones                    Capa 1  cribado (modelo económico)
    para IA externa                            Capa 2  a fondo (modelo potente)
           |                                   Capa 3  Verificador (solo los hallazgos)
           v                                            |
   [Importar respuesta de                               v
    IA externa] -------------------------->  HALLAZGOS (mismo formato)
                                                        |
                                    revisión humana: aceptar / rechazar / editar
                                                        |
                                                        v
                     [Rehidratar etiquetas] -> DOCX con control de cambios y comentarios;
                                               PPTX/XLSX corregidos; informe HTML y Excel
```

---

## 6. Parte 1: Enmascarar

### 6.1 Qué se detecta y cómo (sin IA)

| Categoría | Etiqueta | Ejemplos (EN / FR → ES) | Cómo se detecta |
|---|---|---|---|
| Cifras | `NUM` | 1,250 / 1 250 → 1.250; three / trois → tres | `extractNumbers`, números en letra y monedas. El valor se normaliza en EN, FR y ES |
| Fechas | `FECHA` | 12 March 2024 / 12 mars 2024 → 12 de marzo de 2024 | Detector de fechas de `checks.js`, ampliado al francés |
| Organismos | `ORG` | UNDP / PNUD; OHCHR / HCDH → ACNUDH | Lista trilingüe de entidades de la ONU (siglas y nombres) y siglas en mayúsculas |
| Órganos | `ORGANO` | General Assembly / Assemblée générale → Asamblea General | Lista trilingüe; secuencias con Committee / Comité, Council / Conseil… |
| Países | `PAIS` | Bolivia (Plurinational State of) / Bolivie (État plurinational de) | Lista de Estados Miembros y observadores en EN/FR/ES (fuentes públicas de la ONU, como UNTERM) |
| Lugares | `LUGAR` | Geneva / Genève → Ginebra | Lista trilingüe y mayúsculas tras in / at / à |
| Personas | `PER` | Mr. John Smith / M. Jean Dupont | Tratamientos (Mr., Ms., M., Mme, H.E., S.E.) seguidos de mayúsculas |
| Cargos | `CARGO` | Secretary-General / Secrétaire général → Secretario General; Special Rapporteur on… / Rapporteur spécial sur… | Lista trilingüe y patrones |
| Símbolos | `SIMB` | A/RES/78/123 | `_SYMBOL_RE` de `checks.js` |
| URL y correos | `URL` | www.un.org | `url-spans.js` y una expresión regular |
| Personalizada | `X` | Cualquier término sensible | Lista del usuario |

- Cada categoría se activa o desactiva por separado.
- **Las listas de serie también son editables** (§8.3).
- Cada corrección manual del usuario entra en su **diccionario personal de entidades**, que viaja
  en el archivo de sincronización.

### 6.2 Formato de etiqueta: `{la ORGANO2}`

- **Código en mayúsculas y número pegado:** `CARGO1`, `ORGANO2`, `NUM7`. Así cuesta menos tokens
  que con guion bajo.
- **En la traducción, el artículo de la entidad va dentro de la etiqueta** e indica género y
  número: `el`, `la`, `los` o `las`. Ejemplos: `{el CARGO1}`, `{la ORGANO2}`, `{los PAIS3}`,
  `{las ORG4}`. Si el género no se conoce, la etiqueta va sin artículo.
- **En el original (EN/FR), la etiqueta va sin artículo:** `{ORGANO2}`. El inglés no lo necesita y
  la revisión de concordancia solo se hace en español.
- **Las cifras, fechas, símbolos y URL no llevan artículo:** `{NUM7}`, `{FECHA3}`.
- **El artículo o la contracción del propio texto se quedan fuera, sin tocar:**

  ```
  Traducción:   …que presente a la Asamblea General…       …al Secretario General…
  Enmascarado:  …que presente a la {la ORGANO2}…           …al {el CARGO1}…
  ```

  Parece redundante, pero es lo que permite **detectar errores de artículo**. Si el traductor
  escribió "el Asamblea General", queda "el {la ORGANO2}" y el módulo de gramática ve la
  discordancia. Si la etiqueta se tragara el artículo del texto, ese error desaparecería.
  Otra opción sería que la etiqueta absorbiera el artículo del texto; se puede cambiar si lo
  prefieres.

### 6.3 Misma entidad, misma etiqueta, en las dos lenguas

```
Original:    The Secretary-General informed the General Assembly that 1,250 staff...
Traducción:  El Secretario General informó a la Asamblea General de que 1.520 funcionarios...

Enmascarado:
Original:    The {CARGO1} informed the {ORGANO2} that {NUM3} staff...
Traducción:  El {el CARGO1} informó a la {la ORGANO2} de que {NUM4} funcionarios...

             NUM3 (1250) no aparece en la traducción y NUM4 (1520) no aparece en el original.
             -> Hallazgo CRÍTICO, sin IA y sin coste.
```

- **Cifras:** la etiqueta depende del **valor**. "1,250", "1 250", "1.250", "one thousand two
  hundred and fifty" y "mille deux cent cinquante" son el mismo `NUM`.
- **Entidades:** la pareja se busca en el segmento alineado mediante el diccionario trilingüe. Si
  no aparece, la entidad queda "sin pareja" y decide el usuario.
- **Una etiqueta por entidad en todo el documento.** Si la misma entidad aparece traducida de dos
  formas, la vista de entidades lo señala.

### 6.4 Revisión humana del enmascaramiento (pantalla "Enmascarar")
- **Dos hojas lado a lado**, como en Final Check. Cada tramo enmascarado se ve como una pastilla de
  color y letra según la categoría. El botón de ojo alterna entre **Ver etiquetas** y **Ver
  original**.
- **Panel "Entidades":** categoría, forma en el original, forma en la traducción, etiqueta,
  apariciones O/T y estado (`OK`, `Sin pareja`, `Formas distintas`, `Recuento distinto`).
- **Acciones:**
  - `Alt+E` enmascara la selección;
  - quitar una entidad o todas sus apariciones;
  - fusionar o separar entidades;
  - cambiar la categoría o el artículo.
- **Contador** en la barra superior: "38 entidades · 2 sin pareja · 1 cifra distinta".

### 6.5 Mapa de claves
- La correspondencia etiqueta ↔ original se guarda **solo en el navegador** (IndexedDB), dentro del
  proyecto.
- **No viaja en el archivo de sincronización.**
- Se puede exportar aparte, cifrado con contraseña.
- Sirve para **rehidratar**: los hallazgos vuelven con etiquetas y se muestran y aplican con los
  valores reales.

### 6.6 Exportaciones del enmascarado
1. **Documento enmascarado en el mismo formato:** DOCX, PPTX o XLSX, original y traducción. Se
   escribe parcheando el XML original y se verifica después.
2. **Tabla bilingüe enmascarada** en XLSX, DOCX o HTML (`id | original | traducción`). Es lo ideal
   para subir a una IA externa.
3. **"Copiar para IA externa":** pone en el portapapeles el texto enmascarado con instrucciones
   (qué son las etiquetas, que no hay que tocarlas y el formato de respuesta de §12).
4. **"Importar respuesta de IA externa":** convierte la respuesta en hallazgos dentro del mismo
   flujo de revisión.
5. **Proyecto `.umbra`:** un ZIP con los modelos, el mapa cifrado y los hallazgos, para seguir otro
   día.

### 6.7 La "puerta de salida" hacia la IA
Todas las llamadas pasan por `ai/gateway.js`, que:
- **rechaza** el texto que no venga del modelo enmascarado;
- deja pasar texto sin enmascarar **solo** a proveedores marcados como "locales o de confianza",
  y solo si el usuario lo activa en ese proyecto;
- cuenta los tokens y el coste (§10) y respeta el presupuesto de cada ejecución.

**Aviso honesto:** enmascarar reduce el riesgo, pero no lo elimina, porque el contexto puede
delatar de qué se habla.

---

## 7. Parte 2: Módulos de revisión

### 7.1 Qué es un módulo
```js
{
  id: 'fidelity',
  label: 'Fidelidad (errores de traducción)',
  input: 'bilingual',          // 'bilingual' | 'target' | 'skeleton' | 'findings'
  local: [checkFn, ...],       // comprobaciones sin IA (Capa 0)
  triage: true,                // admite cribado con modelo económico
  prompt: { system, rules },   // instrucciones de serie: EDITABLES (§8.3)
  output: 'lines',             // formato compacto de §12
  categories: ['MIST', 'UNTR'],
  verify: true,                // sus hallazgos pueden pasar por el Verificador
  mergeableWith: ['integrity'] // módulos con la misma entrada que se pueden fusionar
}
```
- Cada módulo se **ejecuta solo** desde su tarjeta, con su proveedor, su modelo y sus reglas.
- "Ejecutar seleccionados" puede fusionar los que comparten entrada y modelo, para ahorrar (§7.4).

### 7.2 Los ocho módulos

#### M1. Gramática (solo la traducción)
*(2026-11-05: la ortografía se deja a Word; el módulo ya no la revisa.)*
- **Sin IA:** palabras repetidas, espacios, ¿ ¡ y comillas o paréntesis sin cerrar. Las etiquetas evitan los
  falsos positivos con nombres propios.
- **Con IA:**
  - concordancia, que aprovecha el artículo de las etiquetas: "el {la ORGANO2}";
  - régimen preposicional;
  - tiempos verbales;
  - puntuación sintáctica;
  - errores que el diccionario no ve, como "sino / si no".

#### M2. Fidelidad: errores de traducción (bilingüe)
- **Sin IA:** cifras y etiquetas (§6.3); segmentos sin traducir; reglas `expr` y `forbid` del
  usuario.
- **Con IA:**
  - sentidos mal trasladados y falsos amigos (EN y FR);
  - modalidad (shall / should, doit / devrait);
  - negaciones invertidas;
  - agente cambiado;
  - grados de intensidad (urges / encourages, prie instamment / encourage).
- Se trabaja **segmento por segmento**, con identificador. El modelo declara al final cuántos
  segmentos ha revisado, para detectar saltos (§11.7).

#### M3. Integridad: omisiones y adiciones (bilingüe)
- **Sin IA (cribado gratis):**
  - proporción de longitud fuera de lo normal para el par de lenguas, calibrada con el propio
    documento;
  - etiquetas, cifras, paréntesis, elementos de lista y número de oraciones distintos;
  - párrafos y oraciones sin pareja.
- **Opcional, también sin coste de API:** similitud semántica entre oraciones con un modelo
  multilingüe que funciona en el navegador.
- **Con IA:** cada pareja de oraciones se lee lado a lado. Las sospechosas van al modelo potente.

#### M4. Estilo (la traducción, con el original opcional)
- **Sin IA:** reglas deterministas del usuario y de serie (anglicismos, galicismos, longitud de
  oración).
- **Con IA:**
  - calcos;
  - pasivas innecesarias;
  - gerundio de posterioridad;
  - nominalización excesiva;
  - registro institucional;
  - claridad;
  - las reglas `style`.

#### M5. Coherencia (macro)
La mayor parte se hace **en local, sin coste**:
- **Etiquetas:** el mismo conjunto en original y traducción por segmento; la misma entidad traducida
  siempre igual.
- **Estructura:** el mismo número de elementos de lista, filas, celdas, diapositivas y títulos.
- **Paralelismo gramatical:** los "hermanos" (elementos de una lista, celdas de una columna,
  títulos del mismo nivel, párrafos dispositivos) se clasifican por su arranque:

  | Patrón | Ejemplo |
  |---|---|
  | `INF` | Fortalecer… |
  | `SUST` | Fortalecimiento… |
  | `GER` | Fortaleciendo… |
  | `PART` | Reconocida… |
  | `PREP` | Para / Con… |
  | `PRES` | Decide… |
  | `SUBJ` | Fortalezcan… |
  | `OTRO` | Otros arranques |

  Si un hermano rompe el patrón mayoritario, es un hallazgo. El mismo análisis sobre el original
  dice si la divergencia ya venía de allí.
- **Patrones de forma:** mayúsculas de los títulos, puntuación final de los elementos de lista y
  numeración.
- **A la IA solo va lo ambiguo**, en forma de **esqueleto** (§11.6). También la coherencia de las
  expresiones repetidas: UMBRA agrupa en local las traducciones de cada expresión y la IA solo dice
  si la variación está justificada.

#### M6. Convenciones de la ONU (casi sin IA)
- **Resoluciones:**
  - los párrafos del preámbulo empiezan por gerundio o adjetivo en cursiva (*Recordando*,
    *Reafirmando*, *Profundamente preocupada*);
  - los dispositivos empiezan por verbo en presente en cursiva (*Decide*, *Exhorta*).
  Se comprueba también **la cursiva** del arranque, porque el modelo de documento conoce el
  formato de cada tramo.
- **Fórmulas fijas y nombres oficiales de países** (lista editable).
- **Formato de cifras, fechas y monedas en español** (reutiliza `number-format-es.js`).
- **Símbolos de documentos y referencias a párrafos y anexos.**
- La IA solo interviene para casos dudosos (por ejemplo, un preámbulo que empieza de forma
  atípica) y siempre sobre el esqueleto, no sobre el texto entero.

#### M7. Verificador (solo los hallazgos)
- Un modelo potente revisa **solo los hallazgos** de los demás módulos: la cita, la sugerencia y
  la pareja de oraciones.
- Para cada uno, confirma, corrige la sugerencia o lo descarta como falso positivo.
- Es la forma más barata de ganar precisión. Se puede activar por módulo.

#### M8. Lectura en frío (solo la traducción)
- Lee la traducción como un lector que **no conoce el original**.
- Señala frases incomprensibles, ambiguas, con referentes confusos o que "suenan a traducción".
- Complementa a Estilo con la mirada de un lector final.

### 7.3 Capas y fusión

| Capa | Quién | Qué | Coste |
|---|---|---|---|
| 0. Local | El navegador | Cifras, etiquetas, estructura, paralelismo, convenciones, reglas deterministas, ortografía de diccionario y cribado de omisiones | 0 |
| 1. Cribado | Modelo económico, razonamiento mínimo | **Todos** los segmentos, con instrucción de señalar ante la duda | Bajo |
| 2. A fondo | Modelo potente | Solo lo marcado por las capas 0 y 1 | Medio, sobre pocos segmentos |
| 3. Verificación | M7 | Solo los hallazgos | Bajo |

### 7.4 Fusión opcional por tipo de entrada
- **M2 + M3** comparten la entrada bilingüe.
- **M1 + M4** comparten la traducción.
- **M8** podría ir con ellos, pero conviene ejecutarlo aparte para que su mirada no se contamine
  con la de Estilo.

Si dos módulos fusionables usan el mismo modelo, se hace una sola llamada por lote. Cada hallazgo
conserva su módulo de origen.

---

## 8. Proveedores, modelos y reglas

### 8.1 Proveedores y modelos (como COMeT, ampliable sobre la marcha)
- **De serie, los mismos que COMeT:**
  - Gemini;
  - Mistral;
  - Azure OpenAI;
  - compatible con OpenAI (OpenAI, OpenRouter, DeepSeek, Groq, modelos locales…).

  En UMBRA el proveedor "compatible con OpenAI" está **siempre disponible**; no es una función
  oculta. Se añade además un adaptador de **Anthropic**.
- **Añadir sobre la marcha, sin ir a Ajustes:**
  - el desplegable de modelo de cada tarjeta de módulo termina en **"+ Añadir modelo…"** y
    **"+ Añadir proveedor…"**;
  - se rellena un formulario breve y queda elegido al momento;
  - se pueden tener **tantos perfiles como se quiera**, a diferencia del único proveedor
    personalizado de COMeT.
- **"Probar conexión"** en cada perfil. Detecta también el rechazo de llamadas desde la web
  (§3.4).
- Los modelos de cada proveedor se añaden y se quitan como en COMeT ("+ Añadir un modelo a la
  lista").

```js
{
  id: 'p_mistral', name: 'Mistral', adapter: 'mistral',  // gemini | mistral | azure-openai | openai-compatible | anthropic
  baseUrl: '', apiKey: '…',                              // la clave: ver §9.3
  models: [{ id: 'mistral-large-latest', label: 'Mistral Large', price: { in: 2, cached: null, out: 6 } }],
  trust: 'external'                                      // 'external' | 'local'
}
```

### 8.2 Modelo por módulo

| Campo | Ejemplo |
|---|---|
| Proveedor y modelo | `General` o uno concreto. Se pueden elegir dos: **cribado** y **a fondo** |
| Razonamiento | Mínimo, bajo o alto |
| Tamaño de lote | Automático (por secciones) o manual |
| Ámbito | Todo, una selección, unas secciones o solo lo cambiado |
| Fusión | Sí o no |
| Pasar por el Verificador | Sí o no |
| Presupuesto máximo por ejecución | 0,50 US$ |
| Reglas | Las activas del perfil |

Si el proveedor de un módulo no tiene clave, ese módulo usa el general y lo dice, como
`featureFallbacks` en COMeT.

### 8.3 Reglas: de serie y del usuario, todas editables
Un **único editor** con un esquema común (el de COMeT `ai-rules.js`, ampliado con el QA Checker):

```js
{
  id, on: true,
  origin: 'serie' | 'usuario',
  modules: ['style', 'grammar'],
  kind: 'expr' | 'forbid' | 'pattern' | 'style' | 'structure' | 'ignore',
  src: 'stakeholder*|partie* prenante*',  // expresión del original (EN o FR); '*' = cualquier final
  es: 'partes interesadas',
  avoid: 'actores',
  regex: null,                             // 'pattern': patrón tipo PowerSearch (con @N)
  note: 'Uso consolidado en la AG.',
  severity: 'MAY',                         // CRI | MAY | MEN | SUG
  profile: ['Resoluciones AG'],
  updatedAt                                // para la sincronización
}
```

| Tipo | Qué hace | ¿Va a la IA? |
|---|---|---|
| `expr` | Si el original dice X, la traducción debe decir Y | Primero se comprueba en local. Solo va a la IA si no se encuentra Y, para que juzgue variantes |
| `forbid` | La forma Z no debe aparecer | No |
| `pattern` | Patrón libre sobre original y traducción | No |
| `style` | Instrucción libre | Sí. Conviene tener pocas y cortas |
| `structure` | Instrucción macro ("las listas con letra empiezan por infinitivo") | En local si se puede expresar como patrón de arranque; si no, a la IA en el esqueleto |
| `ignore` | "No señales X" | No. Filtra los hallazgos |

**Reglas de serie editables:**
- UMBRA trae **reglas y listas de serie**: convenciones de resoluciones, anglicismos y galicismos
  frecuentes, puntuación de listas, patrones de paralelismo, listas de entidades y fórmulas fijas.
  También las **instrucciones (prompts) de cada módulo**, en una sección "Avanzado".
- **Todas se pueden editar, desactivar o borrar**, igual que las del usuario. Llevan la marca
  "De serie" o "De serie · modificada".
- **"Restaurar la de serie"** en cada regla y **"Restaurar todas"** por módulo.
- **Cuando una versión nueva de UMBRA cambia una regla de serie:**
  - si no la habías tocado, se actualiza sola;
  - si la habías modificado, **se respeta la tuya** y aparece el aviso "Hay una versión nueva de
    serie", con las dos versiones y el botón "Adoptar la nueva".
- Una regla de serie borrada no reaparece: queda una "lápida", como en la sincronización de COMeT.

**Además:**
- **Solo viaja lo relevante:** una regla `expr` entra en el prompt solo si su expresión aparece en
  el lote, como `selectRules`.
- **Contador:** "Sus reglas de estilo añaden unos 420 tokens a cada lote".
- **Perfiles** por tipo de documento ("Resoluciones AG", "Informes del SG", "Cartas").
- **Aprender del rechazo:** al rechazar un hallazgo, UMBRA ofrece "Crear regla para no volver a
  señalarlo"; al aceptarlo editado, "Crear regla con esta corrección".
- **Importar y exportar** en JSON, e importar listas de comprobación de Xbench (`.xbckl`).
- **"Probar regla"** en el documento cargado.

---

## 9. Archivo de sincronización (copiado de COMeT)

### 9.1 Qué se copia y cómo se adapta
Se copian `services/sync-fs.js`, `sync-autosave.js` y `sync-device.js` de COMeT y se conserva
todo lo que ya resuelve:

- **El usuario elige o crea un archivo**, por ejemplo en OneDrive. La web lo recuerda
  (IndexedDB) y pide permiso con un clic cuando hace falta.
- **Pregunta al abrir:** traer lo del archivo o guardar lo de este equipo, con la "firma del
  equipo" que lo guardó y cuándo.
- **Autoguardado** silencioso unos segundos después de cada cambio, con un temporizador de
  seguridad y el aviso "Guardar" cuando se queda en pausa por permisos.
- **Fusión, no sobrescritura:**
  - en los ajustes gana el cambio más reciente (`updatedAt`);
  - las listas se unen por id;
  - los borrados se propagan con lápidas.
- **Protección del archivo:** escritura verificada, bloqueo de escritura, copia local del último
  contenido bueno (por si OneDrive lo deja vacío) y "deshacer lo traído".

**Adaptación:** donde COMeT usa `chrome.storage.local`, UMBRA usará su adaptador de almacenamiento
de la web (§3.3), con las mismas operaciones (`get`, `set`, `remove`, aviso de cambios).

### 9.2 Qué viaja en el archivo
| Viaja | No viaja |
|---|---|
| Perfiles de proveedor y **modelos configurados** | Los documentos y los proyectos (confidenciales y pesados) |
| Modelo por módulo y ajustes de cada módulo | El mapa de claves del enmascaramiento |
| Reglas del usuario, **ediciones de las reglas de serie** y lápidas | Las claves de API, salvo que se active la opción de §9.3 |
| Perfiles de reglas | |
| Diccionario personal de entidades y listas editadas | |
| **Registro del gasto** y precios (§10) | |
| Preferencias (modo oscuro, zoom, color…) | |

### 9.3 Claves de API
- **Por defecto no van en el archivo**, como en COMeT: se escriben una vez en cada equipo.
- **Opción "Incluir claves cifradas":** van cifradas con una contraseña (AES-GCM, clave derivada
  con PBKDF2). En otro equipo se escribe la contraseña una vez y quedan disponibles.

### 9.4 Para que nunca se mezcle con COMeT
- **Nombre por defecto:** `umbra-sync.json`.
- Dentro, `meta.kind = 'umbra-sync'`. **Si por error se elige el archivo de COMeT
  (`'comet-sync'`), UMBRA lo rechaza y no escribe en él.**

---

## 10. Seguimiento del gasto (como en COMeT)
Se copia el sistema de `services/ai-usage.js` y la pantalla `settings/tabs/ai-usage-tab.js`:

- **Cada llamada registra** los tokens de entrada, en caché, de salida y de razonamiento, junto
  con el módulo, el proveedor, el modelo, el proyecto, el archivo y las palabras revisadas.
- **Se guarda por día** y **por equipo**, como en COMeT, para que al sincronizar no se cuente nada
  dos veces.
- **Precios:** se rellenan solos desde la lista pública de LiteLLM (comprobado: es accesible desde
  GitHub Pages). Se pueden corregir a mano y en euros o dólares. El coste se calcula con la misma
  fórmula (`costOf`): entrada normal, entrada en caché con descuento, y salida más razonamiento.
- **Pantalla "Uso de IA":**
  - periodos;
  - barras por día, semana o mes;
  - desglose por módulo, proyecto y modelo;
  - notas;
  - exportación a Excel.
- **Además de lo que tiene COMeT:**
  - estimación **antes** de ejecutar (el plan de §13);
  - presupuesto máximo por ejecución;
  - medidor de la sesión en la cabecera.

---

## 11. Optimización de tokens sin perder exhaustividad

**Cada segmento se revisa al menos una vez por una IA. Lo que se recorta es la repetición y lo que
escribe el modelo, no lo que mira.**

1. **No pagar por lo que hace el ordenador.** La Capa 0 resuelve las cifras, las etiquetas, la
   estructura, el paralelismo, las convenciones, las reglas deterministas y la ortografía de
   diccionario. El prompt pide a la IA que no lo repita.
2. **Salida mínima.** Esto es lo más importante, porque los tokens de salida cuestan varias veces
   más que los de entrada:
   - nunca se pide el texto corregido;
   - los segmentos correctos no generan nada;
   - una línea por hallazgo (§12);
   - una explicación de unas 15 palabras.
3. **Entrada sin repeticiones.**
   - Los pares original/traducción repetidos se revisan una vez.
   - No se envían los segmentos que solo tienen cifras, símbolos o etiquetas.
   - Las etiquetas acortan los nombres largos: "Office of the United Nations High Commissioner for
     Human Rights" pasa a ser `{ORG5}`.
   - Se envía texto plano con identificadores cortos.
4. **Varios segmentos bajo una sola copia de las instrucciones, con caché.** COMeT ya lo comprobó en
   el informe Fuzzy (`fuzzy-batch.js`): cada llamada lleva unos 13.000 caracteres de reglas, y
   agrupar los segmentos ahorra alrededor de un 80 % de caracteres (23 segmentos pasan de 23
   llamadas a 3). Además, la parte fija va siempre primero y es idéntica en todos los lotes:
   ```
   [FIJO]      instrucciones del módulo + reglas de estilo + resumen del documento (150 tokens)
   [VARIABLE]  reglas de expresión de este lote + lote de segmentos
   ```
   La mayoría de proveedores cobran mucho menos por un prefijo que ya han visto hace poco.
5. **Cascada.** Un modelo económico criba todo; uno potente revisa solo lo señalado (normalmente
   una cuarta parte o menos); el Verificador filtra. La exhaustividad la da la criba y la
   precisión el Verificador.
6. **Esqueleto para la coherencia y las convenciones.** No se envía el documento, sino algo así:
   ```
   L3 (lista, 6 elementos, sección 2.1):
     1 INF  "Fortalecer la capacidad…"
     2 INF  "Promover la cooperación…"
     3 SUST "Elaboración de…"          <- distinto
     original: 1 INF 2 INF 3 INF
   ```
   Son cientos de tokens en lugar de decenas de miles.
7. **Lotes de tamaño justo y control de saltos.**
   - Los lotes se cortan por secciones, de unas 1.500 a 3.000 palabras.
   - Cada lote termina con `FIN <n>`. Si falta o no cuadra, solo se reenvía la parte que falta,
     como hace COMeT con `[[END]]`.
   - Se añaden el segmento anterior y el siguiente como contexto, marcados "no revisar".
8. **Caché de resultados.** Cada resultado se guarda con una huella (original, traducción, módulo,
   versión del prompt, reglas y modelo). En la segunda vuelta solo se envía lo que ha cambiado.
9. **Modo diferido (más adelante).** Las APIs de "lotes" de varios proveedores devuelven el
   resultado en horas y suelen costar la mitad.
10. **Razonamiento a la medida.** Mínimo en el cribado, en Ortografía y en Lectura en frío; bajo o
    alto solo en Fidelidad a fondo y en el Verificador.

**Estimación orientativa (10.000 palabras EN o FR → ES):**

| Enfoque | Entrada | Salida | Total |
|---|---|---|---|
| Ingenuo: cada módulo recibe el documento bilingüe y devuelve el texto corregido | ~150.000 | ~80.000 | **~230.000** |
| UMBRA: todo lo anterior | ~65.000 (gran parte con caché o en modelo económico) | ~9.000 | **~74.000** |

Son unas **3 veces menos tokens** y unas **9 veces menos de salida**. Como casi todo lo procesa un
modelo económico, el ahorro en **dinero** es mayor que en tokens. Las cifras son una estimación;
las reales las medirá el seguimiento de §10.

---

## 12. Hallazgos

### 12.1 Formato compacto
```
12 | OMI | MAY | y su anexo | ...el informe y su anexo | Falta "and its annex" del original.
15 | GRA | MEN | desplegó | desplegaron | Concuerda con "funcionarios" (plural).
FIN 34
```
Los campos son: `segmento | categoría | severidad | cita exacta | sugerencia | motivo`. Es el mismo
formato que se pide a una IA externa (§6.6).

### 12.2 Clasificación (tipo MQM, el estándar del sector)
| Grupo | Códigos |
|---|---|
| Precisión | `MIST` traducción errónea, `OMI` omisión, `ADD` adición, `UNTR` sin traducir |
| Fluidez | `ORT` ortografía, `GRA` gramática, `PUNT` puntuación |
| Estilo y lectura | `EST` estilo, `LEC` lectura en frío |
| Coherencia | `COH` |
| Convenciones | `CONV` |

| Severidad | Color |
|---|---|
| `CRI` crítica | Rojo #dc2626 |
| `MAY` mayor | Ámbar #d97706 |
| `MEN` menor | Azul |
| `SUG` sugerencia | Gris |

### 12.3 Anclaje y revisión
- **Anclaje:** la cita se busca en el segmento, primero literal y luego aproximada. Si no aparece,
  el hallazgo queda "sin ancla" y no se aplica solo.
- **Lista como la de Final Check:** filtros por módulo, categoría y severidad. Cada tarjeta muestra
  la cita, la sugerencia como diferencia y el motivo, con los botones **Aceptar**, **Editar**,
  **Rechazar** e **Ignorar**.
- **Atajos:** `J`/`K` (siguiente y anterior), `A` (aceptar), `R` (rechazar), `E` (editar).
- **Al pulsar una tarjeta** se desplazan las dos hojas hasta el tramo.
- **"Ver grupo"** para el paralelismo: muestra todos los hermanos de la lista.

### 12.4 Exportación del resultado
| Formato | Salida |
|---|---|
| **DOCX** | **Control de cambios** para lo aceptado (`applyTrackedEdit`) y **comentarios de Word** para el resto. Lo de los comentarios es nuevo |
| **PPTX y XLSX** | No tienen control de cambios. Se exporta una **copia corregida** y, aparte, el informe con cada cambio. En XLSX hay además la opción de **notas en las celdas cambiadas** |
| Todos | **Informe HTML**, **Excel** y **JSON** de hallazgos |

---

## 13. Diseño de la interfaz
La **maqueta** está en [`docs/maqueta.html`](maqueta.html). Ya refleja estas decisiones: etiquetas
`{la ORGANO2}`, los ocho módulos y las pantallas de sincronización y uso de IA.

- **La estructura de Final Check:**
  - cabecera;
  - barra con las dos zonas de carga (DOCX, PPTX o XLSX);
  - carril de iconos;
  - lista lateral de 280 px;
  - dos hojas.

  Con los mismos colores, fuentes y modo oscuro.
- **Cabecera en añil** (#3949AB) para distinguir UMBRA de COMeT de un vistazo. Es fácil volver al
  azul de COMeT si lo prefieres.
- **Tres pasos siempre visibles:** `1 Enmascarar` → `2 Revisar` → `3 Exportar y ajustes`.
- **Carril de iconos:** Entidades, Hallazgos, Módulos, Reglas y Uso de IA.
- **Tarjetas de módulo** con:
  - tipo de entrada;
  - pastilla de modelo con "+ Añadir modelo…";
  - número de reglas;
  - **estimación previa**;
  - botón **Ejecutar**;
  - progreso.
- **"Ejecutar seleccionados"** muestra el plan (llamadas, tokens y coste) y pide confirmación.
- **Cabecera:** medidor de gasto de la sesión y estado de la sincronización ("Sincronizado ·
  umbra-sync.json · hace 2 min", o el botón ámbar "Guardar" si se queda en pausa, como en COMeT).
- **Accesibilidad:** color **y** letra o icono en categorías y severidades. **Ctrl+rueda** por
  zonas.

---

## 14. Estructura del repositorio
```
revmaster/
  app/                       <- LO ÚNICO QUE SE PUBLICA EN GITHUB PAGES
    index.html               Ventana principal
    app.css, app.js          Estilos (de Final Check) y orquestador
    core/                    Copias adaptadas de COMeT: docx-model, pptx-model, align,
                             preview-renderer, srx-segmenter, number-*, currency, section-refs
    formats/                 xlsx-model (nuevo), pptx-writer y xlsx-writer (nuevos)
    storage/                 Adaptador tipo chrome.storage sobre localStorage/IndexedDB
    sync/                    sync-fs, sync-autosave, sync-device (copiados de COMeT)
    redact/                  detectores, listas (gazetteers), entity-store, masker, rehydrate
    review/                  modules/ (ocho), local-checks/, planner, prompt-kit, parse
    ai/                      gateway, adapters/, usage (de ai-usage.js), pricing
    rules/                   almacén, reglas de serie (defaults/*.json), editor
    export/                  documentos enmascarados, DOCX con cambios y comentarios, PPTX/XLSX corregidos, informes
    settings/                Proveedores, Módulos, Reglas, Listas, Sincronización, Uso de IA, Privacidad
    libs/                    jszip, xlsx (copias)
  .github/workflows/pages.yml  Publica app/ en GitHub Pages al fusionar en main
  docs/                      Esta propuesta y la maqueta (no se publican)
  CLAUDE.md                  Normas del proyecto para futuras sesiones
  VERSION.md                 Registro de cambios, solo con añadidos
```

---

## 15. Hoja de ruta (PR pequeños)

| Fase | Contenido | Resultado útil |
|---|---|---|
| **0. Esqueleto web** | `CLAUDE.md`; publicación en Pages; ventana con el diseño de Final Check; adaptador de almacenamiento; carga de los dos DOCX, alineación y vista previa | **La web abre en el navegador** y muestra los dos documentos |
| **1. Enmascarar** | Detectores de cifras, fechas y símbolos (EN, FR y ES); listas trilingües; personas; panel de Entidades; etiquetas `{la ORGANO2}`; exportaciones DOCX, tabla y "Copiar para IA externa" | **Útil por sí sola** |
| **1b. PPTX y XLSX** | Lectura de XLSX, escritura de PPTX y XLSX enmascarados | Los tres formatos |
| **2. IA y sincronización** | Proveedores (con "Probar conexión" y CORS), puerta de salida, **seguimiento del gasto**, **archivo de sincronización**, Capa 0 y **un** módulo de punta a punta (Integridad), hallazgos e importación de respuestas externas | Flujo completo con un módulo |
| **3. Resto de módulos** | M1, M2, M4, M5, M6, M7 y M8; reglas unificadas con **reglas de serie editables** | Los ocho módulos |
| **4. Optimización** | Fusión, cascada, caché de resultados, plan previo, presupuesto y razonamiento por módulo | Coste reducido |
| **5. Exportación final** | DOCX con cambios y comentarios; PPTX y XLSX corregidos; informes; proyecto `.umbra` | Entrega |
| **6. Extras** | Similitud semántica local, modo diferido (−50 %), puente para proveedores sin CORS si hace falta | Más exhaustividad y menos coste |

---

## 16. Pendiente de ti
1. **Visibilidad del repositorio:** hacerlo público, o tener GitHub Pro, para poder usar Pages (§3.2).
2. **En GitHub:**
   - **Settings → Pages → Source: "GitHub Actions"**;
   - **Settings → General → Default branch: `main`**.
3. **¿Renombrar el repositorio a `umbra`?** Es opcional; cambia la dirección de la web.
4. **Archivos de ejemplo** de PPTX y XLSX exportados de eLUNa (original y traducción), para la
   Fase 1b. No hace falta que sean confidenciales: vale cualquier documento público.
5. **Color de la cabecera:** añil propio, o el mismo azul de COMeT.
