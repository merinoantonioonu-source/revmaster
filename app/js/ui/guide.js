/**
 * guide.js - The built-in guide ("Gu\u00eda" at the foot of the side bar): the five steps in plain words.
 */

import { el, modal } from '../util/dom.js';

export function showGuide() {
  const body = el('div',
    el('p', el('b', 'UMBRA'), ' enmascara los datos sensibles de una traducci\u00f3n y la revisa con IA. Todo ocurre en este navegador: los documentos no se suben a ning\u00fan servidor y a la IA solo llega texto enmascarado (salvo en un proyecto marcado \u00abSin enmascarar\u00bb en Archivos, para textos ya publicados). La barra de la izquierda tiene los cinco pasos y dice en qu\u00e9 punto est\u00e1 cada uno.'),
    el('h4', '1 \u00b7 Archivos'),
    el('ul',
      el('li', 'Cargue el original (ingl\u00e9s o franc\u00e9s) y la traducci\u00f3n (espa\u00f1ol): DOCX, PPTX o XLSX exportados de eLUNa.'),
      el('li', 'Los proyectos se guardan solos en este navegador: vuelva a ellos desde Proyectos recientes o con Proyectos, al pie de la barra.')),
    el('h4', '2 \u00b7 Enmascarar'),
    el('ul',
      el('li', 'UMBRA sustituye cifras, fechas, organismos, \u00f3rganos, pa\u00edses, lugares, personas, cargos, s\u00edmbolos y direcciones por etiquetas, como ', el('code', '{CARGO1}'), ': la misma en el original y en la traducci\u00f3n. Al pasar el rat\u00f3n por una etiqueta se ve lo que oculta.'),
      el('li', 'Si una cifra no coincide en las dos lenguas, aparece \u00abSin pareja\u00bb. Seleccione texto y pulse ', el('b', 'Alt+E'), ' para enmascararlo; clic derecho en una etiqueta para quitarla.')),
    el('h4', '3 \u00b7 Revisar'),
    el('ul',
      el('li', 'Cada tarjeta es un revisor con IA que se ci\u00f1e a su tarea: Sentido (lo que la traducci\u00f3n dice distinto, omite o a\u00f1ade), Redacci\u00f3n (el espa\u00f1ol: gram\u00e1tica y estilo institucional), Nombres oficiales y el Verificador, que descarta los falsos positivos. Elija los que quiera y su exigencia, y pulse \u00abRevisar ahora\u00bb: antes de gastar, UMBRA muestra el plan con su coste.')),
    el('h4', '4 \u00b7 Corregir'),
    el('ul',
      el('li', 'Una fila por segmento con hallazgos, con el original y la traducci\u00f3n lado a lado; a la derecha, el hallazgo elegido con su propuesta, que puede cambiar.'),
      el('li', 'Acepte (A), rechace (R) o edite (E); J y K pasan al siguiente y al anterior. \u00abDocumento\u00bb muestra las dos hojas completas: pulse una oraci\u00f3n y se resalta con su pareja; \u2190 y \u2192 recorren las oraciones.')),
    el('h4', '5 \u00b7 Exportar'),
    el('ul',
      el('li', 'DOCX con control de cambios para lo aceptado y comentarios de Word para lo dem\u00e1s; PPTX y XLSX con los cambios aplicados; informes en HTML y Excel; el proyecto en un archivo .umbra.')),
    el('p.info', el('b', 'Ajustes y proveedores'), ', al pie de la barra: proveedores y modelos (uno por m\u00f3dulo), listas de entidades, archivo de sincronizaci\u00f3n y uso de IA.'),
    el('p.info', el('b', 'Ayuda al momento:'), ' junto a cada funci\u00f3n hay un bot\u00f3n ', el('b', '?'), ' que explica c\u00f3mo se usa (tambi\u00e9n en los di\u00e1logos y al final de los men\u00fas). F1 abre la ayuda de la pantalla o del di\u00e1logo en el que est\u00e9.'),
    el('p.info', 'Ctrl+rueda del rat\u00f3n: sobre el texto ampl\u00eda el documento; en el resto, los controles.'));
  return modal({ title: 'Gu\u00eda r\u00e1pida', body, width: '720px', buttons: [{ label: 'Entendido', kind: 'primary' }] });
}
