/**
 * help.js - Contextual help: a small "?" button next to each feature opens a short explanation of how
 * to use it (a popover, so the user keeps working). F1 opens the help of the current screen.
 *
 * Topic text uses a tiny markup: **bold**, `code`, [[key]] (keyboard key). A body item that is an
 * array becomes a bullet list.
 */

import { el } from '../util/dom.js';
import { showGuide } from './guide.js';

const T = {
  // ------------------------------------------------------------------ files and start
  files: { t: 'Cargar los documentos', b: [
    'Pulse una casilla o arrastre a ella el archivo: a la izquierda el **original** (ingl\u00e9s o franc\u00e9s) y a la derecha la **traducci\u00f3n** (espa\u00f1ol).',
    ['Formatos: DOCX, PPTX y XLSX exportados de eLUNa.',
      'UMBRA empareja los p\u00e1rrafos de los dos documentos y enmascara al momento.',
      'Para cambiar un archivo, vuelva a pulsar su casilla.',
      'El proyecto se guarda solo en este navegador; para volver a \u00e9l, pulse \ud83d\uddc2 (Proyectos guardados) en la cabecera.',
      'Los archivos no salen de su ordenador: a una IA solo llega texto enmascarado (y, con Nombres oficiales, la lista de nombres de organismos, \u00f3rganos, cargos, pa\u00edses y lugares).'] ] },

  // ------------------------------------------------------------------ step 1: mask
  'mask-tools': { t: 'Barra de enmascarado', b: [
    ['**Categor\u00edas** (Cifras, Fechas, Organismos\u2026): pulse una para dejar de enmascararla o para volver a hacerlo. Las apagadas salen en gris.',
      'El resumen dice cu\u00e1ntas entidades hay, cu\u00e1ntas tienen **problemas** y cu\u00e1ntas **cifras sin pareja** (una cifra que no est\u00e1 igual en las dos lenguas: posible error).',
      '**Original: ingl\u00e9s / franc\u00e9s**: la lengua del original.',
      '**Opciones**: n\u00fameros en letra, siglas desconocidas y deshacer lo hecho a mano.',
      '**\ud83d\udc41 Ver original / Ver etiquetas**: alterna entre las etiquetas y el texto real.',
      '**+ Enmascarar selecci\u00f3n** ([[Alt+E]]): enmascara lo que haya seleccionado en una hoja.',
      '**Exportar enmascarado**: documentos censurados, tabla biling\u00fce, texto para una IA externa y mapa de claves.'] ] },
  'mask-options': { t: 'Opciones de enmascarado', b: [
    ['**N\u00fameros escritos en letra** (\u00abdoscientos\u00bb, \u00abthree\u00bb\u2026): se enmascaran como cifras.',
      '**Siglas desconocidas presentes en ambos textos**: una sigla que no est\u00e1 en las listas pero aparece igual en el original y en la traducci\u00f3n se enmascara.',
      '**Volver a enmascarar todo lo que se quit\u00f3 a mano**: anula los \u00abNo enmascarar\u00bb.',
      '**Deshacer todos los emparejamientos**: separa las entidades que se emparejaron a mano.',
      '**Quitar los t\u00e9rminos a\u00f1adidos a mano en este proyecto**: borra lo enmascarado con [[Alt+E]] (su diccionario personal no cambia).'] ] },
  'mask-export': { t: 'Exportar enmascarado', b: [
    ['**Original / Traducci\u00f3n enmascarada**: el mismo documento, en su formato, con etiquetas en lugar de los datos. Sirve para enviarlo a una IA o a otra persona sin datos sensibles.',
      '**Tabla biling\u00fce (XLSX o HTML)**: original y traducci\u00f3n enmascarados, p\u00e1rrafo a p\u00e1rrafo.',
      '**Copiar para IA externa**: el texto enmascarado con las instrucciones de revisi\u00f3n, para pegarlo en ChatGPT, Gemini, Claude\u2026',
      '**Importar respuesta de IA externa**: convierte la respuesta de esa IA en hallazgos de Revisar.',
      '**Mapa de claves**: la lista etiqueta \u2192 texto real. Contiene los datos reales: p\u00f3ngale contrase\u00f1a y gu\u00e1rdelo aparte.'] ] },
  entities: { t: 'Entidades del documento', b: [
    'Una entidad es un dato que UMBRA tapa con una etiqueta (`{CARGO1}`, la misma en las dos lenguas): cifras, fechas, s\u00edmbolos y direcciones (por su forma), organismos, \u00f3rganos, pa\u00edses, lugares y cargos (por sus listas triling\u00fces), personas (tras \u00abMr.\u00bb, \u00abSra.\u00bb, \u00abM.\u00bb\u2026), siglas presentes en las dos lenguas y lo que usted a\u00f1ada.',
    ['**Pulse una tarjeta**: las dos hojas van a la entidad; la oraci\u00f3n sale en amarillo en las dos lenguas y la etiqueta, con un brillo rojo. Otra pulsaci\u00f3n: la siguiente aparici\u00f3n.',
      '**Con problemas / Todas**: por defecto se ven solo las que tienen alg\u00fan problema. Debajo, la categor\u00eda.',
      '**Sin pareja**: est\u00e1 en una lengua y no en la otra. **Recuento distinto**: no aparece el mismo n\u00famero de veces. **Formas distintas**: la traducci\u00f3n la nombra de varias maneras.',
      '**Ver d\u00f3nde no cuadra \u203a** y **Siguiente \u203a**: recorren los p\u00e1rrafos en los que no coincide.'],
    'Botones: **Categor\u00eda**, **Emparejar\u2026** (es la misma entidad que otra etiqueta), **A mi diccionario** (se enmascarar\u00e1 en todos los documentos) y **No enmascarar**.'] },
  sheets: { t: 'Las dos hojas', b: [
    'A la izquierda, el original; a la derecha, la traducci\u00f3n, con las etiquetas en color.',
    ['**Clic en una oraci\u00f3n**: se resalta en amarillo con su pareja en la otra hoja, que se desplaza hasta ponerla a la misma altura. Si las oraciones no se corresponden una a una, UMBRA las empareja por su longitud y sus etiquetas; si no hay pareja, marca el p\u00e1rrafo m\u00e1s cercano.',
      '**Rat\u00f3n sobre una etiqueta**: se ve lo que oculta, y su pareja en la otra hoja brilla.',
      '**Clic en una etiqueta**: la entidad se selecciona y brilla en rojo en las dos oraciones.',
      '**Clic derecho en una frase \u203a Desenmascarar**: muestra el texto real de esa frase y de su pareja hasta que pulse otra frase.',
      '**Para enmascarar algo que UMBRA no ha detectado**: selecci\u00f3nelo y pulse [[Alt+E]], o clic derecho \u203a **Enmascarar la selecci\u00f3n\u2026**',
      '[[\u2190]] / [[\u2192]]: oraci\u00f3n anterior y siguiente. **Buscar\u2026**: lleva al primer texto que coincide.',
      '[[Ctrl]]+rueda del rat\u00f3n sobre las hojas ampl\u00eda el texto.'] ] },
  'mask-selection': { t: 'Enmascarar una selecci\u00f3n', b: [
    'Se enmascaran todas las apariciones del texto en esa hoja.',
    ['**Categor\u00eda**: la que mejor encaje; si ninguna, Personalizada. Si elige una entidad de la lista, toma su categor\u00eda.',
      '**Es la misma entidad que**: la lista de la otra lengua, con buscador. Primero van las m\u00e1s probables (en el mismo p\u00e1rrafo, sin pareja, con la misma sigla o una forma parecida) y la mejor viene marcada como **Sugerida**. Elija \u00abNo\u00bb si es una entidad nueva.',
      '**Forma en la otra lengua**: c\u00f3mo aparece en el otro documento, para enmascararla tambi\u00e9n.',
      '**Mi diccionario personal**: se enmascarar\u00e1 en todos los documentos (y viaja en el archivo de sincronizaci\u00f3n).'],
    'Si se equivoca: Opciones \u203a Quitar los t\u00e9rminos a\u00f1adidos a mano.'] },
  'external-copy': { t: 'Copiar para IA externa', b: [
    'Para usar una IA de chat (ChatGPT, Gemini, Claude\u2026) sin configurar ninguna clave.',
    ['Marque qu\u00e9 revisar. Con **Incluir el original** la revisi\u00f3n es biling\u00fce.',
      'Pulse **Copiar** (o Descargar .txt) y pegue el texto en la IA.',
      'Copie su respuesta entera y use **Importar respuesta de IA externa**.'],
    'Solo sale texto enmascarado.'] },
  'external-import': { t: 'Importar respuesta de IA externa', b: [
    'Pegue la respuesta completa de la IA. UMBRA reconoce las l\u00edneas con el formato que se le pidi\u00f3 (`12 | OMI | MAY | cita | sugerencia | motivo`) y descarta el resto.',
    'Las etiquetas se convierten en el texto real y los hallazgos aparecen en Revisar con el origen \u00abIA externa\u00bb.'] },
  merge: { t: 'Emparejar entidades', b: [
    '**Para qu\u00e9 sirve**: a veces UMBRA da dos etiquetas distintas a una sola entidad, porque en cada lengua se escribe de otra forma. Por ejemplo, \u00abUNDP\u00bb en el original queda como `{ORG4}` y \u00abPNUD\u00bb en la traducci\u00f3n como `{ORG7}`: las dos salen como \u00abSin pareja\u00bb.',
    '**C\u00f3mo se usa**: pulse **Emparejar\u2026** en la tarjeta de una de ellas y elija la otra. La lista tiene buscador y empieza por las m\u00e1s probables (mismo p\u00e1rrafo, sin pareja, misma sigla o forma parecida); la mejor viene marcada como **Sugerida**. Desde ese momento llevan la misma etiqueta y dejan de salir como problema.',
    'Para deshacerlo: Opciones \u203a Deshacer todos los emparejamientos.'] },

  // ------------------------------------------------------------------ step 2: review
  'review-tools': { t: 'Barra de revisi\u00f3n', b: [
    ['El resumen cuenta los hallazgos pendientes por gravedad: cr\u00edticos, mayores, menores y sugerencias.',
      '**\u25b6 Ejecutar seleccionados**: ejecuta los m\u00f3dulos marcados en la barra de m\u00f3dulos. Antes de gastar, ense\u00f1a el plan con el coste estimado. **\u25a0 Detener** para a mitad.',
      '**M\u00e1s**: IA externa, verificar hallazgos y configurar los m\u00f3dulos.',
      '**Exportar**: la traducci\u00f3n corregida (DOCX con control de cambios y comentarios), los informes y el Excel para valorar los hallazgos.'] ] },
  modules: { t: 'M\u00f3dulos de revisi\u00f3n', b: [
    'Cada m\u00f3dulo es un revisor especializado con IA que se ci\u00f1e a su tarea, como lo har\u00eda un revisor humano. Cada pastilla: **casilla** = entra en \u00ab\u25b6 Ejecutar seleccionados\u00bb; **\u25b6** peque\u00f1o = ejecuta solo ese m\u00f3dulo; al lado, el coste estimado y, despu\u00e9s, \u2691 n hallazgos pendientes (o \u2713). Deje el rat\u00f3n encima para ver qu\u00e9 hace y con qu\u00e9 modelo.',
    ['**Gram\u00e1tica**: concordancia, r\u00e9gimen, tiempos y puntuaci\u00f3n (la ortograf\u00eda la corrige Word).',
      '**Fidelidad**: solo errores de SENTIDO: lo que hace que la traducci\u00f3n diga algo distinto del original.',
      '**Integridad**: contenido que falta o sobra respecto del original.',
      '**Estilo**: calcos, pasivas, gerundios, registro institucional.',
      '**Coherencia** y **Convenciones ONU**: miran el documento entero de una vez (listas, t\u00edtulos, f\u00f3rmulas de resoluci\u00f3n); son baratos.',
      '**Lectura en fr\u00edo**: lee la traducci\u00f3n sin el original, como un lector nuevo.',
      '**Nombres oficiales**: comprueba la denominaci\u00f3n oficial y la coherencia de organismos, \u00f3rganos, cargos, pa\u00edses y lugares; solo env\u00eda la lista de esos nombres, sin el texto.',
      '**\u2713 Verificar hallazgos**: otro modelo revisa los hallazgos pendientes y descarta los falsos positivos.'],
    'Qu\u00e9 m\u00f3dulos est\u00e1n activos, con qu\u00e9 modelo y con qu\u00e9 **exigencia** se elige en Ajustes \u203a M\u00f3dulos.'] },
  'review-more': { t: 'Men\u00fa M\u00e1s', b: [
    ['**Copiar para IA externa / Importar respuesta**: revisar con una IA de chat sin clave.',
      '**Verificar los hallazgos pendientes de la IA**: los manda al Verificador, que descarta los falsos positivos. Cuesta poco: solo env\u00eda los hallazgos con su contexto.',
      '**Configurar m\u00f3dulos y modelos**: atajo a Ajustes \u203a M\u00f3dulos.'] ] },
  'review-export': { t: 'Exportar la revisi\u00f3n', b: [
    ['**DOCX con control de cambios y comentarios**: los hallazgos ACEPTADOS entran como cambios controlados (que acepta o rechaza en Word) y los dem\u00e1s, como comentarios de Word.',
      '**Sin comentarios**: solo los cambios.',
      '**Con los cambios aplicados**: documento limpio. Es la opci\u00f3n de PPTX y XLSX, que no tienen control de cambios.',
      '**Informe HTML o Excel**: todos los hallazgos, salvo los descartados por el Verificador.',
      '**Hallazgos para valorar (Excel)**: una fila por hallazgo con columnas para su opini\u00f3n; v\u00e9ase su propia ayuda.',
      '**JSON**: los datos en bruto.'] ] },
  findings: { t: 'Hallazgos', b: [
    'Tres listas filtran lo que se ve: **Estado** (lo que usted ya decidi\u00f3), **M\u00f3dulo** (qui\u00e9n lo encontr\u00f3) y **Gravedad**. Cada opci\u00f3n dice cu\u00e1ntos hay.',
    'Cada tarjeta muestra la gravedad (**CRI** cr\u00edtica, **MAY** mayor, **MEN** menor, **SUG** sugerencia), el m\u00f3dulo, el lugar (\u00a7 p\u00e1rrafo.oraci\u00f3n), la cita tachada \u2192 la propuesta, el motivo y el modelo.',
    ['**Pulse una tarjeta**: las dos hojas van a esa oraci\u00f3n; el texto exacto sale en amarillo intenso.',
      '**Aceptar** [[A]]: se aplicar\u00e1 al exportar. **Editar** [[E]]: corrija la propuesta (queda aceptada). **Rechazar** [[R]] e **Ignorar**: lo apartan.',
      '[[J]] / [[K]]: siguiente y anterior. **Deshacer** devuelve un hallazgo decidido a pendientes.',
      '**\u29c9 Tabla**: los hallazgos en una ventana aparte, en forma de tabla (como la de Transformations de Final Check).',
      '**\ud83d\uddd1 Vaciar**: borra los hallazgos para empezar de cero.',
      '**\u22ef**: aceptar o rechazar en bloque los visibles.'],
    'Solo lo ACEPTADO se aplica al exportar.'] },
  'findings-reset': { t: 'Vaciar los hallazgos', b: [
    ['**Todos** o **solo los pendientes**: los aceptados y rechazados se pueden conservar.',
      '**Olvidar las respuestas guardadas**: UMBRA guarda lo que contest\u00f3 la IA para no pagar dos veces por el mismo p\u00e1rrafo. Si cambia de modelo o de exigencia, o los hallazgos no le sirven, m\u00e1rquelo: la pr\u00f3xima revisi\u00f3n preguntar\u00e1 de nuevo.'],
    'Los documentos y las entidades no se tocan.'] },
  feedback: { t: 'Hallazgos para valorar', b: [
    'Un Excel para decir qu\u00e9 hallazgos son buenos y cu\u00e1les no, y as\u00ed ajustar las reglas y las instrucciones de los m\u00f3dulos.',
    ['Una fila por hallazgo: lugar, m\u00f3dulo, gravedad, cita, propuesta, motivo, origen y la oraci\u00f3n del original y de la traducci\u00f3n.',
      '**Su valoraci\u00f3n** (lista desplegable): Correcto, Falso positivo, Gravedad excesiva, Gravedad insuficiente, Propuesta mejorable o Dudoso.',
      '**Gravedad correcta** y **Comentario**: lo que habr\u00eda que cambiar.',
      '**Enmascarado**: sin datos reales, para compartirlo sin riesgo.'],
    'No cambie las columnas ID ni \u00a7: sirven para encontrar cada hallazgo.'] },
  bench: { t: 'Banco de pruebas', b: [
    'Un documento de prueba hecho con su informe de revisi\u00f3n: p\u00e1rrafos con errores conocidos (de sentido, omisiones, adiciones, nombres oficiales y gram\u00e1tica) y p\u00e1rrafos correctos.',
    ['**Cargar**: se abre como un proyecto aparte; el que ten\u00eda abierto queda guardado (\u1f5c2).',
      'Ejecute los m\u00f3dulos con los modelos y la exigencia que quiera probar.',
      '**Resultado**: cu\u00e1ntos errores detecta cada m\u00f3dulo, cu\u00e1les se le escapan, cu\u00e1les descart\u00f3 el Verificador y cu\u00e1nto **ruido** mete (hallazgos que no corresponden a ning\u00fan error).',
      '**Copiar el resumen**: p\u00e9guelo en el chat para ajustar las instrucciones de los m\u00f3dulos.',
      'Antes de repetir una prueba, use \u1f5d1 Vaciar con \u00abOlvidar las respuestas guardadas\u00bb.'],
    'Sirve para comparar modelos, exigencias e instrucciones con datos, y no a ojo.'] },
  'review-sheets': { t: 'Hojas de revisi\u00f3n', b: [
    ['La traducci\u00f3n lleva subrayados los hallazgos visibles, con el color de su gravedad.',
      '**Clic en una oraci\u00f3n**: se resalta con su pareja en el original y, si tiene hallazgos, se muestra el primero en la lista (pulse otra vez para ver el siguiente).',
      'Una marca \u00ab+ omisi\u00f3n\u00bb al final de un p\u00e1rrafo indica algo que falta.',
      '[[\u2190]] / [[\u2192]]: oraci\u00f3n anterior y siguiente. Al pasar el rat\u00f3n por un p\u00e1rrafo, su pareja se recuadra.',
      'Solo se marcan los hallazgos que pasan los filtros de la lista.'] ] },
  plan: { t: 'Plan de ejecuci\u00f3n', b: [
    'Lo que se va a enviar, antes de gastar nada:',
    ['Lotes por m\u00f3dulo (dos m\u00f3dulos \u00abfusionados\u00bb comparten llamada), el modelo del cribado y el de la pasada a fondo.',
      'P\u00e1rrafos **en cach\u00e9**: ya revisados con el mismo texto y las mismas reglas; no se pagan otra vez. **Repetidos**: se revisan una vez.',
      'Total aproximado de llamadas, tokens y coste (precios de lista). El gasto real queda en Uso de IA.',
      '**Presupuesto m\u00e1ximo**: UMBRA deja de enviar al llegar a esa cifra (vac\u00edo = sin l\u00edmite).',
      '**Modo diferido (lotes)**: la primera pasada cuesta la mitad, pero tarda de minutos a horas.'],
    'Solo sale texto enmascarado.'] },
  deferred: { t: 'Lotes diferidos', b: [
    'Revisiones enviadas en **modo diferido**: el proveedor las procesa a mitad de precio cuando tiene capacidad (de minutos a 24 horas).',
    ['UMBRA pregunta por ellas cada minuto mientras la p\u00e1gina est\u00e1 abierta, y al volver a abrir el proyecto.',
      '**Comprobar**: preguntar ahora. **Cancelar**: anularlas en el proveedor. **Quitar**: borrar la tarjeta.',
      'Cuando llegan las respuestas, UMBRA termina sola la revisi\u00f3n (la pasada a fondo y el Verificador, al precio normal) y a\u00f1ade los hallazgos.'],
    'Puede cerrar la p\u00e1gina mientras tanto.'] },

  // ------------------------------------------------------------------ step 3: export
  'export-corrected': { t: 'Traducci\u00f3n revisada', b: [
    ['Aplica los hallazgos **ACEPTADOS** en Revisar.',
      '**DOCX con control de cambios y comentarios**: cada correcci\u00f3n es un cambio controlado de Word (puede aceptarlo o rechazarlo en Word) y los hallazgos sin aplicar van como comentarios.',
      '**Con los cambios aplicados**: documento limpio, sin marcas. Es lo que se obtiene en PPTX y XLSX.'],
    'El archivo original no se modifica: se descarga una copia.'] },
  'export-reports': { t: 'Informes', b: [
    ['**Informe HTML**: para leer o imprimir, con cada hallazgo, su estado y su contexto.',
      '**Informe Excel**: una fila por hallazgo, para filtrar u ordenar.',
      '**Hallazgos en JSON**: los datos en bruto, para guardarlos o procesarlos.'],
    'No incluyen los hallazgos descartados por el Verificador. Para valorar los hallazgos, use Revisar \u203a Exportar \u203a Hallazgos para valorar (Excel).'] },
  'export-masked': { t: 'Exportar enmascarado', b: [
    'El documento con etiquetas en lugar de los datos (mismo formato) o la tabla biling\u00fce enmascarada. Las mismas opciones est\u00e1n en el paso 1, en **Exportar enmascarado**.'] },
  'project-file': { t: 'Proyecto (.umbra)', b: [
    ['Un archivo **.umbra** guarda los dos documentos, las entidades y los hallazgos, para seguir otro d\u00eda o en otro equipo.',
      'Contiene el texto REAL: use **Guardar proyecto cifrado** si va a salir de su ordenador (la contrase\u00f1a no se puede recuperar).',
      '**Abrir proyecto** lo carga y lo deja como estaba.'],
    'Los proyectos tambi\u00e9n se guardan solos en este navegador (\ud83d\uddc2 en la cabecera).'] },

  // ------------------------------------------------------------------ settings: modules
  'module-settings': { t: 'M\u00f3dulos de revisi\u00f3n', b: [
    ['**Activo**: si se desactiva, el m\u00f3dulo no se ejecuta aunque est\u00e9 marcado en Revisar.',
      '**Modelo**: el proveedor y el modelo. **Cribado** repasa todo el texto (basta un modelo econ\u00f3mico); **A fondo** (Fidelidad e Integridad) usa un modelo m\u00e1s fuerte solo en lo que se\u00f1al\u00f3 el cribado. Para Fidelidad conviene un buen modelo \u00abA fondo\u00bb.',
      '**Exigencia**: **Solo lo importante** (errores cr\u00edticos o mayores; recomendado para Fidelidad e Integridad), **Normal** (tambi\u00e9n los menores) o **Exhaustiva** (tambi\u00e9n matices y mejoras opcionales). Lo que quede fuera de la exigencia se descarta aunque la IA lo devuelva.',
      '**Verificar**: los hallazgos del m\u00f3dulo pasan por el Verificador, que descarta falsos positivos y lo que no sea de la tarea del m\u00f3dulo.'],
    'Lo dem\u00e1s est\u00e1 en **Opciones avanzadas**: no hace falta tocarlo.'] },
  'module-advanced': { t: 'Opciones avanzadas', b: [
    ['**Razonamiento**: cu\u00e1nto \u00abpiensa\u00bb el modelo antes de responder. M\u00e1s razonamiento = mejor juicio, pero se cobra como salida.',
      '**Palabras por lote**: tama\u00f1o de cada env\u00edo. \u00abAuto\u00bb va bien.',
      '**Fusionar**: Fidelidad con Integridad, y Gram\u00e1tica con Estilo, comparten una llamada por lote si usan el mismo modelo (la entrada se paga una vez).',
      '**Presupuesto**: tope de gasto por ejecuci\u00f3n del m\u00f3dulo.'] ] },
  'module-prompts': { t: 'Instrucciones de cada m\u00f3dulo', b: [
    'Lo que se le pide a la IA en cada m\u00f3dulo. Puede ampliarlas o cambiarlas (por ejemplo, para insistir en algo) y volver a las de serie con **Restaurar las de serie**.',
    'El formato de respuesta y la explicaci\u00f3n de las etiquetas se a\u00f1aden siempre por su cuenta. Para indicaciones puntuales, mejor una regla de Estilo (Ajustes \u203a Reglas).'] },

  // ------------------------------------------------------------------ settings: providers
  providers: { t: 'Proveedores de IA', b: [
    'Cada proveedor es un perfil con su clave y sus modelos.',
    ['**Editar**: escriba o cambie la clave de API y la lista de modelos.',
      '**Probar conexi\u00f3n**: comprueba la clave y si el proveedor admite llamadas desde una p\u00e1gina web (CORS).',
      '**+ A\u00f1adir proveedor**: cualquier servicio compatible con OpenAI (OpenAI, OpenRouter, Groq, DeepSeek, Ollama\u2026), Azure o Anthropic.',
      '**Ocultar / Restaurar**: los de serie no se borran; se ocultan o vuelven a su estado inicial.'],
    'Las claves se guardan solo en este navegador. D\u00f3nde conseguirlas: en la web de cada proveedor (Google AI Studio para Gemini, console.mistral.ai para Mistral\u2026). El modelo de cada m\u00f3dulo se elige en Ajustes \u203a M\u00f3dulos.'] },
  'general-provider': { t: 'Proveedor general', b: [
    'El modelo que usa todo m\u00f3dulo que no tenga uno propio (o cuyo proveedor no tenga clave). Si no elige ninguno, se usa el primer proveedor con clave.'] },
  'provider-edit': { t: 'Perfil de proveedor', b: [
    ['**Tipo**: Gemini, Mistral, Anthropic, Azure o compatible con OpenAI (la mayor\u00eda de servicios). En los proveedores de serie est\u00e1 fijo (un perfil de Gemini es siempre Gemini): para otro servicio, use **+ A\u00f1adir proveedor**.',
      '**Clave de API**: se guarda solo en este navegador.',
      '**URL base**: la direcci\u00f3n de la API (por ejemplo, `https://api.openai.com/v1`); las plantillas la rellenan.',
      '**Confianza**: \u00abExterno\u00bb = servicio en Internet (solo recibe texto enmascarado); \u00abLocal\u00bb = un modelo en su propio equipo (Ollama, LM Studio\u2026).',
      '**Modelos**: escriba el nombre exacto de la API del modelo y pulse A\u00f1adir.',
      '**API de lotes** (compatibles con OpenAI): permite el modo diferido a mitad de precio.',
      '**Probar con**: comprueba la conexi\u00f3n con el modelo elegido.'] ] },
  'model-add': { t: 'A\u00f1adir un modelo', b: [
    'Escriba el nombre exacto que usa la API (est\u00e1 en la documentaci\u00f3n del proveedor, por ejemplo `gemini-2.5-flash`). El nombre visible y los precios son opcionales: sin precios, UMBRA busca los de la lista p\u00fablica.'] },

  // ------------------------------------------------------------------ settings: lists
  lists: { t: 'Listas de entidades', b: [
    'Deciden qu\u00e9 se enmascara (no se usan para revisar).',
    ['**Listas de serie**: unas 670 entidades (organismos, \u00f3rganos, pa\u00edses, lugares y cargos) en ingl\u00e9s, franc\u00e9s y espa\u00f1ol. Se pueden editar y restaurar.',
      '**Mi diccionario**: lo que usted a\u00f1ade (desde aqu\u00ed, con \u00abA mi diccionario\u00bb en una entidad o al enmascarar con [[Alt+E]]). Viaja en el archivo de sincronizaci\u00f3n.',
      'Cada entrada: categor\u00eda y sus formas (una por l\u00ednea: nombre completo, forma corta y siglas).',
      '**Exportar / Importar**: copia de seguridad o compartir el diccionario.'] ] },

  // ------------------------------------------------------------------ settings: sync
  'sync-file': { t: 'Archivo de sincronizaci\u00f3n', b: [
    'Lleva sus ajustes (proveedores y modelos, m\u00f3dulos, listas, diccionario, gasto\u2026) de un equipo a otro a trav\u00e9s de un archivo, por ejemplo en OneDrive.',
    ['**Crear archivo** la primera vez; en los dem\u00e1s equipos, **Elegir archivo** (el mismo).',
      'Con **Autoguardar**, UMBRA guarda unos segundos despu\u00e9s de cada cambio. **Guardar ahora** / **Traer del archivo** lo hacen a mano.',
      'Al traer, los datos se combinan con los de este equipo. Si no era la copia buena: **Deshacer lo tra\u00eddo**.',
      'Sin Chrome o Edge: **Descargar** aqu\u00ed y **Cargar** en el otro equipo.'],
    'Los documentos y proyectos no viajan; las claves de API, solo cifradas y si lo activa.'] },
  'sync-keys': { t: 'Claves de API en el archivo', b: [
    'Por defecto, las claves no viajan: se escriben una vez en cada equipo. Si activa la casilla, viajan cifradas con una contrase\u00f1a que en otro equipo se pide una sola vez. Nunca viajan en claro.'] },
  'sync-what': { t: 'Qu\u00e9 viaja y qu\u00e9 no', b: [
    'Al guardar o traer, los datos se combinan: en los ajustes gana el cambio m\u00e1s reciente, las listas se unen y los borrados se propagan. La tabla dice qu\u00e9 va en el archivo y qu\u00e9 se queda en este navegador.'] },
  'sync-device': { t: 'Este equipo', b: [
    'Un nombre para reconocer de d\u00f3nde viene cada copia (\u00ablo guard\u00f3 Oficina, ayer\u00bb). Sirve para no traer por error una copia vieja que OneDrive a\u00fan no ha actualizado. No viaja.'] },

  // ------------------------------------------------------------------ settings: usage, privacy
  usage: { t: 'Uso de IA y coste', b: [
    ['Lo que ha gastado cada llamada a la IA, por periodo y equipo.',
      'Las tarjetas dan los totales; debajo, el reparto por m\u00f3dulo, proyecto, modelo y d\u00eda.',
      '**Exportar a Excel**: el detalle, llamada a llamada.',
      'Lo enviado en **modo diferido** aparece como \u00ab(lotes \u221250 %)\u00bb.',
      'Una nota (\u270e) junto a un proyecto le ayuda a reconocerlo.'],
    'El coste se calcula con precios de lista: puede diferir algo de la factura del proveedor.'] },
  prices: { t: 'Precios', b: [
    'US$ por mill\u00f3n de tokens de cada modelo: entrada, en cach\u00e9 y salida. Vienen de la lista p\u00fablica de LiteLLM (**Buscar precios** la actualiza). Si escribe uno, manda el suyo.'] },
  privacy: { t: 'Privacidad', b: [
    ['Los documentos se procesan en este navegador; la web solo sirve el programa.',
      'A una IA solo llega texto ENMASCARADO: la salida rechaza el texto sin enmascarar, salvo hacia un proveedor marcado como local.',
      '\u00danica excepci\u00f3n: **Nombres oficiales** env\u00eda solo la lista de nombres de organismos, \u00f3rganos, cargos, pa\u00edses y lugares (nunca personas, cifras, fechas ni el texto). Se puede desactivar.',
      'Enmascarar reduce el riesgo, pero no lo elimina: el contexto puede delatar de qu\u00e9 se habla.'] ] },
  'browser-data': { t: 'Datos de este navegador', b: [
    ['**Vaciar la cach\u00e9 de resultados**: la pr\u00f3xima revisi\u00f3n de los mismos p\u00e1rrafos se volver\u00e1 a pagar.',
      '**Borrar todos los proyectos**: los guardados en este navegador (no los archivos .umbra).',
      '**Borrar todos los datos de UMBRA**: proyectos, ajustes, reglas, claves y gasto. Si tiene archivo de sincronizaci\u00f3n, podr\u00e1 traerlos de nuevo.'] ] }
};

