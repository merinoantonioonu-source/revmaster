/**
 * dom.js - Small DOM helpers shared by every view: element builder, HTML escaping, toasts, modal
 * dialogs, downloads and the clipboard.
 */

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * el('div.card#id', { onclick, title, dataset:{...}, style:'...' }, children...)
 * children: strings (text), nodes, arrays, null/false (skipped).
 */
export function el(spec, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec || 'div');
  const tag = (m && m[1]) || 'div';
  const node = document.createElement(tag);
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') node.classList.add(part.slice(1));
      else node.id = part.slice(1);
    }
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'class') node.className = v;
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  _append(node, children);
  return node;
}

function _append(node, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) _append(node, c);
    else if (c instanceof Node) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function $(sel, root) { return (root || document).querySelector(sel); }
export function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

// ---- Toasts ----
let _toastHost = null;
export function toast(text, type, ms) {
  if (!_toastHost) {
    _toastHost = el('div.toasts');
    document.body.appendChild(_toastHost);
  }
  const t = el('div.toast' + (type ? '.' + type : ''), text);
  _toastHost.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms || 3800);
  return t;
}

// ---- Modal dialog ----
/**
 * modal({ title, body: Node|string, buttons:[{ label, kind:'primary'|'amber'|'danger'|'', value, onClick }],
 *         width, onClose }) -> Promise<value of the pressed button | null>
 * A button whose onClick returns false keeps the dialog open.
 */
export function modal(opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    const back = el('div.modal-back');
    const box = el('div.modal', { style: o.width ? { width: o.width } : null });
    const close = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      if (typeof o.onClose === 'function') { try { o.onClose(v); } catch (_) {} }
      resolve(v === undefined ? null : v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    box.appendChild(el('div.modal-head', el('span', o.title || ''),
      el('button.icon-btn.modal-x', { title: 'Cerrar', onclick: () => close(null) }, '\u00d7')));
    const body = el('div.modal-body');
    if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
    box.appendChild(body);
    if (o.buttons && o.buttons.length) {
      const foot = el('div.modal-foot');
      for (const b of o.buttons) {
        foot.appendChild(el('button.btn' + (b.kind ? '.' + b.kind : ''), {
          onclick: async () => {
            if (typeof b.onClick === 'function') {
              const r = await b.onClick(body);
              if (r === false) return;
            }
            close(b.value === undefined ? b.label : b.value);
          }
        }, b.label));
      }
      box.appendChild(foot);
    }
    back.appendChild(box);
    back.addEventListener('mousedown', (e) => { if (e.target === back && o.dismissable !== false) close(null); });
    document.body.appendChild(back);
    const first = box.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export async function confirmDialog(title, text, okLabel) {
  const r = await modal({
    title, body: el('p', text),
    buttons: [{ label: 'Cancelar', value: false }, { label: okLabel || 'Aceptar', kind: 'primary', value: true }]
  });
  return r === true;
}

export async function promptDialog(title, label, value, opts) {
  const input = el(opts && opts.multiline ? 'textarea.inp' : 'input.inp', { value: value || '', style: { width: '100%' } });
  if (opts && opts.multiline) { input.value = value || ''; input.rows = opts.rows || 6; }
  if (opts && opts.type) input.type = opts.type;
  const r = await modal({
    title, body: el('div', el('label.lbl', label), input),
    buttons: [{ label: 'Cancelar', value: null }, { label: 'Aceptar', kind: 'primary', value: 'ok' }]
  });
  return r === 'ok' ? input.value : null;
}

// ---- Files ----
export function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

export function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: accept || '', style: { display: 'none' } });
    if (multiple) input.multiple = true;
    input.addEventListener('change', () => { resolve(Array.from(input.files || [])); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = el('textarea', { style: { position: 'fixed', left: '-9999px' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
  }
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function uid(prefix) {
  return (prefix || 'u') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function fmtInt(n) {
  // Spanish thousands separator (a point), as the rest of the interface.
  return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function fmtMoney(n, cur) {
  const v = (Math.round((n || 0) * 1000) / 1000).toFixed(n >= 1 ? 2 : 3).replace('.', ',');
  return v + ' ' + (cur || 'US$');
}
