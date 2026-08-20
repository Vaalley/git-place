import { createBoard, isBoard, applyOp, mergeBoards, encodeOps, key, parseKey } from '../lib/crdt.js';

const CELL = 10;
const COLORS = [
  '#ffffff', '#c0c0c0', '#808080', '#000000',
  '#ff0000', '#800000', '#ffff00', '#808000',
  '#00ff00', '#008000', '#00ffff', '#008080',
  '#0000ff', '#000080', '#ff00ff', '#800080',
];
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
const paletteEl = document.getElementById('palette');
const peerInput = document.getElementById('peer');
const hostBtn = document.getElementById('hostBtn');
const joinBtn = document.getElementById('joinBtn');
const acceptBtn = document.getElementById('acceptBtn');
const publishBtn = document.getElementById('publishBtn');
const offerBox = document.getElementById('offerBox');
const answerBox = document.getElementById('answerBox');
const statusEl = document.getElementById('status');

let board = createBoard();
let unpublished = [];
const conns = [];
let painting = false;
let lastCell = null;

function setStatus(msg) { statusEl.textContent = String(msg); }

window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault();
  setStatus('error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
});
window.addEventListener('error', (e) => {
  if (e.message) { e.preventDefault(); setStatus('error: ' + e.message); }
});

function repoParam() { return new URLSearchParams(location.search).get('repo'); }

function randPeer() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return 'anon-' + s;
}

peerInput.value = localStorage.getItem('git-place-peer') || randPeer();
peerInput.addEventListener('change', () => {
  localStorage.setItem('git-place-peer', peerInput.value.trim());
});
function peerId() { return peerInput.value.trim() || 'anon'; }

let color = localStorage.getItem('git-place-color');
if (!COLORS.includes(color)) color = COLORS[0];
for (const c of COLORS) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.dataset.color = c;
  b.title = c;
  b.addEventListener('click', () => selectColor(c));
  paletteEl.append(b);
}
function selectColor(c) {
  color = c;
  localStorage.setItem('git-place-color', c);
  for (const b of paletteEl.children) b.classList.toggle('sel', b.dataset.color === c);
}
selectColor(color);

// --- rendering ---

function sizeCanvas() {
  canvas.width = board.width * CELL;
  canvas.height = board.height * CELL;
  ctx.imageSmoothingEnabled = false;
}

function drawBoard() {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const k of Object.keys(board.pixels)) {
    const { x, y } = parseKey(k);
    ctx.fillStyle = board.pixels[k][0];
    ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
  }
  drawGrid();
}

function drawGrid() {
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= board.width; x++) {
    ctx.moveTo(x * CELL + 0.5, 0);
    ctx.lineTo(x * CELL + 0.5, canvas.height);
  }
  for (let y = 0; y <= board.height; y++) {
    ctx.moveTo(0, y * CELL + 0.5);
    ctx.lineTo(canvas.width, y * CELL + 0.5);
  }
  ctx.stroke();
}

function drawCell(x, y) {
  const px = x * CELL, py = y * CELL;
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(px, py, CELL, CELL);
  const v = board.pixels[key(x, y)];
  if (v) {
    ctx.fillStyle = v[0];
    ctx.fillRect(px, py, CELL, CELL);
  }
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, CELL, CELL);
}

// --- board state ---

async function readBoard(res) {
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const b = await res.json();
  if (!isBoard(b)) throw new Error('not a valid board document');
  return b;
}

async function fetchBoard() {
  try {
    return await readBoard(await fetch('../state/board.json', { cache: 'no-store' }));
  } catch (err) {
    const repo = repoParam();
    if (!repo) return createBoard();
    return readBoard(await fetch(
      `https://raw.githubusercontent.com/${repo}/main/state/board.json`,
      { cache: 'no-store' }));
  }
}

async function poll() {
  try {
    const fresh = await fetchBoard();
    board = mergeBoards(board, fresh);
    sizeCanvas();
    drawBoard();
  } catch (err) {
    setStatus('poll failed: ' + err.message);
  }
}

// --- painting ---

function paintAt(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const x = Math.floor((e.clientX - rect.left) * sx / CELL);
  const y = Math.floor((e.clientY - rect.top) * sy / CELL);
  if (x < 0 || y < 0 || x >= board.width || y >= board.height) return;
  const k = key(x, y);
  if (k === lastCell) return;
  lastCell = k;
  const op = { x, y, c: color, ts: Date.now(), p: peerId() };
  const res = applyOp(board, op);
  if (res.changed) {
    drawCell(x, y);
    unpublished.push(op);
    updatePublish();
    broadcastOps([op]);
  } else if (res.error) {
    setStatus('paint rejected: ' + res.error);
  }
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  painting = true;
  lastCell = null;
  canvas.setPointerCapture(e.pointerId);
  paintAt(e);
});
canvas.addEventListener('pointermove', (e) => { if (painting) paintAt(e); });
canvas.addEventListener('pointerup', () => { painting = false; });
canvas.addEventListener('pointercancel', () => { painting = false; });

