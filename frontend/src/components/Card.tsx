"use client";

import { ReactNode } from "react";

export default function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`bg-panel border border-line rounded-lg p-4 ${className}`}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[13px] uppercase tracking-wider text-dim mb-3 font-medium">
      {children}
    </h2>
  );
}
