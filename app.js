/* ————————————————————————————————————————————————
   Motion Muse
   Webcam hand-tracking instrument.
   Left hand — root wheel. Right hand — chord quality.
   MediaPipe HandLandmarker (local) + Tone.js.
   ———————————————————————————————————————————————— */

// ——— music data ————————————————————————————————

// Circle of fifths: neighbouring segments are musically related,
// so sweeping the wheel sounds intentional rather than random.
const ROOTS = [
  { name: "C",  pc: 0 }, { name: "G",  pc: 7 }, { name: "D",  pc: 2 },
  { name: "A",  pc: 9 }, { name: "E",  pc: 4 }, { name: "B",  pc: 11 },
  { name: "F♯", pc: 6 }, { name: "D♭", pc: 1 }, { name: "A♭", pc: 8 },
  { name: "E♭", pc: 3 }, { name: "B♭", pc: 10 }, { name: "F",  pc: 5 },
];

const QUALITIES = [
  { name: "maj",  suffix: "",     intervals: [0, 4, 7] },
  { name: "min",  suffix: "m",    intervals: [0, 3, 7] },
  { name: "7",    suffix: "7",    intervals: [0, 4, 7, 10] },
  { name: "maj7", suffix: "maj7", intervals: [0, 4, 7, 11] },
  { name: "m7",   suffix: "m7",   intervals: [0, 3, 7, 10] },
  { name: "sus4", suffix: "sus4", intervals: [0, 5, 7] },
  { name: "dim",  suffix: "dim",  intervals: [0, 3, 6] },
  { name: "aug",  suffix: "aug",  intervals: [0, 4, 8] },
];

// Melody strip: C major, two octaves.
const MELODY_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MELODY_KEYS = Array.from({ length: 15 }, (_, i) => {
  const oct = Math.floor(i / 7);
  const step = MELODY_STEPS[i % 7];
  return { midi: 60 + oct * 12 + step, name: "CDEFGAB"[i % 7] };
});

// ——— state ————————————————————————————————————

const state = {
  mode: "chords",            // 'chords' | 'melody'
  tracking: false,           // camera + hands active
  rootIdx: null,             // currently sounding root
  qualityIdx: 0,             // last chosen quality (persists)
  playing: false,
  melodyKeyIdx: null,
  pointers: { left: null, right: null }, // {x, y, pinch} in screen px
  hands: [],                 // raw landmarks for skeleton drawing
  mouse: { x: -1, y: -1, inside: false },
};

// selection debounce
const debounce = {
  root: { candidate: null, frames: 0, missing: 0 },
  quality: { candidate: null, frames: 0 },
};
const STABLE_FRAMES = 3;   // frames a new segment must hold before it counts
const GRACE_FRAMES = 10;   // frames the hand may leave before the chord releases

// ——— audio engine ——————————————————————————————

const engine = (() => {
  let ready = false;
  let chordSynth, melodySynth;
  let currentNotes = [];

  async function init() {
    if (ready) return;
    await Tone.start();

    const limiter = new Tone.Limiter(-2).toDestination();
    const reverb = new Tone.Reverb({ decay: 4.2, wet: 0.34 }).connect(limiter);
    const filter = new Tone.Filter(2600, "lowpass").connect(reverb);

    chordSynth = new Tone.PolySynth(Tone.Synth, {
      maxPolyphony: 24,
      volume: -10,
      oscillator: { type: "triangle8" },
      envelope: { attack: 0.025, decay: 0.35, sustain: 0.45, release: 1.4 },
    }).connect(filter);

    const melodyVerb = new Tone.Reverb({ decay: 2.6, wet: 0.28 }).connect(limiter);
    melodySynth = new Tone.Synth({
      volume: -6,
      oscillator: { type: "sine" },
      envelope: { attack: 0.01, decay: 0.15, sustain: 0.6, release: 0.5 },
    }).connect(melodyVerb);

    ready = true;
  }

  function voice(rootPc, intervals) {
    const bass = 36 + rootPc;                       // root, octave 2
    const body = intervals.map((iv) => 48 + rootPc + iv); // triad/7th, octave 3
    return [bass, ...body];
  }

  function playChord(rootIdx, qualityIdx) {
    if (!ready) return;
    const now = Tone.now();
    if (currentNotes.length) chordSynth.triggerRelease(currentNotes.map(m => Tone.Frequency(m, "midi")), now);
    currentNotes = voice(ROOTS[rootIdx].pc, QUALITIES[qualityIdx].intervals);
    currentNotes.forEach((m, i) => {
      chordSynth.triggerAttack(Tone.Frequency(m, "midi"), now + 0.012 + i * 0.028); // gentle strum
    });
  }

  function stopChord() {
    if (!ready || !currentNotes.length) return;
    chordSynth.triggerRelease(currentNotes.map(m => Tone.Frequency(m, "midi")), Tone.now());
    currentNotes = [];
  }

  function melodyOn(midi) {
    if (!ready) return;
    melodySynth.triggerAttack(Tone.Frequency(midi, "midi"), Tone.now());
  }
  function melodyOff() {
    if (!ready) return;
    melodySynth.triggerRelease(Tone.now());
  }

  return { init, playChord, stopChord, melodyOn, melodyOff, get ready() { return ready; } };
})();

