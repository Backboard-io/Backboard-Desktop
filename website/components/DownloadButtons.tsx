export function DownloadButtons() {
  return (
    <div
      className="platform-downloads"
      id="downloads"
      role="group"
      aria-label="Get Backboard Desktop for your computer"
    >
      <button
        className="platform-download"
        type="button"
        aria-disabled="true"
        data-platform="mac-arm"
      >
        <img
          className="download-art"
          src="/assets/kevin-reef-cove.png"
          alt=""
          aria-hidden="true"
        />
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M16.8 12.8c0-2 1.6-3 1.7-3.1-1-1.5-2.5-1.7-3.1-1.7-1.3-.2-2.5.8-3.2.8s-1.7-.8-2.8-.8C7.9 8 6.5 9 5.7 10.3c-1.6 2.7-.4 6.8 1.1 9 .7 1 1.5 2.1 2.6 2 1-.1 1.4-.7 2.7-.7s1.7.7 2.8.7 1.8-1 2.5-2c.8-1.1 1.1-2.2 1.2-2.3-.1 0-2.4-.9-2.4-3.5l.6-.7ZM14.8 6.5c.6-.8 1.1-1.9 1-3-.9 0-2 .6-2.7 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2-.5 2.7-1.3Z"
          />
        </svg>
        <span>
          <strong>Mac M-series</strong>
          <small>Apple silicon</small>
        </span>
        <span className="download-arrow" aria-hidden="true">
          ↓
        </span>
      </button>
      <button
        className="platform-download"
        type="button"
        aria-disabled="true"
        data-platform="mac-intel"
      >
        <img
          className="download-art"
          src="/assets/sun-study-2026-09-27/04-sun-walk.png"
          alt=""
          aria-hidden="true"
        />
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M16.8 12.8c0-2 1.6-3 1.7-3.1-1-1.5-2.5-1.7-3.1-1.7-1.3-.2-2.5.8-3.2.8s-1.7-.8-2.8-.8C7.9 8 6.5 9 5.7 10.3c-1.6 2.7-.4 6.8 1.1 9 .7 1 1.5 2.1 2.6 2 1-.1 1.4-.7 2.7-.7s1.7.7 2.8.7 1.8-1 2.5-2c.8-1.1 1.1-2.2 1.2-2.3-.1 0-2.4-.9-2.4-3.5l.6-.7ZM14.8 6.5c.6-.8 1.1-1.9 1-3-.9 0-2 .6-2.7 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2-.5 2.7-1.3Z"
          />
        </svg>
        <span>
          <strong>Mac Intel</strong>
          <small>Intel processor</small>
        </span>
        <span className="download-arrow" aria-hidden="true">
          ↓
        </span>
      </button>
      <button
        className="platform-download"
        type="button"
        aria-disabled="true"
        data-platform="windows"
      >
        <img
          className="download-art"
          src="/assets/kevin-wave-paint.png"
          alt=""
          aria-hidden="true"
        />
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M2 4.5 10.5 3.3v8H2zm10-1.4L22 1.7v9.6H12zM2 12.8h8.5v8L2 19.5zm10 0h10v9.5L12 21z"
          />
        </svg>
        <span>
          <strong>Windows</strong>
          <small>Windows PC</small>
        </span>
        <span className="download-arrow" aria-hidden="true">
          ↓
        </span>
      </button>
      <button
        className="platform-download"
        type="button"
        aria-disabled="true"
        data-platform="linux"
      >
        <img
          className="download-art"
          src="/assets/sun-study-2026-09-27/02-solar-tide.png"
          alt=""
          aria-hidden="true"
        />
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect
            x="2"
            y="4"
            width="20"
            height="16"
            rx="3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="m6 8 4 4-4 4m7 0h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
        <span>
          <strong>Linux</strong>
          <small>Linux desktop</small>
        </span>
        <span className="download-arrow" aria-hidden="true">
          ↓
        </span>
      </button>
    </div>
  );
}
