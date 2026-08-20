import assert from 'node:assert/strict';
import {
  createBoard, isBoard, validateOp, applyOp, mergeBoards,
  encodeOps, decodeOps, parsePaintTitle, isSyncTitle, extractSyncPayload,
  key, parseKey,
} from '../lib/crdt.js';

// --- commutativity: 12 ops, 6 deterministic shuffles -> identical boards ---

const OPS = [
  { x: 0, y: 0, c: '#ff0000', ts: 1000, p: 'a' },
  { x: 63, y: 63, c: '#00ff00', ts: 1001, p: 'b' },
  { x: 10, y: 10, c: '#0000ff', ts: 1002, p: 'c' },
  { x: 10, y: 10, c: '#123456', ts: 1003, p: 'a' },   // same cell as above, newer wins
  { x: 20, y: 20, c: '#abcdef', ts: 1004, p: 'd' },
  { x: 20, y: 20, c: '#fedcba', ts: 1004, p: 'e' },   // same ts, peer tie-break
  { x: 5, y: 40, c: '#ff8800', ts: 1005, p: 'väle' },
  { x: 6, y: 41, c: '#88ff00', ts: 1006, p: 'f' },
  { x: 7, y: 42, c: '#0088ff', ts: 1007, p: 'g' },
  { x: 30, y: 30, c: '#000000', ts: 1008, p: 'h' },
  { x: 31, y: 31, c: '#ffffff', ts: 1009, p: 'i' },
  { x: 1, y: 63, c: '#13579b', ts: 1010, p: 'j' },
];

const PERMS = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  [5, 0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10],
  [3, 8, 1, 10, 5, 0, 7, 2, 9, 4, 11, 6],
  [6, 11, 4, 9, 2, 7, 0, 5, 10, 1, 8, 3],
  [9, 4, 11, 6, 1, 8, 3, 10, 5, 0, 7, 2],
];

const boards = PERMS.map((perm) => {
  const b = createBoard();
  for (const i of perm) {
    const r = applyOp(b, OPS[i]);
    assert.strictEqual(r.error, undefined);
  }
  return b;
});
for (const b of boards) assert.deepEqual(b, boards[0]);
assert.deepEqual(boards[0].pixels[key(10, 10)], ['#123456', 1003, 'a']);
assert.deepEqual(boards[0].pixels[key(20, 20)], ['#fedcba', 1004, 'e']);

// --- idempotency ---

{
  const b = createBoard();
  const op = { x: 7, y: 9, c: '#FF8800', ts: 424242, p: 'alice' };
  const r1 = applyOp(b, op);
  assert.strictEqual(r1.changed, true);
  assert.deepEqual(b.pixels[key(7, 9)], ['#ff8800', 424242, 'alice']); // stored lowercase
  const snap = JSON.stringify(b);
  const r2 = applyOp(b, { ...op });
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(JSON.stringify(b), snap);
}

// --- tie-break: same ts, higher peer wins regardless of order ---

{
  const opA = { x: 1, y: 1, c: '#ff0000', ts: 5000, p: 'a' };
  const opB = { x: 1, y: 1, c: '#0000ff', ts: 5000, p: 'b' };

  const b1 = createBoard();
  assert.strictEqual(applyOp(b1, opA).changed, true);
  assert.strictEqual(applyOp(b1, opB).changed, true);

  const b2 = createBoard();
  assert.strictEqual(applyOp(b2, opB).changed, true);
  assert.strictEqual(applyOp(b2, opA).changed, false);

  for (const b of [b1, b2]) assert.deepEqual(b.pixels[key(1, 1)], ['#0000ff', 5000, 'b']);
  assert.deepEqual(b1, b2);
}

// --- validateOp boundaries on 64x64 ---

{
  const b = createBoard();
  const base = { x: 0, y: 0, c: '#ff8800', ts: 1, p: 'p' };
  assert.ok(validateOp({ ...base, x: -1 }, b));
  assert.strictEqual(validateOp({ ...base, x: 63 }, b), null);
  assert.ok(validateOp({ ...base, x: 64 }, b));
  assert.ok(validateOp({ ...base, y: 64 }, b));
  assert.strictEqual(validateOp({ ...base, c: '#FF8800' }, b), null);
  assert.ok(validateOp({ ...base, c: '#ff880' }, b));
  assert.ok(validateOp({ ...base, c: '#gg0000' }, b));
  assert.ok(validateOp({ ...base, ts: 0 }, b));
  assert.ok(validateOp({ ...base, ts: -5 }, b));
  assert.ok(validateOp({ ...base, p: '' }, b));
  assert.ok(validateOp({ ...base, p: 'x'.repeat(65) }, b));
  assert.strictEqual(validateOp({ ...base, p: 'x'.repeat(64) }, b), null);
}

