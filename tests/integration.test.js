import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBoard, encodeOps } from '../lib/crdt.js';
import { applyIssue } from '../scripts/apply-issue.js';
import { render } from '../scripts/render.js';

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-place-'));

const boardPath = path.join(repo, 'state', 'board.json');
const opsPath = path.join(repo, 'state', 'ops.jsonl');
const boardSvgPath = path.join(repo, 'assets', 'board.svg');
const statsSvgPath = path.join(repo, 'assets', 'stats.svg');
const opsLines = () => fs.readFileSync(opsPath, 'utf8').split('\n').filter(Boolean);

// 1. seed tmp repo with an empty board
fs.mkdirSync(path.join(repo, 'state'), { recursive: true });
fs.writeFileSync(boardPath, JSON.stringify(createBoard(), null, 2) + '\n');

// 2. paint issue
const CREATED = '2026-08-20T12:00:00.000Z';
const ts2 = Date.parse(CREATED);
const paintIssue = { title: '[paint] 3,4,#ff8800', body: '', author: 'alice', createdAt: CREATED };
const r2 = await applyIssue(repo, paintIssue);
assert.strictEqual(r2.boardChanged, true);
assert.strictEqual(r2.applied, 1);
assert.strictEqual(r2.skipped, 0);

// 3. sync issue: bob's op is new, carol's op is older than alice's paint -> loses LWW
const syncOps = [
  { x: 5, y: 6, c: '#00ff00', ts: ts2 + 1000, p: 'bob' },
  { x: 3, y: 4, c: '#0000ff', ts: ts2 - 1000, p: 'carol' },
];
const r3 = await applyIssue(repo, {
  title: '[sync]',
  body: 'sync payload below\n```\n' + encodeOps(syncOps) + '\n```\n',
  author: 'alice',
  createdAt: '2026-08-20T12:05:00.000Z',
});
assert.strictEqual(r3.applied, 1);
assert.strictEqual(r3.skipped, 1);
assert.strictEqual(r3.boardChanged, true);

// 4. state on disk: alice's newer paint kept, bob's pixel added, 2 ops logged
const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
assert.deepEqual(board.pixels['3,4'], ['#ff8800', ts2, 'alice']);
assert.deepEqual(board.pixels['5,6'], ['#00ff00', ts2 + 1000, 'bob']);
assert.strictEqual(opsLines().length, 2);

// 5. render produces assets reflecting state
await render(repo);
const svg1 = fs.readFileSync(boardSvgPath, 'utf8');
assert.ok(svg1.includes('#ff8800'));
assert.ok(svg1.includes('#00ff00'));
const stats = fs.readFileSync(statsSvgPath, 'utf8');
assert.ok(stats.includes('alice'));
assert.ok(stats.includes('bob'));

// 6. render is deterministic
await render(repo);
assert.strictEqual(fs.readFileSync(boardSvgPath, 'utf8'), svg1);

// 7. re-applying the same paint issue is a no-op
const r7 = await applyIssue(repo, paintIssue);
assert.strictEqual(r7.applied, 0);
assert.strictEqual(r7.boardChanged, false);
assert.strictEqual(opsLines().length, 2);

fs.rmSync(repo, { recursive: true, force: true });
console.log('PASS integration');
