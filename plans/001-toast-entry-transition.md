# 001 — Toast: keyframe entrance → transition (retargetable) + 150ms explicit exit

- **Status**: TODO
- **Commit**: 1b6cb41
- **Severity**: HIGH
- **Category**: Interruptibility
- **Estimated scope**: 1 file (index.html), 4 small edits (3 CSS, 1 JS)

## Problem

Toasts are created by the `toast()` helper at `index.html:3416` and styled at
`index.html:698-701`. Two violations of the interruptibility rule (rapidly-
triggered UI must use transitions so state changes retarget mid-motion instead
of restarting; only transform/opacity animate):

1. The entrance is a keyframe (`animation:slide .2s`) with no curve (defaults
   to `ease`). Worse: a running animation overrides inline styles in the
   cascade — if the dismiss timer fires while the entrance is still running,
   the JS-set `opacity:0` is blocked until the keyframe ends, then jumps.
2. The exit sets an inline `d.style.transition='.3s'` — that is
   `transition: all .3s`: every property change at that moment animates,
   including layout properties, off-GPU.

Current code:

```css
/* index.html:698-701 — current */
#toasts{position:fixed;inset-inline-end:20px;bottom:20px;z-index:120;display:flex;flex-direction:column;gap:8px}
.toast{display:flex;align-items:center;gap:10px;background:var(--ink-bg);color:#fff;padding:11px 16px;border-radius:12px;box-shadow:var(--sh-2);font-size:13.5px;font-weight:500;animation:slide .2s}
.toast .ic{color:var(--accent)}
@keyframes slide{from{transform:translateY(8px);opacity:0}}
```

```js
/* index.html:3416 — current */
const toast=m=>{const d=document.createElement('div');d.className='toast';d.innerHTML=`${ic('check',16)}${esc(t(m))}`;$('toasts').appendChild(d);setTimeout(()=>{d.style.opacity='0';d.style.transition='.3s';setTimeout(()=>d.remove(),300)},2600)};
```

## Target

```css
/* index.html:699-701 — target */
.toast{display:flex;align-items:center;gap:10px;background:var(--ink-bg);color:#fff;padding:11px 16px;border-radius:12px;box-shadow:var(--sh-2);font-size:13.5px;font-weight:500;transition:opacity .2s ease-out,transform .2s ease-out}
.toast .ic{color:var(--accent)}
.toast.out{opacity:0;transition:opacity .15s ease-out}
@starting-style{.toast{opacity:0;transform:translateY(8px)}}
@media(prefers-reduced-motion:reduce){@starting-style{.toast{opacity:0;transform:none}}}
```

(`@keyframes slide` is deleted — nothing else uses it.)

```js
/* index.html:3416 — target */
const toast=m=>{const d=document.createElement('div');d.className='toast';d.innerHTML=`${ic('check',16)}${esc(t(m))}`;$('toasts').appendChild(d);setTimeout(()=>{d.classList.add('out');setTimeout(()=>d.remove(),150)},2600)};
```

- Entry: the toast rises 8px + fades in over 200ms ease-out.
  `@starting-style` supplies the starting state for the JS-appended element —
  no markup change.
- Exit: fades out over 150ms (the `.out` class; explicit property list, not
  `all`). The removal timeout drops 300 → 150ms to match.
- Interruptibility win: adding `.out` mid-entrance now retargets opacity from
  its current value instead of being blocked by a running keyframe.
- Reduced motion: movement is dropped (starting `transform:none`), the
  opacity fades remain.

## Repo conventions to follow

- `@starting-style` is new to this codebase (no existing usage). It is plain
  CSS (no dependency); in browsers without it the toast simply appears
  instantly (acceptable degradation).
- Reduced-motion blocks are compact one-liners right after the related rule —
  imitate `index.html:936`
  (`@media(prefers-reduced-motion:reduce){.pf-dot{animation:none}}`).
- Enumerated transitions are the established pattern: `index.html:960`
  (`.pf-chat{...;transition:transform .15s}`) and `index.html:437`
  (`.stat{transition:transform .18s,box-shadow .18s}`).
- `index.html:247` (CoachMint skin) sets only static chrome on `.toast`
  (border/font) — it does not conflict; do not touch it.

## Steps

1. `index.html:699` — in `.toast{...}`, replace `animation:slide .2s` with
   `transition:opacity .2s ease-out,transform .2s ease-out` (keep every other
   declaration byte-identical).
2. `index.html:701` — delete the now-unused line
   `@keyframes slide{from{transform:translateY(8px);opacity:0}}`.
3. `index.html` — insert immediately after the `.toast .ic{color:var(--accent)}`
   line (now line 700), one line each:
   - `.toast.out{opacity:0;transition:opacity .15s ease-out}`
   - `@starting-style{.toast{opacity:0;transform:translateY(8px)}}`
   - `@media(prefers-reduced-motion:reduce){@starting-style{.toast{opacity:0;transform:none}}}`
4. `index.html` — in the `toast()` helper (the `const toast=m=>{...}` line,
   was line 3416), replace
   `setTimeout(()=>{d.style.opacity='0';d.style.transition='.3s';setTimeout(()=>d.remove(),300)},2600)`
   with
   `setTimeout(()=>{d.classList.add('out');setTimeout(()=>d.remove(),150)},2600)`

## Boundaries

- Do NOT touch the CoachMint skin `.toast` at `index.html:247`.
- Do NOT change `#toasts` container styling or the 2600ms display duration.
- Do NOT add a transform to the exit (stays opacity-only).
- Do NOT introduce easing tokens — use the literal `ease-out` keyword.
- Do NOT touch `design/path-designer-prototype.html` — it has its own
  `toast()` (line 209) and its own styles; out of scope.
- If a step doesn't match the code you find (drift since the commit stamp),
  STOP and report instead of improvising.

## Verification

- **Mechanical**: no build/lint in this repo (static single-file app). Open
  `index.html` in a browser, DevTools Console: no CSS parse errors;
  `@keyframes slide` is gone from the stylesheet.
- **Feel check**: trigger toasts (export a calendar, upload a file, save a
  note) and confirm:
  - each toast rises 8px and fades in, decelerating (ease-out), not easing-in;
  - trigger two toasts back-to-back: both animate independently; a toast
    dismissed mid-entrance fades out smoothly from its current state (never
    restarts or freezes);
  - the exit is a quick ~150ms fade, no jarring disappearance.
  - In DevTools, set playback to 10% (Animations panel) and confirm only
    opacity + transform animate (no other properties).
  - Toggle `prefers-reduced-motion` (Rendering panel) and confirm movement is
    dropped but the opacity fades remain.
- **Done when**: toasts enter via a transition, exit via a 150ms explicit
  fade, and `@keyframes slide` plus the inline `transition:.3s` are gone from
  `toast()`.
