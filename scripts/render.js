// state/board.json -> assets/board.svg + assets/stats.svg
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBoard, parseKey } from '../lib/crdt.js';

const CELL = 10;
const BG = '#0d1117';
const GRID = '#21262d';
const FG = '#f0f6fc';
const BAR = '#1f6feb';
const STATS_WIDTH = 460;
const ROW_H = 22;
const HEADER_H = 30;
const BAR_X = 170;
const BAR_MAX_W = 200;
const COUNT_X = 390;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sortedKeys(pixels) {
  return Object.keys(pixels).sort((a, b) => {
    const pa = parseKey(a);
    const pb = parseKey(b);
    return pa.x - pb.x || pa.y - pb.y;
  });
}

function leaderboard(pixels) {
  const counts = new Map();
  for (const k of Object.keys(pixels)) {
    const peer = pixels[k][2];
    counts.set(peer, (counts.get(peer) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 10);
}

function boardSvg(board) {
  const w = board.width * CELL;
  const h = board.height * CELL;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">`,
    `  <defs>`,
    `    <pattern id="grid" width="${CELL}" height="${CELL}" patternUnits="userSpaceOnUse">`,
    `      <path d="M ${CELL} 0 L 0 0 0 ${CELL}" fill="none" stroke="${GRID}" stroke-width="1"/>`,
    `    </pattern>`,
    `  </defs>`,
    `  <rect width="${w}" height="${h}" fill="${BG}"/>`,
    `  <rect width="${w}" height="${h}" fill="url(#grid)"/>`,
  ];
  for (const k of sortedKeys(board.pixels)) {
    const { x, y } = parseKey(k);
    lines.push(`  <rect x="${x * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}" fill="${board.pixels[k][0]}"/>`);
  }
  lines.push('</svg>');
  return lines.join('\n') + '\n';
}

function statsSvg(board, leaders) {
  const painted = Object.keys(board.pixels).length;
  const height = HEADER_H + leaders.length * ROW_H;
  const max = leaders.length ? leaders[0][1] : 0;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STATS_WIDTH} ${height}">`,
    `  <rect width="${STATS_WIDTH}" height="${height}" fill="${BG}"/>`,
    `  <text x="10" y="20" fill="${FG}" font-family="monospace" font-size="13">git-place leaderboard — ${painted} pixels painted</text>`,
  ];
  leaders.forEach(([peer, count], i) => {
    const y = HEADER_H + i * ROW_H;
    lines.push(`  <text x="10" y="${y + 15}" fill="${FG}" font-family="monospace" font-size="13">${i + 1}. ${esc(peer)}</text>`);
    lines.push(`  <rect x="${BAR_X}" y="${y + 5}" width="${Math.max(1, Math.round((count / max) * BAR_MAX_W))}" height="12" fill="${BAR}"/>`);
    lines.push(`  <text x="${COUNT_X}" y="${y + 15}" fill="${FG}" font-family="monospace" font-size="13">${count}</text>`);
  });
  lines.push('</svg>');
  return lines.join('\n') + '\n';
}

export async function render(repoDir) {
  const boardPath = path.join(repoDir, 'state', 'board.json');
  let board;
  try {
    board = JSON.parse(await fs.readFile(boardPath, 'utf8'));
  } catch (err) {
    throw new Error(`render: cannot read/parse board at ${boardPath}: ${err.message}`);
  }
  if (!isBoard(board)) {
    throw new Error(`render: ${boardPath} is not a valid board document`);
  }

  const leaders = leaderboard(board.pixels);
  const assetsDir = path.join(repoDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.writeFile(path.join(assetsDir, 'board.svg'), boardSvg(board));
  await fs.writeFile(path.join(assetsDir, 'stats.svg'), statsSvg(board, leaders));

  return { painted: Object.keys(board.pixels).length, leaderboard: leaders };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const repoDir = process.argv[2] ?? process.cwd();
  const { painted, leaderboard: leaders } = await render(repoDir);
  console.log(`rendered ${painted} painted pixels, ${leaders.length} peers -> assets/board.svg, assets/stats.svg`);
}
