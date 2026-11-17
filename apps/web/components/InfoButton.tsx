"use client";

/**
 * Plain (i) glyph that opens the assumptions modal -- deliberately NOT
 * styled as a boxed button (no border/background like .icon-button), it's
 * meant to read as inline punctuation next to a name, not a toolbar action.
 */
export default function InfoButton({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`info-button${className ? ` ${className}` : ""}`}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="5" r="0.75" fill="currentColor" />
        <path d="M8 7.5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </button>
  );
}
