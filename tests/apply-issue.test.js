// git-place: tests for scripts/apply-issue.js. Run: node tests/apply-issue.test.js
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBoard, encodeOps } from '../lib/crdt.js';
import { applyIssue } from '../scripts/apply-issue.js';

async function fixture({ seed = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-place-'));
  if (seed) {
    await fs.mkdir(path.join(dir, 'state'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'state', 'board.json'),
      JSON.stringify(createBoard(), null, 2) + '\n',
    );
  }
  return dir;
}

const readBoard = async (dir) =>
  JSON.parse(await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8'));

const readOpsLines = async (dir) =>
  (await fs.readFile(path.join(dir, 'state', 'ops.jsonl'), 'utf8'))
    .split('\n')
    .filter((l) => l.length > 0);

const CREATED = '2026-08-20T12:00:00.000Z';

// (1) valid paint -> boardChanged, lowercase hex persisted, 1 ops.jsonl line
{
  const dir = await fixture();
  const res = await applyIssue(dir, {
    title: '[paint] 3,4,#FF8800',
    author: 'vaale',
    createdAt: CREATED,
  });
  assert.equal(res.kind, 'paint');
  assert.equal(res.applied, 1);
  assert.equal(res.skipped, 0);
  assert.equal(res.boardChanged, true);
  assert.deepEqual(res.errors, []);
  assert.equal(res.comment, 'Placed #ff8800 at (3, 4).');

  const board = await readBoard(dir);
  assert.equal(board.pixels['3,4'][0], '#ff8800');
  assert.equal(board.pixels['3,4'][1], Date.parse(CREATED));
  assert.equal(board.pixels['3,4'][2], 'vaale');
  assert.equal((await readOpsLines(dir)).length, 1);

  // (2) same paint re-applied -> stale: applied 0 / skipped 1, ops.jsonl unchanged
  const before = await fs.readFile(path.join(dir, 'state', 'ops.jsonl'), 'utf8');
  const res2 = await applyIssue(dir, {
    title: '[paint] 3,4,#FF8800',
    author: 'vaale',
    createdAt: CREATED,
  });
  assert.equal(res2.kind, 'paint');
  assert.equal(res2.applied, 0);
  assert.equal(res2.skipped, 1);
  assert.equal(res2.boardChanged, false);
  assert.match(res2.comment, /stale/i);
  assert.equal(await fs.readFile(path.join(dir, 'state', 'ops.jsonl'), 'utf8'), before);
}

// (3) invalid color title -> parsePaintTitle fails -> ignored, board untouched
{
  const dir = await fixture();
  const seeded = await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8');
  const res = await applyIssue(dir, {
    title: '[paint] 1,2,red',
    author: 'vaale',
    createdAt: CREATED,
  });
  assert.equal(res.kind, 'ignored');
  assert.equal(res.applied, 0);
  assert.equal(res.boardChanged, false);
  assert.equal(await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8'), seeded);
  await assert.rejects(fs.readFile(path.join(dir, 'state', 'ops.jsonl'), 'utf8'));
}

// (4) out-of-bounds paint -> applied 0, error in comment, files untouched
{
  const dir = await fixture();
  const seeded = await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8');
  const res = await applyIssue(dir, {
    title: '[paint] 64,0,#ff8800',
    author: 'vaale',
    createdAt: CREATED,
  });
  assert.equal(res.kind, 'paint');
  assert.equal(res.applied, 0);
  assert.equal(res.skipped, 1);
  assert.equal(res.boardChanged, false);
  assert.equal(res.errors.length, 1);
  assert.match(res.comment, /out of bounds/);
  assert.equal(await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8'), seeded);
  await assert.rejects(fs.readFile(path.join(dir, 'state', 'ops.jsonl'), 'utf8'));
}

// (5) sync with 2 valid ops + 1 invalid -> applied 2, skipped 1, 2 ops.jsonl lines
{
  const dir = await fixture();
  const ops = [
    { x: 1, y: 1, c: '#ff8800', ts: 1000, p: 'tester' },
    { x: 2, y: 2, c: '#00ff00', ts: 1001, p: 'tester' },
    { x: 3, y: 3, c: 'red', ts: 1002, p: 'tester' },
  ];
  const res = await applyIssue(dir, {
    title: '[sync]',
    body: 'here are my ops:\n```\n' + encodeOps(ops) + '\n```\nthanks',
    author: 'vaale',
    createdAt: CREATED,
  });
  assert.equal(res.kind, 'sync');
  assert.equal(res.applied, 2);
  assert.equal(res.skipped, 1);
  assert.equal(res.boardChanged, true);
  assert.equal(res.errors.length, 1);
  assert.match(res.comment, /^Synced 2 ops \(1 skipped\)\./);

  const board = await readBoard(dir);
  assert.equal(board.pixels['1,1'][0], '#ff8800');
  assert.equal(board.pixels['2,2'][0], '#00ff00');
  assert.equal(board.pixels['3,3'], undefined);
  assert.equal((await readOpsLines(dir)).length, 2);
}

// (6) sync with garbage body -> errors non-empty, no mutation
{
  const dir = await fixture();
  const seeded = await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8');
  const res = await applyIssue(dir, {
    title: '[sync]',
    body: 'payload: this-is-not-a-valid-ops-payload-at-all ok?',
    author: 'vaale',
    createdAt: CREATED,
  });
  assert.equal(res.kind, 'sync');
  assert.equal(res.applied, 0);
  assert.equal(res.boardChanged, false);
  assert.ok(res.errors.length > 0);
  assert.equal(await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8'), seeded);
  await assert.rejects(fs.readFile(path.join(dir, 'state', 'ops.jsonl'), 'utf8'));
}

// (7) random title -> ignored
{
  const dir = await fixture();
  const seeded = await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8');
  const res = await applyIssue(dir, {
    title: 'hello world',
    author: 'vaale',
    createdAt: CREATED,
  });
  assert.equal(res.kind, 'ignored');
  assert.equal(res.applied, 0);
  assert.equal(res.boardChanged, false);
  assert.equal(await fs.readFile(path.join(dir, 'state', 'board.json'), 'utf8'), seeded);
}

// (8) missing board.json -> treated as empty board, paint succeeds
{
  const dir = await fixture({ seed: false });
  const res = await applyIssue(dir, {
    title: '[paint] 0,0,#00ff00',
    author: 'vaale',
    createdAt: CREATED,
  });
  assert.equal(res.kind, 'paint');
  assert.equal(res.applied, 1);
  assert.equal(res.boardChanged, true);
  const board = await readBoard(dir);
  assert.equal(board.width, 64);
  assert.equal(board.height, 64);
  assert.equal(board.pixels['0,0'][0], '#00ff00');
  assert.equal((await readOpsLines(dir)).length, 1);
}

console.log('PASS apply-issue');
