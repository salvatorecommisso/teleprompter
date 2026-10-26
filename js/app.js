import * as store from "./store.js";
import * as vaultLib from "./crypto.js";
import * as drive from "./drive.js";
import { Prompter } from "./prompter.js";
import { loudness, speechRanges, totalLength } from "./trim.js";
import { pickMime, extFor, primePlayers, releasePlayers, render } from "./render.js";

const $ = (id) => document.getElementById(id);

// ---------- settings ----------
const DEFAULTS = { mode: "follow", speed: 4, size: 30, guides: "all", center: true, mirror: true, flip: false, countdown: true, sens: 50, micId: "" };
const settings = { ...DEFAULTS, ...store.get("settings", {}) };
const saveSettings = () => store.set("settings", settings);
const pxPerSecond = () => 12 + settings.speed * 9;
const MODE_LABEL = { follow: "Follow my voice", talk: "Scroll while I talk", steady: "Steady scroll" };
const MODE_CHIP = { follow: "Follow voice", talk: "Talk scroll", steady: "Steady" };

// ---------- app state ----------
let session = null;          // unlocked keys, only in memory
let synced = [];             // scripts from Claude (repository)
let local = [];              // scripts typed on this phone
let script = null;           // script open in the studio
let sections = [];
let sectionIndex = 0;
let takes = {};              // section index -> { blob, mime, duration, at }
let audioCtx = null;

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  if (id === "studio" || id === "final") keepAwake(); else releaseAwake();
}

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

const splitSections = (body) => body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
const wordCount = (t) => (t.match(/\S+/g) || []).length;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const allScripts = () => [...synced.map((s) => ({ ...s, source: "synced" })), ...local.map((s) => ({ ...s, source: "local" }))];

// ---------- screen wake lock ----------
let wakeLock = null;
async function keepAwake() {
  try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch {}
}
function releaseAwake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

// ---------- passcode ----------
let lockMode = "unlock";

function showLock() {
  session = null;
  const vault = store.get("vault");
  lockMode = vault ? "unlock" : "create";
  $("lockTitle").textContent = vault ? "Enter passcode" : "Choose a passcode";
  $("lockHint").textContent = vault ? "" : "At least 4 digits. You'll type it each time you open the app. It locks your scripts on this phone.";
  $("pin2").hidden = !!vault;
  $("lockGo").textContent = vault ? "Unlock" : "Set passcode";
  $("forgot").hidden = !vault;
  $("forgotBox").hidden = true;
  $("pin1").value = $("pin2").value = "";
  $("lockErr").textContent = "";
  show("lock");
}

$("lockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p1 = $("pin1").value.trim(), p2 = $("pin2").value.trim();
  $("lockErr").textContent = "";
  $("lockGo").disabled = true;
  try {
    if (lockMode === "create") {
      if (p1.length < 4) throw new Error("Use at least 4 digits.");
      if (p1 !== p2) throw new Error("The two passcodes don't match.");
      const made = await vaultLib.createVault(p1);
      store.set("vault", made.vault);
      session = made.session;
      await saveLocal();
      showSetupCode(true);
    } else {
      try { session = await vaultLib.openVault(store.get("vault"), p1); }
      catch { throw new Error("Wrong passcode. Try again."); }
      await openLibrary();
    }
  } catch (err) {
    $("lockErr").textContent = err.message;
    $("pin1").value = "";
  } finally {
    $("lockGo").disabled = false;
  }
});

$("forgot").onclick = () => ($("forgotBox").hidden = false);
$("forgotNo").onclick = () => ($("forgotBox").hidden = true);
$("forgotYes").onclick = async () => {
  for (const k of ["vault", "localBox", "syncedFile"]) store.remove(k);
  for (const k of await store.idb.keys("takes")) await store.idb.del("takes", k);
  showLock();
};

function showSetupCode(first) {
  $("setupCode").textContent = vaultLib.setupCodeOf(store.get("vault"));
  $("copyMsg").textContent = "";
  $("setupDone").textContent = first ? "Continue" : "Back";
  show("setup");
}

$("copyCode").onclick = async () => {
  const code = $("setupCode").textContent;
  try { await navigator.clipboard.writeText(code); $("copyMsg").textContent = "Copied. Paste it to Claude in your project chat."; }
  catch {
    const r = document.createRange(); r.selectNodeContents($("setupCode"));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    $("copyMsg").textContent = "Selected. Tap Copy in the menu, then paste it to Claude.";
  }
};
$("setupDone").onclick = () => openLibrary();