// --- WebRTC manual signaling ---
// Star topology: only the host relays. Guests never republish ops they
// received; the host rebroadcasts guest ops to its OTHER channels and adds
// them to its own unpublished buffer, so they reach GitHub on its next sync.

function openChannels() {
  return conns.filter((c) => c.dc && c.dc.readyState === 'open').length;
}

function broadcastOps(ops, except = null) {
  const msg = JSON.stringify({ type: 'ops', ops });
  for (const c of conns) {
    if (c.dc && c.dc !== except && c.dc.readyState === 'open') {
      try { c.dc.send(msg); } catch { /* channel closing */ }
    }
  }
}

function addConn(pc, role) {
  const conn = { pc, dc: null, role };
  conns.push(conn);
  pc.onconnectionstatechange = () =>
    setStatus(`${role} link: ${pc.connectionState} (${openChannels()} channel(s) open)`);
  return conn;
}

function wireChannel(conn) {
  const dc = conn.dc;
  dc.onopen = () => setStatus(`${conn.role} channel open (${openChannels()} total)`);
  dc.onclose = () => setStatus(`${conn.role} channel closed`);
  dc.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg || msg.type !== 'ops' || !Array.isArray(msg.ops)) return;
    const applied = [];
    for (const op of msg.ops) {
      const res = applyOp(board, op);
      if (res.changed) { drawCell(op.x, op.y); applied.push(op); }
    }
    if (conn.role === 'host' && msg.ops.length) {
      broadcastOps(msg.ops, dc);
      if (applied.length) { unpublished.push(...applied); updatePublish(); }
    }
  };
}

function b64urlEncode(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  let b = String(s).trim().replaceAll('-', '+').replaceAll('_', '/');
  while (b.length % 4) b += '=';
  return new TextDecoder().decode(Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0)));
}

function waitIceComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, 10000);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onchange);
      resolve();
    }
    function onchange() { if (pc.iceGatheringState === 'complete') done(); }
    pc.addEventListener('icegatheringstatechange', onchange);
  });
}

hostBtn.addEventListener('click', async () => {
  try {
    const pc = new RTCPeerConnection(ICE);
    const conn = addConn(pc, 'host');
    conn.dc = pc.createDataChannel('ops');
    wireChannel(conn);
    await pc.setLocalDescription(await pc.createOffer());
    setStatus('hosting: gathering ICE candidates…');
    await waitIceComplete(pc);
    offerBox.value = b64urlEncode(JSON.stringify(pc.localDescription));
    setStatus('hosting: send the offer blob to a guest');
  } catch (err) {
    setStatus('host error: ' + err.message);
  }
});

joinBtn.addEventListener('click', async () => {
  try {
    const desc = JSON.parse(b64urlDecode(offerBox.value));
    const pc = new RTCPeerConnection(ICE);
    const conn = addConn(pc, 'guest');
    pc.ondatachannel = (e) => { conn.dc = e.channel; wireChannel(conn); };
    await pc.setRemoteDescription(desc);
    await pc.setLocalDescription(await pc.createAnswer());
    setStatus('joining: gathering ICE candidates…');
    await waitIceComplete(pc);
    answerBox.value = b64urlEncode(JSON.stringify(pc.localDescription));
    setStatus('joined: send the answer blob back to the host');
  } catch (err) {
    setStatus('join error: ' + err.message);
  }
});

acceptBtn.addEventListener('click', async () => {
  try {
    const waiting = conns.filter((c) => c.role === 'host' && !c.pc.remoteDescription);
    const conn = waiting[waiting.length - 1];
    if (!conn) { setStatus('accept: no host link waiting for an answer'); return; }
    await conn.pc.setRemoteDescription(JSON.parse(b64urlDecode(answerBox.value)));
    setStatus('answer accepted; connecting…');
  } catch (err) {
    setStatus('accept error: ' + err.message);
  }
});

// --- publish ---

function updatePublish() {
  publishBtn.textContent = `Publish ${unpublished.length} pixels`;
  publishBtn.disabled = unpublished.length === 0;
}

publishBtn.addEventListener('click', () => {
  if (!unpublished.length) return;
  let repo = repoParam() || localStorage.getItem('git-place-repo');
  if (!repo) {
    repo = prompt('owner/repo');
    if (!repo) { setStatus('publish cancelled: no repo given'); return; }
    repo = repo.trim();
    localStorage.setItem('git-place-repo', repo);
  }
  const ops = unpublished;
  window.open(
    `https://github.com/${repo}/issues/new?title=%5Bsync%5D&body=${encodeOps(ops)}`,
    '_blank');
  unpublished = [];
  updatePublish();
  setStatus(`opened sync issue for ${ops.length} op(s) on ${repo}`);
});

// --- init ---

updatePublish();
drawBoard();
(async () => {
  try {
    board = await fetchBoard();
  } catch (err) {
    setStatus('board load failed, starting empty: ' + err.message);
    board = createBoard();
  }
  sizeCanvas();
  drawBoard();
})();
setInterval(poll, 60000);
