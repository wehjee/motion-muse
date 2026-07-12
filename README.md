# Motion Muse

Play music with your hands, through your webcam — in the browser.

**Live: https://wehjee.github.io/motion-muse/**

- **Left hand** points at the root wheel (circle of fifths) to play a chord
- **Right hand** points at the quality wheel (maj · min · 7 · maj7 · m7 · sus4 · dim · aug) to color it
- **Melody mode**: pinch thumb + index over the key strip to play notes while the left hand holds chords
- No camera? It also works with the mouse

Hand tracking runs entirely in your browser with [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) — no video is uploaded anywhere. Sound is synthesized with [Tone.js](https://tonejs.github.io/).

## Run locally

```sh
python3 -m http.server 8787
# open http://localhost:8787
```

No build step — three static files.

## Credits

Interaction inspired by a viral hand-tracking chord instrument; nearest open-source reference is [SoundGo](https://github.com/Gojaehyeon/soundgo).