// ---------- script library ----------
async function saveLocal() { store.set("localBox", await vaultLib.sealLocal(session, local)); }

async function openLibrary() {
  show("library");
  const box = store.get("localBox");
  try { local = box ? await vaultLib.openLocal(session, box) : []; } catch { local = []; }
  await useSyncedFile(store.get("syncedFile"));
  renderLibrary();
  refreshOutboxNote();
  fetchScripts();
}

async function useSyncedFile(file) {
  const vault = store.get("vault");
  if (!file || !file.epk) { synced = []; $("syncNote").textContent = "No scripts from Claude yet. Send Claude your setup code (Settings ⚙︎ → Setup code)."; return; }
  if (file.to && file.to !== vault.pub.slice(0, 12)) {
    synced = [];
    $("syncNote").textContent = "Claude's scripts are locked for a different setup code. Send Claude your current one (Settings ⚙︎ → Setup code).";
    return;
  }
  try {
    const data = await vaultLib.openFromRepo(session, file);
    synced = data.scripts || [];
    const when = data.updated ? new Date(data.updated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    $("syncNote").textContent = `${synced.length} script${synced.length === 1 ? "" : "s"} from Claude${when ? ", updated " + when : ""}.`;
  } catch {
    synced = [];
    $("syncNote").textContent = "Couldn't open Claude's scripts on this phone. Send Claude your current setup code.";
  }
}

async function fetchScripts(manual) {
  try {
    const r = await fetch("scripts.enc.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error();
    const file = await r.json();
    if (JSON.stringify(file) !== JSON.stringify(store.get("syncedFile"))) {
      store.set("syncedFile", file);
      await useSyncedFile(file);
      renderLibrary();
    } else if (manual) {
      $("syncNote").textContent += " Up to date.";
    }
  } catch {
    if (manual) $("syncNote").textContent = "No connection. Showing the scripts saved on this phone.";
  }
}

async function renderLibrary() {
  const list = $("scriptList");
  const progress = store.get("progress", {});
  const takeKeys = await store.idb.keys("takes").catch(() => []);
  list.textContent = "";
  const items = allScripts();
  if (!items.length) {
    list.innerHTML = '<div class="empty">No scripts yet.<br>Ask Claude to write one, or tap New to type one here.</div>';
    return;
  }
  const order = (s) => (progress[s.id]?.sent ? 1 : 0);
  items.sort((a, b) => order(a) - order(b));
  for (const s of items) {
    const secs = splitSections(s.body);
    const kept = takeKeys.filter((k) => k.startsWith(s.id + "|")).length;
    const seconds = Math.round(wordCount(s.body) / 2.6);
    const card = document.createElement("div");
    card.className = "card" + (progress[s.id]?.sent ? " done" : "");
    card.tabIndex = 0;
    card.innerHTML = '<div class="info"><div class="t"></div><div class="s"></div></div><span class="state"></span>';
    card.querySelector(".t").textContent = s.title;
    card.querySelector(".s").textContent = `${secs.length} section${secs.length === 1 ? "" : "s"} · about ${seconds} s${s.source === "local" ? " · on this phone" : ""}`;
    const state = card.querySelector(".state");
    if (progress[s.id]?.sent) { state.textContent = "Done"; state.classList.add("sent"); }
    else if (kept) { state.textContent = `${kept}/${secs.length} recorded`; state.classList.add("partial"); }
    else state.textContent = "New";
    card.onclick = () => openStudio(s);
    card.onkeydown = (e) => e.key === "Enter" && openStudio(s);
    if (s.source === "local") {
      const edit = document.createElement("button");
      edit.className = "btn small"; edit.type = "button"; edit.textContent = "Edit";
      edit.onclick = (e) => { e.stopPropagation(); openEditor(s); };
      card.appendChild(edit);
    }
    list.appendChild(card);
  }
}

$("refresh").onclick = () => fetchScripts(true);
$("newScript").onclick = () => openEditor(null);
$("libSettings").onclick = () => showSetupCode(false);

// ---------- editor (phone-only scripts) ----------
let editing = null;
function openEditor(s) {
  editing = s;
  $("edTitle").value = s ? s.title : "";
  $("edBody").value = s ? s.body : "";
  $("edDelete").hidden = !s;
  $("edDeleteBox").hidden = true;
  show("editor");
}
$("edSave").onclick = async () => {
  const title = $("edTitle").value.trim() || "Untitled script";
  const body = $("edBody").value.replace(/\r/g, "").trim();
  if (!body) return $("edBody").focus();
  if (editing) Object.assign(local.find((s) => s.id === editing.id), { title, body });
  else local.unshift({ id: "local-" + Date.now().toString(36), title, body });
  await saveLocal();
  openLibrary();
};
$("edCancel").onclick = () => openLibrary();
$("edDelete").onclick = () => ($("edDeleteBox").hidden = false);
$("edDeleteNo").onclick = () => ($("edDeleteBox").hidden = true);
$("edDeleteYes").onclick = async () => {
  local = local.filter((s) => s.id !== editing.id);
  await store.clearTakes(editing.id);
  await saveLocal();
  openLibrary();
};

// ---------- camera and mic ----------
let stream = null, analyser = null, level = 0, voiceActive = false, lastVoice = 0;

async function startCamera() {
  stopCamera();
  const audio = { echoCancellation: false };
  if (settings.micId) audio.deviceId = { exact: settings.micId };
  const video = { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (err) {
    if (settings.micId && err.name === "OverconstrainedError") {
      settings.micId = ""; saveSettings();
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: { echoCancellation: false } });
    } else throw err;
  }
  $("cam").srcObject = stream;
  const src = ctx().createMediaStreamSource(stream);
  analyser = ctx().createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  stream.getAudioTracks()[0].addEventListener("ended", () => toast("The mic disconnected. Open Mic check to pick one."));
  updateMicName();
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

const cameraLive = () => stream && stream.getTracks().every((t) => t.readyState === "live");

function updateMicName() {
  const t = stream && stream.getAudioTracks()[0];
  $("micName").textContent = t ? t.label || "Phone microphone" : "No mic";
}

const levelBuf = new Float32Array(1024);
function levelLoop() {
  if (analyser) {
    analyser.getFloatTimeDomainData(levelBuf);
    let sum = 0;
    for (const x of levelBuf) sum += x * x;
    const db = 10 * Math.log10(sum / levelBuf.length + 1e-10);
    level = db;
    $("micLevel").style.width = Math.max(0, Math.min(100, (db + 70) * 1.6)) + "%";
    const threshold = -28 - settings.sens * 0.32; // 0 → -28 dB (needs a louder voice), 100 → -60 dB
    const now = performance.now();
    if (db > threshold) lastVoice = now;
    voiceActive = now - lastVoice < 700;
    prompter.voiceActive = voiceActive;
  }
  requestAnimationFrame(levelLoop);
}
requestAnimationFrame(levelLoop);

async function fillMicList() {
  const pick = $("micPick");
  pick.textContent = "";
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const current = stream?.getAudioTracks()[0]?.getSettings?.().deviceId;
  for (const d of devices) {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || "Microphone";
    if (d.deviceId === current) o.selected = true;
    pick.appendChild(o);
  }
  pick.disabled = devices.length < 2;
}

$("micPick").onchange = async () => {
  settings.micId = $("micPick").value; saveSettings();
  try { await startCamera(); } catch (e) { toast("Couldn't switch mics: " + e.message); }
};

// ---------- voice-following (speech recognition) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, recogWanted = false;

function startListening(onWords, onFail) {
  if (!SR) return onFail("unsupported");
  recogWanted = true;
  const r = new SR();
  r.lang = navigator.language || "en-US";
  r.continuous = true;
  r.interimResults = true;
  let failures = 0;
  r.onresult = (e) => {
    failures = 0;
    let text = "";
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + " ";
    onWords(text);
  };
  r.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    const fatal = ["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"].includes(e.error);
    if (fatal || ++failures >= 3) {
      recogWanted = false;
      onFail(e.error);
    }
  };
  r.onend = () => { if (recogWanted && recog === r) setTimeout(() => { try { r.start(); } catch {} }, 120); };
  recog = r;
  try { r.start(); } catch { recogWanted = false; onFail("start"); }
}

function stopListening() {
  recogWanted = false;
  const r = recog; recog = null;
  try { r && r.abort(); } catch {}
}

$("voiceTest").onclick = () => {
  const out = $("voiceOut");
  if (!SR) { out.textContent = "This browser doesn't offer voice-following. Use Scroll while I talk instead, or open the app in Safari."; return; }
  out.textContent = "Listening for 8 seconds. Read a sentence out loud…";
  let heard = "", quietDuringTest = true;
  const watch = setInterval(() => { if (level > -55) quietDuringTest = false; }, 100);
  startListening((t) => { heard = t; out.textContent = "Heard: " + t.split(/\s+/).slice(-12).join(" "); }, (why) => {
    clearInterval(watch);
    out.textContent = "Voice-following isn't allowed here (" + why + "). Use Scroll while I talk.";
  });
  setTimeout(() => {
    if (!recogWanted) return;
    stopListening();
    clearInterval(watch);
    const micOk = !quietDuringTest && cameraLive();
    out.textContent = (heard.trim() ? "✓ Voice-following heard you." : "✗ Voice-following didn't hear anything.") +
      (micOk ? " ✓ The recording mic kept working." : " ✗ The recording mic went quiet while listening, so use Scroll while I talk.");
  }, 8000);
};

// ---------- studio ----------
const prompter = new Prompter($("prompt"), $("promptText"));
prompter.onTap = () => {
  if (settings.mode === "follow" && !isRecording()) return;
  prompter.running = !prompter.running;
};

function applySettings() {
  prompter.mode = settings.mode;
  prompter.speed = pxPerSecond();
  $("promptText").style.setProperty("--fs", settings.size + "px");
  $("prompt").classList.toggle("flip", settings.flip);
  $("cam").classList.toggle("mirror", settings.mirror);
  $("speedVal").textContent = "Speed " + settings.speed;
  $("speedStep").hidden = settings.mode === "follow";
  $("modeChip").textContent = MODE_CHIP[settings.mode];
  drawGuides();
}

const ZONES = {
  tiktok: { name: "TikTok", t: 0.08, b: 0.24, l: 0.06, r: 0.14 },
  reels: { name: "Reels", t: 0.12, b: 0.3, l: 0.06, r: 0.13 },
  shorts: { name: "Shorts", t: 0.1, b: 0.24, l: 0.06, r: 0.14 },
};

function drawGuides() {
  const svg = $("guides");
  const W = 1080, H = 1920;
  let html = "";
  let z = ZONES[settings.guides];
  if (settings.guides === "all") {
    const zs = Object.values(ZONES);
    z = { name: "TikTok, Reels and Shorts", t: Math.max(...zs.map((q) => q.t)), b: Math.max(...zs.map((q) => q.b)), l: Math.max(...zs.map((q) => q.l)), r: Math.max(...zs.map((q) => q.r)) };
  }
  if (z) {
    const x = z.l * W, y = z.t * H, w = W - x - z.r * W, h = H - y - z.b * H;
    html += `<path d="M0 0H${W}V${H}H0Z M${x} ${y}V${y + h}H${x + w}V${y}Z" fill="rgba(0,0,0,0.28)" fill-rule="evenodd"/>`;
    html += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ffb340" stroke-width="4" stroke-dasharray="18 12" rx="10"/>`;
    html += `<text x="${x + 14}" y="${y + h - 18}" fill="#ffb340" font-size="30" font-family="-apple-system, system-ui" font-weight="600">${z.name} safe area (approx.)</text>`;
  }
  if (settings.center) {
    html += `<line x1="${W / 2}" y1="0" x2="${W / 2}" y2="${H}" stroke="rgba(255,255,255,0.55)" stroke-width="3"/>`;
    html += `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>`;
    html += `<line x1="0" y1="${H / 3}" x2="${W}" y2="${H / 3}" stroke="rgba(255,255,255,0.25)" stroke-width="2" stroke-dasharray="10 10"/>`;
    html += `<circle cx="${W / 2}" cy="${H / 2}" r="22" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="3"/>`;
  }
  svg.innerHTML = html;
}

document.querySelectorAll("[data-step]").forEach((b) => {
  b.onclick = () => {
    const [what, dir] = b.dataset.step.split(":");
    if (what === "speed") settings.speed = Math.max(1, Math.min(10, settings.speed + Number(dir)));
    if (what === "size") settings.size = Math.max(20, Math.min(56, settings.size + 3 * Number(dir)));
    saveSettings(); applySettings();
  };
});

$("modeChip").onclick = () => {
  const order = ["follow", "talk", "steady"];
  settings.mode = order[(order.indexOf(settings.mode) + 1) % 3];
  saveSettings(); applySettings();
  toast(MODE_LABEL[settings.mode]);
};
$("restartBtn").onclick = () => { prompter.reset(); };

let toastTimer = 0;
function toast(msg, ms = 3500) {
  const t = $("studioMsg");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

async function openStudio(s) {
  ctx(); // tap → allowed to start audio
  script = s;
  sections = splitSections(s.body);
  takes = await store.takesFor(s.id);
  sectionIndex = Math.max(0, sections.findIndex((_, i) => !takes[i]));
  if (Object.keys(takes).length >= sections.length) sectionIndex = 0;
  show("studio");
  applySettings();
  loadSection(sectionIndex);
  drive.warmUp();
  try {
    if (!cameraLive()) await startCamera();
    await fillMicList();
    openSheet("micSheet");
  } catch (err) {
    toast(err.name === "NotAllowedError"
      ? "Camera or mic access is off. In Settings → Safari → Camera and Microphone, choose Allow, then reopen the app."
      : "The camera didn't start: " + err.message, 12000);
  }
}

function loadSection(i) {
  sectionIndex = i;
  const next = sections[i + 1] ? sections[i + 1].split(/\s+/).slice(0, 8).join(" ") + "…" : "";
  prompter.setText(sections[i], next);
  prompter.running = false;
  $("sectionChip").textContent = `Section ${i + 1} of ${sections.length}${takes[i] ? " ✓" : ""}`;
}

$("backBtn").onclick = () => {
  if (isRecording()) return;
  stopListening();
  stopCamera();
  openLibrary();
};

// sheets
function openSheet(id) {
  ["micSheet", "setSheet", "secSheet"].forEach((s) => ($(s).hidden = s !== id));
}
const closeSheets = () => openSheet(null);

$("micOk").onclick = () => { stopListening(); closeSheets(); };
$("settingsBtn").onclick = () => {
  if (isRecording()) return;
  $("setMode").value = settings.mode;
  $("setSens").value = settings.sens;
  $("setGuides").value = settings.guides;
  $("setCenter").checked = settings.center;
  $("setMirror").checked = settings.mirror;
  $("setFlip").checked = settings.flip;
  $("setCount").checked = settings.countdown;
  openSheet("setSheet");
};
const bindSetting = (id, key, prop = "value", conv = (v) => v) => ($(id).onchange = () => { settings[key] = conv($(id)[prop]); saveSettings(); applySettings(); });
bindSetting("setMode", "mode");
bindSetting("setSens", "sens", "value", Number);
bindSetting("setGuides", "guides");
bindSetting("setCenter", "center", "checked");
bindSetting("setMirror", "mirror", "checked");
bindSetting("setFlip", "flip", "checked");
bindSetting("setCount", "countdown", "checked");
$("setClose").onclick = closeSheets;
$("setMic").onclick = async () => { await fillMicList(); openSheet("micSheet"); };
$("setCode").onclick = () => { stopCamera(); showSetupCode(false); };
$("setLock").onclick = () => { stopCamera(); showLock(); };

$("sectionChip").onclick = () => {
  if (isRecording()) return;
  const ol = $("secList");
  ol.textContent = "";
  sections.forEach((text, i) => {
    const li = document.createElement("li");
    li.className = (takes[i] ? "have" : "") + (i === sectionIndex ? " current" : "");
    li.innerHTML = '<span class="p"></span><span class="k"></span>';
    li.querySelector(".p").textContent = text;
    li.querySelector(".k").textContent = takes[i] ? `Recorded · ${takes[i].duration.toFixed(1)} s · tap to redo` : "Not recorded yet";
    li.onclick = () => { closeSheets(); loadSection(i); };
    ol.appendChild(li);
  });
  $("secTitle").textContent = script.title;
  $("secFinish").disabled = !Object.keys(takes).length;
  openSheet("secSheet");
};
$("secClose").onclick = closeSheets;
$("secFinish").onclick = () => { closeSheets(); openFinal(); };

// ---------- recording one section ----------
let recorder = null, chunks = [], recStart = 0, recElapsed = 0, recPaused = false, timerId = 0, counting = false;
const isRecording = () => counting || (recorder && recorder.state !== "inactive");

function setRecUi() {
  const on = isRecording();
  $("recBtn").classList.toggle("on", on);
  $("recBtn").classList.toggle("paused", recPaused);
  $("recBtn").setAttribute("aria-label", on ? "Stop" : "Record");
  $("pauseBtn").disabled = !on || counting;
  $("doneBtn").disabled = !on || counting;
  $("pauseBtn").textContent = recPaused ? "▶" : "❚❚";
  $("pauseBtn").setAttribute("aria-label", recPaused ? "Resume" : "Pause");
  $("recTimer").hidden = !on || counting;
  $("backBtn").disabled = on;
}

function elapsed() { return recElapsed + (recPaused ? 0 : (performance.now() - recStart) / 1000); }

function startFollowIfNeeded() {
  if (settings.mode !== "follow") return;
  startListening((t) => prompter.hear(t), () => {
    settings.mode = "talk"; saveSettings(); applySettings();
    toast("Voice-following isn't available here, so the script now scrolls while you talk.", 6000);
  });
}

$("recBtn").onclick = async () => {
  if (isRecording()) return stopRecording();
  if (!cameraLive()) { try { await startCamera(); } catch (e) { return toast("The camera didn't start: " + e.message); } }
  closeSheets();
  prompter.reset();
  if (settings.countdown) {
    counting = true; setRecUi();
    for (const n of [3, 2, 1]) {
      $("countdown").textContent = n; $("countdown").hidden = false;
      await new Promise((r) => setTimeout(r, 800));
      if (!counting) { $("countdown").hidden = true; return setRecUi(); }
    }
    $("countdown").hidden = true;
    counting = false;
  }
  const mime = pickMime();
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = onRecorded;
  recorder.start(1000);
  recStart = performance.now(); recElapsed = 0; recPaused = false;
  prompter.running = true;
  startFollowIfNeeded();
  timerId = setInterval(() => ($("recTimer").textContent = "● " + fmtTime(elapsed())), 250);
  setRecUi();
};

$("pauseBtn").onclick = () => {
  if (!recorder || recorder.state === "inactive") return;
  if (!recPaused) {
    recorder.pause();
    recElapsed += (performance.now() - recStart) / 1000;
    recPaused = true;
    prompter.running = false;
    stopListening();
  } else {
    recorder.resume();
    recStart = performance.now();
    recPaused = false;
    prompter.running = true;
    startFollowIfNeeded();
  }
  setRecUi();
};

$("doneBtn").onclick = () => stopRecording();

function stopRecording() {
  if (counting) { counting = false; return; }
  if (!recorder || recorder.state === "inactive") return;
  if (!recPaused) recElapsed += (performance.now() - recStart) / 1000;
  recPaused = false;
  recorder.stop();
  prompter.running = false;
  stopListening();
  clearInterval(timerId);
}

let pendingTake = null;
function onRecorded() {
  const mime = recorder.mimeType.split(";")[0] || "video/mp4";
  const blob = new Blob(chunks, { type: mime });
  recorder = null;
  setRecUi();
  if (blob.size < 1000) return toast("That take was empty. Try again.");
  pendingTake = { blob, mime, duration: recElapsed, at: Date.now() };
  const v = $("takeVideo");
  v.src = URL.createObjectURL(blob);
  $("takeSheet").hidden = false;
  v.play().catch(() => {});
}

function closeTake() {
  const v = $("takeVideo");
  v.pause();
  URL.revokeObjectURL(v.src);
  v.removeAttribute("src");
  $("takeSheet").hidden = true;
}

$("takeRetake").onclick = () => { pendingTake = null; closeTake(); prompter.reset(); };
$("takeKeep").onclick = async () => {
  closeTake();
  takes[sectionIndex] = pendingTake;
  await store.idb.put("takes", store.takeKey(script.id, sectionIndex), pendingTake);
  pendingTake = null;
  const next = sections.findIndex((_, i) => !takes[i]);
  if (next === -1) return openFinal();
  loadSection(next);
  toast(`Section ${next + 1} next.`);
};

// Recording stops if the app goes to the background.
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) return;
  if ($("studio").classList.contains("on") || $("final").classList.contains("on")) keepAwake();
  if (!$("studio").classList.contains("on")) return;
  if (!cameraLive()) {
    if (recorder && recorder.state !== "inactive") {
      try { recorder.stop(); } catch {}
      toast("Recording stopped because the app was in the background. Retake this section.", 8000);
    }
    try { await startCamera(); } catch {}
  }
});

