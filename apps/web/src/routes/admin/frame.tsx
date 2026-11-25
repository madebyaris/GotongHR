import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

const linkClass =
  "inline-flex min-h-11 items-center text-base font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function AdminFrame({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const width = wide ? "max-w-5xl" : "max-w-xl";
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border">
        <div
          className={`mx-auto flex w-full ${width} flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2`}
        >
          <p className="text-sm font-medium text-muted-foreground">GotongHR</p>
          <nav aria-label="Admin" className="flex flex-wrap justify-end gap-x-4">
            <Link to="/admin" className={linkClass} activeOptions={{ exact: true }}>
              Company
            </Link>
            <Link to="/admin/employees" className={linkClass}>
              Employees
            </Link>
            <Link to="/admin/anomalies" className={linkClass}>
              Anomalies
            </Link>
            <Link to="/admin/assistant" className={linkClass}>
              Assistant
            </Link>
          </nav>
        </div>
      </header>
      {children}
    </div>
  );
}
