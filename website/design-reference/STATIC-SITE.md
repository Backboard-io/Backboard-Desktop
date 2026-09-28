# Backboard Desktop website

A standalone, responsive marketing website. No build step or package installation is required. The workspace preview is illustrative; its mode tabs support mouse and keyboard navigation.

From this directory, start a local preview:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Open http://127.0.0.1:4173. Deploy this directory to any static host. The public files are `index.html`, `style.css`, `app.js`, `logo.svg`, `demo.js`, `demo.css`, and all files under `assets/`. Google Fonts is optional; system fonts provide a fallback when offline.

The calls to action link to the repository and its source setup instructions. They do not assume a downloadable release is available.

## Design and artwork

The site retains its original Hermes-inspired electric blue background, condensed typography, navigation, and layout. User-supplied surf and rodeo images add branding to the existing hero, copied unchanged into `assets/motion-surf.jpeg` and `assets/rodeo.jpeg`. Their original filenames are “Holy beach _ With @pullinofficial #hossegor….jpeg” and “franklin rodeo cowboy _ cowboy aesthetic horse….jpeg”; authorship and licensing metadata were not supplied. The logo comes from this repository. The earlier generated orbital illustration remains unused in `hero-orbit.png`.

The mode switcher supports Left/Right, Home, and End keys. FAQs use native disclosure controls. The copy button reports clipboard failures with a manual-copy instruction. The IDE panels illustrate workflows rather than running live agent sessions.

## Animated IDE walkthrough

The 18-second walkthrough is a DOM/CSS recreation based on direct inspection of the running Backboard Studio app. It shows a sample conversation, an illustrative editor review, and the real Advanced mode's board layout. It is not a screen recording or a live agent session. The conversations, code, and test results are scripted examples.

The background is the actual `backboard/src/vs/sessions/contrib/chat/browser/media/backgrounds/golden-hour.jpeg` asset, copied into `assets/golden-hour.jpeg` so this site stays independently deployable. No user session history is included.

Playback begins when the preview enters the viewport and suspends offscreen or when the browser tab is hidden. Pause and Replay controls are provided; manual mode selection stops playback and displays the complete scene. Reduced-motion visitors start with a static, complete scene and can explicitly start playback with transitions disabled.

### Native UI fidelity

The preview reuses Microsoft's [Codicons](https://github.com/microsoft/vscode-codicons) font, distributed under CC BY 4.0, from the installed IDE (`assets/codicon.ttf`). Its license is retained in `assets/CODICONS-LICENSE`; include both when deploying. The desktop board reproduces the app's 3 × 3 session grid, compact 29px toolbar, system typography, and translucent cards. Smaller previews show six cards to preserve legibility. This is an illustrative recreation with fictional sessions.

## Editor and cloud pages

Editor mode is rebuilt from a direct visual inspection of Backboard Studio's Code–OSS window: activity rail, Explorer, nested folders, tabs, breadcrumbs, syntax-colored code, minimap, optional terminal, right-hand chat, and status bar. Its sample files, file search, Source Control filter, panel toggles, and local scripted chat work without a backend. Native mode buttons also change the preview. Animation runs at six seconds per mode, with brief transitions and the existing reduced-motion behavior.

`cloud/` is a separate landing page following the supplied Nous Cloud reference. Its form prepares a connection guide for an existing compatible agent server, based on `docs/cloud-agent-locations.md`. It supports SSH forwarding and authenticated secure WebSocket endpoints. Inputs stay in the browser; the page does not provision infrastructure, connect to a server, collect credentials, or bill users. Deploy the entire `website/` directory, including `editor-demo.js`, `editor-demo.css`, `cloud/`, and all of `assets/`.

The editor composer uses a separate rounded input surface and location footer, with the site grain kept outside the IDE preview. `assets/studio-mark.svg` derives from the repository logo with the desktop blue treatment.

## Background

Both pages use a flat orange background (`#FF6600`) without grain or animation. The surf and rodeo images remain in the hero. `waves.js` is an unused experiment and is not loaded by either page.

## Photo-print branding

All eight user-supplied moodboard images now appear on the home page. The original surf/rodeo hero is joined by `flight.jpeg`, `racing.jpeg`, `create-more.jpeg`, `ocean.jpeg`, `never-too-late.jpeg`, and `summit.jpeg`. These are unchanged copies of the supplied files, presented in CSS cream print borders with captions and small rotations. Embedded artwork, quotes, and third-party marks remain part of the reference images, not product endorsements. Below-fold images load lazily; paired prints stack with their surrounding copy on small screens.

Six additional Downloads references were inspected and selected for the expanded branding: `diablo.jpeg`, `move.jpeg`, `new-york.jpeg`, `adventure-collage.jpeg`, `no-limits.jpeg`, and `no-risk.jpeg`. These are unchanged copies. The inspiration strip supports native horizontal scrolling and keyboard focus on narrow screens. Original files in Downloads are untouched.

## Provider icons

The workspace has a floating foreground layer of 60 provider and model-family marks reused from the repository’s model picker, plus Copilot. All 60 icons remain visible simultaneously: 24 above, 24 below, and 12 around and over the IDE. The layer passes pointer events through to the editor. Accessible image labels identify the marks; the checkbox pauses animation, and reduced-motion preferences keep all 60 static. The old provider text row is removed. These identify providers and families rather than promising every model version is available: the real app loads its model catalog dynamically. Icon source and license files are retained under `assets/providers/`.

The four inspiration-wall prints are now distributed as section transitions: skyline before the workspace, adventure collage before setup, ocean before FAQs, and No Risk before the closing section. Each retains its cream border and rotation, paired with a small section cue. The former four-image scrolling strip is removed.

The four transition prints now sit as small, zero-height overlays across existing section boundaries. Their standalone headings, captions, and section padding are removed so they do not add scroll length.

## Laptop hero

The hero pairs bold left-aligned copy with a CSS laptop against the IDE’s golden-hour wallpaper, blended into the orange page. `laptop-demo.html` isolates a working copy of the existing three-mode walkthrough inside the laptop screen. `hero-laptop.js` scales its 1100×720 viewport with ResizeObserver; mode buttons send same-origin messages handled by `laptop-mode.js`. The lower workspace demo remains independent. On mobile, the laptop stacks below the copy. Include `hero-laptop.css`, both laptop scripts, and `laptop-demo.html` when deploying.

The latest hero replaces the CSS laptop with a full-viewport generated photograph (`assets/laptop-meadow-hero.png`). The built-in image generator used the supplied laptop/meadow composition as reference; its full prompt is saved in `assets/laptop-meadow-hero.prompt.txt`. Live IDE content is aligned to measured screen bounds with ResizeObserver, while the copy and navigation overlay the left side.
