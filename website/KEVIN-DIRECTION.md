# Kevin — initial visual direction

Brand architecture: Backboard Studio is the overarching app layer. Kevin is the IDE. Use “Kevin, by Backboard Studio” on first introduction, then “Kevin.” This concept does not rename the desktop source or claim a completed product migration.

Preview: /kevin-concept.html. The current homepage remains at /index.html.

## Direction: room to make your own tracks

An expansive white sculptural canvas inhabited by miniature skiers. Human scale, tactility, and purposeful empty space translate the requested Werner Bronkhorst reference into a software page. The canvas is newly generated original artwork, not a reproduction or licensed work by the artist. Reference: https://wernerbronkhorst.com/pages/about

The signature is the contrast between a tactile, almost boundless physical canvas and a precise, functional IDE window. Keep the product visible and interactive beneath the hero; don't bury it behind lifestyle imagery.

## Foundation

- Paper #F6F6F2: page and artwork ground.
- Graphite #20211F: typography and primary action.
- Vermilion #EE542B: wordmark dot and one headline emphasis.
- Quiet grey #656761: secondary copy.
- Cobalt #254BB7: focus states and occasional miniature detail.
- Manrope medium: large, closely spaced headlines; extra-bold for the lowercase kevin wordmark.
- DM Sans: readable body and navigation.

## Composition

Hero: small Kevin wordmark and parent endorsement; large left-aligned headline over white texture; tiny figures to the right; one clear workspace action.
Product: generous breathing room, short explanatory copy, dark interactive preview with Simple / Editor / Advanced controls.
Brand detail: close-up crop of the same canvas paired with “Make your own tracks,” then the explicit Backboard Studio → Kevin relationship.

The current concept uses the existing demo engine as a functional placeholder. Its in-app labels still show Backboard Studio until a separate product naming pass.

## Later expansion

Extend into water and grass canvases as distinct editorial chapters rather than an auto-rotating hero. Keep image transitions short and integrated with content. Let aspiration come from craft and freedom; no invented popularity, usage numbers, or scarcity claims.

## Scope

This is a responsive local design study, not a replacement of the deployed homepage. Existing marketing pages and desktop work are preserved.


## Revision: demo first, art everywhere

The interactive Film / Simple / Editor / Advanced demo now sits in the hero next to “Good ideas. Go wild.” Full-bleed landscape art is replaced with small irregular painted fragments, miniature skiers, a rodeo cutout and a generated transparent sculptural surf shape. Paint crosses the actual boundaries between the pale lemon hero, cobalt features and pink closing area. The palette expands to lemon #F6EB6C, cobalt #2445D8, pink #FFD8E5 and vermilion #F04C27. The intention is playful and handmade, with artwork outside the usable demo area. This revises the restrained gallery direction above based on user feedback.

## Current direction: the whole page is an ocean

The original laptop presentation returns in the hero, containing Film / Simple / Editor / Advanced. The headline is “Good ideas come in waves.” The ocean theme carries through sea-glass navigation with painted foam, turquoise chapters, miniature surfers, loose surf photography and a sunset shoreline bridging into the deep-blue footer. Five additional transparent original impasto artworks make each boundary distinct; they overlap existing sections rather than becoming separate galleries. All generated assets and exact prompts are documented in assets/KEVIN-OCEAN-ART.md. This supersedes the snowy gallery direction. Local concept only; the production homepage is unchanged.

## Download-first hero and shared navigation

Hero copy is now exactly “Don't let coding hold you back from starting.” Four platform buttons replace the supporting text and CTA: Mac M-series, Mac Intel, Windows and Linux. Their destinations are intentionally empty at the user's request; buttons expose aria-disabled until release URLs are supplied. The tighter hero retains the laptop and keeps artwork crossing into the following content. Homepage, Kevin and Cloud all use the same navigation structure and shared-nav.css, retaining the homepage's centered brand and two link groups. Kevin uses the ocean ink color for contrast.

## Models throughout the page

All 60 provider/model-family icons from the homepage are included exactly once: 24 in the hero around the computer, 20 through features and 16 in the closing section. The original homepage assets and names are reused. Floating motion has a pause button and respects reduced-motion preferences. On narrow screens the same full collection wraps within each existing section instead of covering copy and controls. No new provider/model support is implied beyond the homepage collection.

## Editorial refresh and model slider

All 60 providers/model families now appear in one horizontally scrollable strip between the hero and workspace modes. Visible names, previous/next controls, range indicator, touch scrolling and keyboard Arrow/Home/End navigation replace scattered floating logos. No autoplay. The copy is rewritten around “Big idea. Meet Kevin.” and concrete uses of each workspace mode. The three modes are arranged side by side, with the newer solar-tide image connecting them to the closing section. Newly integrated sun-study assets: 02-solar-tide, 08-painted-sun, 09-sunray-sweep, 07-afterglow. Hero laptop, shared navigation and deliberately empty platform download destinations remain. Styling is consolidated in kevin-concept.css; the old kevin-launch.css is no longer loaded.

Verified next advances the carousel and keyboard End reaches 53–60 with the next control disabled. Home returns to the first group. Asset-reference checks and JavaScript syntax checks pass.


## Beach-filled layout — September 27
Hero reduced to “Big idea. Meet Kevin.” and the four empty platform download buttons. Existing surf lineup, reef, nav foam, wave ribbon and sun surround the live laptop. All three workspace cards now contain beach artwork (Sun Walk, painted surf, reef cove). The original motion-surf image joins the closing shore collage. All 60 provider/model-family cards drift at 40px/sec, reversing at the ends. Pause/play and arrow controls remain available; hover, keyboard focus, touch, reduced motion, viewport visibility and page visibility are respected.

Correction: removed the entire three-mode content section. The image-filled boxes refer to the four platform download buttons: each now has its own beach-art background. Shared navigation now links Models to the model slider.


## Floating workspace and transparent model flow
Replaced the photographic laptop and detached pill switcher with a slim dark app window and integrated mode tabs. The 60 model/provider icons now form a seamless, transparent marquee within the hero; the separate section, heading, counter, cards and arrows are removed. A hidden-until-hover pause control, keyboard focus pause, reduced-motion fallback and offscreen/page visibility pausing keep the motion controllable.


## Larger demo
Expanded the desktop demo column and removed the frame rotation. Film uses the source video’s native 16:9 ratio to eliminate letterboxing. Increased tab and title-bar sizing, added native fullscreen expansion, and gave the demo a full-width row at tablet widths. The transparent model flow stays at the hero’s bottom.
