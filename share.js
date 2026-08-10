// ==========================================================================
// share.js — URL sharing (compress + encode) and local design library
//
// Share URL shape:
//   <base-url>?u=<username>&d=<compressed-url-safe-string>
//
// The compressed payload is { s: script, n: title } packed as JSON and
// run through LZString's URI-safe compressor, so the whole thing is a
// single query param that's safe to paste anywhere (Slack, email, etc.)
// and works from a plain static host like GitHub Pages — no server.
// ==========================================================================

import LZString from 'lz-string';

const USERNAME_KEY = 'fabify_cad_username';
const DESIGNS_KEY = 'fabify_cad_local_designs_v1';

export function getStoredUsername() {
  return localStorage.getItem(USERNAME_KEY) || '';
}

export function setStoredUsername(name) {
  localStorage.setItem(USERNAME_KEY, name || '');
}

/** Build a shareable URL for the current script */
export function buildShareUrl(script, title, username) {
  const payload = JSON.stringify({ s: script, n: title || 'Untitled' });
  const compressed = LZString.compressToEncodedURIComponent(payload);
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('u', username || 'anon');
  url.searchParams.set('d', compressed);
  return url.toString();
}

/** Read ?u= and ?d= from the current URL. Returns null if nothing shared. */
export function parseShareUrl() {
  const url = new URL(window.location.href);
  const d = url.searchParams.get('d');
  const u = url.searchParams.get('u');
  if (!d) return null;
  try {
    const json = LZString.decompressFromEncodedURIComponent(d);
    if (!json) return null;
    const payload = JSON.parse(json);
    return { script: payload.s, title: payload.n || 'Untitled', username: u || 'anon' };
  } catch (err) {
    console.error('Failed to parse shared design from URL:', err);
    return null;
  }
}

export function clearShareParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete('u');
  url.searchParams.delete('d');
  window.history.replaceState({}, '', url.toString());
}

// ---------------------------------------------------------------------
// Local design library (localStorage) — save/list/load/delete
// ---------------------------------------------------------------------

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(DESIGNS_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeAll(list) {
  localStorage.setItem(DESIGNS_KEY, JSON.stringify(list));
}

export function listDesigns() {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveDesign({ id, name, script }) {
  const list = readAll();
  const idx = id ? list.findIndex((d) => d.id === id) : -1;
  const entry = {
    id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    name: name || 'Untitled',
    script,
    updatedAt: Date.now(),
  };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  writeAll(list);
  return entry;
}

export function loadDesign(id) {
  return readAll().find((d) => d.id === id) || null;
}

export function deleteDesign(id) {
  writeAll(readAll().filter((d) => d.id !== id));
}
