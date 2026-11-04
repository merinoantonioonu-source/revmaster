/**
 * menu.js - Dropdown menus (.menu): openMenu(anchor, items).
 * anchor: an element (the menu opens under it) or { x, y } (context menu).
 * items: [{ label, onClick, cls, disabled } | { header } | { sep:true }]
 */

import { el } from '../util/dom.js';

let _open = null;

export function closeMenu() {
  if (_open) { _open.remove(); _open = null; }
}

export function openMenu(anchor, items) {
  closeMenu();
  const m = el('div.menu');
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { m.appendChild(el('div.sep')); continue; }
    if (it.header) { m.appendChild(el('div.mh', it.header)); continue; }
    m.appendChild(el('div.mi' + (it.cls ? '.' + it.cls : '') + (it.disabled ? '.disabled' : ''), {
      onclick: (e) => { e.stopPropagation(); if (it.disabled) return; closeMenu(); if (it.onClick) it.onClick(); }
    }, it.label));
  }
  document.body.appendChild(m);
  let x, y;
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    x = r.left; y = r.bottom + 4;
  } else { x = anchor.x; y = anchor.y; }
  const mr = m.getBoundingClientRect();
  if (x + mr.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - mr.width - 8);
  if (y + mr.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mr.height - 8);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  _open = m;
  setTimeout(() => {
    const off = (e) => { if (!m.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off, true); } };
    document.addEventListener('mousedown', off, true);
  }, 0);
  return m;
}
