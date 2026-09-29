# 004 — Replace raw `transition:.XXs` shorthands with explicit property lists (21 spots)

- **Status**: TODO
- **Commit**: 1b6cb41
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 3 files — index.html ×19 lines, shop/account.html ×1, shop/checkout.html ×1

## Problem

21 rules use the transition shorthand without a property list —
`transition:.15s` means `transition: all .15s`: EVERY property change on that
element animates (including properties that were never meant to animate — a
future hover tweak, a theme swap, a JS inline style), off-GPU. Each rule must
enumerate exactly the properties its state changes actually touch. Durations
stay identical — only the property lists become explicit.

Full sweep (authoritative, `transition:\.\d`): index.html lines 274, 287, 301,
424, 425, 462, 486, 492, 577, 657, 686, 728, 750, 943, 981, 986, 1004, 1049,
1195 + shop/account.html:60 + shop/checkout.html:50. There are ZERO
`transition:all` instances in index.html (verified). Every edit below is a
1-line-for-1-line substring swap, so line numbers do not shift.

Representative current code:

```css
/* index.html:287-293 — current (hover rules the `.btn` must cover) */
.btn{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:10px;font-weight:600;font-size:13.5px;border:1px solid transparent;transition:.15s;white-space:nowrap}
.btn-primary{...}.btn-primary:hover{filter:brightness(1.04);transform:translateY(-1px);box-shadow:0 7px 20px -6px rgba(143,181,30,.65)}
.btn-dark{...}.btn-dark:hover{filter:brightness(.94)}
.btn-outline{...}.btn-outline:hover{border-color:var(--ink3);background:var(--row-h)}
.btn-ghost{...}.btn-ghost:hover{background:var(--line2);color:var(--ink)}
```

```css
/* shop/checkout.html:50-51 — current */
.plan .dot{width:16px;height:16px;border-radius:50%;border:2px solid var(--line2);flex:none;transition:.2s}
.plan.on .dot{border-color:var(--acc);background:var(--acc);box-shadow:inset 0 0 0 3px var(--bg)}
```

## Target

For each spot: replace ONLY the `transition:.XXs` declaration with the
enumerated list; every other declaration stays byte-identical. The listed
properties are exactly what that selector's hover/state rules change
(the state rule is cited per spot).

| # | File:line | Selector | State rule (cite) | Target `transition` |
|---|-----------|----------|-------------------|---------------------|
| 1 | index.html:274 | `.cm-ath` | :275 hover `border-color` + `transform` | `border-color .15s,transform .15s` |
| 2 | index.html:287 | `.btn` | :290-.293 hovers `filter`,`transform`,`box-shadow`,`border-color`,`background`,`color` | `filter .15s,transform .15s,box-shadow .15s,border-color .15s,background .15s,color .15s` |
| 3 | index.html:301 | `.inp,.sel,.ta` | :302 focus `border-color` + `box-shadow` | `border-color .15s,box-shadow .15s` |
| 4 | index.html:424 | `.sw i` | :426 checked `background` | `background .15s` |
| 5 | index.html:425 | `.sw i::after` | :427 checked `inset-inline-start` | `inset-inline-start .15s` |
| 6 | index.html:462 | `.cal-hd.click` | :463 hover `background` | `background .12s` |
| 7 | index.html:486 | `.mday.click` | :487 hover `background` | `background .12s` |
| 8 | index.html:492 | `.wprow` | :493 hover `border-color` + `background` | `border-color .12s,background .12s` |
| 9 | index.html:577 | `.rolecard` | :578 hover `border-color` + `box-shadow` + `transform` | `border-color .15s,box-shadow .15s,transform .15s` |
| 10 | index.html:657 | `.un-chip` | :658 `.on` `border-color` + `background` + `box-shadow` | `border-color .15s,background .15s,box-shadow .15s` |
| 11 | index.html:686 | `.pickc` | :687 `.on` `border-color` + `background` + `color` | `border-color .12s,background .12s,color .12s` |
| 12 | index.html:728 | `.setrow` | :729 `.on` `background` + `border-color` | `background .15s,border-color .15s` |
| 13 | index.html:750 | `.chead-bell` | :751 hover `color` | `color .15s` |
| 14 | index.html:943 | `.pf-copy` (rule spans 942-943) | :944 `:active` `transform` | `transform .15s` |
| 15 | index.html:981 | `.pf-lang button` (rule spans 980-981) | :982 `.on` `background` + `color` + `box-shadow` | `background .18s,color .18s,box-shadow .18s` |
| 16 | index.html:986 | `.pf-out` (rule spans 984-986) | :987 hover `background`; :988 `:active` `transform` | `background .15s,transform .15s` |
| 17 | index.html:1004 | `.td-day` | :1005 `.on` `background` + `box-shadow` | `background .15s,box-shadow .15s` |
| 18 | index.html:1049 | `.td-tab` | :1050 `.on` `background` + `color` + `box-shadow` | `background .15s,color .15s,box-shadow .15s` |
| 19 | index.html:1195 | `.tbx-it` | :1196 hover `border-color` + `background` | `border-color .15s,background .15s` |
| 20 | shop/account.html:60 | `.modes button` | :61 `.on` `background` + `border-color` + `color` | `background .25s,border-color .25s,color .25s` |
| 21 | shop/checkout.html:50 | `.plan .dot` | :51 `.on` `border-color` + `background` + `box-shadow` | `border-color .2s,background .2s,box-shadow .2s` |

