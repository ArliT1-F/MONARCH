export function MonarchMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={className} aria-hidden>
      <rect x="2" y="2" width="44" height="44" rx="12" fill="url(#mg)" />
      {/* stylized crown */}
      <path
        d="M12 32 L12 19 L18.5 25 L24 15.5 L29.5 25 L36 19 L36 32 Z"
        fill="#fff"
        fillOpacity="0.95"
      />
      <defs>
        <linearGradient id="mg" x1="0" y1="0" x2="48" y2="48">
          <stop stopColor="#7c5cff" />
          <stop offset="1" stopColor="#4b32c3" />
        </linearGradient>
      </defs>
    </svg>
  );
}