// ---------- finish: trim, stitch, send ----------
let curves = {};      // take.at -> loudness curve
let finalTakes = [];  // takes in section order
let rendered = null;  // { key, blob, mime }

async function openFinal() {
  stopListening();
  stopCamera();
  show("final");
  $("finalTitle").textContent = script.title;
  $("finalMsg").textContent = "";
  $("progressBox").hidden = true;
  $("finalActions").hidden = false;
  $("doneActions").hidden = true;
  $("sendBtn").textContent = drive.configured() ? "OK, send to Google Drive" : "Make the video";
  const missing = sections.map((_, i) => i).filter((i) => !takes[i]);
  if (missing.length) $("finalMsg").textContent = `Section ${missing.map((i) => i + 1).join(", ")} has no take yet and will be left out.`;
  finalTakes = sections.map((_, i) => takes[i]).filter(Boolean);
  rendered = null;
  if (finalTakes[0]) {
    const v = $("finalVideo");
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(finalTakes[0].blob) + "#t=0.1";
  }
  drive.warmUp();
  $("trimInfo").textContent = "Working out the quiet parts…";
  for (const t of finalTakes) {
    if (curves[t.at]) continue;
    try { curves[t.at] = await loudness(ctx(), t.blob); }
    catch { curves[t.at] = { db: new Float32Array(0), duration: t.duration }; }
  }
  updateTrimInfo();
}

