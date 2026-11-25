import {
  employmentStatuses,
  type DepartmentRecord,
  type EmployeeRecord,
  type MeContext,
} from "@gotonghr/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiRequestError, apiData } from "@/lib/api";
import { fieldClass } from "../shell";
import { AdminFrame } from "./frame";
import { EmployeeForm } from "./employee-form";
import { todayJakarta } from "./employee-fields";
import { contractEndLabel, filterDirectoryRows } from "./directory-view";
import { EmployeeProfile } from "./employee-profile";

const statusLabels: Record<string, string> = {
  active: "Active",
  probation: "Probation",
  resigned: "Resigned",
  terminated: "Terminated",
};

const contractFilters = [
  { value: "", label: "All contracts" },
  { value: "ending", label: "Ending within 90 days" },
  { value: "PKWT", label: "PKWT" },
  { value: "PKWTT", label: "PKWTT" },
];

export default function EmployeesPage() {
  return (
    <AdminFrame wide>
      <EmployeesBody />
    </AdminFrame>
  );
}

function EmployeesBody() {
  const navigate = useNavigate();
  const context = useQuery({
    queryKey: ["me", "context"],
    queryFn: () => apiData<MeContext>("/api/v1/me/context"),
    retry: false,
  });

  useEffect(() => {
    if (context.error instanceof ApiRequestError && context.error.status === 401) {
      void navigate({ to: "/sign-in" });
    }
  }, [context.error, navigate]);

  if (context.isPending) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
        <p className="mt-4 text-base text-muted-foreground">Loading employees…</p>
      </main>
    );
  }

  if (!context.data) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
        <p className="mt-4 text-base" role="alert">
          Employees could not be loaded.
        </p>
        <Button className="mt-6 min-h-11" type="button" onClick={() => void context.refetch()}>
          Try again
        </Button>
      </main>
    );
  }

  return <EmployeeDirectory context={context.data} />;
}

function EmployeeDirectory({ context }: { context: MeContext }) {
  const navigate = useNavigate();
  const today = todayJakarta();
  const employees = useQuery({
    queryKey: ["employees"],
    queryFn: () => apiData<EmployeeRecord[]>("/api/v1/employees?limit=100"),
    retry: false,
  });
  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: () => apiData<DepartmentRecord[]>("/api/v1/departments"),
    retry: false,
  });
  const canWrite = context.permissions.includes("employee.write");
  const entity = context.legalEntities[0] ?? null;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [contract, setContract] = useState<"" | "ending" | "PKWT" | "PKWTT">("");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealFor, setRevealFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; nik: string } | null>(null);
  const rows = employees.data ?? [];
  const visible = filterDirectoryRows(
    rows,
    { query, status, departmentId, contract },
    today,
  );
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  useEffect(() => {
    if (employees.error instanceof ApiRequestError && employees.error.status === 401) {
      void navigate({ to: "/sign-in" });
    }
  }, [employees.error, navigate]);

  async function onReveal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!revealFor) return;
    setRevealError(null);
    setRevealed(null);
    try {
      const result = await apiData<{ employeeId: string; values: { nik?: string } }>(
        `/api/v1/employees/${revealFor}/pii/reveal`,
        {
          method: "POST",
          body: JSON.stringify({ reason, fields: ["nik"] }),
        },
      );
      const value = result.values.nik;
      if (!value) {
        setRevealError("NIK could not be shown.");
        return;
      }
      setRevealed({ id: result.employeeId, nik: value });
      setReason("");
    } catch (caught) {
      setRevealError(caught instanceof ApiRequestError ? caught.message : "NIK could not be shown.");
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl overflow-x-clip px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
      <p className="mt-4 text-base" role="status">
        {notice ?? (rows.length === 0 ? "No employees yet." : employeeCount(rows.length))}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FilterField id="directory-search" label="Name or code" value={query} onChange={setQuery} />
        <FilterSelect
          id="directory-status"
          label="Filter by status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: "All statuses" },
            ...employmentStatuses.map((value) => ({ value, label: statusLabels[value] ?? value })),
          ]}
        />
        <FilterSelect
          id="directory-department"
          label="Filter by department"
          value={departmentId}
          onChange={setDepartmentId}
          options={[
            { value: "", label: "All departments" },
            ...(departments.data ?? []).map((item) => ({ value: item.id, label: item.name })),
          ]}
        />
        <FilterSelect
          id="directory-contract"
          label="Contract"
          value={contract}
          onChange={(value) => {
            if (value === "" || value === "ending" || value === "PKWT" || value === "PKWTT") setContract(value);
          }}
          options={contractFilters}
        />
      </div>
      {employees.isPending ? <p className="mt-4 text-base text-muted-foreground">Loading employees…</p> : null}
      {employees.error ? (
        <p className="mt-4 text-base" role="alert">
          The employee list could not be loaded.
        </p>
      ) : (
        <DirectoryTable
          rows={visible}
          today={today}
          selectedId={selectedId}
          onOpen={(row) => {
            setSelectedId(row.id);
            setRevealFor(null);
            setRevealed(null);
            setRevealError(null);
          }}
          onReveal={(row) => {
            setSelectedId(row.id);
            setRevealFor(row.id);
            setRevealed(null);
            setRevealError(null);
          }}
        />
      )}
      {visible.length === 0 && rows.length > 0 ? (
        <p className="mt-4 text-base">No employees match this search.</p>
      ) : null}
      {selected ? (
        <EmployeeProfile
          key={selected.id}
          employee={selected}
          context={context}
          canWrite={canWrite}
          today={today}
          revealOpen={revealFor === selected.id}
          reason={reason}
          revealError={revealError}
          revealedNik={revealed?.id === selected.id ? revealed.nik : null}
          onReason={setReason}
          onStartReveal={() => {
            setRevealFor(selected.id);
            setRevealed(null);
            setRevealError(null);
          }}
          onReveal={(event) => void onReveal(event)}
          onClose={() => {
            setSelectedId(null);
            setRevealFor(null);
          }}
        />
      ) : null}
      {!entity ? (
        <p className="mt-8 max-w-xl text-base">
          Set up the company before adding an employee.{" "}
          <Link className="font-medium underline" to="/admin">
            Company setup
          </Link>
        </p>
      ) : null}
      {entity && canWrite ? (
        <EmployeeForm
          context={context}
          onSaved={(saved) => {
            setNotice(`Saved. ${saved.fullName}.`);
            setRevealed(null);
          }}
        />
      ) : null}
      {entity && !canWrite ? <p className="mt-8 text-base">An owner or HR admin can add an employee.</p> : null}
    </main>
  );
}

