"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { listProjects } from "@/lib/api";
import ImportPanel from "@/components/ImportPanel";

export default function ImportWorkflowPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <main className="min-h-screen bg-[#F7F7FC] text-[#17172A] px-6 md:px-10 py-12">
      <div className="max-w-[1100px] mx-auto">
        <button
          onClick={() => router.push("/workspace")}
          className="text-sm font-semibold text-[#68677A] hover:text-[#17172A] transition-colors mb-8"
        >
          ← Back to workflows
        </button>

        <div className="mb-8">
          <div className="text-xs uppercase tracking-[0.2em] text-[#4164FA] font-semibold">Import</div>
          <h1 className="text-5xl font-semibold tracking-[-0.05em] mt-3">Import from Jira.</h1>
          <p className="text-[#68677A] mt-4 max-w-2xl leading-7">
            Bring an existing project into FlowTrace, then review its workflow before running intelligence on it.
          </p>
        </div>

        <div className={busy ? "opacity-70 pointer-events-none" : ""}>
          <ImportPanel
            onImported={async (projectId) => {
              setBusy(true);
              try {
                const projects = await listProjects();
                const project = projects.find((item) => item.id === projectId);
                if (project) {
                  router.push(`/workspace/${project.id}/build`);
                  return;
                }
                router.push("/workspace");
              } finally {
                setBusy(false);
              }
            }}
          />
        </div>
      </div>
    </main>
  );
}
