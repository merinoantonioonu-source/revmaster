#!/usr/bin/env node
/**
 * run-all.mjs - Runs every UMBRA test, one after the other, and fails if any fails.
 *   node tests/run-all.mjs
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const steps = [
  ['ASCII', 'python3', ['-I', path.join(ROOT, 'tools', 'asciify.py'), '--check']],
  ['Formatos', 'node', [path.join(HERE, 'formats.test.mjs')]],
  ['IA y sincronizacion', 'node', [path.join(HERE, 'ai-sync.test.mjs')]],
  ['Aplicacion completa', 'node', [path.join(HERE, 'app.e2e.mjs')]],
  ['Fase 6 (lotes diferidos)', 'node', [path.join(HERE, 'phase6.e2e.mjs')]],
  ['Ayuda contextual', 'node', [path.join(HERE, 'help.e2e.mjs')]],
  ['Navegacion por segmentos', 'node', [path.join(HERE, 'nav.e2e.mjs')]],
  ['Banco de pruebas y nombres', 'node', [path.join(HERE, 'bench.e2e.mjs')]],
  ['Sin enmascarar', 'node', [path.join(HERE, 'unmasked.e2e.mjs')]],
  ['Tipo de documento y paso siguiente', 'node', [path.join(HERE, 'doctype.e2e.mjs')]]
];

let failed = 0;
for (const [label, cmd, args] of steps) {
  console.log('\n=== ' + label + ' ===');
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) { failed++; console.log('=== ' + label + ': FALLO ==='); }
}
console.log(failed ? '\n' + failed + ' bloque(s) con fallos' : '\nTodas las pruebas superadas');
process.exit(failed ? 1 : 0);