// ——— canvas / geometry ————————————————————————

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

function wheelGeometry() {
  const r = Math.min(W, H) * 0.21;
  return {
    left:  { cx: W * 0.26, cy: H * 0.46, r, rIn: r * 0.42, items: ROOTS,     label: "root" },
    right: { cx: W * 0.74, cy: H * 0.46, r, rIn: r * 0.42, items: QUALITIES, label: "quality" },
  };
}

function melodyStripGeometry() {
  const w = Math.min(W * 0.8, 1100);
  const x = (W - w) / 2;
  const h = 74;
  const y = H - h - 110;
  return { x, y, w, h, keyW: w / MELODY_KEYS.length };
}

// Returns segment index, or null when outside the ring / in the off-zone.
function hitWheel(wheel, px, py) {
  const dx = px - wheel.cx, dy = py - wheel.cy;
  const d = Math.hypot(dx, dy);
  if (d < wheel.rIn || d > wheel.r * 1.18) return null;
  const n = wheel.items.length;
  const seg = (Math.PI * 2) / n;
  // segment 0 centred at 12 o'clock, clockwise
  const ang = (Math.atan2(dy, dx) + Math.PI / 2 + seg / 2 + Math.PI * 2) % (Math.PI * 2);
  return Math.floor(ang / seg) % n;
}

function hitMelodyKey(px, py) {
  const s = melodyStripGeometry();
  if (py < s.y - 14 || py > s.y + s.h + 14 || px < s.x || px > s.x + s.w) return null;
  return Math.min(MELODY_KEYS.length - 1, Math.max(0, Math.floor((px - s.x) / s.keyW)));
}

// ——— drawing ———————————————————————————————————

const IVORY = "#f4f1ea";
const AMBER = "#e8b44a";

