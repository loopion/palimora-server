export default function Mark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label="Palimora"
      className={className}
    >
      {/* folio, folded corner */}
      <path
        d="M8 4h24l8 8v32a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
        fill="var(--color-paper-2)"
        stroke="var(--color-ink)"
        strokeWidth="1.5"
      />
      <path d="M32 4v8h8" fill="none" stroke="var(--color-ink)" strokeWidth="1.5" strokeLinejoin="round" />
      {/* older line, faint, offset — showing through */}
      <line x1="12" y1="24" x2="34" y2="24" stroke="var(--color-ink)" strokeWidth="2" strokeLinecap="round" opacity="0.28" />
      {/* newer line, solid, accent */}
      <line x1="12" y1="30" x2="30" y2="30" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}
