# Backboard Studio website

The Backboard Studio product hub and Kevin landing page use Next.js App Router, React, and TypeScript.
The cloud page and embedded IDE demo remain static files in `public/`.

## Run locally

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:4173/ for the product hub or `/kevin` for the IDE. The previous `/kevin-concept.html` URL redirects to `/kevin`, preserving anchor links.

```sh
npm run build      # production compilation and TypeScript validation
npm run typecheck
npm start          # serve the production build on port 4173
```

## Source map

- `app/page.tsx` and `app/home.css`: compact five-product homepage.
- `data/products.ts`: product artwork and destinations; missing URLs display as Coming soon.
- `app/kevin/page.tsx`: hero, artwork, closing section and footer.
- `app/kevin/kevin.css`: the existing responsive beach design, migrated without a visual redesign.
- `components/SiteHeader.tsx`: shared navigation for the product hub and Kevin.
- `components/DownloadButtons.tsx`: four illustrated platform tiles. Destinations intentionally remain empty.
- `components/WorkspaceDemo.tsx`: floating app window, integrated React mode controls, video playback, iframe sizing and lifecycle cleanup.
- `components/ModelSlider.tsx`: all 60 provider/model-family icons, a seamless transparent marquee inside the hero with pause on hover/focus and a discreet pause control. Motion pauses offscreen, on hover/focus, when hidden, and for reduced-motion preferences.
- `data/models.ts`: the model/provider catalog.
- `public/assets/`: shared artwork, provider logos and video.
- `public/laptop-demo.html`: existing interactive IDE demo, isolated in the laptop iframe to preserve its behavior.
- `public/cloud/`: existing cloud page, served through a Next rewrite. `/index.html` redirects to the React homepage.
- `design-reference/`: original static Kevin prototype, archived homepage (`home-marketing.html`), and prior static-site documentation; not deployed.

## Deployment

`vercel.json` now selects the Next.js framework and build output. Deploy from this directory with Vercel when ready. Changes are local until deployment is explicitly requested.