function segments() {
  return finalTakes.flatMap((t, i) => {
    const c = curves[t.at];
    if (!c) return [{ take: i, start: 0, end: t.duration }];
    const ranges = $("trimOn").checked ? speechRanges(c, $("trimStrength").value / 100) : [[0, c.duration]];
    return ranges.map(([start, end]) => ({ take: i, start, end }));
  });
}

function updateTrimInfo() {
  $("trimBox").hidden = !$("trimOn").checked;
  const full = finalTakes.reduce((t, k) => t + (curves[k.at]?.duration || k.duration), 0);
  const kept = totalLength(segments());
  $("trimInfo").textContent = $("trimOn").checked
    ? `Cuts ${(full - kept).toFixed(1)} s of quiet. New length ${kept.toFixed(1)} s (was ${full.toFixed(1)} s).`
    : `Length ${full.toFixed(1)} s.`;
  stopPreview();
}
$("trimOn").onchange = updateTrimInfo;
$("trimStrength").oninput = updateTrimInfo;

// Preview jumps through the kept parts without making a new file, so changes show instantly.
let preview = null;
function stopPreview() {
  if (!preview) return;
  preview.stop = true;
  $("finalVideo").pause();
  $("finalPlay").hidden = false;
  preview = null;
}

$("finalPlay").onclick = async () => {
  const segs = segments();
  if (!segs.length) return;
  const v = $("finalVideo");
  const urls = finalTakes.map((t) => URL.createObjectURL(t.blob));
  const p = (preview = { stop: false });
  $("finalPlay").hidden = true;
  let current = -1;
  for (const seg of segs) {
    if (p.stop) break;
    if (seg.take !== current) {
      v.src = urls[seg.take];
      current = seg.take;
      await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
    }
    v.currentTime = seg.start;
    await v.play().catch(() => {});
    await new Promise((r) => {
      const tick = () => (p.stop || v.currentTime >= seg.end - 0.03 || v.ended ? r() : requestAnimationFrame(tick));
      tick();
    });
  }
  v.pause();
  urls.forEach((u) => URL.revokeObjectURL(u));
  if (preview === p) { preview = null; $("finalPlay").hidden = false; }
};
$("finalVideo").onclick = stopPreview;