function drawWheel(wheel, selectedIdx, hot) {
  const n = wheel.items.length;
  const seg = (Math.PI * 2) / n;
  const { cx, cy, r, rIn } = wheel;

  ctx.save();
  ctx.translate(cx, cy);

  // outer + inner rings
  ctx.strokeStyle = "rgba(244,241,234,0.20)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(244,241,234,0.10)";
  ctx.beginPath(); ctx.arc(0, 0, rIn, 0, Math.PI * 2); ctx.stroke();

  // dividers
  ctx.strokeStyle = "rgba(244,241,234,0.10)";
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 - seg / 2 + i * seg;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * rIn, Math.sin(a) * rIn);
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.stroke();
  }

  // selected segment
  if (selectedIdx != null) {
    const a0 = -Math.PI / 2 - seg / 2 + selectedIdx * seg;
    ctx.beginPath();
    ctx.arc(0, 0, r, a0, a0 + seg);
    ctx.arc(0, 0, rIn, a0 + seg, a0, true);
    ctx.closePath();
    ctx.fillStyle = hot ? "rgba(232,180,74,0.20)" : "rgba(232,180,74,0.10)";
    ctx.fill();
    ctx.strokeStyle = hot ? "rgba(232,180,74,0.85)" : "rgba(232,180,74,0.4)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }

  // labels
  const labelR = (r + rIn) / 2;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * seg;
    const item = wheel.items[i];
    const isSel = i === selectedIdx;
    ctx.font = `${isSel ? 600 : 400} ${n > 8 ? 15 : 14}px "Instrument Sans", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = isSel ? AMBER : "rgba(244,241,234,0.66)";
    ctx.fillText(item.name, Math.cos(a) * labelR, Math.sin(a) * labelR);
  }

  // hub label
  ctx.font = `500 10px "Instrument Sans", sans-serif`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "3px";
  ctx.fillStyle = "rgba(244,241,234,0.30)";
  ctx.textAlign = "center";
  ctx.fillText(wheel.label.toUpperCase(), 1.5, 0);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

  ctx.restore();
}

function drawMelodyStrip(activeIdx) {
  const s = melodyStripGeometry();
  const pad = 3;
  for (let i = 0; i < MELODY_KEYS.length; i++) {
    const kx = s.x + i * s.keyW;
    const active = i === activeIdx;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(kx + pad, s.y, s.keyW - pad * 2, s.h, 10);
    else ctx.rect(kx + pad, s.y, s.keyW - pad * 2, s.h);
    ctx.fillStyle = active ? "rgba(232,180,74,0.28)" : "rgba(16,16,18,0.45)";
    ctx.fill();
    ctx.strokeStyle = active ? "rgba(232,180,74,0.9)" : "rgba(244,241,234,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = `${active ? 600 : 400} 12px "Instrument Sans", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = active ? AMBER : "rgba(244,241,234,0.5)";
    ctx.fillText(MELODY_KEYS[i].name, kx + s.keyW / 2, s.y + s.h / 2);
  }
}

const HAND_EDGES = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17],
];

function drawHands() {
  ctx.strokeStyle = "rgba(244,241,234,0.16)";
  ctx.lineWidth = 1;
  for (const lm of state.hands) {
    for (const [a, b] of HAND_EDGES) {
      ctx.beginPath();
      ctx.moveTo((1 - lm[a].x) * W, lm[a].y * H);
      ctx.lineTo((1 - lm[b].x) * W, lm[b].y * H);
      ctx.stroke();
    }
  }
}

