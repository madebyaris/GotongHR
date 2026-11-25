import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

const linkClass =
  "inline-flex min-h-11 items-center text-base font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function AdminFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3 px-4 py-2">
          <p className="text-sm font-medium text-muted-foreground">GotongHR</p>
          <nav aria-label="Admin" className="flex gap-4">
            <Link to="/admin" className={linkClass} activeOptions={{ exact: true }}>
              Company
            </Link>
            <Link to="/admin/employees" className={linkClass}>
              Employees
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