function DirectoryTable({
  rows,
  today,
  selectedId,
  onOpen,
  onReveal,
}: {
  rows: EmployeeRecord[];
  today: string;
  selectedId: string | null;
  onOpen: (row: EmployeeRecord) => void;
  onReveal: (row: EmployeeRecord) => void;
}) {
  return (
    <Table className="mt-4 max-md:block">
      <TableHeader className="max-md:sr-only">
        <TableRow>
          <TableHead className="whitespace-normal" scope="col">Name</TableHead>
          <TableHead className="whitespace-normal" scope="col">Department</TableHead>
          <TableHead className="whitespace-normal" scope="col">Contract</TableHead>
          <TableHead className="whitespace-normal" scope="col">NIK</TableHead>
          <TableHead className="whitespace-normal" scope="col">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="max-md:block">
        {rows.map((row) => (
          <TableRow
            key={row.id}
            data-state={selectedId === row.id ? "selected" : undefined}
            className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:py-3"
          >
            <TableCell className="min-w-0 max-md:col-start-1 max-md:row-start-1 max-md:block">
              <button
                className="block max-w-full min-h-11 text-left font-medium underline [overflow-wrap:anywhere]"
                type="button"
                onClick={() => onOpen(row)}
              >
                {row.fullName}
              </button>
              <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">{row.employeeCode}</span>
              {selectedId !== row.id ? (
                <button className="mt-1 min-h-11 underline" type="button" onClick={() => onReveal(row)}>
                  Reveal NIK
                </button>
              ) : null}
            </TableCell>
            <TableCell className="min-w-0 max-md:col-span-2 max-md:row-start-2 max-md:block [overflow-wrap:anywhere]">
              <span className="block">{row.departmentName ?? "No department"}</span>
              <span className="block text-sm text-muted-foreground">{row.positionName ?? "No position"}</span>
            </TableCell>
            <TableCell className="min-w-0 max-md:col-span-2 max-md:row-start-3 max-md:block [overflow-wrap:anywhere]">
              {row.contractType ? (
                <>
                  <span className="block font-medium">{row.contractType}</span>
                  <span className="block text-sm">{contractEndLabel(row.contractEndDate, today)}</span>
                </>
              ) : (
                "No contract"
              )}
            </TableCell>
            <TableCell className="min-w-0 font-mono max-md:col-span-2 max-md:row-start-4 max-md:block [overflow-wrap:anywhere]">
              {row.nikMask}
            </TableCell>
            <TableCell className="max-md:col-start-2 max-md:row-start-1 max-md:block max-md:text-right">
              {statusLabels[row.employmentStatus] ?? row.employmentStatus}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function FilterField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={id}
        className={fieldClass}
        value={value}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="min-w-0">
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <select id={id} name={id} className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value || "all"} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function employeeCount(count: number): string {
  return count === 1 ? "1 employee." : `${count} employees.`;
}
