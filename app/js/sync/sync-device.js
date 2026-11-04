/**
 * sync-device.js - Which computer saved the synchronization file, and when, said in plain words.
 *
 * Origin: COMeT services/sync-device.js @ 04540f5 (adapted)
 *
 * WHY. The sync file travels through OneDrive, and OneDrive may take a while to bring the latest copy
 * to this computer. Meanwhile the file on disk is an OLDER copy, complete and readable, and nothing in
 * it says it is old. So every save signs the file with the computer that made it (sync-fs.js:
 * meta.device, and meta.devices with the last save of each computer), and the question at opening
 * says who saved the copy that is here and when: "ESTE EQUIPO, AYER".
 *
 * The identity lives in storage under DEVICE_KEY: { id, name }. The id is made once and never
 * changes; the name is the one the user gives this computer ("Oficina", "Casa"). It is not
 * synchronized: each computer has its own.
 */

import { getValue, setValue } from '../store/storage.js';

export const DEVICE_KEY = 'device';

function _newId() {
  try {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
  }
}

/** This computer: { id, name } (name '' until the user gives one). Made on first use. */
export async function getDevice() {
  let dev = null;
  try { dev = await getValue(DEVICE_KEY, null); } catch (_) { dev = null; }
  if (dev && dev.id) return { id: String(dev.id), name: String(dev.name || '') };
  dev = { id: _newId(), name: '' };
  try { await setValue(DEVICE_KEY, dev); } catch (_) {}
  return dev;
}

/** Give this computer a name ("Oficina"). Returns the device. */
export async function setDeviceName(name) {
  const dev = await getDevice();
  dev.name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  await setValue(DEVICE_KEY, dev);
  return dev;
}

const ES_NUM = ['', '', '', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ'];

/**
 * When `iso` was, in plain words: { word, when }. `word` is the day counted back from today (HOY,
 * AYER, ANTEAYER, HACE TRES D\u00cdAS...), in capitals, to be shown highlighted; `when` is the weekday,
 * date and time ("lunes, 27 de octubre, 18:02"). Calendar days on this computer's clock. null when
 * there is no date.
 */
export function relativeDay(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const n = Math.max(0, Math.round((day(now) - day(d)) / 86400000));
  const word = n === 0 ? 'HOY' : n === 1 ? 'AYER' : n === 2 ? 'ANTEAYER' : 'HACE ' + (ES_NUM[n] || String(n)) + ' D\u00cdAS';
  let when = '';
  try {
    when = d.toLocaleString('es-ES', {
      weekday: 'long', day: 'numeric', month: 'long',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch (_) { when = d.toLocaleString(); }
  return { word, when };
}
