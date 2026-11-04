/**
 * help.js - Contextual help: a small "?" button next to each feature opens a short explanation of how
 * to use it (a popover, so the user keeps working). F1 opens the help of the current screen.
 *
 * Topic text uses a tiny markup: **bold**, `code`, [[key]] (keyboard key). A body item that is an
 * array becomes a bullet list.
 */

import { el } from '../util/dom.js';
import { MODULES } from '../review/module-list.js';
import { showGuide } from './guide.js';

const CARD_TIP = ['**Casilla**: el m\u00f3dulo entra en **\u25b6 Ejecutar seleccionados**.',
  '**Pastilla del modelo**: p\u00falsela para cambiar el proveedor o el modelo, o para a\u00f1adir uno.',
  'Debajo, los tokens y el coste estimados.',
  '**Ejecutar**: solo este m\u00f3dulo. **\u2691 n**: sus hallazgos pendientes.'];

const T = {
  // ------------------------------------------------------------------ files and start
  files: { t: 'Cargar los documentos', b: [
    'Pulse una casilla o arrastre a ella el archivo: a la izquierda el **original** (ingl\u00e9s o franc\u00e9s) y a la derecha la **traducci\u00f3n** (espa\u00f1ol).',
    ['Formatos: DOCX, PPTX y XLSX exportados de eLUNa.',
      'UMBRA empareja los p\u00e1rrafos de los dos documentos y enmascara al momento.',
      'Para cambiar un archivo, vuelva a pulsar su casilla.',
      'El proyecto se guarda solo en este navegador; para volver a \u00e9l, pulse \ud83d\uddc2 (Proyectos guardados) en la cabecera.',
      'Los archivos no salen de su ordenador: a una IA solo llega texto enmascarado.'] ] },

  // ------------------------------------------------------------------ step 1: mask
  'mask-tools': { t: 'Barra de enmascarado', b: [
    ['**Categor\u00edas** (Cifras, Fechas, Organismos\u2026): pulse una para dejar de enmascararla o para volver a hacerlo. Las apagadas salen en gris.',
      'El resumen dice cu\u00e1ntas entidades hay, cu\u00e1ntas est\u00e1n **por revisar** y cu\u00e1ntas **cifras sin pareja** (una cifra que no est\u00e1 igual en las dos lenguas: posible error).',
      '**Original: ingl\u00e9s / franc\u00e9s**: la lengua del original.',
      '**Opciones**: n\u00fameros en letra, siglas desconocidas y deshacer lo hecho a mano.',
      '**\ud83d\udc41 Ver original / Ver etiquetas**: alterna entre las etiquetas y el texto real.',
      '**+ Enmascarar selecci\u00f3n** ([[Alt+E]]): enmascara lo que haya seleccionado en una hoja.',
      '**Exportar enmascarado**: documentos censurados, tabla biling\u00fce, texto para una IA externa y mapa de claves.'] ] },
  'mask-options': { t: 'Opciones de enmascarado', b: [
    ['**N\u00fameros escritos en letra** (\u00abdoscientos\u00bb, \u00abthree\u00bb\u2026): se enmascaran como cifras.',
      '**Siglas desconocidas presentes en ambos textos**: una sigla que no est\u00e1 en las listas pero aparece igual en el original y en la traducci\u00f3n se enmascara.',
      '**Volver a enmascarar todo lo que se quit\u00f3 a mano**: anula los \u00abNo enmascarar\u00bb.',
      '**Deshacer todas las fusiones**: separa las entidades que se fusionaron.',
      '**Quitar los t\u00e9rminos a\u00f1adidos a mano en este proyecto**: borra lo enmascarado con [[Alt+E]] (su diccionario personal no cambia).'] ] },
  'mask-export': { t: 'Exportar enmascarado', b: [
    ['**Original / Traducci\u00f3n enmascarada**: el mismo documento, en su formato, con etiquetas en lugar de los datos. Sirve para enviarlo a una IA o a otra persona sin datos sensibles.',
      '**Tabla biling\u00fce (XLSX o HTML)**: original y traducci\u00f3n enmascarados, p\u00e1rrafo a p\u00e1rrafo.',
      '**Copiar para IA externa**: el texto enmascarado con las instrucciones de revisi\u00f3n, para pegarlo en ChatGPT, Gemini, Claude\u2026',
      '**Importar respuesta de IA externa**: convierte la respuesta de esa IA en hallazgos de Revisar.',
      '**Mapa de claves**: la lista etiqueta \u2192 texto real. Contiene los datos reales: p\u00f3ngale contrase\u00f1a y gu\u00e1rdelo aparte.'] ] },
  entities: { t: 'Entidades del documento', b: [
    'Cada tarjeta es una entidad con su etiqueta (`{el CARGO1}`), su estado y sus formas: **O:** en el original y **T:** en la traducci\u00f3n (\u00d7n = veces).',
    ['**OK**: todo cuadra.',
      '**Sin pareja**: est\u00e1 en una lengua y no en la otra. Compruebe si falta, si sobra o si hay que fusionarla con otra.',
      '**Recuento distinto**: aparece un n\u00famero de veces distinto en cada lengua.',
      '**Formas distintas**: la traducci\u00f3n la nombra de varias maneras; revise la coherencia.'],
    'Las burbujas de arriba filtran (Todas, Por revisar o una categor\u00eda). Pulse una tarjeta para resaltar la entidad en las hojas. Botones:',
    ['**Categor\u00eda** y **Art\u00edculo** (el, la, los, las: el que lleva la etiqueta de la traducci\u00f3n).',
      '**Fusionar\u2026**: dos etiquetas que son la misma entidad.',
      '**A mi diccionario**: se enmascarar\u00e1 en todos los documentos.',
      '**No enmascarar**: la deja como texto normal.'] ] },
  sheets: { t: 'Las dos hojas', b: [
    'A la izquierda, el original; a la derecha, la traducci\u00f3n, con las etiquetas en color (las de la traducci\u00f3n llevan el art\u00edculo).',
    ['Pulse un p\u00e1rrafo para ver su pareja en la otra hoja; pulse una etiqueta para ver su entidad.',
      '**Para enmascarar algo que UMBRA no ha detectado**: selecci\u00f3nelo y pulse [[Alt+E]], o clic derecho \u203a **Enmascarar la selecci\u00f3n\u2026**',
      '**Clic derecho en una etiqueta**: no enmascarar esa aparici\u00f3n o la entidad en todo el documento.',
      '**Buscar\u2026**: salta al primer p\u00e1rrafo que contiene el texto.',
      'Las etiquetas en rojo no tienen pareja en la otra lengua.',
      '[[Ctrl]]+rueda del rat\u00f3n sobre las hojas ampl\u00eda el texto.'] ] },
  'mask-selection': { t: 'Enmascarar una selecci\u00f3n', b: [
    'Se enmascaran todas las apariciones del texto en esa hoja.',
    ['**Categor\u00eda**: la que mejor encaje; si ninguna, Personalizada.',
      '**Art\u00edculo en espa\u00f1ol**: el que llevar\u00e1 la etiqueta en la traducci\u00f3n (`{la X1}`).',
      '**Es la misma entidad que**: si la otra lengua ya est\u00e1 enmascarada, el\u00edjala aqu\u00ed para que las dos formen pareja.',
      '**Forma en la otra lengua**: c\u00f3mo aparece en el otro documento, para enmascararla tambi\u00e9n. Si esa forma ya est\u00e1 enmascarada, la pareja se elige sola.',
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
  merge: { t: 'Fusionar entidades', b: [
    'Para cuando UMBRA ha dado dos etiquetas a una sola entidad: por ejemplo, la sigla del original (UNDP) y el nombre completo de la traducci\u00f3n (Programa de las Naciones Unidas para el Desarrollo).',
    'La etiqueta elegida absorbe a la otra y las dos lenguas quedan emparejadas. Para deshacerlo: Opciones \u203a Deshacer todas las fusiones.'] },

  // ------------------------------------------------------------------ step 2: review
  'review-tools': { t: 'Barra de revisi\u00f3n', b: [
    ['El resumen cuenta los hallazgos pendientes por gravedad: cr\u00edticos, mayores, menores y sugerencias.',
      '**Perfil de reglas**: aplica solo las reglas de un tipo de documento (los perfiles se crean en Ajustes \u203a Reglas).',
      '**\u25b6 Ejecutar seleccionados**: ejecuta los m\u00f3dulos marcados en sus tarjetas. Antes de gastar, ense\u00f1a el plan con el coste estimado. **\u25a0 Detener** para a mitad.',
      '**M\u00e1s**: IA externa, verificar hallazgos y atajos a los ajustes.',
      '**Exportar**: la traducci\u00f3n corregida (DOCX con control de cambios y comentarios) y los informes.'],
    'Consejo: empiece por la **Capa 0** (gratis); lo que se\u00f1ale ayuda a los m\u00f3dulos con IA.'] },
  'review-more': { t: 'Men\u00fa M\u00e1s', b: [
    ['**Copiar para IA externa / Importar respuesta**: revisar con una IA de chat sin clave.',
      '**Verificar los hallazgos pendientes de la IA**: los manda al Verificador, que descarta los falsos positivos. Cuesta poco: solo env\u00eda los hallazgos con su contexto.',
      '**Configurar m\u00f3dulos y modelos / Editar reglas**: atajos a Ajustes.'] ] },
  'review-export': { t: 'Exportar la revisi\u00f3n', b: [
    ['**DOCX con control de cambios y comentarios**: los hallazgos ACEPTADOS entran como cambios controlados (que acepta o rechaza en Word) y los dem\u00e1s, como comentarios de Word.',
      '**Sin comentarios**: solo los cambios.',
      '**Con los cambios aplicados**: documento limpio. Es la opci\u00f3n de PPTX y XLSX, que no tienen control de cambios.',
      '**Informe HTML o Excel**: todos los hallazgos, salvo los descartados por el Verificador. **JSON**: los datos en bruto.'] ] },
  findings: { t: 'Hallazgos', b: [
    'Cada tarjeta muestra la gravedad (**CRI** cr\u00edtico, **MAY** mayor, **MEN** menor, **SUG** sugerencia), el m\u00f3dulo, el p\u00e1rrafo (\u00a7), la cita tachada \u2192 la propuesta, el motivo y el origen (Sin IA, Regla, el modelo, a fondo, cach\u00e9 o IA externa).',
    ['**Aceptar** [[A]]: se aplicar\u00e1 al exportar. Si est\u00e1 desactivado, no hay propuesta o no se encontr\u00f3 la cita: use Editar.',
      '**Editar** [[E]]: corrija la propuesta (queda aceptada); UMBRA ofrece convertirla en regla.',
      '**Rechazar** [[R]]: ofrece \u00abNo volver a se\u00f1alarlo\u00bb (crea una regla de ignorar). **Ignorar**: lo aparta sin m\u00e1s.',
      '[[J]] / [[K]]: siguiente y anterior. **Deshacer** devuelve un hallazgo decidido a pendientes.',
      'Burbujas: filtran por estado, m\u00f3dulo y gravedad. **Descartados** = los que el Verificador consider\u00f3 falsos.',
      '**\u22ef**: aceptar o rechazar en bloque los visibles, o borrar los pendientes de la IA.'],
    'Solo lo ACEPTADO se aplica al exportar.'] },
  'review-sheets': { t: 'Hojas de revisi\u00f3n', b: [
    ['La traducci\u00f3n lleva subrayados los hallazgos visibles, con el color de su gravedad: pulse uno para verlo en la lista.',
      'Una marca \u00ab+ omisi\u00f3n\u00bb al final de un p\u00e1rrafo indica algo que falta.',
      'A la izquierda, el original del mismo documento.',
      'Solo se marcan los hallazgos que pasan los filtros de la lista.'] ] },
  plan: { t: 'Plan de ejecuci\u00f3n', b: [
    'Lo que se va a enviar, antes de gastar nada:',
    ['Lotes por m\u00f3dulo (dos m\u00f3dulos \u00abfusionados\u00bb comparten llamada), el modelo del cribado y el de la pasada a fondo.',
      'P\u00e1rrafos **en cach\u00e9**: ya revisados con el mismo texto y las mismas reglas; no se pagan otra vez. **Repetidos**: se revisan una vez.',
      'Total aproximado de llamadas, tokens y coste (precios de lista). El gasto real queda en Uso de IA.',
      '**Presupuesto m\u00e1ximo**: UMBRA deja de enviar al llegar a esa cifra (vac\u00edo = sin l\u00edmite).',
      '**Modo diferido (lotes)**: la primera pasada cuesta la mitad, pero tarda de minutos a horas.'],
    'Solo sale texto enmascarado.'] },
  semantic: { t: 'Similitud sem\u00e1ntica', b: [
    'Compara el sentido de cada oraci\u00f3n del original con las de la traducci\u00f3n, sin gastar en modelos de texto. Una oraci\u00f3n sin equivalente es una posible **omisi\u00f3n** (o **adici\u00f3n**).',
    ['**En este navegador**: gratis y privado. La primera vez descarga unos 140 MB (el motor y el modelo) y luego los guarda.',
      '**Con un proveedor**: muy barato y r\u00e1pido; solo env\u00eda texto enmascarado.',
      '**No usarla**: la Capa 0 sigue con sus comprobaciones de longitud y oraciones.'],
    'Se cambia cuando quiera en Ajustes \u203a M\u00f3dulos \u203a Capa 0. Los p\u00e1rrafos sospechosos pasan adem\u00e1s al modelo \u00aba fondo\u00bb de Integridad y Fidelidad.'] },
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
    'No incluyen los hallazgos descartados por el Verificador.'] },
  'export-masked': { t: 'Exportar enmascarado', b: [
    'El documento con etiquetas en lugar de los datos (mismo formato) o la tabla biling\u00fce enmascarada. Las mismas opciones est\u00e1n en el paso 1, en **Exportar enmascarado**.'] },
  'project-file': { t: 'Proyecto (.umbra)', b: [
    ['Un archivo **.umbra** guarda los dos documentos, las entidades y los hallazgos, para seguir otro d\u00eda o en otro equipo.',
      'Contiene el texto REAL: use **Guardar proyecto cifrado** si va a salir de su ordenador (la contrase\u00f1a no se puede recuperar).',
      '**Abrir proyecto** lo carga y lo deja como estaba.'],
    'Los proyectos tambi\u00e9n se guardan solos en este navegador (\ud83d\uddc2 en la cabecera).'] },

  // ------------------------------------------------------------------ settings: modules
  layer0: { t: 'Capa 0 (sin IA)', b: [
    ['**Corrector ortogr\u00e1fico**: diccionario espa\u00f1ol de Hunspell en el navegador. Si marca una palabra correcta, rech\u00e1cela con \u00abNo volver a se\u00f1alarlo\u00bb.',
      '**Similitud sem\u00e1ntica**: busca oraciones sin equivalente (omisiones y adiciones). \u00abPreguntar la primera vez\u00bb, desactivada, en este navegador o con un proveedor.',
      '**Sensibilidad**: \u00abAlta\u00bb da m\u00e1s avisos (y m\u00e1s falsos positivos).',
      '**Modelo local**: el de serie es multiling\u00fce; solo c\u00e1mbielo si sabe lo que hace.',
      '**Proveedor y modelo de embeddings**: solo para el modo con proveedor (Gemini, Mistral u OpenAI).'] ] },
  'module-settings': { t: 'Ajustes de los m\u00f3dulos', b: [
    ['**Activo**: si se desactiva, el m\u00f3dulo no se ejecuta aunque est\u00e9 marcado.',
      '**Razonamiento**: cu\u00e1nto \u00abpiensa\u00bb el modelo antes de responder. M\u00e1s razonamiento = mejor juicio, pero se cobra como salida.',
      '**Palabras por lote**: tama\u00f1o de cada env\u00edo. \u00abAuto\u00bb va bien; lotes m\u00e1s grandes ahorran instrucciones repetidas, pero el modelo puede pasar cosas por alto.',
      '**Fusionar**: Fidelidad con Integridad, y Gram\u00e1tica con Estilo, comparten una llamada por lote si usan el mismo modelo (la entrada se paga una vez).',
      '**Verificar**: los hallazgos del m\u00f3dulo pasan por el Verificador, que descarta falsos positivos.',
      '**Presupuesto**: tope de gasto por ejecuci\u00f3n del m\u00f3dulo.'] ] },
  'module-prompts': { t: 'Instrucciones de cada m\u00f3dulo', b: [
    'Lo que se le pide a la IA en cada m\u00f3dulo. Puede ampliarlas o cambiarlas (por ejemplo, para insistir en algo) y volver a las de serie con **Restaurar las de serie**.',
    'El formato de respuesta y la explicaci\u00f3n de las etiquetas se a\u00f1aden siempre por su cuenta. Para indicaciones puntuales, mejor una regla de Estilo (Ajustes \u203a Reglas).'] },

  // ------------------------------------------------------------------ settings: providers
  providers: { t: 'Proveedores de IA', b: [
    'Cada proveedor es un perfil con su clave y sus modelos.',
    ['**Editar**: escriba o cambie la clave de API y la lista de modelos.',
      '**Probar conexi\u00f3n**: comprueba la clave y si el proveedor admite llamadas desde una p\u00e1gina web (CORS).',
      '**+ A\u00f1adir proveedor**: cualquier servicio compatible con OpenAI (OpenRouter, Groq, DeepSeek, Ollama\u2026), Azure o Anthropic.',
      '**Ocultar / Restaurar**: los de serie no se borran; se ocultan o vuelven a su estado inicial.'],
    'Las claves se guardan solo en este navegador. D\u00f3nde conseguirlas: en la web de cada proveedor (Google AI Studio para Gemini, console.mistral.ai para Mistral\u2026).'] },
  'general-provider': { t: 'Proveedor general', b: [
    'El modelo que usa todo m\u00f3dulo que no tenga uno propio (o cuyo proveedor no tenga clave). Si no elige ninguno, se usa el primer proveedor con clave.'] },
  'module-models': { t: 'Modelo por m\u00f3dulo', b: [
    ['**Cribado**: pasada econ\u00f3mica por todo el texto. Un modelo r\u00e1pido y barato basta.',
      '**A fondo**: modelo fuerte solo sobre lo que se\u00f1alaron el cribado o la Capa 0 (Fidelidad e Integridad; el Verificador usa este).',
      '**General**: usa el proveedor general.'],
    'Tambi\u00e9n se cambia desde la tarjeta de cada m\u00f3dulo, en Revisar (la pastilla del modelo).'] },
  'provider-edit': { t: 'Perfil de proveedor', b: [
    ['**Tipo**: Gemini, Mistral, Anthropic, Azure o compatible con OpenAI (la mayor\u00eda de servicios).',
      '**Clave de API**: se guarda solo en este navegador.',
      '**URL base**: la direcci\u00f3n de la API (por ejemplo, `https://api.openai.com/v1`); las plantillas la rellenan.',
      '**Confianza**: \u00abExterno\u00bb = servicio en Internet (solo recibe texto enmascarado); \u00abLocal\u00bb = un modelo en su propio equipo (Ollama, LM Studio\u2026).',
      '**Modelos**: escriba el nombre exacto de la API del modelo y pulse A\u00f1adir.',
      '**API de lotes** (compatibles con OpenAI): permite el modo diferido a mitad de precio.',
      '**Probar con**: comprueba la conexi\u00f3n con el modelo elegido.'] ] },
  'model-add': { t: 'A\u00f1adir un modelo', b: [
    'Escriba el nombre exacto que usa la API (est\u00e1 en la documentaci\u00f3n del proveedor, por ejemplo `gemini-2.5-flash`). El nombre visible y los precios son opcionales: sin precios, UMBRA busca los de la lista p\u00fablica.'] },

  // ------------------------------------------------------------------ settings: rules and lists
  rules: { t: 'Reglas', b: [
    'Indicaciones fijas para la revisi\u00f3n: las de serie (que puede editar, desactivar y restaurar) y las suyas.',
    ['**Expresi\u00f3n**: si el original dice X, la traducci\u00f3n debe decir Y.',
      '**Prohibido**: una forma que no debe aparecer.',
      '**Patr\u00f3n**: expresi\u00f3n regular sobre la traducci\u00f3n (avanzado).',
      '**Estilo** y **Estructura**: instrucci\u00f3n libre que viaja a la IA en cada llamada (sea breve: cuesta tokens).',
      '**Ignorar**: silencia los hallazgos que citen esa forma.'],
    'Expresi\u00f3n, Prohibido, Patr\u00f3n e Ignorar se comprueban sin IA. La casilla activa o desactiva cada regla. **M\u00e1s**: restaurar las de serie, exportar o importar (JSON o lista de Xbench).'] },
  profiles: { t: 'Perfiles', b: [
    'Un perfil es un juego de reglas para un tipo de documento (por ejemplo, \u00abResoluci\u00f3n\u00bb o \u00abInforme\u00bb).',
    ['Cr\u00e9elo aqu\u00ed y m\u00e1rquelo en las reglas que le correspondan.',
      'Una regla sin perfiles se aplica siempre.',
      'El perfil del proyecto se elige en Revisar, en la barra.'] ] },
  'rule-edit': { t: 'Editar una regla', b: [
    ['**Tipo**: cambia los campos (debajo se explica cada tipo).',
      'En las formas, separe variantes con `|` y use `*` para \u00abcualquier final\u00bb: `stakeholder*|partie* prenante*`.',
      '**Gravedad**: c\u00f3mo se mostrar\u00e1 el hallazgo.',
      '**Nota**: explica la regla; en Estilo y Estructura es lo que se env\u00eda a la IA.',
      '**M\u00f3dulos**: en cu\u00e1les se aplica. **Perfiles**: ninguno = siempre.',
      '**Probar en el documento**: muestra qu\u00e9 se\u00f1alar\u00eda en el documento abierto.'] ] },
  lists: { t: 'Listas de entidades', b: [
    'Deciden qu\u00e9 se enmascara y con qu\u00e9 art\u00edculo.',
    ['**Listas de serie**: organismos, \u00f3rganos, pa\u00edses, cargos\u2026 en ingl\u00e9s, franc\u00e9s y espa\u00f1ol. Se pueden editar y restaurar.',
      '**Mi diccionario**: lo que usted a\u00f1ade (desde aqu\u00ed, con \u00abA mi diccionario\u00bb en una entidad o al enmascarar con [[Alt+E]]). Viaja en el archivo de sincronizaci\u00f3n.',
      'Cada entrada: categor\u00eda, art\u00edculo y sus formas (una por l\u00ednea: nombre completo, forma corta y siglas).',
      '**Exportar / Importar**: copia de seguridad o compartir el diccionario.'] ] },

  // ------------------------------------------------------------------ settings: sync
  'sync-file': { t: 'Archivo de sincronizaci\u00f3n', b: [
    'Lleva sus ajustes (reglas, proveedores y modelos, listas, diccionario, gasto\u2026) de un equipo a otro a trav\u00e9s de un archivo, por ejemplo en OneDrive.',
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
      'Enmascarar reduce el riesgo, pero no lo elimina: el contexto puede delatar de qu\u00e9 se habla.'] ] },
  'browser-data': { t: 'Datos de este navegador', b: [
    ['**Vaciar la cach\u00e9 de resultados**: la pr\u00f3xima revisi\u00f3n de los mismos p\u00e1rrafos se volver\u00e1 a pagar.',
      '**Borrar todos los proyectos**: los guardados en este navegador (no los archivos .umbra).',
      '**Borrar todos los datos de UMBRA**: proyectos, ajustes, reglas, claves y gasto. Si tiene archivo de sincronizaci\u00f3n, podr\u00e1 traerlos de nuevo.'] ] }
};

