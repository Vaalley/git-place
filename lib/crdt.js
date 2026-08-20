// git-place CRDT core: last-writer-wins pixel map.
// Zero-dependency ESM. Runs in node (GitHub Actions) and browsers (client).
//
// Board doc:  { v: 1, width, height, pixels: { "x,y": [hex, ts, peer] } }
// Op:         { x, y, c: "#rrggbb", ts: <unix ms>, p: <peer id> }
// Merge rule: per cell, (ts, peer) lexicographic — higher wins. Ops commute.

export const DEFAULT_WIDTH = 64;
export const DEFAULT_HEIGHT = 64;

export function key(x, y) {
  return x + ',' + y;
}

export function parseKey(k) {
  const i = k.indexOf(',');
  return { x: Number(k.slice(0, i)), y: Number(k.slice(i + 1)) };
}

export function createBoard(width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
  return { v: 1, width, height, pixels: {} };
}

export function isBoard(b) {
  return !!b && b.v === 1
    && Number.isInteger(b.width) && Number.isInteger(b.height)
    && b.width > 0 && b.height > 0
    && !!b.pixels && typeof b.pixels === 'object';
}

// Returns error string, or null when valid.
export function validateOp(op, board) {
  if (!op || typeof op !== 'object') return 'op must be an object';
  const { x, y, c, ts, p } = op;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return 'x,y must be integers';
  if (x < 0 || y < 0 || x >= board.width || y >= board.height)
    return `out of bounds for ${board.width}x${board.height}`;
  if (typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c)) return 'c must be "#rrggbb"';
  if (!Number.isSafeInteger(ts) || ts <= 0) return 'ts must be a positive integer (unix ms)';
  if (typeof p !== 'string' || p.length === 0 || p.length > 64)
    return 'p must be a peer id string (1..64 chars)';
  return null;
}

// Cell value: [hexLower, ts, peer]. Order: (ts, peer) lexicographic; higher wins.
function cmpCell(a, b) {
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

// Mutates `board`. Returns { changed: boolean, error?: string }.
export function applyOp(board, op) {
  const err = validateOp(op, board);
  if (err) return { changed: false, error: err };
  const k = key(op.x, op.y);
  const next = [op.c.toLowerCase(), op.ts, op.p];
  const cur = board.pixels[k];
  if (cur && cmpCell(cur, next) >= 0) return { changed: false };
  board.pixels[k] = next;
  return { changed: true };
}

// Pure. Throws on invalid boards or dimension mismatch.
export function mergeBoards(a, b) {
  if (!isBoard(a) || !isBoard(b)) throw new Error('invalid board document');
  if (a.width !== b.width || a.height !== b.height) throw new Error('dimension mismatch');
  const out = createBoard(a.width, a.height);
  for (const src of [a, b]) {
    for (const k of Object.keys(src.pixels)) {
      const v = src.pixels[k];
      const cur = out.pixels[k];
      if (!cur || cmpCell(cur, v) < 0) out.pixels[k] = v;
    }
  }
  return out;
}

// --- op payload codec (base64url of JSON array; node + browser) ---

export function encodeOps(ops) {
  const json = JSON.stringify(ops);
  let b64;
  if (typeof Buffer !== 'undefined') b64 = Buffer.from(json, 'utf8').toString('base64');
  else b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeOps(payload) {
  let b64 = String(payload).replaceAll('-', '+').replaceAll('_', '/');
  while (b64.length % 4) b64 += '=';
  let json;
  if (typeof Buffer !== 'undefined') json = Buffer.from(b64, 'base64').toString('utf8');
  else json = new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)));
  const ops = JSON.parse(json);
  if (!Array.isArray(ops)) throw new Error('payload is not an op array');
  for (const op of ops) {
    if (!op || typeof op !== 'object') throw new Error('payload contains a non-object op');
  }
  return ops;
}

// --- issue conventions ---

const PAINT_RE = /^\[paint\]\s+(\d+)\s*,\s*(\d+)\s*,\s*(#[0-9a-fA-F]{6})\s*$/i;

// "[paint] x,y,#rrggbb" -> op; ts/peer come from issue metadata (created_at, author).
// Returns null when the title is not a valid paint command.
export function parsePaintTitle(title, ts, peer) {
  const m = PAINT_RE.exec(String(title).trim());
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), c: m[3].toLowerCase(), ts, p: peer };
}

export function isSyncTitle(title) {
  return /^\[sync\]\s*$/i.test(String(title).trim());
}

// Pull the longest base64url token out of an issue body (tolerates prose/fences).
export function extractSyncPayload(body) {
  let best = null;
  for (const m of String(body).matchAll(/[A-Za-z0-9\-_]{20,}={0,2}/g)) {
    if (!best || m[0].length > best.length) best = m[0];
  }
  return best;
}
