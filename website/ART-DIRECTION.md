# Backboard Studio — Ink & Paint

The homepage takes its cue from the logo: a loose black-ink sketch of a surfing
penguin and a wide-tracked mono wordmark. That line sits on Werner
Bronkhorst–style white impasto, thick palette-knife paint with tiny people in
it. Colour only ever comes from the paint.

## Rules

- Paper `#F6F2E8`, ink `#161512`, secondary ink `#57544C`, hairlines at 15% ink.
- Paint colours: turquoise `#1FA9B8`, sea `#1D5FC4`, sun `#FF6B2C`.
- Type: Instrument Sans for headlines and body, JetBrains Mono uppercase with
  wide tracking for labels (echoes the wordmark), Caveat for handwritten notes.
- Hand-drawn ink marks (underline, circle, arrow note in `components/Ink.tsx`)
  draw themselves on scroll. Use one per section at most.
- The penguin mark appears in the nav, the closing section and the footer.
- One page, one section per product, all in the same layout (label, name,
  pitch, checklist, action, visual).

## Motion

- `lib/impasto.ts` / `components/PaintCanvas.tsx`: the hero paints a wave
  ribbon, sand and sun into lit impasto, then tiny surfers and walkers ride the
  strokes. Visitors can drag to paint and pick colours.
- `components/DesktopMock.tsx`: self-playing Backboard Desktop window cycling
  Simple / Editor / Advanced. Tabs are clickable.
- `components/TerminalDemo.tsx`: looping Backboard CLI session.
- Everything pauses offscreen and respects reduced motion.

## Assets to generate

Save each at its path to replace the stand-in. Shared suffix:

> Thick sculptural impasto acrylic on a mostly white canvas, palette-knife
> ridges, raking light from the upper left, miniature realistic people with long
> soft shadows, generous empty white space, overhead view, no text, no logos.

1. **Backboard CLI** — `public/assets/cli-lighthouse.png` (1:1): a tiny
   lighthouse on a rock in a turquoise paint pool; its beam is a single
   cream-white stroke across the canvas with one miniature sailboat following it.
2. **Nash** — `public/assets/nash-hut.png` (1:1): a single small beach hut on a
   white paint dune, door closed, a surfboard leaning on it, one tiny figure
   walking up to it.
3. **Giggsfields** — `public/assets/giggsfields-field.png` (1:1): a field of
   yellow and green paint dabs with a huge blank white canvas laid in the middle
   like a picnic blanket; tiny painters with rollers are adding a wave and a sun.
4. **Backboard Apps** — `public/assets/apps-huts.png` (1:1): a row of five small
   striped beach huts along a turquoise shoreline, a short queue of tiny people
   at each.
5. **Social card** — `public/og.png` (1200×630): white impasto canvas, one
   turquoise wave ribbon lower right, a small orange sun upper right, empty space
   on the left for the penguin mark and "Backboard Studio" set afterwards.

After generating 1–4, point `artwork` for that product in `data/products.ts` at
the new file.

The older risograph stand-ins (`scripts/riso.py`, `public/assets/riso/`) are no
longer used by the page.