// --- encodeOps/decodeOps roundtrip + garbage rejection ---

assert.deepEqual(decodeOps(encodeOps([])), []);

{
  const ops = Array.from({ length: 100 }, (_, i) => ({
    x: i % 64,
    y: Math.floor(i / 64) % 64,
    c: '#0a0b0c',
    ts: 1000000 + i,
    p: 'peer-' + i,
  }));
  ops[50].p = 'väle-😀';
  assert.deepEqual(decodeOps(encodeOps(ops)), ops);
}

assert.throws(() => decodeOps('not-valid!!!'));
{
  const notArray = Buffer.from(JSON.stringify({ nope: true }), 'utf8').toString('base64url');
  assert.throws(() => decodeOps(notArray));
}

// --- parsePaintTitle ---

{
  const ts = 1724000000000;
  assert.deepEqual(parsePaintTitle('[paint] 1,2,#aabbcc', ts, 'alice'),
    { x: 1, y: 2, c: '#aabbcc', ts, p: 'alice' });
  assert.deepEqual(parsePaintTitle('[paint] 1, 2, #AABBCC', ts, 'alice'),
    { x: 1, y: 2, c: '#aabbcc', ts, p: 'alice' });
  assert.strictEqual(parsePaintTitle('[paint] 1,2', ts, 'alice'), null);
  assert.strictEqual(parsePaintTitle('[sync]', ts, 'alice'), null);
  assert.strictEqual(parsePaintTitle('[paint] -1,2,#aabbcc', ts, 'alice'), null);
  assert.ok(isSyncTitle('[sync]'));
}

// --- extractSyncPayload ---

{
  const ops = [
    { x: 1, y: 1, c: '#ff0000', ts: 1724000000000, p: 'alice' },
    { x: 2, y: 2, c: '#00ff00', ts: 1724000000001, p: 'bob' },
  ];
  const payload = encodeOps(ops);

  const fenced = 'Here is my sync payload, painted on the site:\n```\n'
    + payload + '\n```\nThanks, bot!';
  const extracted = extractSyncPayload(fenced);
  assert.strictEqual(extracted, payload);
  assert.deepEqual(decodeOps(extracted), ops);

  const urlToken = 'aB0-_x9Q'.repeat(5); // 40 chars, valid base64url alphabet
  const body = `See https://example.com/click/${urlToken}?ref=me for details\n`
    + 'and the real payload is ' + payload + ' ok';
  assert.strictEqual(extractSyncPayload(body), payload);

  assert.strictEqual(extractSyncPayload(''), null);
}

// --- mergeBoards ---

{
  const a = createBoard();
  applyOp(a, { x: 1, y: 1, c: '#ff0000', ts: 100, p: 'a' });
  applyOp(a, { x: 2, y: 2, c: '#00ff00', ts: 300, p: 'a' });
  const b = createBoard();
  applyOp(b, { x: 1, y: 1, c: '#0000ff', ts: 200, p: 'b' });
  applyOp(b, { x: 3, y: 3, c: '#123456', ts: 100, p: 'b' });
  const c = createBoard();
  applyOp(c, { x: 1, y: 1, c: '#ffff00', ts: 150, p: 'c' });

  assert.deepEqual(mergeBoards(mergeBoards(a, b), c), mergeBoards(a, mergeBoards(b, c)));
  assert.ok(isBoard(mergeBoards(a, b)));

  assert.throws(() => mergeBoards(createBoard(8, 8), createBoard(4, 4)));
  assert.throws(() => mergeBoards({}, createBoard()));
  assert.throws(() => mergeBoards(createBoard(), null));
}

// --- key/parseKey sanity ---

assert.strictEqual(key(12, 40), '12,40');
assert.deepEqual(parseKey('12,40'), { x: 12, y: 40 });

console.log('PASS crdt');
