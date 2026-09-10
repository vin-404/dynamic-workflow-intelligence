"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LandingPage } from "@/components/LandingPage";

export default function Home() {
  const router = useRouter();
  const [darkMode, setDarkMode] = useState(false);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("flowtrace-theme");
    const next = savedTheme === "dark";
    setDarkMode(next);
    document.documentElement.style.colorScheme = next ? "dark" : "light";
    document.documentElement.classList.toggle("dark", next);
    document.documentElement.classList.toggle("flowtrace-dark", next);
  }, []);

  useEffect(() => {
    const handleThemeToggle = (event: Event) => {
      const next = Boolean((event as CustomEvent<boolean>).detail);
      setDarkMode(next);
      document.documentElement.style.colorScheme = next ? "dark" : "light";
      document.documentElement.classList.toggle("dark", next);
      document.documentElement.classList.toggle("flowtrace-dark", next);
      window.localStorage.setItem("flowtrace-theme", next ? "dark" : "light");
    };

    window.addEventListener("flowtrace-theme-toggle", handleThemeToggle);
    return () => window.removeEventListener("flowtrace-theme-toggle", handleThemeToggle);
  }, []);

  return (
    <main className={darkMode ? "flowtrace-site min-h-screen bg-[#0B0E1B] text-white" : "flowtrace-site min-h-screen bg-[#F7F7FC] text-[#17172A]"}>
      <LandingPage
        darkMode={darkMode}
        onOpenWorkspace={() => router.push("/workspace")}
        onHowItWorks={() => document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })}
        onQuestion={(stage) => {
          const route = stage === "analyze" ? "bottlenecks" : stage;
          router.push(`/workspace/demo-product-launch/${route}`);
        }}
      />
    </main>
  );
}
