// The Backboard Studio lightning mark. Fills with the surrounding text colour.
// (The surfing penguin, /logo.svg, belongs to Backboard Desktop only.)
export function StudioMark({ className = "", size = 28 }: { className?: string; size?: number }) {
  return (
    <svg className={className} viewBox="0 0 164.5 221.19" width={(size * 164.5) / 221.19} height={size} fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M77.21,0h10.1c1.32,0,2.4,1.07,2.4,2.4v216.39c0,1.32-1.07,2.4-2.4,2.4h-10.1c-1.32,0-2.4-1.07-2.4-2.4V2.4c0-1.32,1.07-2.4,2.4-2.4Z"
      />
      <rect x="49.87" y="30.34" width="14.89" height="80.25" rx="2.4" />
      <rect y="90.8" width="14.88" height="19.8" rx="2.4" />
      <rect x="99.74" y="110.59" width="14.89" height="80.25" rx="2.4" />
      <rect x="149.61" y="110.59" width="14.89" height="19.8" rx="2.4" />
      <rect x="124.68" y="110.59" width="14.89" height="50.06" rx="2.4" />
      <rect x="24.94" y="60.53" width="14.89" height="50.06" rx="2.4" />
    </svg>
  );
}
