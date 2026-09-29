# 002 — Command palette: delete the entrance animation (high-frequency action must not animate)

- **Status**: TODO
- **Commit**: 1b6cb41
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 1 file (index.html), 1 edit

## Problem

The command palette (⌘K / Ctrl+K toggle at `index.html:10177`) is one of the
highest-frequency actions in the app — dozens of opens per day. Per the
frequency rule (100+ times/day: no animation, ever), its entrance must be
instant. The overlay `.pal` already appears with no animation; the box is the
only animated piece.

Current code:

```css
/* index.html:688-689 — current */
.pal{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100;display:flex;justify-content:center;align-items:flex-start;padding-top:11vh;backdrop-filter:blur(3px)}
.pal-box{width:100%;max-width:600px;max-height:68vh;background:var(--surface);border-radius:16px;box-shadow:var(--sh-2);display:flex;flex-direction:column;overflow:hidden;animation:pop .15s}
```

The open/close JS is already instant (innerHTML swap): `renderPal()` at
`index.html:9104`, `closePal()` at `index.html:9117`
(`$('pal-root').innerHTML=''`), `openPal()` at `index.html:9118`. No JS change.

## Target

```css
/* index.html:689 — target */
.pal-box{width:100%;max-width:600px;max-height:68vh;background:var(--surface);border-radius:16px;box-shadow:var(--sh-2);display:flex;flex-direction:column;overflow:hidden}
```

The palette box appears instantly. `@keyframes pop` (`index.html:390`) stays —
still used by `.modal` (`index.html:389`, `pop .16s ease`) and `.pwa-banner`
(`index.html:1259`, `pop .2s ease`).

## Repo conventions to follow

- Exemplar of the correct pattern: the `.pal` overlay itself
  (`index.html:688`) appears with no animation — native-launcher feel
  (Raycast/Spotlight).

## Steps

1. `index.html:689` — in `.pal-box{...}`, delete `;animation:pop .15s` (keep
   every other declaration byte-identical).

## Boundaries

- Do NOT touch `.modal` / `@keyframes pop` (`index.html:389-390`) or
  `.pwa-banner` (`index.html:1259`) — modals and the PWA banner are occasional
  actions and keep their entrances.
- Do NOT add a close animation.
- Do NOT change `openPal`/`closePal`/`renderPal` JS or the ⌘K handler.
- Do NOT change markup — motion properties only.
- If a step doesn't match the code you find (drift since the commit stamp),
  STOP and report instead of improvising.

## Verification

- **Mechanical**: open `index.html`, press ⌘K/Ctrl+K (coach role) — the
  palette appears instantly; `animation` is gone from `.pal-box` in the
  computed styles.
- **Feel check**: open/close the palette 10 times rapidly (⌘K, Escape) —
  never any flash, restart, or flicker; it must feel like a native launcher.
  Typing in the input must filter results instantly with no motion.
- **Done when**: `animation` is gone from `.pal-box` and ⌘K feels instant.
