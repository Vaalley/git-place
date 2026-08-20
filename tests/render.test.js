import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { render } from '../scripts/render.js';
import { createBoard, applyOp } from '../lib/crdt.js';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

async function makeRepo(parent, name, board) {
  const repo = path.join(parent, name);
  await fs.mkdir(path.join(repo, 'state'), { recursive: true });
  const content = typeof board === 'string' ? board : JSON.stringify(board, null, 2);
  await fs.writeFile(path.join(repo, 'state', 'board.json'), content);
  return repo;
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'git-place-render-'));

// Case 1: painted board, two peers 2 vs 1 cells
const board1 = createBoard();
assert.equal(applyOp(board1, { x: 0, y: 0, c: '#ff8800', ts: 1000, p: 'alice' }).changed, true);
assert.equal(applyOp(board1, { x: 1, y: 0, c: '#00ff00', ts: 1001, p: 'alice' }).changed, true);
assert.equal(applyOp(board1, { x: 2, y: 0, c: '#0000ff', ts: 1002, p: 'bob' }).changed, true);
const repo1 = await makeRepo(tmp, 'repo1', board1);

const result = await render(repo1);
assert.equal(result.painted, 3);
assert.deepEqual(result.leaderboard, [['alice', 2], ['bob', 1]]);

const boardSvg1 = await fs.readFile(path.join(repo1, 'assets', 'board.svg'), 'utf8');
const statsSvg1 = await fs.readFile(path.join(repo1, 'assets', 'stats.svg'), 'utf8');
assert.ok(boardSvg1.startsWith(XML_HEADER));
assert.ok(statsSvg1.startsWith(XML_HEADER));
assert.ok(boardSvg1.includes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"'));
assert.ok(boardSvg1.includes('fill="#ff8800"'));
assert.ok(statsSvg1.includes('git-place leaderboard — 3 pixels painted'));
assert.ok(statsSvg1.indexOf('alice') !== -1 && statsSvg1.indexOf('bob') !== -1);
assert.ok(statsSvg1.indexOf('alice') < statsSvg1.indexOf('bob'));

// Case 2: empty board — grid pattern present, no painted rects beyond background + grid fill
const repo2 = await makeRepo(tmp, 'repo2', createBoard());
const empty = await render(repo2);
assert.equal(empty.painted, 0);
assert.deepEqual(empty.leaderboard, []);
const boardSvg2 = await fs.readFile(path.join(repo2, 'assets', 'board.svg'), 'utf8');
assert.ok(boardSvg2.includes('<pattern'));
assert.ok(boardSvg2.includes('fill="url(#grid)"'));
assert.equal(boardSvg2.match(/<rect/g).length, 2);

// Case 3: corrupt board.json -> render throws
const repo3 = await makeRepo(tmp, 'repo3', 'this is not json {');
await assert.rejects(() => render(repo3));

// Case 4: peer name with XML-special chars is escaped in stats.svg
const board4 = createBoard();
assert.equal(applyOp(board4, { x: 5, y: 5, c: '#123456', ts: 2000, p: 'a&<b' }).changed, true);
const repo4 = await makeRepo(tmp, 'repo4', board4);
await render(repo4);
const statsSvg4 = await fs.readFile(path.join(repo4, 'assets', 'stats.svg'), 'utf8');
assert.ok(statsSvg4.includes('a&amp;&lt;b'));
assert.ok(!statsSvg4.includes('a&<b'));

console.log('PASS render');
