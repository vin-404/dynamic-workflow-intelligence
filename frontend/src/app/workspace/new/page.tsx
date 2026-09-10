"use client";

import { useRouter } from "next/navigation";
import { Project } from "@/lib/api";
import { ProjectCreate } from "@/components/SetupPanel";

export default function NewWorkflowPage() {
  const router = useRouter();

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
          <div className="text-xs uppercase tracking-[0.2em] text-[#4164FA] font-semibold">New workflow</div>
          <h1 className="text-5xl font-semibold tracking-[-0.05em] mt-3">Create a workflow.</h1>
          <p className="text-[#68677A] mt-4 max-w-2xl leading-7">
            Describe the outcome first. FlowTrace will use the kind of work for suggestions and vocabulary, while the analysis engine focuses on the workflow itself.
          </p>
        </div>

        <ProjectCreate
          onCreated={(project: Project) => {
            router.push(`/workspace/${project.id}/build`);
          }}
          onCancel={() => router.push("/workspace")}
        />
      </div>
    </main>
  );
}