function drawCursor(p, pinched) {
  if (!p) return;
  const r = pinched ? 7 : 10;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(232,180,74,0.12)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = AMBER;
  ctx.globalAlpha = 0.9;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ——— chord display ————————————————————————————

const chordName = document.getElementById("chordName");
function showChord(rootIdx, qualityIdx) {
  const q = QUALITIES[qualityIdx];
  chordName.innerHTML = q.suffix
    ? `${ROOTS[rootIdx].name}<sup>${q.suffix}</sup>`
    : ROOTS[rootIdx].name;
  chordName.classList.add("is-on");
}
function hideChord() {
  chordName.classList.remove("is-on");
}

// ——— per-frame instrument logic ————————————————

function updateChordMode(leftPtr, rightPtr, wheels) {
  // quality (right hand) — persists once chosen
  const qIdx = rightPtr ? hitWheel(wheels.right, rightPtr.x, rightPtr.y) : null;
  if (qIdx != null) {
    if (debounce.quality.candidate === qIdx) debounce.quality.frames++;
    else { debounce.quality.candidate = qIdx; debounce.quality.frames = 1; }
    if (debounce.quality.frames >= STABLE_FRAMES && state.qualityIdx !== qIdx) {
      state.qualityIdx = qIdx;
      if (state.playing && state.rootIdx != null) {
        engine.playChord(state.rootIdx, state.qualityIdx);
        showChord(state.rootIdx, state.qualityIdx);
      }
    }
  } else {
    debounce.quality.candidate = null;
    debounce.quality.frames = 0;
  }

  // root (left hand) — drives attack & release
  const rIdx = leftPtr ? hitWheel(wheels.left, leftPtr.x, leftPtr.y) : null;
  if (rIdx != null) {
    debounce.root.missing = 0;
    if (debounce.root.candidate === rIdx) debounce.root.frames++;
    else { debounce.root.candidate = rIdx; debounce.root.frames = 1; }
    const stable = debounce.root.frames >= STABLE_FRAMES;
    if (stable && (state.rootIdx !== rIdx || !state.playing)) {
      state.rootIdx = rIdx;
      state.playing = true;
      engine.playChord(state.rootIdx, state.qualityIdx);
      showChord(state.rootIdx, state.qualityIdx);
    }
  } else if (state.playing) {
    debounce.root.missing++;
    if (debounce.root.missing > GRACE_FRAMES) {
      state.playing = false;
      state.rootIdx = null;
      debounce.root.candidate = null;
      debounce.root.frames = 0;
      engine.stopChord();
      hideChord();
    }
  }
  return { rootSel: state.playing ? state.rootIdx : (rIdx ?? null), qualSel: state.qualityIdx };
}

function updateMelodyMode(leftPtr, rightPtr, wheels) {
  // left hand still plays chords
  const sel = updateChordMode(leftPtr, null, wheels);

  // right hand: pinch to sing
  let activeKey = null;
  if (rightPtr) {
    activeKey = hitMelodyKey(rightPtr.x, rightPtr.y);
    const pinched = !!rightPtr.pinch;
    if (pinched && activeKey != null) {
      if (state.melodyKeyIdx !== activeKey) {
        engine.melodyOn(MELODY_KEYS[activeKey].midi);
        state.melodyKeyIdx = activeKey;
      }
    } else if (state.melodyKeyIdx != null) {
      engine.melodyOff();
      state.melodyKeyIdx = null;
    }
  } else if (state.melodyKeyIdx != null) {
    engine.melodyOff();
    state.melodyKeyIdx = null;
  }
  return { ...sel, activeKey };
}

// ——— main loop —————————————————————————————————

let lastVideoTime = -1;

function frame() {
  ctx.clearRect(0, 0, W, H);
  const wheels = wheelGeometry();

  // gather pointers
  let leftPtr = null, rightPtr = null;
  if (state.tracking) {
    detectHands();
    leftPtr = state.pointers.left;
    rightPtr = state.pointers.right;
  } else if (state.mouse.inside) {
    const m = { x: state.mouse.x, y: state.mouse.y, pinch: state.mouse.down };
    if (m.x < W / 2) leftPtr = m; else rightPtr = m;
  }

  // instrument logic
  let sel;
  if (state.mode === "chords") {
    sel = updateChordMode(leftPtr, rightPtr, wheels);
  } else {
    sel = updateMelodyMode(leftPtr, rightPtr, wheels);
  }

  // draw
  drawHands();
  drawWheel(wheels.left, sel.rootSel, state.playing);
  if (state.mode === "chords") {
    const hoverQ = rightPtr ? hitWheel(wheels.right, rightPtr.x, rightPtr.y) : null;
    drawWheel(wheels.right, hoverQ ?? state.qualityIdx, hoverQ != null);
  } else {
    drawMelodyStrip(sel.activeKey ?? state.melodyKeyIdx);
  }
  drawCursor(leftPtr, false);
  drawCursor(rightPtr, rightPtr && rightPtr.pinch);

  requestAnimationFrame(frame);
}

// ——— hand tracking ————————————————————————————

const video = document.getElementById("cam");
let landmarker = null;
let smooth = new Map(); // hand slot -> {x, y}

function ema(slot, x, y) {
  const prev = smooth.get(slot);
  const a = 0.4;
  const next = prev ? { x: prev.x + a * (x - prev.x), y: prev.y + a * (y - prev.y) } : { x, y };
  smooth.set(slot, next);
  return next;
}

function detectHands() {
  if (!landmarker || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const res = landmarker.detectForVideo(video, performance.now());
  state.hands = res.landmarks || [];

  const found = [];
  for (const lm of state.hands) {
    const tip = lm[8];
    const x = (1 - tip.x) * W;   // mirror
    const y = tip.y * H;
    // pinch: thumb tip to index tip, normalised by hand size
    const handSize = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 0.001;
    const pinchD = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / handSize;
    found.push({ x, y, pinch: pinchD < 0.38 });
  }

  found.sort((p, q) => p.x - q.x);
  if (found.length >= 2) {
    const l = ema("left", found[0].x, found[0].y);
    const r = ema("right", found[found.length - 1].x, found[found.length - 1].y);
    state.pointers.left = { ...found[0], ...l };
    state.pointers.right = { ...found[found.length - 1], ...r };
  } else if (found.length === 1) {
    const p = found[0];
    const side = p.x < W / 2 ? "left" : "right";
    const other = side === "left" ? "right" : "left";
    const s = ema(side, p.x, p.y);
    state.pointers[side] = { ...p, ...s };
    state.pointers[other] = null;
    smooth.delete(other);
  } else {
    state.pointers.left = state.pointers.right = null;
    smooth.clear();
  }
}

async function startCamera() {
  const status = document.getElementById("introStatus");
  try {
    status.textContent = "warming up the camera…";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    video.classList.add("is-live");

    if (!landmarker) {
      status.textContent = "loading hand tracking…";
      const visionUrl = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
      const { HandLandmarker, FilesetResolver } = await import(`${visionUrl}/+esm`);
      const fileset = await FilesetResolver.forVisionTasks(`${visionUrl}/wasm`);
      const opts = (delegate) => ({
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate,
        },
        runningMode: "VIDEO",
        numHands: 2,
      });
      try {
        landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU"));
      } catch {
        landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU"));
      }
    }

    state.tracking = true;
    status.textContent = "";
    return true;
  } catch (err) {
    console.error(err);
    status.textContent =
      err.name === "NotAllowedError"
        ? "camera permission was declined — you can still play with the mouse"
        : "couldn't start the camera — you can still play with the mouse";
    return false;
  }
}

function stopCamera() {
  state.tracking = false;
  state.pointers.left = state.pointers.right = null;
  state.hands = [];
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  video.classList.remove("is-live");
}

// ——— UI wiring —————————————————————————————————

const intro = document.getElementById("intro");
const bar = document.getElementById("bar");
const barCamera = document.getElementById("barCamera");
const hint = document.getElementById("hint");

function dismissIntro() {
  intro.classList.add("is-hidden");
  document.body.classList.remove("has-intro");
  bar.hidden = false;
}

document.body.classList.add("has-intro");

document.getElementById("btnCamera").addEventListener("click", async () => {
  await engine.init();
  const ok = await startCamera();
  if (ok) {
    dismissIntro();
    barCamera.classList.add("is-live");
    hint.textContent = "left hand · root — right hand · colour";
  }
});

document.getElementById("btnMouse").addEventListener("click", async () => {
  await engine.init();
  dismissIntro();
  hint.textContent = "hover a wheel to play";
});

barCamera.addEventListener("click", async () => {
  if (state.tracking) {
    stopCamera();
    barCamera.classList.remove("is-live");
    hint.textContent = "hover a wheel to play";
  } else {
    const ok = await startCamera();
    if (ok) {
      barCamera.classList.add("is-live");
      hint.textContent = "left hand · root — right hand · colour";
    }
  }
});

const modeChords = document.getElementById("modeChords");
const modeMelody = document.getElementById("modeMelody");
function setMode(mode) {
  state.mode = mode;
  modeChords.classList.toggle("is-active", mode === "chords");
  modeMelody.classList.toggle("is-active", mode === "melody");
  engine.melodyOff();
  state.melodyKeyIdx = null;
}
modeChords.addEventListener("click", () => setMode("chords"));
modeMelody.addEventListener("click", () => setMode("melody"));

// mouse fallback
canvas.addEventListener("mousemove", (e) => {
  state.mouse.x = e.clientX;
  state.mouse.y = e.clientY;
  state.mouse.inside = true;
});
canvas.addEventListener("mouseleave", () => { state.mouse.inside = false; });
canvas.addEventListener("mousedown", () => { state.mouse.down = true; });
window.addEventListener("mouseup", () => { state.mouse.down = false; });

// audio requires a user gesture at least once
window.addEventListener("pointerdown", () => { engine.init(); }, { once: true });

// debug/testing hook
window.MM = { state, engine, ROOTS, QUALITIES, wheelGeometry };

requestAnimationFrame(frame);
