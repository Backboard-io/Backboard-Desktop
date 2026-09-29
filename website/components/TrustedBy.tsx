import type { ReactNode } from "react";

// Monochrome company marks. Image marks are flattened to ink with CSS so every
// logo in the row reads as one set.
const COMPANIES: { name: string; mark: ReactNode; wordmark?: boolean }[] = [
  {
    name: "AWS",
    // The mark is already the wordmark, so the name isn't repeated beside it.
    wordmark: true,
    mark: (
      <svg viewBox="0 0 40 24" aria-hidden="true">
        <text
          x="20"
          y="13"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fontFamily="Arial, Helvetica, sans-serif"
          letterSpacing="-0.4"
        >
          aws
        </text>
        <path
          d="M7 16.5c7.5 4.6 18.5 4.8 26 .2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
        <path
          d="M29.6 15.2l3.9.8-1.4 3.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    name: "Shopify",
    mark: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M9 7.5V6a3 3 0 0 1 6 0v1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path d="M4.5 7.5h15l-1.2 14H5.7z" />
        <text
          x="12"
          y="18.4"
          textAnchor="middle"
          fontSize="10"
          fontWeight="800"
          fontFamily="Arial, Helvetica, sans-serif"
          fill="#f6f1e7"
        >
          S
        </text>
      </svg>
    ),
  },
  {
    name: "Google",
    mark: <img src="/assets/providers/ai_google.svg" alt="" />,
  },
  {
    name: "Meta",
    mark: <img src="/assets/providers/brand_meta-color.svg" alt="" />,
  },
  {
    name: "Cloudflare",
    mark: (
      <svg viewBox="0 0 32 20" aria-hidden="true">
        <path d="M25.6 18H5.4a4.2 4.2 0 0 1-.7-8.3 7.1 7.1 0 0 1 13.5-2.7 5.7 5.7 0 0 1 9.3 4.1A3.6 3.6 0 0 1 25.6 18Z" />
      </svg>
    ),
  },
  {
    name: "Microsoft",
    mark: <img src="/assets/providers/brand_microsoft-color.svg" alt="" />,
  },
  {
    name: "Apple",
    mark: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.2-1.7-3-1.9-3.6-2-1.5-.2-3 .9-3.8.9s-2-.9-3.3-.9c-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.3.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.8-1.1-2.8-4.3ZM13.9 5.2c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5Z" />
      </svg>
    ),
  },
];

export function TrustedBy({ className = "" }: { className?: string }) {
  return (
    <section className={`tb ${className}`} aria-label="Trusted and used by">
      <p className="tb-label">Trusted and used by</p>
      <ul>
        {COMPANIES.map((c) => (
          <li
            key={c.name}
            className={`tb-${c.name.toLowerCase()}`}
            aria-label={c.name}
          >
            <span className="tb-mark">{c.mark}</span>
            {!c.wordmark && <span className="tb-name">{c.name}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
