// Copies the MediaPipe wasm runtime into public/ and downloads the hand
// landmarker model so tracking runs fully offline after install.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'public/mediapipe');
const modelDst = join(root, 'public/models');
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task';

mkdirSync(wasmDst, { recursive: true });
mkdirSync(modelDst, { recursive: true });

if (existsSync(wasmSrc)) {
  for (const f of ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm']) {
    copyFileSync(join(wasmSrc, f), join(wasmDst, f));
  }
  console.log('[vision] copied wasm runtime');
}

const dst = join(modelDst, 'hand_landmarker.task');
if (!(existsSync(dst) && statSync(dst).size > 100_000)) {
  try {
    const res = await fetch(MODEL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
    console.log('[vision] downloaded hand_landmarker.task');
  } catch (err) {
    // Not fatal: the app falls back to loading the model from the CDN.
    console.warn(`[vision] could not download the model (${err.message}); will load from CDN at runtime`);
  }
}
