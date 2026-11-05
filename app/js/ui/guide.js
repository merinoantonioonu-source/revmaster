/**
 * guide.js - The built-in guide (the "?" button).
 */

import { el, modal } from '../util/dom.js';

export function showGuide() {
  const body = el('div',
    el('p', el('b', 'UMBRA'), ' enmascara los datos sensibles de una traducci\u00f3n y la revisa con IA. Todo ocurre en este navegador: los documentos no se suben a ning\u00fan servidor y a la IA solo llega texto enmascarado.'),
    el('h4', '1 \u00b7 Enmascarar'),
    el('ul',
      el('li', 'Cargue el original (ingl\u00e9s o franc\u00e9s) y la traducci\u00f3n (espa\u00f1ol): DOCX, PPTX o XLSX exportados de eLUNa.'),
      el('li', 'UMBRA sustituye cifras, fechas, organismos, \u00f3rganos, pa\u00edses, lugares, personas, cargos, s\u00edmbolos y direcciones por etiquetas, como ', el('code', '{CARGO1}'), ': la misma en el original y en la traducci\u00f3n. Al pasar el rat\u00f3n por una etiqueta se ve lo que oculta.'),
      el('li', 'La misma entidad tiene la misma etiqueta en las dos lenguas: si una cifra no coincide, aparece \u00abSin pareja\u00bb.'),
      el('li', 'Seleccione texto y pulse ', el('b', 'Alt+E'), ' para enmascararlo; clic derecho en una etiqueta para quitarla. \u00abVer original\u00bb muestra el texto real.'),
      el('li', '\u00abExportar enmascarado\u00bb crea el documento censurado (mismo formato), una tabla biling\u00fce o el texto listo para pegar en una IA externa.')),
    el('h4', '2 \u00b7 Revisar'),
    el('ul',
      el('li', 'Cada m\u00f3dulo es un revisor especializado con IA que se ci\u00f1e a su tarea: gram\u00e1tica, fidelidad de sentido, integridad (omisiones y adiciones), estilo, coherencia, convenciones de la ONU y lectura en fr\u00edo; el verificador descarta los falsos positivos. Se ejecutan juntos o por separado, y antes de gastar UMBRA muestra el plan con su coste estimado.'),
      el('li', 'Pulse una oraci\u00f3n de una hoja y se resalta con su pareja en la otra; \u2190 y \u2192 pasan a la anterior y a la siguiente. Pulse un hallazgo y las dos hojas van a su oraci\u00f3n.'),
      el('li', 'Modo diferido: en el plan de gasto, marque \u00abModo diferido (lotes)\u00bb y la primera pasada costar\u00e1 la mitad; las respuestas llegan en minutos u horas y UMBRA termina la revisi\u00f3n sola cuando vuelva a abrir el proyecto.'),
      el('li', 'Acepte (A), rechace (R) o edite (E) cada hallazgo; J y K pasan al siguiente y al anterior. \u29c9 Tabla abre los hallazgos en una ventana aparte.')),
    el('h4', '3 \u00b7 Exportar y ajustes'),
    el('ul',
      el('li', 'DOCX con control de cambios para lo aceptado y comentarios de Word para lo dem\u00e1s; PPTX y XLSX con los cambios aplicados; informes en HTML y Excel.'),
      el('li', 'Proveedores y modelos (uno por m\u00f3dulo), reglas (las de serie tambi\u00e9n se editan), listas de entidades, archivo de sincronizaci\u00f3n y uso de IA.')),
    el('p.info', el('b', 'Ayuda al momento:'), ' junto a cada funci\u00f3n hay un bot\u00f3n ', el('b', '?'), ' que explica c\u00f3mo se usa (tambi\u00e9n en los di\u00e1logos y al final de los men\u00fas). F1 abre la ayuda de la pantalla o del di\u00e1logo en el que est\u00e9.'),
    el('p.info', 'Ctrl+rueda del rat\u00f3n: sobre las hojas ampl\u00eda el documento; en el resto, los controles.'));
  return modal({ title: 'Gu\u00eda r\u00e1pida', body, width: '720px', buttons: [{ label: 'Entendido', kind: 'primary' }] });
}
