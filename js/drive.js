// Uploads finished videos to a "Teleprompter Recordings" folder in Google Drive.
// The app asks only for access to files it creates itself.

import { GOOGLE_CLIENT_ID } from "../config.js";
import * as store from "./store.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Teleprompter Recordings";
let token = null, tokenExpires = 0, client = null, gisLoading = null;

export const configured = () => !!GOOGLE_CLIENT_ID;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = resolve;
      s.onerror = () => { gisLoading = null; reject(new Error("Couldn't reach Google. Check your connection.")); };
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}

// Load Google's sign-in code early so a tap can open the sign-in window right away.
export function warmUp() {
  if (configured()) loadGis().catch(() => {});
}

export const hasToken = () => token && Date.now() < tokenExpires - 60_000;

// Must run from a tap. Resolves once Google has given access.
export function signIn() {
  if (hasToken()) return Promise.resolve();
  if (!window.google?.accounts?.oauth2) return loadGis().then(() => Promise.reject(new Error("Google sign-in is ready now. Tap again.")));
  return new Promise((resolve, reject) => {
    client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      prompt: store.get("driveSignedIn") ? "" : "consent",
      callback: (r) => {
        if (r.error) return reject(new Error("Google sign-in didn't finish: " + r.error));
        token = r.access_token;
        tokenExpires = Date.now() + Number(r.expires_in || 3600) * 1000;
        store.set("driveSignedIn", true);
        resolve();
      },
      error_callback: (e) => reject(new Error(e?.type === "popup_closed" ? "The Google sign-in window was closed." : "Google sign-in didn't open. Allow pop-ups and try again.")),
    });
    client.requestAccessToken();
  });
}

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) } });
  if (r.status === 401) { token = null; throw new Error("Google sign-in expired. Tap upload again."); }
  if (!r.ok) throw new Error("Google Drive said: " + r.status + " " + (await r.text()).slice(0, 120));
  return r;
}

async function folderId() {
  const cached = store.get("driveFolder");
  if (cached) {
    try {
      const r = await api(`https://www.googleapis.com/drive/v3/files/${cached}?fields=id,trashed`);
      if (!(await r.json()).trashed) return cached;
    } catch (e) { if (!String(e.message).includes("404")) throw e; }
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await (await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`)).json();
  let id = found.files?.[0]?.id;
  if (!id) {
    const made = await api("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    id = (await made.json()).id;
  }
  store.set("driveFolder", id);
  return id;
}

// Uploads one video. onProgress gets 0..1.
export async function upload(blob, name, mime, onProgress = () => {}) {
  if (!hasToken()) throw new Error("Sign in to Google first.");
  const parent = await folderId();
  const start = await api("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime },
    body: JSON.stringify({ name, parents: [parent], mimeType: mime }),
  });
  const location = start.headers.get("Location");
  if (!location) throw new Error("Google Drive didn't accept the upload. Try again.");
  await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", location);
    x.setRequestHeader("Content-Type", mime);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve() : reject(new Error("Upload failed (" + x.status + "). It will retry.")));
    x.onerror = () => reject(new Error("Upload stopped. Check your connection; it will retry."));
    x.send(blob);
  });
  onProgress(1);
}
