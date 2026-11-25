import {
  employmentStatuses,
  parseEmployeeCreate,
  ptkpStatuses,
  type EmployeeRecord,
  type FieldIssue,
  type MeContext,
} from "@gotonghr/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, apiData } from "@/lib/api";
import { TextField } from "../shell";
import { SelectField, todayJakarta } from "./employee-fields";

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

export function EmployeeForm({
  context,
  onSaved,
}: {
  context: MeContext;
  onSaved: (saved: EmployeeRecord) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
  const branches = context.branches.filter((item) => item.legalEntityId === legalEntityId);

  function onEntity(next: string) {
    setLegalEntityId(next);
    setBranchId(branchFor(context, next));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      setFullName("");
      setEmployeeCode("");
      setNik("");
      setNpwp("");
      await queryClient.invalidateQueries({ queryKey: ["employees"] });
      onSaved(saved);
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

  return (
    <form className="mt-8 max-w-xl border-t border-border pt-8" noValidate onSubmit={(event) => void onSubmit(event)}>
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
  );
}

function branchFor(context: MeContext, legalEntityId: string): string {
  return context.branches.find((item) => item.legalEntityId === legalEntityId)?.id ?? "";
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
