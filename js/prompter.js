// The scrolling script. Three ways to move:
//   "steady": fixed speed while running
//   "talk":   fixed speed, but only while the mic hears a voice
//   "follow": jumps to the words speech recognition hears

const norm = (w) => w.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9']/g, "").replace(/'/g, "");

function lev1(a, b) {
  // true when a and b differ by at most one letter
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const same = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (lev1(a, b) || a.startsWith(b) || b.startsWith(a)));

export class Prompter {
  constructor(viewport, content) {
    this.viewport = viewport;
    this.content = content;
    this.y = 0;
    this.target = null;
    this.running = false;
    this.speed = 40;
    this.mode = "steady";
    this.voiceActive = false;
    this.words = [];
    this.spans = [];
    this.cursor = 0;
    this.last = 0;
    requestAnimationFrame((t) => this.frame(t));
    this.bindDrag();
  }

  setText(text, nextPreview = "") {
    this.content.textContent = "";
    this.words = [];
    this.spans = [];
    const paras = text.split(/\n/);
    paras.forEach((line, li) => {
      const p = document.createElement("p");
      for (const part of line.split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { p.appendChild(document.createTextNode(part)); continue; }
        const s = document.createElement("span");
        s.textContent = part;
        p.appendChild(s);
        const n = norm(part);
        if (n) { this.words.push(n); this.spans.push(s); }
      }
      if (!line.trim()) p.innerHTML = "&nbsp;";
      this.content.appendChild(p);
    });
    if (nextPreview) {
      const p = document.createElement("p");
      p.className = "next";
      p.textContent = "Next: " + nextPreview;
      this.content.appendChild(p);
    }
    this.reset();
  }

  reset() {
    this.y = 0;
    this.target = null;
    this.cursor = 0;
    this.spans.forEach((s) => s.classList.remove("said"));
    this.apply();
  }

  readingLine() { return this.viewport.clientHeight * 0.3; }

  apply() {
    const max = Math.max(0, this.content.scrollHeight - this.readingLine());
    this.y = Math.max(0, Math.min(max, this.y));
    this.content.style.transform = `translateY(${this.readingLine() - this.y}px)`;
  }

  frame(t) {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    if (this.running && !this.dragging) {
      if (this.mode === "follow") {
        if (this.target != null) this.y += (this.target - this.y) * Math.min(1, dt * 6);
      } else if (this.mode === "steady" || (this.mode === "talk" && this.voiceActive)) {
        this.y += this.speed * dt;
      }
      this.apply();
    }
    requestAnimationFrame((t2) => this.frame(t2));
  }

  bindDrag() {
    let startY = 0, startScroll = 0, moved = false;
    this.viewport.addEventListener("pointerdown", (e) => {
      this.dragging = true; moved = false;
      startY = e.clientY; startScroll = this.y;
      this.viewport.setPointerCapture(e.pointerId);
    });
    this.viewport.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      if (Math.abs(e.clientY - startY) > 6) moved = true;
      if (moved) { this.y = startScroll - (e.clientY - startY); this.target = null; this.apply(); }
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      if (!moved && this.onTap) this.onTap();
      if (moved && this.mode === "follow") this.cursor = this.wordAtReadingLine();
    };
    this.viewport.addEventListener("pointerup", end);
    this.viewport.addEventListener("pointercancel", end);
  }

  wordAtReadingLine() {
    for (let i = 0; i < this.spans.length; i++) if (this.spans[i].offsetTop + this.spans[i].offsetHeight > this.y) return i;
    return this.spans.length;
  }

  // Called with the most recent words speech recognition heard.
  hear(transcript) {
    const heard = transcript.split(/\s+/).map(norm).filter(Boolean).slice(-6);
    if (!heard.length || !this.words.length) return;
    const from = Math.max(0, this.cursor - 4), to = Math.min(this.words.length - 1, this.cursor + 30);
    let best = -1, bestScore = 0;
    for (let j = from; j <= to; j++) {
      if (!same(heard[heard.length - 1], this.words[j])) continue;
      let score = 1, pos = j - 1;
      for (let h = heard.length - 2; h >= 0 && pos >= 0; h--) {
        for (let k = pos; k >= Math.max(0, pos - 2); k--) {
          if (same(heard[h], this.words[k])) { score++; pos = k - 1; break; }
        }
      }
      const better = score > bestScore || (score === bestScore && best >= 0 && Math.abs(j - this.cursor) < Math.abs(best - this.cursor));
      if (better) { best = j; bestScore = score; }
    }
    if (best < 0) return;
    const nearby = best >= this.cursor - 1 && best <= this.cursor + 4;
    const goingBack = best < this.cursor - 1;
    if (bestScore >= 3 || (bestScore >= 2 && !goingBack) || (bestScore === 1 && nearby && heard[heard.length - 1].length >= 3)) {
      this.cursor = best + 1;
      for (let i = 0; i < this.spans.length; i++) this.spans[i].classList.toggle("said", i <= best);
      const s = this.spans[best];
      this.target = s.offsetTop + s.offsetHeight / 2;
    }
  }
}
