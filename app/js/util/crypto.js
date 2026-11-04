/**
 * crypto.js - Hashes and password encryption (WebCrypto).
 *
 * - sha256Hex(text): fingerprints for the results cache and project ids.
 * - fnv1a(text): fast synchronous hash for in-memory keys.
 * - encryptJSON / decryptJSON: AES-GCM with a key derived from a password (PBKDF2-SHA256,
 *   200k iterations). Used for API keys in the sync file and for protected projects.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fnv1a(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function _b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function _unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function _key(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** -> { v:1, alg:'AES-GCM', salt, iv, data } (all base64) */
export async function encryptJSON(value, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _key(password, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { v: 1, alg: 'AES-GCM', salt: _b64(salt), iv: _b64(iv), data: _b64(data) };
}

/** Throws an error with code 'BAD_PASSWORD' when the password is wrong. */
export async function decryptJSON(box, password) {
  try {
    const key = await _key(password, _unb64(box.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _unb64(box.iv) }, key, _unb64(box.data));
    return JSON.parse(dec.decode(plain));
  } catch (e) {
    const err = new Error('Contrase\u00f1a incorrecta o datos da\u00f1ados.');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
}

export async function encryptBytes(bytes, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await _key(password, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { salt, iv, data: new Uint8Array(data) };
}

export async function decryptBytes(box, password) {
  try {
    const key = await _key(password, box.salt);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.data));
  } catch (e) {
    const err = new Error('Contrase\u00f1a incorrecta o datos da\u00f1ados.');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
}
