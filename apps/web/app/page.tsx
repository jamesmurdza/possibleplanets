"use client";

import { useState } from "react";
import Sidebar, { Tab } from "../components/Sidebar";
import NewRunPanel from "../components/NewRunPanel";
import RunsPanel from "../components/RunsPanel";
import ComparePanel from "../components/ComparePanel";

// A single-page app: switching tabs is plain React state, never a
// navigation/page load -- each panel mounts once and keeps its own state
// (e.g. a run still in flight in "New Run" keeps polling even while you're
// looking at "Runs" or "Compare") rather than being torn down and rebuilt.
export default function Page() {
  const [tab, setTab] = useState<Tab>("new");

  return (
    <div className="app-shell">
      <Sidebar active={tab} onChange={setTab} />
      <main className="main-area">
        <div style={{ display: tab === "new" ? "block" : "none" }}>
          <NewRunPanel />
        </div>
        <div style={{ display: tab === "runs" ? "block" : "none" }}>
          <RunsPanel />
        </div>
        <div style={{ display: tab === "compare" ? "block" : "none" }}>
          <ComparePanel />
        </div>
      </main>
    </div>
  );
}
