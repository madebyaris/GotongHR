import {
  employmentStatuses,
  parseEmployeeCreate,
  ptkpStatuses,
  type EmployeeRecord,
  type FieldIssue,
  type MeContext,
} from "@gotonghr/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, apiData } from "@/lib/api";
import { fieldClass, SetupColumn, SetupHeader, TextField } from "../shell";
import { AdminFrame } from "./frame";

const taxMethods = [
  { value: "gross", label: "Gross" },
  { value: "nett", label: "Nett" },
  { value: "gross_up", label: "Gross up" },
] as const;

const subjects = [
  { value: "permanent", label: "Permanent" },
  { value: "non_permanent", label: "Non-permanent" },
  { value: "expat", label: "Expat" },
] as const;

const fieldOrder = [
  "fullName",
  "employeeCode",
  "legalEntityId",
  "branchId",
  "nik",
  "npwp",
  "joinDate",
  "employmentStatus",
  "ptkpStatus",
  "taxMethod",
  "pph21SubjectType",
];

export default function EmployeesPage() {
  return (
    <AdminFrame>
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
      <SetupColumn>
        <SetupHeader title="Employees" detail={null} />
        <p className="mt-4 text-base text-muted-foreground">Loading employees…</p>
      </SetupColumn>
    );
  }

  if (!context.data) {
    return (
      <SetupColumn>
        <SetupHeader title="Employees" detail={null} />
        <p className="mt-4 text-base" role="alert">
          Employees could not be loaded.
        </p>
        <Button className="mt-6 min-h-11" type="button" onClick={() => void context.refetch()}>
          Try again
        </Button>
      </SetupColumn>
    );
  }

  return <EmployeeDirectory context={context.data} />;
}

