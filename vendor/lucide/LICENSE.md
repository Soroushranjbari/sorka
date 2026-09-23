# Lucide icons — vendored build

- File: `lucide.min.js` — UMD build of **lucide v1.47.0**
- Source: https://github.com/lucide-icons/lucide
- License: **ISC** — https://github.com/lucide-icons/lucide/blob/main/LICENSE
- Why vendored: the app CSP allows `script-src 'self'` only (no CDNs), so the
  icon bank must ship with the project. It is precached by the service worker
  (`sw.js` ASSETS) and exposed to the app through the `ic()` bridge in
  `index.html` (`lucideSvg()`), which resolves any of the 1500+ kebab-case
  icon names, e.g. `ic('heart-pulse')`.

ISC License text (per the upstream repository):

> ISC License
>
> Copyright (c) for portions of Lucide are held by Bricke Duarte, 2020 and
> contributors. All rights reserved. Copyright (c) for other portions of
> Lucide are held by Lucide Contributors 2022. All rights reserved.
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
> SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
> OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
> CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
