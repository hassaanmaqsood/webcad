// ==========================================================================
// storage.js — signed-in user session + encrypted local design library
//              + shareable-link compression (unrelated to encryption: a
//              share link is meant to be readable by whoever opens it)
// ==========================================================================

import LZString from 'lz-string';
import { deriveKey, hashUsername, encryptJSON, decryptJSON } from './crypto.js';

const RECENTS_KEY = 'webcad_recent_usernames';
const KEY_PREFIX = 'webcad::';

let session = null; // { username, key, userHash }

// ---------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------

export async function login(username) {
    const clean = username.trim();
    const key = await deriveKey(clean);
    const userHash = await hashUsername(clean);
    session = { username: clean, key, userHash };
    rememberUsername(clean);
    return clean;
}

export function logout() {
    session = null;
}

export function currentUsername() {
    return session ? session.username : null;
}

export function isSignedIn() {
    return session !== null;
}

export function recentUsernames() {
    try {
        return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    } catch {
        return [];
    }
}

function rememberUsername(name) {
    const list = recentUsernames().filter((n) => n.toLowerCase() !== name.toLowerCase());
    list.unshift(name);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 6)));
}

// ---------------------------------------------------------------------
// Encrypted design library (namespaced per signed-in username)
// ---------------------------------------------------------------------

function requireSession() {
    if (!session) throw new Error('storage: no user is signed in');
    return session;
}

function designKey(userHash, id) {
    return `${KEY_PREFIX}${userHash}::design::${id}`;
}

function designPrefix(userHash) {
    return `${KEY_PREFIX}${userHash}::design::`;
}

export async function saveDesign({ id, name, script }) {
    const { key, userHash } = requireSession();
    const entry = {
        id: id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
        name: name || 'Untitled design',
        script,
        updatedAt: Date.now(),
    };
    const payload = await encryptJSON(key, entry);
    localStorage.setItem(designKey(userHash, entry.id), payload);
    return entry;
}

export async function listDesigns() {
    const { key, userHash } = requireSession();
    const prefix = designPrefix(userHash);
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        try {
            out.push(await decryptJSON(key, localStorage.getItem(k)));
        } catch {
            // belongs to a different username or is corrupt — skip silently
        }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadDesignById(id) {
    const { key, userHash } = requireSession();
    const raw = localStorage.getItem(designKey(userHash, id));
    if (!raw) return null;
    try {
        return await decryptJSON(key, raw);
    } catch {
        return null;
    }
}

export function deleteDesign(id) {
    const { userHash } = requireSession();
    localStorage.removeItem(designKey(userHash, id));
}

// ---------------------------------------------------------------------
// Shareable links — { s: script, n: title } compressed into ?d=, plus a
// plain ?u= for attribution. Not encrypted: anyone with the link should
// be able to open it without knowing anyone's username.
// ---------------------------------------------------------------------

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