function fileName(ext) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `${script.title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 60).trim()} ${stamp}.${ext}`;
}

function progress(frac, text) {
  $("progressBox").hidden = false;
  $("progressBar").style.width = Math.round(frac * 100) + "%";
  $("progressText").textContent = text;
}

// Starts from a tap. Makes (or reuses) the finished video.
async function makeVideo(primed) {
  const segs = segments();
  const key = JSON.stringify(segs.map((s) => [s.take, s.start.toFixed(2), s.end.toFixed(2)]));
  if (rendered && rendered.key === key) { if (primed) releasePlayers(primed); return rendered; }
  const single = segs.length === 1 && segs[0].start < 0.05 && finalTakes.length === 1 && segs[0].end >= (curves[finalTakes[0].at]?.duration || 0) - 0.05;
  if (single && primed) {
    // One untrimmed take: use it as recorded, no need to remake it.
    releasePlayers(primed);
    const t = finalTakes[0];
    rendered = { key, blob: t.blob, mime: t.mime };
    return rendered;
  }
  const total = totalLength(segs);
  const out = await render(primed, segs, {
    onProgress: (f) => progress(f, `Making your video… ${Math.round(f * total)} of ${Math.round(total)} s. Keep this screen open.`),
  });
  releasePlayers(primed);
  if (!out) throw new Error("Making the video stopped. Try again.");
  rendered = { key, blob: out.blob, mime: out.mime };
  return rendered;
}

