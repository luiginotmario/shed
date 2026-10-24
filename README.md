# Shed

Guitar practice in the browser. Search any song, play along with its tab as it
scrolls into the nut, and let your webcam watch your hands.

- **Any song.** Tabs come from Songsterr's public catalog: pick the guitar part,
  see the tuning, and start a bar before the guitar comes in.
- **Plays with you.** A plucked-string guide tone and a metronome follow the tab
  at 40–100% speed, with a one-bar count-in.
- **Tells you what's wrong.** MediaPipe hand landmarks run on your GPU in a web
  worker. Shed tracks your picking hand's strokes and grades each note as
  on time, early, late or missed. It also checks your fretting hand: flat fingers,
  and, once you mark the neck, whether your hand is at the right fret.

Nothing leaves your machine. The camera feed is only used for tracking, in the
browser, and never recorded.

## Run it

Requires Node 22.

```sh
npm install   # also copies the MediaPipe runtime and downloads the hand model
npm run dev   # http://localhost:5207
```

Use Chrome or Safari, allow the camera, and sit so both hands and the neck are
in frame.

## How the coaching works

| What | How |
| --- | --- |
| Which hand is which | The camera faces you, so the picking hand is on the image's left (right for lefties, toggle "Lefty"). |
| Pick strokes | Vertical motion of the point between thumb and index tip. A swing between two reversals that is large and fast enough is a stroke, timed at its fastest point, which is when the pick crosses the string. |
| Timing | Strokes are mapped to song time through the audio clock's output timestamp, minus the webcam's lag. Within ±90 ms is on time; up to ±280 ms is early or late. |
| Fret position | "Mark neck" asks you to hold your index finger on fret 3, then fret 12. The fingertip is projected onto that line and the fret spacing rule (each fret is 2^(−1/12) closer) gives the fret. |
| Finger shape | The middle-joint angle of the index, middle and ring fingers. Near-straight while fretting means you're pressing with the pads. |

Thresholds live in `src/coach.ts` and are covered by tests with synthetic
landmarks (`npm test`).

## Notes

Songsterr has no official public API. Shed reads the same endpoints their own
player uses, through a same-origin proxy (`vite.config.ts` in dev,
`vercel.json` in production). It is a personal practice tool, not affiliated
with Songsterr.

## License

MIT
