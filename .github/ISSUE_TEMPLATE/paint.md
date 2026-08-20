---
name: Place a pixel
about: Paint a single pixel on the shared git-place canvas
title: "[paint] 12,40,#ff8800"
---

Edit the **title** of this issue to describe your pixel:

```
[paint] x,y,#rrggbb
```

- The board is **64x64** pixels. Coordinates are zero-based: `x` (column) and `y`
  (row) both run from `0` to `63`.
- The color is a hex color like `#ff8800` (a `#` followed by 6 hex digits).
- **One pixel per issue** — open another issue to place another pixel.

When the issue is opened, a bot applies your pixel, updates the canvas, and
closes the issue with a confirmation comment.

The live canvas is at [`/site/`](/site/).
