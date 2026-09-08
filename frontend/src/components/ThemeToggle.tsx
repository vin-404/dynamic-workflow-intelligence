"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("flowtrace-theme");
    const isDark = saved === "dark";
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.classList.toggle("light", !isDark);
    document.documentElement.classList.toggle("flowtrace-dark", isDark);
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("light", !next);
    document.documentElement.classList.toggle("flowtrace-dark", next);
    document.documentElement.style.colorScheme = next ? "dark" : "light";
    window.localStorage.setItem("flowtrace-theme", next ? "dark" : "light");
    window.dispatchEvent(new CustomEvent("flowtrace-theme-toggle", { detail: next }));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to day mode" : "Switch to night mode"}
      title={dark ? "Switch to day mode" : "Switch to night mode"}
      className="group flex h-10 w-10 items-center justify-center rounded-xl border border-[#D9DCE7] bg-white text-[#536174] shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#4164FA]/40 hover:text-[#4164FA] hover:shadow-md dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
    >
      {dark ? <Sun className="size-4 transition-transform group-hover:rotate-12" /> : <Moon className="size-4 transition-transform group-hover:-rotate-12" />}
    </button>
  );
}
