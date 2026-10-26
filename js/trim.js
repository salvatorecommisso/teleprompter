// Finds the spoken parts of each take so the quiet gaps can be cut.

const FRAME = 0.01; // seconds per loudness reading

// Reads a take's audio into a loudness curve (dB per 10 ms). Cached per take.
export async function loudness(audioCtx, blob) {
  const buf = await audioCtx.decodeAudioData(await blob.arrayBuffer());
  const data = buf.getChannelData(0);
  const step = Math.max(1, Math.round(buf.sampleRate * FRAME));
  const db = new Float32Array(Math.floor(data.length / step));
  for (let f = 0; f < db.length; f++) {
    let sum = 0;
    for (let i = f * step, end = i + step; i < end; i++) sum += data[i] * data[i];
    db[f] = 10 * Math.log10(sum / step + 1e-10);
  }
  return { db, duration: buf.duration };
}

// strength 0 = gentle, 1 = tight. Returns [[start, end], ...] in seconds to keep.
export function speechRanges(curve, strength) {
  const { db, duration } = curve;
  if (!db.length) return [[0, duration]];
  const pad = 0.38 - 0.26 * strength;      // cushion kept around speech (0.38 s → 0.12 s)
  const minGap = 0.8 - 0.6 * strength;     // silence shorter than this stays in (0.8 s → 0.2 s)

  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.15)];
  const peak = sorted[Math.floor(sorted.length * 0.98)];
  // Speech threshold sits a third of the way from the room noise to the loud parts,
  // and at least 8 dB above the noise, so soft consonants still count as speech.
  const threshold = Math.max(floor + 8, floor + (peak - floor) * 0.33);
  if (peak - floor < 10) return [[0, duration]]; // no clear speech: keep everything

  const raw = [];
  let start = -1;
  for (let f = 0; f <= db.length; f++) {
    const loud = f < db.length && db[f] >= threshold;
    if (loud && start < 0) start = f;
    if (!loud && start >= 0) { raw.push([start * FRAME, f * FRAME]); start = -1; }
  }
  if (!raw.length) return [[0, duration]];

  const ranges = [];
  for (const [s, e] of raw) {
    const a = Math.max(0, s - pad), b = Math.min(duration, e + pad);
    const last = ranges[ranges.length - 1];
    if (last && a - last[1] < minGap) last[1] = Math.max(last[1], b);
    else ranges.push([a, b]);
  }
  return ranges.filter(([a, b]) => b - a > 0.08);
}

export const totalLength = (segments) => segments.reduce((t, s) => t + (s.end - s.start), 0);
