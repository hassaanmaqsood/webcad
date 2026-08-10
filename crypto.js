// ==========================================================================
// crypto.js — username-derived encryption for local design storage
//
// Every design saved on this device is encrypted with a key derived (via
// PBKDF2) from the signed-in username, using the browser's native Web
// Crypto API. Nothing is sent anywhere — this only protects the local
// browser storage from casual snooping if the device is shared, and keeps
// one username's designs cleanly separated from another's. It is not a
// substitute for a real account system (that's step 2).
// ==========================================================================

const APP_SALT = 'webcad-static-salt-v1';
const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Derive an AES-GCM-256 CryptoKey from a username. */
export async function deriveKey(username) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        enc.encode(username.trim().toLowerCase()),
        'PBKDF2',
        false,
        ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: enc.encode(APP_SALT),
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256',
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/** A short, non-reversible namespace id for a username (used as a storage-key prefix). */
export async function hashUsername(username) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(username.trim().toLowerCase()));
    return bytesToHex(new Uint8Array(digest)).slice(0, 24);
}

/** Encrypt a JSON-serializable value. Returns a compact base64url string: `iv.ciphertext`. */
export async function encryptJSON(key, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = enc.encode(JSON.stringify(value));
    const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return `${toB64Url(iv)}.${toB64Url(new Uint8Array(cipherBuf))}`;
}

/** Decrypt a value produced by encryptJSON(). */
export async function decryptJSON(key, payload) {
    const [ivPart, cipherPart] = payload.split('.');
    const iv = fromB64Url(ivPart);
    const cipher = fromB64Url(cipherPart);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return JSON.parse(dec.decode(plainBuf));
}

function bytesToHex(bytes) {
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toB64Url(bytes) {
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str) {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}