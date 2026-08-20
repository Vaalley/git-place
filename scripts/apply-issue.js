// git-place: apply a [paint]/[sync] issue to state/. The Action is the only writer.
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createBoard, isBoard, parsePaintTitle, isSyncTitle,
  extractSyncPayload, decodeOps, applyOp, parseKey,
} from '../lib/crdt.js';

async function loadBoard(repoDir) {
  try {
    const board = JSON.parse(await readFile(path.join(repoDir, 'state', 'board.json'), 'utf8'));
    if (isBoard(board)) return board;
  } catch { /* missing/unreadable/invalid -> fresh default board */ }
  return createBoard();
}

function sortedBoard(board) {
  const keys = Object.keys(board.pixels).sort((a, b) => {
    const pa = parseKey(a);
    const pb = parseKey(b);
    return pa.x - pb.x || pa.y - pb.y;
  });
  const pixels = {};
  for (const k of keys) pixels[k] = board.pixels[k];
  return { ...board, pixels };
}

async function persist(repoDir, board, changedOps) {
  const stateDir = path.join(repoDir, 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, 'board.json'),
    JSON.stringify(sortedBoard(board), null, 2) + '\n',
  );
  if (changedOps.length > 0) {
    const lines = changedOps.map((op) => JSON.stringify(op) + '\n').join('');
    await appendFile(path.join(stateDir, 'ops.jsonl'), lines);
  }
}

export async function applyIssue(repoDir, { title, body = '', author = 'anon', createdAt } = {}) {
  const errors = [];
  let applied = 0;
  let skipped = 0;
  let kind = 'ignored';
  let comment = 'Not a [paint] or [sync] issue; nothing to do.';
  let boardChanged = false;

  const board = await loadBoard(repoDir);
  const parsed = Date.parse(createdAt);
  const ts = Number.isNaN(parsed) ? Date.now() : parsed;
  const peer = String(author ?? 'anon');
  const changedOps = [];

  if (isSyncTitle(title)) {
    kind = 'sync';
    const payload = extractSyncPayload(body ?? '');
    if (!payload) {
      errors.push('no payload found');
      comment = 'no payload found';
    } else {
      let ops = null;
      try {
        ops = decodeOps(payload);
      } catch (err) {
        errors.push('invalid sync payload: ' + (err && err.message ? err.message : String(err)));
      }
      if (ops) {
        for (const op of ops) {
          const res = applyOp(board, op);
          if (res.error) errors.push(`op ${JSON.stringify(op)}: ${res.error}`);
          if (res.changed) {
            applied++;
            changedOps.push(op);
          } else {
            skipped++;
          }
        }
        if (applied > 0) {
          await persist(repoDir, board, changedOps);
          boardChanged = true;
        }
        comment = `Synced ${applied} ops (${skipped} skipped).`;
        if (errors.length > 0) comment += ` First error: ${errors[0]}`;
      } else {
        comment = errors[errors.length - 1];
      }
    }
  } else {
    const op = parsePaintTitle(title, ts, peer);
    if (op) {
      kind = 'paint';
      const res = applyOp(board, op);
      if (res.error) {
        errors.push(res.error);
        skipped = 1;
        comment = `Paint rejected: ${res.error}`;
      } else if (res.changed) {
        applied = 1;
        await persist(repoDir, board, [op]);
        boardChanged = true;
        comment = `Placed ${op.c} at (${op.x}, ${op.y}).`;
      } else {
        skipped = 1;
        comment = `Skipped stale op at (${op.x}, ${op.y}): cell already holds an equal or newer write.`;
      }
    }
  }

  return { kind, applied, skipped, errors, comment, boardChanged };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] ?? '';
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await applyIssue(args.repo ?? '.', {
    title: args.title ?? '',
    body: args.body ?? '',
    author: args.author ?? 'anon',
    createdAt: args.created ?? '',
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}

const invokedAsMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(String((err && err.stack) || err) + '\n');
      process.exit(1);
    },
  );
}
