/**
 * QR Code encoder (ISO/IEC 18004, Model 2): byte mode, error correction
 * level M, versions 1–10 (up to 213 bytes — ample for a share link).
 *
 * Written from the specification with no dependencies so that the share
 * dialog shows a code that actually scans. tests/qr.test.mjs checks the
 * output against a reference matrix that was verified with an independent
 * decoder.
 */

// Per version (index = version): [error-correction codewords per block, [blocks, data codewords]...]
const BLOCKS_M = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]]
];

const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

function reedSolomon(data, ecLength) {
  // Generator polynomial: product of (x - 2^i) for i in [0, ecLength).
  let gen = [1];
  for (let i = 0; i < ecLength; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gen[j] === 0 ? 0 : EXP[LOG[gen[j]] + i];
    }
    gen = next;
  }
  const remainder = new Array(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLength; i++) {
        remainder[i] ^= EXP[LOG[gen[i + 1]] + LOG[factor]];
      }
    }
  }
  return remainder;
}

function dataCapacity(version) {
  const [, ...groups] = BLOCKS_M[version];
  return groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

function buildCodewords(bytes, version) {
  const capacity = dataCapacity(version);
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };

  push(0b0100, 4);                          // byte mode
  push(bytes.length, version <= 9 ? 8 : 16); // character count
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; data.length < capacity; pad ^= 1) data.push(pad ? 0x11 : 0xec);

  // Split into blocks, compute error correction, then interleave.
  const [ecLength, ...groups] = BLOCKS_M[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(reedSolomon(block, ecLength));
    }
  }
  const out = [];
  const longest = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < longest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLength; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

function bch(value, generator, totalBits, dataBits) {
  let v = value << (totalBits - dataBits);
  const genLength = generator.toString(2).length;
  for (let i = totalBits - 1; i >= genLength - 1; i--) {
    if ((v >>> i) & 1) v ^= generator << (i - genLength + 1);
  }
  return (value << (totalBits - dataBits)) | v;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function penalty(m) {
  const n = m.length;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < n; i++) {
    for (const line of [m[i], m.map(row => row[i])]) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && line[j] === line[j - 1]) { run++; continue; }
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
  }
  // Rule 2: 2×2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }
  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules on either side.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, start, pat) => pat.every((bit, k) => (line[start + k] ? 1 : 0) === bit);
  for (let i = 0; i < n; i++) {
    const row = m[i];
    const col = m.map(r => r[i]);
    for (let j = 0; j <= n - 11; j++) {
      for (const line of [row, col]) {
        if (matches(line, j, A) || matches(line, j, B)) score += 40;
      }
    }
  }
  // Rule 4: balance of dark and light.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** Returns a square array of booleans (true = dark), without the quiet zone. */
export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const overheadBits = 4 + (v <= 9 ? 8 : 16);
    if (bytes.length * 8 + overheadBits <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error('That text is too long for a QR code here');

  const n = 17 + version * 4;
  const modules = Array.from({ length: n }, () => new Array(n).fill(false));
  const reserved = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, dark) => { modules[r][c] = dark; reserved[r][c] = true; };

  // Finder patterns with separators.
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, ring <= 1 || ring === 3);
      }
    }
  }
  // Timing patterns.
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Alignment patterns (skipping the three that would overlap finders).
  const centres = ALIGNMENT[version];
  const last = centres[centres.length - 1];
  for (const r of centres) {
    for (const c of centres) {
      // The three positions that coincide with finder patterns are omitted.
      // (Those on row or column 6 that only cross the timing pattern are kept.)
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }
  // Dark module and format-information areas.
  set(n - 8, 8, true);
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][n - 1 - i] = true;
    reserved[n - 1 - i][8] = true;
  }
  // Version information (versions 7 and up).
  if (version >= 7) {
    const info = bch(version, 0x1f25, 18, 6);
    for (let i = 0; i < 18; i++) {
      const bit = ((info >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = n - 11 + (i % 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // Place the data bits in the zig-zag order, right to left, skipping column 6.
  const codewords = buildCodewords(bytes, version);
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push(((cw >>> i) & 1) === 1);
  let bitIndex = 0;
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < n; step++) {
      const row = upward ? n - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        modules[row][c] = bitIndex < bits.length ? bits[bitIndex] : false;
        bitIndex++;
      }
    }
    upward = !upward;
  }

  // Try all eight masks; keep the one with the lowest penalty.
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row, r) => row.map((v, c) => (reserved[r][c] ? v : v !== MASKS[mask](r, c))));
    const format = bch((0b00 << 3) | mask, 0x537, 15, 5) ^ 0x5412; // level M = 00
    for (let i = 0; i < 15; i++) {
      const bit = ((format >>> i) & 1) === 1;
      // Copy 1: around the top-left finder.
      if (i < 6) candidate[i][8] = bit;
      else if (i < 8) candidate[i + 1][8] = bit;
      else if (i === 8) candidate[8][7] = bit;
      else candidate[8][14 - i] = bit;
      // Copy 2: split between top-right and bottom-left.
      if (i < 8) candidate[8][n - 1 - i] = bit;
      else candidate[n - 15 + i][8] = bit;
    }
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, matrix: candidate };
  }
  return best.matrix;
}

/** SVG markup for the code, including the 4-module quiet zone. */
export function qrSvg(text, { label = 'QR code' } = {}) {
  const matrix = qrMatrix(text);
  const n = matrix.length;
  const quiet = 4;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      let run = 1;
      while (c + run < n && matrix[r][c + run]) run++;
      path += `M${c + quiet} ${r + quiet}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  const size = n + quiet * 2;
  const safeLabel = String(label).replace(/[^\w ,.'-]/g, '');
  return `<svg class="qr" viewBox="0 0 ${size} ${size}" role="img" aria-label="${safeLabel}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#111"/></svg>`;
}
