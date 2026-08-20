# git-place contract

All components bind to these formats and APIs. Zero runtime dependencies, ESM only
(`"type": "module"` in package.json). Runs on node 20+ (Actions) and modern browsers.

## Layout

```
lib/crdt.js            CRDT core (exists — do not modify; import it)
state/board.json       CRDT document (canonical state)
state/ops.jsonl        audit log: one JSON op per line, append-only
assets/board.svg       rendered board (generated — never hand-edit)
assets/stats.svg       rendered leaderboard (generated)
scripts/render.js      state -> assets
scripts/apply-issue.js issue -> state mutation
site/                  gh-pages client (served from repo root: /site/)
.github/workflows/paint.yml
.github/ISSUE_TEMPLATE/paint.md
tests/                 plain ESM assert scripts
docs/CONTRACT.md       this file
```

## state/board.json

```json
{ "v": 1, "width": 64, "height": 64, "pixels": { "12,40": ["#ff8800", 1724000000000, "vaale"] } }
```

Cell value = `[hexLower, unixMs, peerId]`. Writers pretty-print with 2 spaces and
sort `pixels` keys (numeric x then y) for clean git diffs.

## state/ops.jsonl

One `JSON.stringify(op)` per line for every op that CHANGED the board, in apply order.
Rejected/stale ops are NOT logged. Append-only.

## Op

`{ x: int, y: int, c: "#rrggbb", ts: positiveIntUnixMs, p: peerId(1..64 chars) }`

## lib/crdt.js API (already implemented — import, don't reimplement)

- `createBoard(width=64, height=64) -> board`
- `isBoard(b) -> bool`
- `validateOp(op, board) -> errorString | null`
- `applyOp(board, op) -> { changed, error? }` — MUTATES board
- `mergeBoards(a, b) -> newBoard` — pure; throws on dimension mismatch
- `encodeOps(ops) -> base64url string`; `decodeOps(str) -> ops[]` (throws on garbage)
- `parsePaintTitle(title, ts, peer) -> op | null`
- `isSyncTitle(title) -> bool`
- `extractSyncPayload(body) -> base64url | null` (longest token in body)
- `key(x,y)`, `parseKey(k)`

## Issue write path (only writer to state is the Action)

- Title `[paint] x,y,#rrggbb` -> single op; `ts` = issue created_at (ms), `p` = author login.
- Title `[sync]`, body contains base64url payload (from client) -> apply each op in order.
- Anything else: ignored, no mutation.
- After applying: write board.json, append changed ops to ops.jsonl, regenerate
  assets/*.svg, commit, comment summary on issue, close it.

## Client conventions

- Loads `../state/board.json` (relative — Pages serves repo root), falls back to
  `https://raw.githubusercontent.com/<repo>/main/state/board.json` with `?repo=owner/name`.
- WebRTC manual signaling (copy-paste base64 SDP blobs), star topology, host relays.
  DataChannel messages: JSON `{ "type": "ops", "ops": [...] }`.
- Publish = open `https://github.com/<repo>/issues/new?title=%5Bsync%5D&body=<payload>`.
  Buffer = own painted ops; host also buffers relayed ops. Guests never publish relayed ops.
- Poll board.json every 60s, `mergeBoards` into local state.

## Tests

Plain ESM scripts using `node:assert/strict`; top-level asserts, `console.log('PASS <name>')`
at end. Runnable via `node tests/x.test.js` or dynamic import. No test-runner dependency.