function busy(on) {
  for (const id of ["sendBtn", "saveBtn", "finalBack", "trimOn", "trimStrength", "saveAfter", "nextScript"]) $(id).disabled = on;
}

$("sendBtn").onclick = async () => {
  stopPreview();
  $("finalMsg").textContent = "";
  const primed = rendered ? null : primePlayers(finalTakes, ctx());
  const signing = drive.configured() ? drive.signIn() : null;
  signing?.catch(() => {});
  busy(true);
  try {
    const video = await makeVideo(primed);
    if (!drive.configured()) {
      progress(1, "Your video is ready.");
      showDone(false);
      return;
    }
    const name = fileName(extFor(video.mime));
    const id = "v" + Date.now();
    await store.idb.put("outbox", id, { blob: video.blob, name, mime: video.mime, scriptId: script.id, at: Date.now() });
    try {
      await signing;
      progress(0, "Uploading to Google Drive…");
      await drive.upload(video.blob, name, video.mime, (f) => progress(f, `Uploading to Google Drive… ${Math.round(f * 100)}%`));
      await store.idb.del("outbox", id);
      progress(1, `Uploaded to Google Drive › Teleprompter Recordings as "${name}".`);
      showDone(true);
    } catch (err) {
      progress(1, "Your video is saved on this phone and will upload next time you open the app.");
      $("finalMsg").textContent = err.message;
      showDone(false);
    }
  } catch (err) {
    $("finalMsg").textContent = err.message;
    $("progressBox").hidden = true;
  } finally {
    busy(false);
  }
};

