"use client";

export type Tab = "overview" | "new" | "runs" | "compare";

const ITEMS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "new", label: "New Run" },
  { id: "runs", label: "Runs" },
  { id: "compare", label: "Compare" },
];

function TabIcon({ id }: { id: Tab }) {
  if (id === "overview") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M2.5 12.5V3M2.5 12.5h11M5 10l2.2-3 2 2L13 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
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

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/";
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
      <div className="sidebar-footer">
        <a href="/" className="sidebar-footer-link">
          View public site
        </a>
        <button type="button" className="sidebar-footer-link" onClick={logout}>
          Log out
        </button>
      </div>
    </nav>
  );
}
