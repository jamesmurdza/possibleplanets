"use client";

import { useState } from "react";
import Sidebar, { Tab } from "../../components/Sidebar";
import OverviewPanel from "../../components/OverviewPanel";
import NewRunPanel from "../../components/NewRunPanel";
import RunsPanel from "../../components/RunsPanel";
import ComparePanel from "../../components/ComparePanel";

// A single-page app: switching tabs is plain React state, never a
// navigation/page load -- each panel mounts once and keeps its own state
// (e.g. a run still in flight in "New Run" keeps polling even while you're
// looking at "Runs" or "Compare") rather than being torn down and rebuilt.
//
// Lives at /dashboard (not /) now -- see proxy.ts, which gates everything
// under /dashboard behind a login. The public site took over / (see
// app/page.tsx) and has no sidebar at all.
export default function DashboardPage() {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="app-shell">
      <Sidebar active={tab} onChange={setTab} />
      <main className="main-area">
        <div style={{ display: tab === "overview" ? "block" : "none" }}>
          <OverviewPanel />
        </div>
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
