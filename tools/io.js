// Node helpers for the offline test harness: raw f32le stereo I/O.
import fs from 'node:fs';
export function readF32(path) {
  const buf = fs.readFileSync(path);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = all.length / 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = all[2 * i]; R[i] = all[2 * i + 1]; }
  return { L, R };
}
export function writeF32(path, L, R) {
  const out = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) { out[2 * i] = L[i]; out[2 * i + 1] = R[i]; }
  fs.writeFileSync(path, Buffer.from(out.buffer));
}