## Repo conventions to follow

- Enumerated transition lists are the established pattern in this codebase.
  Exemplars to imitate:
  - `index.html:449` — `.cgrid .card{...;transition:border-color .15s,box-shadow .15s,transform .15s}`
  - `index.html:437` — `.stat{transition:transform .18s,box-shadow .18s}`
  - `index.html:960` — `.pf-chat{...;transition:transform .15s}`
  - `shop/checkout.html:47` — `.plan{...;transition:border-color .25s,background .25s}`
- Durations in this file use the no-leading-zero shorthand (`.15s`, not
  `0.15s`) — keep that style exactly.

## Steps

1. Apply all 21 replacements from the Target table, in order, one edit per
   line (each is a substring swap of only the `transition` declaration —
   line numbers do not shift). Use line-anchored edits: lines 943, 981 and
   986 are continuation lines of multi-line rules, and several other lines
   share the literal text `transition:.15s`.
2. After all 21 edits, re-run the sweep to confirm nothing was missed:
   `Select-String -Path "index.html" -Pattern 'transition:\.\d'` must return
   ZERO matches, and the two shop lines must be gone too.

## Boundaries

- Do NOT change durations, curves, or any other declaration — the swap is
  property-list-only.
- Do NOT convert `.sw i::after`'s `inset-inline-start` (line 425) to a
  transform-based slide — out of scope (separate finding); enumerate it
  as-is.
- Do NOT touch `shop/index.html:513` (`.chip8{transition:all .4s}`) or the
  `COACH-OS-*.html` marketing copies — out of scope; flagged for a follow-up
  plan (see `plans/README.md` backlog).
- Do NOT touch `.pf-chat` (index.html:960) — already correct.
- The toast's inline `d.style.transition='.3s'` (index.html:3416) is handled
  by plan 001 — do not touch it here.
- Do NOT change markup — motion properties only.
- If a step doesn't match the code you find (drift since the commit stamp),
  STOP and report instead of improvising.

## Verification

- **Mechanical**: re-run the sweep —
  `Select-String -Path "index.html" -Pattern 'transition:\.\d'` → zero
  matches; `Select-String -Path "shop\account.html","shop\checkout.html" -Pattern 'transition:\.\d'` → zero matches;
  `(Select-String -Path "index.html" -Pattern 'transition:all').Count` → 0.
- **Feel check**: hover/toggle each affected component and confirm each
  animates exactly as before (same properties, same durations) and nothing
  NEW animates:
  - roster cards (`.cm-ath`), buttons, inputs/textarea focus ring, settings
    switches (track + knob), calendar headers and month days, week-plan rows;
  - role cards, join chips (`.un-chip`), picker tiles, workout set rows,
    profile copy/lang/out buttons, today tabs and day strip, toolbox items;
  - shop sign-in/sign-up toggle (account.html), checkout plan dots.
- **Done when**: the sweep returns zero raw shorthand transitions and every
  listed interaction still animates exactly as before.
