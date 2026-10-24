# Contributing

Issues and pull requests are welcome.

- Use Node 22 and run `npm test` and `npm run build` before opening a PR.
- Coaching logic in `src/coach.ts` should stay DOM-free and come with a test in
  `test/coach.test.ts` using synthetic landmarks.
- If you tune a threshold on a real webcam, say which camera and lighting you
  used in the PR.
