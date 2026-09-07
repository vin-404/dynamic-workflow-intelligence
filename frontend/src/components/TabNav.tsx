"use client";

interface Tab {
  id: string;
  label: string;
}

export default function TabNav({
  tabs,
  active,
  onChange,
}: {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <nav className="flex gap-0.5 px-6 border-b border-line bg-panel overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-4 py-3 text-[13px] border-b-2 whitespace-nowrap transition-colors ${
            active === tab.id
              ? "text-foreground border-accent"
              : "text-dim border-transparent hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
