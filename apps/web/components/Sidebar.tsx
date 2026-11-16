"use client";

export type Tab = "new" | "runs" | "compare";

const ITEMS: { id: Tab; label: string }[] = [
  { id: "new", label: "New Run" },
  { id: "runs", label: "Runs" },
  { id: "compare", label: "Compare" },
];

function TabIcon({ id }: { id: Tab }) {
  if (id === "new") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2.5v11M2.5 8h11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (id === "runs") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M2.5 4h11M2.5 8h11M2.5 12h7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 2.5v9M4 11.5l-2-2M4 11.5l2-2M12 13.5v-9M12 4.5l-2 2M12 4.5l2 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Sidebar({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-title">Simple Climate Models</div>
      </div>
      <ul className="sidebar-nav">
        {ITEMS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`sidebar-nav-item${active === item.id ? " active" : ""}`}
              aria-current={active === item.id}
              onClick={() => onChange(item.id)}
            >
              <TabIcon id={item.id} />
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
