// Passcode lock and script encryption.
//
// The phone holds an ECDH key pair. Its private half is encrypted with a key
// derived from the passcode; its public half is the "setup code". Scripts in the
// repository are encrypted to the setup code, so anyone can lock scripts but only
// the phone (with the passcode) can unlock them. Works in browsers and Node 18+.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ITERATIONS = 250000;
const HKDF_INFO = enc.encode("teleprompter-scripts-v1");
export const SETUP_PREFIX = "TP1-";

export function toB64(bytes) {
  bytes = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function passKey(passcode, salt) {
  const base = await subtle.importKey("raw", enc.encode(passcode), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function aesEncrypt(key, bytes) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function aesDecrypt(key, box) {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: fromB64(box.iv) }, key, fromB64(box.ct)));
}

// Creates a new key pair locked with the passcode.
// Returns { vault, setupCode, session } where vault is safe to store on the phone.
export async function createVault(passcode) {
  const salt = rand(16);
  const pk = await passKey(passcode, salt);
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const priv = await subtle.exportKey("pkcs8", pair.privateKey);
  const pub = await subtle.exportKey("raw", pair.publicKey);
  const vault = { v: 1, salt: toB64(salt), priv: await aesEncrypt(pk, priv), pub: toB64(pub) };
  return { vault, setupCode: SETUP_PREFIX + vault.pub, session: { passKey: pk, privateKey: pair.privateKey } };
}

// Unlocks a stored vault. Throws if the passcode is wrong.
export async function openVault(vault, passcode) {
  const pk = await passKey(passcode, fromB64(vault.salt));
  const priv = await aesDecrypt(pk, vault.priv);
  const privateKey = await subtle.importKey("pkcs8", priv, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { passKey: pk, privateKey };
}

export const setupCodeOf = (vault) => SETUP_PREFIX + vault.pub;

// Local data (scripts typed on the phone) is locked with the passcode key.
export async function sealLocal(session, value) {
  return aesEncrypt(session.passKey, enc.encode(JSON.stringify(value)));
}

export async function openLocal(session, box) {
  return JSON.parse(dec.decode(await aesDecrypt(session.passKey, box)));
}

async function sharedKey(privateKey, publicRaw, usage) {
  const pub = await subtle.importKey("raw", publicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await subtle.deriveBits({ name: "ECDH", public: pub }, privateKey, 256);
  const hk = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: HKDF_INFO },
    hk, { name: "AES-GCM", length: 256 }, false, [usage]);
}

// Encrypts a value to a setup code (used by tools/encrypt-scripts.mjs).
export async function sealForSetupCode(setupCode, value) {
  const code = setupCode.trim();
  if (!code.startsWith(SETUP_PREFIX)) throw new Error("Not a setup code");
  const recipient = fromB64(code.slice(SETUP_PREFIX.length));
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const key = await sharedKey(eph.privateKey, recipient, "encrypt");
  const box = await aesEncrypt(key, enc.encode(JSON.stringify(value)));
  return { v: 1, to: code.slice(SETUP_PREFIX.length, SETUP_PREFIX.length + 12), epk: toB64(await subtle.exportKey("raw", eph.publicKey)), ...box };
}

// Decrypts a file made by sealForSetupCode on the phone.
export async function openFromRepo(session, file) {
  const key = await sharedKey(session.privateKey, fromB64(file.epk), "decrypt");
  return JSON.parse(dec.decode(await aesDecrypt(key, file)));
}
