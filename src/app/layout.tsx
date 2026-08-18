import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Memento — AI operations with organizational memory",
    template: "%s · Memento",
  },
  description:
    "An autonomous AI operations agent that remembers what happened, learns from organizational history, and uses persistent memory in CockroachDB to make better decisions over time.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="flex min-h-screen">
          <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 border-r border-line bg-canvas lg:block">
            <Sidebar />
          </aside>

          {/* Below `lg` the nav collapses to a horizontal strip rather than a
              drawer — this is an operator dashboard, not a mobile app, and a
              scrollable strip beats a hamburger nobody opens. */}
          <div className="min-w-0 flex-1">
            <div className="sticky top-0 z-20 overflow-x-auto border-b border-line bg-canvas lg:hidden">
              <Sidebar variant="strip" />
            </div>

            <main className="mx-auto w-full max-w-6xl px-6 py-8 lg:px-10 lg:py-10">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
