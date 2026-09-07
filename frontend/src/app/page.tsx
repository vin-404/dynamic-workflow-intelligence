"use client";

import { useEffect, useState } from "react";
import { getProjectState, ProjectState } from "@/lib/api";
import Header from "@/components/Header";
import TabNav from "@/components/TabNav";
import DashboardView from "@/components/DashboardView";
import BottleneckInbox from "@/components/BottleneckInbox";
import DependencyGraph from "@/components/DependencyGraph";
import SimulationPanel from "@/components/SimulationPanel";
import TasksView from "@/components/TasksView";
import WhyLateView from "@/components/WhyLateView";
import DemoWalkthrough from "@/components/DemoWalkthrough";

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "why-late", label: "Why Are We Late?" },
  { id: "bottlenecks", label: "Bottleneck Inbox" },
  { id: "simulate", label: "Change Simulator" },
  { id: "graph", label: "Dependency Graph" },
  { id: "tasks", label: "Tasks" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Home() {
  const [state, setState] = useState<ProjectState | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoVisible, setDemoVisible] = useState(false);

  useEffect(() => {
    loadState();
  }, []);

  async function loadState() {
    try {
      setLoading(true);
      const data = await getProjectState();
      setState(data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load project data"
      );
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-dim text-sm">Loading project intelligence...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-panel border border-line rounded-lg p-8 max-w-md text-center">
          <div className="text-red text-4xl mb-4">!</div>
          <h2 className="text-lg font-semibold mb-2">Connection Error</h2>
          <p className="text-dim text-sm mb-4">{error}</p>
          <p className="text-dim text-xs mb-4">
            Make sure the API server is running on port 8001
          </p>
          <button
            onClick={loadState}
            className="px-4 py-2 bg-accent text-background rounded-md text-sm font-medium hover:opacity-90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!state) return null;

  return (
    <div className="flex flex-col min-h-screen">
      <Header state={state} />
      <TabNav
        tabs={TABS as unknown as { id: string; label: string }[]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as TabId)}
      />
      <main className="flex-1 max-w-[1600px] w-full mx-auto p-5">
        {activeTab === "dashboard" && (
          <DashboardView
            state={state}
            onNavigate={(tab) => setActiveTab(tab as TabId)}
          />
        )}
        {activeTab === "why-late" && <WhyLateView state={state} />}
        {activeTab === "bottlenecks" && <BottleneckInbox state={state} />}
        {activeTab === "simulate" && <SimulationPanel state={state} />}
        {activeTab === "graph" && <DependencyGraph state={state} />}
        {activeTab === "tasks" && <TasksView state={state} />}
      </main>
      <DemoWalkthrough
        currentTab={activeTab}
        onNavigate={(tab) => setActiveTab(tab as TabId)}
        visible={demoVisible}
        onToggle={() => setDemoVisible(!demoVisible)}
      />
    </div>
  );
}