function EmployeeDirectory({ context }: { context: MeContext }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const employees = useQuery({
    queryKey: ["employees"],
    queryFn: () => apiData<EmployeeRecord[]>("/api/v1/employees"),
    retry: false,
  });
  const canWrite = context.permissions.includes("employee.write");
  const entity = context.legalEntities[0] ?? null;
  const [fullName, setFullName] = useState("");
  const [employeeCode, setEmployeeCode] = useState("");
  const [legalEntityId, setLegalEntityId] = useState(entity?.id ?? "");
  const [branchId, setBranchId] = useState(branchFor(context, entity?.id ?? ""));
  const [nik, setNik] = useState("");
  const [npwp, setNpwp] = useState("");
  const [joinDate, setJoinDate] = useState(todayJakarta);
  const [employmentStatus, setEmploymentStatus] = useState("active");
  const [ptkpStatus, setPtkpStatus] = useState("TK/0");
  const [taxMethod, setTaxMethod] = useState("gross");
  const [pph21SubjectType, setPph21SubjectType] = useState("permanent");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [revealFor, setRevealFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; nik: string } | null>(null);
  const branches = context.branches.filter((item) => item.legalEntityId === legalEntityId);
  const rows = employees.data ?? [];

  useEffect(() => {
    if (employees.error instanceof ApiRequestError && employees.error.status === 401) {
      void navigate({ to: "/sign-in" });
    }
  }, [employees.error, navigate]);

  function onEntity(next: string) {
    setLegalEntityId(next);
    setBranchId(branchFor(context, next));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    const parsed = parseEmployeeCreate({
      fullName,
      employeeCode,
      legalEntityId,
      branchId,
      employmentStatus,
      joinDate,
      ptkpStatus,
      taxMethod,
      pph21SubjectType,
      nik,
      npwp,
    });
    if (!parsed.ok) {
      const nextErrors = fieldMap(parsed.fields);
      setErrors(nextErrors);
      setFormError("Check the highlighted fields.");
      focusFirst(nextErrors);
      return;
    }
    setPending(true);
    setFormError(null);
    setErrors({});
    try {
      const saved = await apiData<EmployeeRecord>("/api/v1/employees", {
        method: "POST",
        body: JSON.stringify(parsed.value),
      });
      setStatus(`Saved. ${saved.fullName}.`);
      setFullName("");
      setEmployeeCode("");
      setNik("");
      setNpwp("");
      setRevealed(null);
      await queryClient.invalidateQueries({ queryKey: ["employees"] });
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        if (caught.status === 401) {
          void navigate({ to: "/sign-in" });
          return;
        }
        const nextErrors = fieldMap(caught.fields);
        setErrors(nextErrors);
        setFormError(caught.fields.length > 0 ? "Check the highlighted fields." : caught.message);
        focusFirst(nextErrors);
      } else {
        setFormError("The employee could not be saved.");
      }
    } finally {
      setPending(false);
    }
  }

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
    <SetupColumn>
      <SetupHeader title="Employees" detail={null} />
      <p className="mt-2 text-base">
        <Link className="font-medium underline" to="/admin">
          Company setup
        </Link>
      </p>
      <p className="mt-4 text-base" role="status">
        {status ?? (rows.length === 0 ? "No employees yet." : employeeCount(rows.length))}
      </p>
      {employees.isPending ? <p className="mt-4 text-base text-muted-foreground">Loading employees…</p> : null}
      {employees.error ? (
        <p className="mt-4 text-base" role="alert">
          The employee list could not be loaded.
        </p>
      ) : null}
      {!employees.error && rows.length > 0 ? (
        <table className="mt-6 w-full text-base">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 font-medium">NIK</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border align-top">
                <td className="py-3 pr-3">
                  <span className="block font-medium">{row.fullName}</span>
                  <span className="block text-sm text-muted-foreground">{row.employeeCode}</span>
                  <button
                    className="mt-2 min-h-11 underline"
                    type="button"
                    onClick={() => {
                      setRevealFor(row.id);
                      setRevealed(null);
                      setRevealError(null);
                    }}
                  >
                    Reveal NIK
                  </button>
                </td>
                <td className="py-3">
                  <span className="block font-mono">{row.nikMask}</span>
                  {row.npwpMask ? (
                    <span className="mt-1 block text-sm text-muted-foreground">{row.npwpMask}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {revealFor ? (
        <form className="mt-4" noValidate onSubmit={(event) => void onReveal(event)}>
          <TextField
            id="reason"
            label="Reason"
            value={reason}
            onChange={setReason}
            error={null}
            readOnly={false}
            inputMode="text"
            autoComplete="off"
          />
          {revealError ? (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {revealError}
            </p>
          ) : null}
          <Button className="mt-4 min-h-11" type="submit">
            Show NIK
          </Button>
        </form>
      ) : null}
      {revealed ? (
        <p className="mt-4 text-base" role="status">
          NIK {revealed.nik}
        </p>
      ) : null}
      {!entity ? (
        <p className="mt-8 text-base">
          Set up the company before adding an employee.{" "}
          <Link className="font-medium underline" to="/admin">
            Company setup
          </Link>
        </p>
      ) : null}
      {entity && canWrite ? (
        <form className="mt-8 border-t border-border pt-8" noValidate onSubmit={(event) => void onSubmit(event)}>
          <h2 className="text-lg font-semibold">Add employee</h2>
          {formError ? (
            <p className="mt-4 text-base text-destructive" role="alert">
              {formError}
            </p>
          ) : null}
          <TextField
            id="fullName"
            label="Full name"
            value={fullName}
            onChange={setFullName}
            error={errors.fullName ?? null}
            readOnly={pending}
            inputMode="text"
            autoComplete="name"
          />
          <TextField
            id="employeeCode"
            label="Employee code"
            value={employeeCode}
            onChange={setEmployeeCode}
            error={errors.employeeCode ?? null}
            readOnly={pending}
            inputMode="text"
            autoComplete="off"
          />
          <SelectField
            id="legalEntityId"
            label="Legal entity"
            value={legalEntityId}
            error={errors.legalEntityId ?? null}
            disabled={pending}
            onChange={onEntity}
            options={context.legalEntities.map((item) => ({ value: item.id, label: item.companyName }))}
          />
          <SelectField
            id="branchId"
            label="Branch"
            value={branchId}
            error={errors.branchId ?? null}
            disabled={pending}
            onChange={setBranchId}
            options={branches.map((item) => ({ value: item.id, label: item.name }))}
          />
          <TextField
            id="nik"
            label="NIK"
            value={nik}
            onChange={setNik}
            error={errors.nik ?? null}
            readOnly={pending}
            inputMode="numeric"
            autoComplete="off"
          />
          <TextField
            id="npwp"
            label="NPWP (optional)"
            value={npwp}
            onChange={setNpwp}
            error={errors.npwp ?? null}
            readOnly={pending}
            inputMode="numeric"
            autoComplete="off"
          />
          <TextField
            id="joinDate"
            label="Join date"
            value={joinDate}
            onChange={setJoinDate}
            error={errors.joinDate ?? null}
            readOnly={pending}
            inputMode="text"
            autoComplete="off"
            type="date"
          />
          <SelectField
            id="employmentStatus"
            label="Status"
            value={employmentStatus}
            error={errors.employmentStatus ?? null}
            disabled={pending}
            onChange={setEmploymentStatus}
            options={employmentStatuses.map((value) => ({ value, label: value }))}
          />
          <SelectField
            id="ptkpStatus"
            label="PTKP"
            value={ptkpStatus}
            error={errors.ptkpStatus ?? null}
            disabled={pending}
            onChange={setPtkpStatus}
            options={ptkpStatuses.map((value) => ({ value, label: value }))}
          />
          <SelectField
            id="taxMethod"
            label="Tax method"
            value={taxMethod}
            error={errors.taxMethod ?? null}
            disabled={pending}
            onChange={setTaxMethod}
            options={taxMethods.map((item) => ({ value: item.value, label: item.label }))}
          />
          <SelectField
            id="pph21SubjectType"
            label="PPh 21 subject"
            value={pph21SubjectType}
            error={errors.pph21SubjectType ?? null}
            disabled={pending}
            onChange={setPph21SubjectType}
            options={subjects.map((item) => ({ value: item.value, label: item.label }))}
          />
          <Button className="mt-8 min-h-11 w-full text-base" type="submit" disabled={pending} aria-busy={pending}>
            {pending ? "Saving…" : "Add employee"}
          </Button>
        </form>
      ) : null}
      {entity && !canWrite ? <p className="mt-8 text-base">An owner or HR admin can add an employee.</p> : null}
    </SetupColumn>
  );
}

function SelectField({
  id,
  label,
  value,
  error,
  disabled,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="mt-4">
      <label className="block text-base font-medium" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        name={id}
        className={fieldClass}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p className="mt-1 text-sm text-destructive" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function employeeCount(count: number): string {
  return count === 1 ? "1 employee." : `${count} employees.`;
}

function branchFor(context: MeContext, legalEntityId: string): string {
  return context.branches.find((item) => item.legalEntityId === legalEntityId)?.id ?? "";
}

function todayJakarta(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function fieldMap(fields: FieldIssue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const field of fields) {
    if (field.field === "body") continue;
    map[field.field] = field.message;
  }
  return map;
}

function focusFirst(errors: Record<string, string>): void {
  const id = fieldOrder.find((key) => errors[key]);
  if (!id) return;
  document.getElementById(id)?.focus();
}
