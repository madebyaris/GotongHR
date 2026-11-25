import type { ReactNode } from "react";

export const fieldClass =
  "mt-1 box-border h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base text-foreground outline-none read-only:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:bg-muted";

export function SetupColumn({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col px-4 py-8 sm:py-12">
      {children}
    </main>
  );
}

export function SetupHeader({ title, detail }: { title: string; detail: string | null }) {
  return (
    <header>
      <p className="text-sm font-medium text-muted-foreground">GotongHR</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
      {detail ? <p className="mt-1 text-base text-muted-foreground">{detail}</p> : null}
    </header>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  readOnly,
  inputMode,
  autoComplete,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  readOnly: boolean;
  inputMode: "text" | "numeric" | "decimal";
  autoComplete: string;
  type?: "text" | "email";
}) {
  return (
    <div className="mt-4">
      <label className="block text-base font-medium" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        className={fieldClass}
        value={value}
        readOnly={readOnly}
        inputMode={inputMode}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p className="mt-1 text-sm text-destructive" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
