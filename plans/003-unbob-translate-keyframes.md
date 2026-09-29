# 003 — Unlock bob: animate the composited `translate` property instead of `margin` inside the infinite keyframes

- **Status**: TODO
- **Commit**: 1b6cb41
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 1 file (index.html), 1 edit + comment

## Problem

`@keyframes unbob` animates `margin-top` on `.un-lock` inside an infinite 5.5s
loop (`index.html:605-606`). Margin is a layout property — every frame
triggers layout + paint for the whole unlock stage (rings, grid, particles
share the area). Only transform/opacity may run infinitely.

Current code:

```css
/* index.html:605-606 — current */
.un-lock{position:relative;transform:translateY(calc(var(--ux,0)*-30px)) rotate(calc(var(--ux,0)*-3deg)) scale(calc(1 + var(--ux,0)*.07));animation:unbob 5.5s ease-in-out infinite;pointer-events:none}
@keyframes unbob{0%,100%{margin-top:0}50%{margin-top:-9px}}
```

The static `transform` on `.un-lock` is the held-pose target driven by `--ux`
(set per pointermove by `set()` at `index.html:4223`). The bob animates
`margin-top` because `transform` is already taken. The fix uses the individual
`translate` property inside the keyframes: it is independent of `transform`,
so the two compose (the keyframes override only `translate`; the held pose in
`transform` is untouched).

Visual-parity note: under `place-items:center` (`.un-hold`, `index.html:612`),
grid alignment centers the item's MARGIN BOX, so `margin-top:-9px` shifts the
visible box by half the margin (4.5px up), not 9px. The 50% keyframe value is
therefore `-4.5px` for an identical feel.

## Target

```css
/* index.html:605-606 — target */
.un-lock{position:relative;transform:translateY(calc(var(--ux,0)*-30px)) rotate(calc(var(--ux,0)*-3deg)) scale(calc(1 + var(--ux,0)*.07));animation:unbob 5.5s ease-in-out infinite;pointer-events:none}
/* bob rides the individual `translate` property (composes with the --ux
   transform instead of overriding it); the old margin-top animated layout
   every frame. -4.5px = the visual offset margin-top:-9px produced under
   place-items:center (margin-box centering shifts by half). */
@keyframes unbob{0%,100%{translate:0 0}50%{translate:0 -4.5px}}
```

- Same 5.5s ease-in-out infinite timing; same bob amplitude (4.5px, now via
  `translate`); GPU-composited, zero layout work per frame.
- The static `transform` on `.un-lock` STAYS — reduced motion
  (`index.html:683`, `.un-lock{animation:none}`) already stops the bob and
  relies on the static transform for the held pose. No edit needed there.
- On unlock, `animation:unpop` (`.index.html:680`) replaces `unbob`
  wholesale — same as today (a ≤4.5px settle at burst start, imperceptible).

## Repo conventions to follow

- var-in-keyframes is an established pattern here: `index.html:592`
  (`@keyframes unfloat{...translate3d(0,0,var(--z,0px))...}`). This plan
  avoids `var()` in keyframes entirely — the held pose stays in the static
  transform, the bob is a plain value (no browser snapshot risk).
- Single-line keyframes style is used throughout: imitate `index.html:601`
  (`@keyframes unspin{from{...}to{...}}`).
- Individual transform properties are already in use (`index.html:642`);
  `translate` support is Chrome 104+/Safari 14.1+/Firefox 72+ (the app
  targets modern browsers; without it the bob simply doesn't run).

## Steps

1. `index.html:606` — replace
   `@keyframes unbob{0%,100%{margin-top:0}50%{margin-top:-9px}}`
   with
   `@keyframes unbob{0%,100%{translate:0 0}50%{translate:0 -4.5px}}`
   (keep it on one line, matching the file's style).
2. `index.html` — insert a new line between the `.un-lock` rule (line 605)
   and the keyframes, with the explanatory comment from the Target block —
   so a future editor does not "simplify" it back to margin.

## Boundaries

- Do NOT touch `.un-lock`'s static `transform` (`index.html:605`) — reduced
  motion and the hold-lift path rely on it.
- Do NOT touch `@keyframes unpop` / `.unlocked .un-lock`
  (`index.html:680-681`) — the unlock exit replaces the animation wholesale;
  its hardcoded pose is a separate pre-existing quirk, out of scope.
- Do NOT touch `.un-hold` (`index.html:612`), `.un-plate`
  (`index.html:628-632`), or the `set()`/`--ux` JS (`index.html:4223`) —
  that is a separate, unselected finding.
- Do NOT change the bob timing (5.5s), easing (ease-in-out), or add
  `will-change`.
- Do NOT change markup — motion properties only.
- If a step doesn't match the code you find (drift since the commit stamp),
  STOP and report instead of improvising.

## Verification

- **Mechanical**: open the join flow (a bare/unknown join code shows the
  unlock screen), DevTools Console: no CSS parse errors; the computed
  `translate` on `.un-lock` cycles between `0 -4.5px` and `none`.
- **Feel check**:
  - the dumbbell bobs gently exactly as before (same amplitude/direction —
    compare at 10% playback speed before/after; if the amplitude visibly
    differs, measure the old amplitude in DevTools and set the 50% `translate`
    to match, then report);
  - hold to lift: the bar lifts, rings accelerate, plates glow — the bob
    composes with the held pose (the bar must NOT jump or snap when `--ux`
    starts moving);
  - release mid-hold: the pose returns smoothly, bob continues;
  - In DevTools Performance panel, record 3s of the idle unlock screen: no
    Layout / Recalculate Style entries per frame from the bob (before the
    fix, `unbob` forces layout every frame).
  - Toggle `prefers-reduced-motion` (Rendering panel): bob stops, and the
    held pose still works when holding (static transform path).
- **Done when**: the bob is transform/translate-only (no layout work per
  frame) and the idle + hold visuals are indistinguishable from before.
