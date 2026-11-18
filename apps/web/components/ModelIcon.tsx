// One simple, distinct glyph per model -- purely decorative wayfinding on
// a model card, not derived from any real model property. Falls back to a
// plain circle for any model not listed here, so adding a new model to
// lib/models.ts without updating this never breaks rendering.
//
// Extracted out of components/NewRunPanel.tsx (where this originated) so
// app/page.tsx's homepage model cards can use the exact same icons
// instead of duplicating/reinventing a second set.
export default function ModelIcon({ model }: { model: string }) {
  const common = { viewBox: "0 0 16 16", "aria-hidden": true as const };
  switch (model) {
    case "hector": // bolt -- fastest model in this project
      return (
        <svg {...common}>
          <path d="M8.5 1.5 3 9h3.3L6 14.5 13 6.5H9.3L8.5 1.5z" fill="currentColor" />
        </svg>
      );
    case "fair": // balance/scale
      return (
        <svg {...common}>
          <path
            d="M8 1.5v13M3 4.5h10M3 4.5 1.5 8.5a1.75 1.75 0 0 0 3 0L3 4.5zM13 4.5l-1.5 4a1.75 1.75 0 0 0 3 0L13 4.5zM5.5 14.5h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "oscar": // orbit/atom -- Monte Carlo ensemble
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <ellipse cx="8" cy="8" rx="6.2" ry="2.6" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <ellipse
            cx="8"
            cy="8"
            rx="6.2"
            ry="2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            transform="rotate(60 8 8)"
          />
          <ellipse
            cx="8"
            cy="8"
            rx="6.2"
            ry="2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
            transform="rotate(120 8 8)"
          />
        </svg>
      );
    case "dice": // literal die
      return (
        <svg {...common}>
          <rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="5.5" cy="5.5" r="1" fill="currentColor" />
          <circle cx="10.5" cy="5.5" r="1" fill="currentColor" />
          <circle cx="8" cy="8" r="1" fill="currentColor" />
          <circle cx="5.5" cy="10.5" r="1" fill="currentColor" />
          <circle cx="10.5" cy="10.5" r="1" fill="currentColor" />
        </svg>
      );
    case "magicc": // sparkle
      return (
        <svg {...common}>
          <path
            d="M8 1.5l1.1 3.4L12.5 6l-3.4 1.1L8 10.5l-1.1-3.4L3.5 6l3.4-1.1L8 1.5zM13 9.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z"
            fill="currentColor"
          />
        </svg>
      );
    case "twolayer": // two stacked layers -- surface + deep ocean
      return (
        <svg {...common}>
          <path
            d="M8 2 1.5 5.5 8 9l6.5-3.5L8 2z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M1.5 9.5 8 13l6.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "gcam": // globe -- multi-region, multi-sector integrated model
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <ellipse cx="8" cy="8" rx="2.6" ry="6" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <path d="M2 8h12M2.9 5.2h10.2M2.9 10.8h10.2" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
  }
}