// One topic per review module, built from the module list plus what it means in practice.
const MOD_EXTRA = {
  local: ['Gratis e instant\u00e1nea: no env\u00eda nada a ninguna IA. Comprueba cifras y etiquetas que no coinciden, p\u00e1rrafos que faltan o est\u00e1n sin traducir, diferencias de longitud y de n\u00famero de oraciones (posibles omisiones), paralelismo de listas, palabras repetidas, limpieza (espacios, signos), convenciones de cifras y resoluciones, ortograf\u00eda y las reglas que no necesitan IA.',
    'Ejec\u00fatela siempre primero: lo que se\u00f1ala sobre omisiones lo miran despu\u00e9s a fondo Integridad y Fidelidad.'],
  grammar: ['Lee solo la traducci\u00f3n. Ortograf\u00eda, concordancia, r\u00e9gimen preposicional, tiempos verbales y puntuaci\u00f3n.',
    'Un modelo econ\u00f3mico basta. Se fusiona con Estilo si usan el mismo modelo.'],
  fidelity: ['Lee el original y la traducci\u00f3n (enmascarados). Errores de sentido, falsos amigos, modalidad (shall, should, may\u2026), negaciones, qui\u00e9n hace qu\u00e9 e intensidad.',
    'Dos modelos: **Cribado** (econ\u00f3mico, todo el texto) y **A fondo** (fuerte, solo lo se\u00f1alado). Se fusiona con Integridad.'],
  integrity: ['Lee el original y la traducci\u00f3n (enmascarados). Busca lo que falta y lo que sobra.',
    'Cribado + a fondo, como Fidelidad. Recibe adem\u00e1s los p\u00e1rrafos que la Capa 0 marc\u00f3 como sospechosos.'],
  style: ['Lee solo la traducci\u00f3n. Calcos, pasivas, gerundios, nominalizaciones, registro institucional y claridad.',
    'Se fusiona con Gram\u00e1tica si usan el mismo modelo.'],
  coherence: ['Trabaja con el **esqueleto**: un resumen del documento (t\u00edtulos, listas, comienzos de p\u00e1rrafo y expresiones repetidas) en una sola llamada, as\u00ed que es barato.',
    'Se\u00f1ala etiquetas tratadas de forma distinta, listas sin paralelismo (verbos y sustantivos) y expresiones repetidas traducidas de varias maneras.'],
  conventions: ['Trabaja con el esqueleto. Convenciones de la ONU: pre\u00e1mbulo y parte dispositiva de las resoluciones, cursivas, f\u00f3rmulas fijas, cifras, fechas y s\u00edmbolos.'],
  coldread: ['Lee la traducci\u00f3n **sin el original**, como un lector nuevo, y se\u00f1ala lo que no se entiende o suena a traducci\u00f3n.',
    '\u00daselo al final, con un buen modelo.'],
  verifier: ['No revisa el texto: revisa los **hallazgos** de los dem\u00e1s m\u00f3dulos y descarta los falsos positivos (o mejora la propuesta: \u00ab\u270e verificado\u00bb).',
    'Se activa por m\u00f3dulo en Ajustes \u203a M\u00f3dulos (columna Verificar) o a mano con su bot\u00f3n **Verificar**. Lo descartado va a la burbuja \u00abDescartados\u00bb.']
};
for (const m of MODULES) {
  const tips = m.ai ? CARD_TIP : [CARD_TIP[0], '**Ejecutar**: solo la Capa 0. **\u2691 n**: sus hallazgos pendientes.'];
  T['mod-' + m.id] = { t: m.label, b: [].concat(MOD_EXTRA[m.id] || [m.desc], m.id === 'verifier' ? [] : ['En la tarjeta:', tips]) };
}

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
