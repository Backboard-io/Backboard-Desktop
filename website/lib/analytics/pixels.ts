// The vendor bootstrap snippets, de-minified. Each one installs a stub that
// queues calls synchronously and then pulls the real script in async, so
// track() can fire before the network catches up.

type Fn = (...args: unknown[]) => void;
type Queued = Fn & { queue?: unknown[]; q?: unknown[] };

declare global {
  interface Window {
    fbq?: Queued & { callMethod?: Fn; loaded?: boolean; version?: string; push?: Fn };
    _fbq?: unknown;
    dataLayer?: unknown[];
    gtag?: Fn;
    twq?: Queued & { exe?: Fn; version?: string };
    lintrk?: Queued;
    _linkedin_data_partner_ids?: string[];
  }
}

function inject(src: string) {
  const s = document.createElement("script");
  s.async = true;
  s.src = src;
  document.head.appendChild(s);
}

export function loadMeta(pixelId: string) {
  if (window.fbq) return;
  const fbq: NonNullable<Window["fbq"]> = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue!.push(args);
  };
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.queue = [];
  window.fbq = fbq;
  window._fbq = fbq;
  inject("https://connect.facebook.net/en_US/fbevents.js");
  fbq("init", pixelId);
  fbq("track", "PageView");
}

export function loadGoogleAds(adsId: string) {
  if (window.gtag) return;
  window.dataLayer = window.dataLayer ?? [];
  // gtag.js reads the `arguments` object itself, not an array copy.
  window.gtag = function () {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  inject(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(adsId)}`);
  window.gtag("js", new Date());
  window.gtag("config", adsId, { allow_enhanced_conversions: true });
}

export function loadX(pixelId: string) {
  if (window.twq) return;
  const twq: NonNullable<Window["twq"]> = function (...args: unknown[]) {
    if (twq.exe) twq.exe(...args);
    else twq.queue!.push(args);
  };
  twq.version = "1.1";
  twq.queue = [];
  window.twq = twq;
  inject("https://static.ads-twitter.com/uwt.js");
  twq("config", pixelId);
}

export function loadLinkedIn(partnerId: string) {
  if (window.lintrk) return;
  (window as unknown as { _linkedin_partner_id: string })._linkedin_partner_id = partnerId;
  window._linkedin_data_partner_ids = window._linkedin_data_partner_ids ?? [];
  window._linkedin_data_partner_ids.push(partnerId);
  const lintrk: NonNullable<Window["lintrk"]> = function (a: unknown, b: unknown) {
    lintrk.q!.push([a, b]);
  };
  lintrk.q = [];
  window.lintrk = lintrk;
  inject("https://snap.licdn.com/li.lms-analytics/insight.min.js");
}