async function shareVideo(video) {
  const file = new File([video.blob], fileName(extFor(video.mime)), { type: video.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (err) { if (err.name === "AbortError") return false; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  return true;
}

$("saveBtn").onclick = async () => {
  stopPreview();
  $("finalMsg").textContent = "";
  if (rendered && rendered.key === JSON.stringify(segments().map((s) => [s.take, s.start.toFixed(2), s.end.toFixed(2)]))) {
    if (await shareVideo(rendered)) markSaved();
    return;
  }
  const primed = primePlayers(finalTakes, ctx());
  busy(true);
  try {
    await makeVideo(primed);
    progress(1, "Ready. Tap Save to camera roll, then choose Save Video.");
    $("saveBtn").textContent = "Save to camera roll";
  } catch (err) {
    $("finalMsg").textContent = err.message;
  } finally { busy(false); }
};

$("saveAfter").onclick = async () => { if (rendered && (await shareVideo(rendered))) markSaved(); };

function markSaved() {
  const p = store.get("progress", {});
  p[script.id] = { ...(p[script.id] || {}), saved: true, sent: p[script.id]?.sent || !drive.configured() };
  store.set("progress", p);
}

function showDone(uploaded) {
  $("finalActions").hidden = true;
  $("doneActions").hidden = false;
  $("saveAfter").textContent = uploaded ? "Also save to camera roll" : "Save to camera roll";
  if (uploaded) {
    const p = store.get("progress", {});
    p[script.id] = { ...(p[script.id] || {}), sent: true };
    store.set("progress", p);
    store.clearTakes(script.id);
  }
}

$("finalBack").onclick = async () => {
  stopPreview();
  show("studio");
  applySettings();
  loadSection(sectionIndex);
  try { await startCamera(); } catch {}
};

$("nextScript").onclick = async () => {
  const p = store.get("progress", {});
  if (p[script.id]?.saved || p[script.id]?.sent) await store.clearTakes(script.id);
  if (!drive.configured()) { p[script.id] = { ...(p[script.id] || {}), sent: !!p[script.id]?.saved }; store.set("progress", p); }
  openLibrary();
};

// ---------- videos waiting to upload ----------
async function refreshOutboxNote() {
  const keys = await store.idb.keys("outbox").catch(() => []);
  const note = $("outboxNote");
  note.hidden = !keys.length || !drive.configured();
  if (note.hidden) return;
  drive.warmUp();
  note.innerHTML = `<span>${keys.length} video${keys.length === 1 ? "" : "s"} waiting to upload to Google Drive.</span><button class="btn small primary" type="button">Upload now</button>`;
  note.querySelector("button").onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await drive.signIn();
      for (const k of keys) {
        const item = await store.idb.get("outbox", k);
        note.querySelector("span").textContent = `Uploading "${item.name}"…`;
        await drive.upload(item.blob, item.name, item.mime, (f) => (note.querySelector("span").textContent = `Uploading "${item.name}"… ${Math.round(f * 100)}%`));
        await store.idb.del("outbox", k);
        const p = store.get("progress", {});
        p[item.scriptId] = { ...(p[item.scriptId] || {}), sent: true };
        store.set("progress", p);
        await store.clearTakes(item.scriptId);
      }
      refreshOutboxNote();
      renderLibrary();
    } catch (err) {
      note.querySelector("span").textContent = err.message;
      btn.disabled = false;
    }
  };
}

// ---------- start ----------
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
  document.body.insertAdjacentHTML("afterbegin", '<p class="banner pad">This browser can\'t record video. Open the app in Safari on your iPhone.</p>');
}
showLock();
