/**
 * settings-sync.js - Settings > Sincronizacion: the linked file and its state, the buttons (choose,
 * create, save now, bring, undo, unlink), autosave, the encrypted API keys, what travels and what
 * does not, and this computer's name. Also the header chip (mountSyncChip).
 *
 * Origin: COMeT settings/tabs/data-tab.js @ 04540f5 (adapted)  (initSyncUI)
 * Origin: COMeT toolbar/toolbar.js @ 04540f5 (adapted)  (the amber "Guardar" when autosave pauses)
 */

import { el, clear, toast, modal, confirmDialog, pickFiles } from '../util/dom.js';
import { getValue, setValue, storage } from '../store/storage.js';
import { getDevice, setDeviceName, relativeDay } from '../sync/sync-device.js';
import * as sfs from '../sync/sync-fs.js';
import {
  TRAVELS, DOES_NOT_TRAVEL, AUTOSAVE_PREF_KEY, SECRETS_PREF_KEY, SECRETS_PASS_KEY, DEFAULT_FILE_NAME
} from '../sync/sync-spec.js';

const STATE_LABEL = {
  ok: ['ok', 'Al d\u00eda'],
  saving: ['info', 'Guardando\u2026'],
  needs_gesture: ['warn', 'En pausa'],
  error: ['err', 'Error'],
  off: ['gray', 'Sin archivo']
};

/**
 * The header chip (a <button class="meter">): "Sinc.: <file>" with a coloured dot; when the
 * autosave pauses (needs_gesture) it turns amber and says "Guardar" (a click saves: the gesture the
 * browser wants). opts.onOpenSettings() is called when there is no file. Returns the unsubscriber.
 */
export function mountSyncChip(node, opts) {
  const o = opts || {};
  const paint = (s) => {
    clear(node);
    node.classList.toggle('warn', s.state === 'needs_gesture' || s.state === 'error');
    if (s.state === 'needs_gesture' || s.state === 'error') {
      node.appendChild(document.createTextNode(s.state === 'error' ? '\u26a0 Sincronizaci\u00f3n: error' : 'Guardar'));
    } else {
      const dot = s.state === 'ok' ? 'ok' : s.state === 'saving' ? 'warn' : '';
      node.appendChild(el('span.dot' + (dot ? '.' + dot : '')));
      node.appendChild(document.createTextNode(s.linked ? 'Sinc.: ' + (s.state === 'saving' ? 'guardando\u2026' : (s.fileName || '')) : 'Sinc.: no'));
    }
    node.title = s.message || (s.linked ? 'Archivo de sincronizaci\u00f3n: ' + s.fileName : 'Sin archivo de sincronizaci\u00f3n. Pulsa para configurarlo.');
  };
  const onClick = async () => {
    const s = sfs.getSyncState();
    if (!s.linked) { if (typeof o.onOpenSettings === 'function') o.onOpenSettings(); return; }
    if (s.state === 'needs_gesture' || s.state === 'error') {
      try { await sfs.saveToSyncFile(); toast('Guardado en ' + s.fileName + '.', 'ok'); }
      catch (e) { toast((e && e.message) || String(e), 'err', 9000); }
    } else if (typeof o.onOpenSettings === 'function') o.onOpenSettings();
  };
  node.addEventListener('click', onClick);
  paint(sfs.getSyncState());
  const off = sfs.onSyncState(paint);
  return () => { off(); node.removeEventListener('click', onClick); };
}

function _card(title, ...children) {
  return el('div.card', el('h3', title), el('div.body', ...children));
}