export const HELP_TOPICS = T;

// ------------------------------------------------------------------ rendering

function _rich(s) {
  const out = [];
  for (const part of String(s).split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/)) {
    if (!part) continue;
    if (part.startsWith('**')) out.push(el('b', part.slice(2, -2)));
    else if (part.startsWith('`')) out.push(el('code', part.slice(1, -1)));
    else if (part.startsWith('[[')) out.push(el('kbd', part.slice(2, -2)));
    else out.push(document.createTextNode(part));
  }
  return out;
}

let _open = null;   // { pop, anchor, off }

export function closeHelp() {
  if (!_open) return;
  document.removeEventListener('mousedown', _open.off, true);
  window.removeEventListener('keydown', _open.key, true);
  _open.pop.remove();
  _open = null;
}

/** Opens the explanation of `topic` next to `anchor` (an element), or centred when there is none. */
export function showHelp(topic, anchor) {
  const h = T[topic];
  if (!h) return null;
  if (_open && _open.anchor && _open.anchor === anchor) { closeHelp(); return null; }   // second click closes
  closeHelp();
  const body = el('div.hb');
  for (const item of h.b) {
    if (Array.isArray(item)) body.appendChild(el('ul', item.map(li => el('li', _rich(li)))));
    else body.appendChild(el('p', _rich(item)));
  }
  const pop = el('div.help-pop', { role: 'dialog', 'aria-label': h.t, 'data-topic': topic },
    el('div.hh', el('span', '? ', h.t), el('span.grow'), el('button.icon-btn', { title: 'Cerrar', onclick: closeHelp }, '\u00d7')),
    body,
    el('div.hf', el('button.btn.link', { onclick: () => { closeHelp(); showGuide(); } }, 'Gu\u00eda completa'),
      el('span.muted', el('kbd', 'F1'), ' ayuda de esta pantalla')));
  document.body.appendChild(pop);
  // Position: under the anchor (or above it when there is no room), inside the window.
  const pr = pop.getBoundingClientRect();
  let x, y;
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    x = r.left - 12;
    y = r.bottom + 6;
    if (y + pr.height > window.innerHeight - 8 && r.top - pr.height - 6 > 8) y = r.top - pr.height - 6;
  } else {
    x = (window.innerWidth - pr.width) / 2;
    y = Math.max(8, (window.innerHeight - pr.height) / 3);
  }
  x = Math.max(8, Math.min(x, window.innerWidth - pr.width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - pr.height - 8));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  const off = (e) => { if (!pop.contains(e.target) && !(anchor && anchor.contains && anchor.contains(e.target))) closeHelp(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeHelp(); } };
  setTimeout(() => { if (_open && _open.pop === pop) document.addEventListener('mousedown', off, true); }, 0);
  window.addEventListener('keydown', key, true);   // before the dialogs' own Escape (on document)
  _open = { pop, anchor: anchor || null, off, key };
  return pop;
}

/** The "?" button. Clicking it never triggers what is under it (drop zones, cards, menus). */
export function helpBtn(topic, opts) {
  const o = opts || {};
  const title = 'C\u00f3mo se usa' + (T[topic] ? ': ' + T[topic].t.toLowerCase() : '');
  const b = el('button.help-btn' + (o.light ? '.light' : ''), { type: 'button', title, 'aria-label': title, 'data-help': topic,
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); showHelp(topic, e.currentTarget); } }, '?');
  return b;
}

/** A menu item that explains the options of that menu (for openMenu lists). */
export function helpItem(topic, anchor) {
  return { label: '? Qu\u00e9 hace cada opci\u00f3n', cls: 'help', onClick: () => showHelp(topic, anchor) };
}
