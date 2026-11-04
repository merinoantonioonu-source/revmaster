# UMBRA — Registro de cambios aplicados

Este archivo es un registro APPEND-ONLY: solo se añaden líneas al final y nunca se borran ni se
reescriben las existentes. Cada cambio añade UNA línea a la tabla, para saber con certeza qué
contiene cada estado del repositorio.

| Fecha | Cambio | Resumen |
|---|---|---|
| 2026-11-04 | propuesta_inicial | Nombre (UMBRA), propuesta de diseño completa (docs/PROPUESTA.md), maqueta estática de las tres pantallas (docs/maqueta.html), README y este registro. Sin código de la aplicación. |
| 2026-11-04 | propuesta_v2_decisiones | Propuesta v2 con las decisiones del usuario: web en GitHub Pages (no extension), formatos DOCX/PPTX/XLSX de eLUNa, EN/FR -> ES, etiquetas {la ORGANO2} (articulo dentro, numero pegado), modulos: 5 minimos + Convenciones ONU, Verificador y Lectura en frio (sin Terminologia), reglas de serie editables, archivo de sincronizacion copiado de COMeT, seguimiento del gasto como COMeT, proveedores y modelos anadibles sobre la marcha, comprobacion de CORS. Maqueta y README actualizados. Sin codigo de la aplicacion. |
| 2026-11-04 | v1_app_completa | Primera version completa de la app web (app/): enmascarado EN/FR->ES con etiquetas {la ORGANO2} para DOCX, PPTX y XLSX (detectores, 670 entidades trilingues, panel de entidades, Alt+E, exportaciones, IA externa); revision con Capa 0 sin IA (incluye corrector ortografico Hunspell) y 8 modulos con IA (fusion, cascada, cache, verificador, presupuesto, plan previo); reglas de serie editables (164) y propias; proveedores y modelos por modulo (Gemini, Mistral, Azure, Anthropic, compatibles con OpenAI); seguimiento del gasto y archivo de sincronizacion copiados de COMeT; DOCX con control de cambios y comentarios; informes; proyecto .umbra; publicacion en GitHub Pages; pruebas automaticas. |
| 2026-11-04 | fase6_lotes_y_similitud | Fase 6 completa: modo diferido (lotes asincronos, -50 %) para Gemini, Anthropic, Mistral y OpenAI (opcion en el plan de gasto, tarjeta de seguimiento, reanuda tras cerrar la pagina, gasto anotado a mitad de precio) y similitud semantica en la Capa 0 (motor local en el navegador con transformers.js o embeddings por API con texto enmascarado; sus parrafos sospechosos pasan al modelo a fondo). Casilla de API de lotes en los perfiles compatibles con OpenAI. Pruebas: tests/phase6.e2e.mjs. |
| 2026-11-04 | enmascarar_con_clic_derecho | Clic derecho sobre el texto seleccionado en una hoja: "Enmascarar la seleccion..." (ademas de Alt+E y del boton). Al escribir la forma en la otra lengua de una entidad ya enmascarada, se empareja sola con ella. |