async function _run(btn, fn, okMsg) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Un momento\u2026';
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'ok', 5000);
    return r;
  } catch (e) {
    if (e && e.name === 'AbortError') return null;     // the picker was closed
    toast((e && e.message) || String(e), 'err', 10000);
    return null;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** Asks for (and confirms) the password of the encrypted API keys. -> the password or null. */
async function _askNewPassword() {
  const a = el('input.inp', { type: 'password', autocomplete: 'new-password', style: { width: '100%' } });
  const b = el('input.inp', { type: 'password', autocomplete: 'new-password', style: { width: '100%' } });
  const msg = el('div');
  let pass = null;
  await modal({
    title: 'Contrase\u00f1a de las claves cifradas',
    body: el('div',
      el('p.info', 'Las claves de API viajar\u00e1n en el archivo cifradas con esta contrase\u00f1a (AES-GCM). En otro equipo la escribes una vez ' +
        'y quedan disponibles. Si la olvidas, no se pueden recuperar: vuelve a escribir las claves.'),
      el('label.lbl', 'Contrase\u00f1a (8 caracteres o m\u00e1s)'), a,
      el('label.lbl', 'Rep\u00edtela'), b, msg),
    buttons: [
      { label: 'Cancelar', value: null },
      { label: 'Guardar', kind: 'primary', value: 'ok', onClick: () => {
        if (a.value.length < 8) { msg.className = 'note err'; msg.textContent = 'Usa al menos 8 caracteres.'; return false; }
        if (a.value !== b.value) { msg.className = 'note err'; msg.textContent = 'Las dos contrase\u00f1as no coinciden.'; return false; }
        pass = a.value;
        return true;
      } }
    ]
  });
  return pass;
}

/** Builds Settings > Sincronizacion inside `container`. -> { refresh, destroy } */
export async function mount(container) {
  const root = el('div.umbra-settings-sync');
  clear(container).appendChild(root);
  const supported = sfs.isSupported();

  async function render() {
    if (!root.isConnected) return;
    const st = sfs.getSyncState();
    const [autosave, secretsOn, secretsPass, dev, lastPull, lastPush] = await Promise.all([
      getValue(AUTOSAVE_PREF_KEY, true), getValue(SECRETS_PREF_KEY, false), getValue(SECRETS_PASS_KEY, ''),
      getDevice(), sfs.getLastPull(), getValue(sfs.LAST_PUSH_KEY, null)
    ]);
    const frag = el('div');

    // ---- The file
    const fileBody = [];
    if (!supported) {
      fileBody.push(el('div.note.warn', 'Este navegador no permite vincular un archivo (solo Chrome y Edge lo permiten). ' +
        'Puedes llevar tus datos a mano: "Descargar archivo de sincronizaci\u00f3n" aqu\u00ed y "Cargar archivo" en el otro equipo (se combinan, no se sustituyen).'));
    } else {
      const [cls, label] = STATE_LABEL[st.state] || STATE_LABEL.off;
      fileBody.push(el('div.row', { style: { marginBottom: '8px' } },
        st.linked ? el('span', 'Vinculado a ', el('b.mono', st.fileName)) : el('span.muted', 'Ning\u00fan archivo vinculado. Elige uno que ya exista o crea uno nuevo (por ejemplo, en OneDrive).'),
        el('span.pill.' + cls, label)));
      if (st.message) fileBody.push(el('p.info', st.message));
      const lp = lastPush ? relativeDay(lastPush) : null;
      if (lp) fileBody.push(el('p.info', '\u00daltima vez que este equipo guard\u00f3 o trajo datos: ', el('b', lp.word.toLowerCase()), ' (' + lp.when + ').'));

      const bChoose = el('button.btn', st.linked ? 'Elegir otro archivo' : 'Elegir archivo');
      bChoose.addEventListener('click', async () => {
        const name = await _run(bChoose, () => sfs.chooseSyncFile());
        if (name) {
          await render();
          const action = await sfs.showSyncDecisionModal(await sfs.peekSyncFileMetaWithPermission());
          if (action) render();
        }
      });
      const bCreate = el('button.btn', 'Crear archivo');
      bCreate.addEventListener('click', async () => {
        const r = await _run(bCreate, () => sfs.createSyncFile(), (x) => 'Archivo creado: ' + x.name + '.');
        if (r) render();
      });
      const row1 = el('div.row', bChoose, bCreate);
      fileBody.push(row1);
      if (st.linked) {
        const bSave = el('button.btn.primary', 'Guardar ahora');
        bSave.addEventListener('click', async () => { await _run(bSave, () => sfs.saveToSyncFile(), 'Datos de este equipo guardados en el archivo.'); render(); });
        const bLoad = el('button.btn', 'Traer del archivo');
        bLoad.addEventListener('click', async () => {
          const r = await _run(bLoad, () => sfs.loadFromSyncFile(), (x) => 'Datos tra\u00eddos del archivo' +
            (x && x.secrets && x.secrets.applied ? ' (y ' + x.secrets.applied + ' clave(s) de API)' : '') + '. Si no era la copia buena, pulsa "Deshacer lo tra\u00eddo".');
          if (r) render();
        });
        const bUnlink = el('button.btn.danger', 'Desvincular');
        bUnlink.addEventListener('click', async () => {
          if (await confirmDialog('Desvincular el archivo', 'UMBRA dejar\u00e1 de guardar en ' + st.fileName + '. El archivo y los datos de este navegador no se borran.', 'Desvincular')) {
            await sfs.unlinkSyncFile();
            render();
          }
        });
        fileBody.push(el('div.row', { style: { marginTop: '8px' } }, bSave, bLoad, bUnlink));
        const chk = el('input', { type: 'checkbox', checked: autosave !== false ? true : null });
        chk.addEventListener('change', () => setValue(AUTOSAVE_PREF_KEY, chk.checked));
        fileBody.push(el('label.row', { style: { marginTop: '10px' }, title: 'Guarda en el archivo unos segundos despu\u00e9s de cada cambio.' }, chk,
          'Autoguardar (unos segundos despu\u00e9s de cada cambio, sin preguntar si el navegador ya dio permiso)'));
      }
    }
    if (lastPull) {
      const when = relativeDay(new Date(lastPull.at).toISOString());
      const bUndo = el('button.btn.amber', 'Deshacer lo tra\u00eddo');
      bUndo.addEventListener('click', async () => {
        if (await confirmDialog('Deshacer lo tra\u00eddo', 'Este equipo vuelve exactamente a como estaba antes de traer los datos del archivo' +
          (when ? ' (' + when.word.toLowerCase() + ')' : '') + '. El archivo no se toca.', 'Deshacer')) {
          await _run(bUndo, () => sfs.undoLastPull(), 'Se ha deshecho lo tra\u00eddo.');
          render();
        }
      });
      const bOk = el('button.btn', 'Es la copia buena');
      bOk.addEventListener('click', async () => { await sfs.confirmLastPull(); render(); });
      fileBody.push(el('div.note.warn', { style: { marginTop: '10px' } },
        el('div', 'Datos tra\u00eddos ' + (when ? when.word.toLowerCase() : '') + (lastPull.fromDevice && lastPull.fromDevice.name ? ' desde ' + lastPull.fromDevice.name : '') +
          (lastPull.confirmed ? '.' : '. Mientras no confirmes que es la copia buena (o pasen 10 minutos), el autoguardado espera.')),
        el('div.row', { style: { marginTop: '6px' } }, bUndo, lastPull.confirmed ? null : bOk)));
    }
    // Manual file: always available (a backup, or the only way without the File System Access API).
    const bDown = el('button.btn', 'Descargar archivo de sincronizaci\u00f3n');
    bDown.addEventListener('click', () => _run(bDown, () => sfs.downloadSyncFile()));
    const bUp = el('button.btn', 'Cargar archivo');
    bUp.addEventListener('click', async () => {
      const files = await pickFiles('.json,application/json', false);
      if (!files.length) return;
      const r = await _run(bUp, () => sfs.loadFromFileObject(files[0]), 'Datos del archivo combinados con los de este equipo.');
      if (r) render();
    });
    fileBody.push(el('div', { style: { marginTop: '12px' } },
      el('label.lbl', 'A mano'),
      el('div.row', bDown, bUp),
      el('p.info', { style: { marginTop: '6px' } }, 'El archivo descargado se llama ' + DEFAULT_FILE_NAME + '. Al cargarlo se combina con lo de este equipo, ' +
        'como al traer del archivo vinculado. Un archivo de COMeT se rechaza.')));
    frag.appendChild(_card('Archivo de sincronizaci\u00f3n', ...fileBody));

    // ---- Encrypted API keys
    const chkSec = el('input', { type: 'checkbox', checked: secretsOn ? true : null });
    const bPass = el('button.btn.sm', secretsPass ? 'Cambiar contrase\u00f1a' : 'Poner contrase\u00f1a');
    const setPass = async () => {
      const pass = await _askNewPassword();
      if (!pass) return false;
      await storage.set({ [SECRETS_PASS_KEY]: pass, [SECRETS_PREF_KEY]: true });
      toast('Contrase\u00f1a guardada. Las claves viajar\u00e1n cifradas en el pr\u00f3ximo guardado.', 'ok');
      return true;
    };
    chkSec.addEventListener('change', async () => {
      if (chkSec.checked) {
        if (!secretsPass && !(await setPass())) { chkSec.checked = false; return; }
        await setValue(SECRETS_PREF_KEY, true);
      } else {
        await setValue(SECRETS_PREF_KEY, false);
        toast('Las claves dejar\u00e1n de ir en lo que guarde este equipo. Las que ya est\u00e9n en el archivo siguen ah\u00ed, cifradas.', 'warn', 7000);
      }
      render();
    });
    bPass.addEventListener('click', async () => { if (await setPass()) render(); });
    frag.appendChild(_card('Claves de API',
      el('p.info', 'Por defecto, las claves de API no viajan: se escriben una vez en cada equipo. Si activas esta opci\u00f3n, van en el archivo ' +
        'cifradas con una contrase\u00f1a (AES-GCM, clave derivada con PBKDF2); en otro equipo se pide la contrase\u00f1a una vez al traer los datos. ' +
        'Nunca viajan en claro. La contrase\u00f1a se guarda solo en este navegador, como las propias claves.'),
      el('div.row', el('label.row', chkSec, 'Incluir claves de API cifradas'), secretsOn || secretsPass ? bPass : null),
      secretsOn && !secretsPass ? el('div.note.warn', { style: { marginTop: '8px' } }, 'Falta la contrase\u00f1a: sin ella las claves no viajan.') : null));

    // ---- What travels
    const tbl = el('table.grid', el('tr', el('th', 'Viaja en el archivo'), el('th', 'No viaja')));
    const n = Math.max(TRAVELS.length, DOES_NOT_TRAVEL.length);
    for (let i = 0; i < n; i++) tbl.appendChild(el('tr', el('td', TRAVELS[i] || ''), el('td', DOES_NOT_TRAVEL[i] || '')));
    frag.appendChild(_card('Qu\u00e9 viaja y qu\u00e9 no',
      el('p.info', 'Al guardar o traer, los datos se combinan: en los ajustes gana el cambio m\u00e1s reciente, las listas se unen y los borrados se propagan.'),
      tbl));

    // ---- This computer
    const nameInp = el('input.inp', { type: 'text', maxlength: '40', value: dev.name || '', placeholder: 'Por ejemplo: Oficina, Casa' });
    const saveName = async () => {
      if (!nameInp.value.trim()) { nameInp.focus(); return; }
      try { const d = await setDeviceName(nameInp.value); nameInp.value = d.name; toast('Este equipo se llama ahora "' + d.name + '".', 'ok'); }
      catch (e) { toast('No se ha podido guardar el nombre: ' + ((e && e.message) || e), 'err'); }
    };
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveName(); } });
    frag.appendChild(_card('Este equipo',
      el('p.info', 'El nombre aparece en la pregunta al abrir ("lo guard\u00f3 Oficina, ayer"), para reconocer una copia vieja que OneDrive a\u00fan no ha sustituido. No viaja.'),
      el('div.row', nameInp, el('button.btn.sm', { onclick: saveName }, 'Guardar'))));

    clear(root).appendChild(frag);
  }

  let _t = null;
  // render() only reads the state, so a state change never loops back here.
  const offState = sfs.onSyncState(() => { if (!root.isConnected) { offState(); return; } clearTimeout(_t); _t = setTimeout(render, 120); });
  await sfs.refreshSyncState();
  await render();
  return { refresh: render, destroy: () => offState() };
}
