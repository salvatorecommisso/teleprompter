// Stitches the kept parts of every take into one 9:16 video.
// It plays each part into a canvas and records that canvas with the take's sound,
// so it takes about as long as the finished video. The recorder pauses between
// parts, so the cuts land cleanly.

export function pickMime() {
  const options = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];
  if (typeof MediaRecorder === "undefined") return "";
  return options.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

export const extFor = (mime) => (mime.includes("mp4") ? "mp4" : "webm");

// Must be called straight from a tap: iPhones only let a video play with sound
// if it was first started by the person.
export function primePlayers(takes, audioCtx) {
  const dest = audioCtx.createMediaStreamDestination();
  const gain = audioCtx.createGain();
  const limiter = audioCtx.createDynamicsCompressor(); // keeps boosted peaks from crackling
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;
  gain.connect(limiter).connect(dest);
  const players = takes.map((take) => {
    const v = document.createElement("video");
    v.playsInline = true;
    v.preload = "auto";
    v.src = URL.createObjectURL(take.blob);
    v.style.cssText = "position:fixed;width:72px;height:128px;opacity:0.01;pointer-events:none;left:0;bottom:0;z-index:-1";
    document.body.appendChild(v);
    audioCtx.createMediaElementSource(v).connect(gain);
    const p = v.play();
    v.primed = p ? p.then(() => v.pause()).catch(() => {}) : Promise.resolve();
    return v;
  });
  return { players, dest, gain };
}

export function releasePlayers(primed) {
  for (const v of primed.players) {
    v.pause();
    URL.revokeObjectURL(v.src);
    v.remove();
  }
}

// Average brightness (0-255) of the middle of each take, as a correction factor per take.
async function brightnessFactors(players, segments, crop) {
  const takes = [...new Set(segments.map((s) => s.take))];
  if (takes.length < 2) return {};
  const c = document.createElement("canvas");
  c.width = c.height = 24;
  const g = c.getContext("2d", { willReadFrequently: true });
  const luma = {};
  for (const t of takes) {
    const segs = segments.filter((s) => s.take === t);
    const mid = (segs[0].start + segs[segs.length - 1].end) / 2;
    try {
      await seek(players[t], mid);
      g.drawImage(players[t], ...crop(players[t]), 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      luma[t] = sum / (d.length / 4);
    } catch {}
  }
  const vals = Object.values(luma).filter((x) => x > 8).sort((a, b) => a - b);
  if (vals.length < 2) return {};
  const target = vals[Math.floor(vals.length / 2)];
  const out = {};
  for (const t in luma) if (luma[t] > 8) out[t] = Math.max(0.8, Math.min(1.25, target / luma[t]));
  return out;
}

const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));

async function seek(v, t) {
  if (v.readyState < 1) await once(v, "loadedmetadata");
  if (Math.abs(v.currentTime - t) < 0.01 && v.readyState >= 2) return;
  const done = once(v, "seeked");
  v.currentTime = t;
  await done;
}

// segments: [{ take, start, end }], where take indexes primed.players.
export async function render(primed, segments, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const { players, dest } = primed;
  // Each part fades its sound in and out over a few hundredths of a second, so cuts don't click.
  const vol = primed.gain.gain, ac = primed.gain.context, FADE = 0.025;
  await Promise.all(players.map((v) => v.primed));
  const first = players[segments[0].take];
  if (first.readyState < 1) await once(first, "loadedmetadata");
  const srcW = first.videoWidth || 1080, srcH = first.videoHeight || 1920;

  // Output: 9:16, cropped from the middle of the camera picture, at most 1080x1920.
  let cropW = srcW, cropH = Math.round(srcW * 16 / 9);
  if (cropH > srcH) { cropH = srcH; cropW = Math.round(srcH * 9 / 16); }
  const outW = Math.min(1080, Math.round(cropW / 18) * 18), outH = outW / 9 * 16; // both even, exact 9:16

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const g = canvas.getContext("2d");
  const crop = (v) => {
    const w = v.videoWidth || srcW, h = v.videoHeight || srcH;
    let cw = w, ch = Math.round(w * 16 / 9);
    if (ch > h) { ch = h; cw = Math.round(h * 9 / 16); }
    return [(w - cw) / 2, (h - ch) / 2, cw, ch];
  };

  // iPhones won't let web apps lock exposure, so sections can come out a little brighter or darker.
  // Measure each take's brightness and nudge them all toward the middle one.
  const shade = await brightnessFactors(players, segments, crop);
  let factor = 1;
  const draw = (v) => {
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.drawImage(v, ...crop(v), 0, 0, outW, outH);
    if (factor > 1.01) { // add a share of the picture on top of itself
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = factor - 1;
      g.drawImage(v, ...crop(v), 0, 0, outW, outH);
    } else if (factor < 0.99) { // lay a little black over it
      g.globalAlpha = 1 - factor;
      g.fillStyle = "#000";
      g.fillRect(0, 0, outW, outH);
    }
  };

  const mime = pickMime();
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 160_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = once(rec, "stop");

  const total = segments.reduce((t, s) => t + s.end - s.start, 0);
  let doneTime = 0;

  for (const seg of segments) {
    if (isCancelled()) break;
    const v = players[seg.take];
    factor = shade[seg.take] ?? 1;
    await seek(v, seg.start);
    draw(v);
    const level = seg.gain ?? 1;
    vol.cancelScheduledValues(ac.currentTime);
    vol.setValueAtTime(0, ac.currentTime);
    await v.play();
    if (rec.state === "inactive") rec.start(1000);
    else rec.resume();
    vol.linearRampToValueAtTime(level, ac.currentTime + FADE);
    let fading = false;
    await new Promise((resolve) => {
      const tick = () => {
        draw(v);
        onProgress(Math.min(1, (doneTime + Math.max(0, v.currentTime - seg.start)) / total));
        if (!fading && v.currentTime >= seg.end - FADE - 0.02) {
          fading = true;
          vol.cancelScheduledValues(ac.currentTime);
          vol.setValueAtTime(vol.value, ac.currentTime);
          vol.linearRampToValueAtTime(0, ac.currentTime + FADE);
        }
        if (v.currentTime >= seg.end - 0.02 || v.ended || isCancelled()) return resolve();
        requestAnimationFrame(tick);
      };
      tick();
    });
    rec.pause();
    v.pause();
    doneTime += seg.end - seg.start;
  }

  if (rec.state !== "inactive") rec.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());
  if (isCancelled()) return null;
  onProgress(1);
  return { blob: new Blob(chunks, { type: mime.split(";")[0] }), mime: mime.split(";")[0], width: outW, height: outH };
}
