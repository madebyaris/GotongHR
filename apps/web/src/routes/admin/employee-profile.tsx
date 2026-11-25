import {
  contractEndLabel,
  formatDirectoryDate,
  parseCompensationCreate,
  parseContractCreate,
  parseDepartmentCreate,
  parsePositionCreate,
  type CompensationRecord,
  type ContractRecord,
  type DepartmentRecord,
  type EmployeeRecord,
  type FieldIssue,
  type MeContext,
  type PositionRecord,
} from "@gotonghr/contracts";
import { formatIdr } from "@gotonghr/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, apiData } from "@/lib/api";
import { TextField } from "../shell";
import { SelectField } from "./employee-fields";

const contractOptions = [
  { value: "PKWT", label: "PKWT" },
  { value: "PKWTT", label: "PKWTT" },
];

export function EmployeeProfile({
  employee,
  context,
  canWrite,
  today,
  revealOpen,
  reason,
  revealError,
  revealedNik,
  onReason,
  onStartReveal,
  onReveal,
  onClose,
}: {
  employee: EmployeeRecord;
  context: MeContext;
  canWrite: boolean;
  today: string;
  revealOpen: boolean;
  reason: string;
  revealError: string | null;
  revealedNik: string | null;
  onReason: (value: string) => void;
  onStartReveal: () => void;
  onReveal: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const entity = context.legalEntities.find((item) => item.id === employee.legalEntityId);
  const branch = context.branches.find((item) => item.id === employee.branchId);
  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: () => apiData<DepartmentRecord[]>("/api/v1/departments"),
  });
  const positions = useQuery({
    queryKey: ["positions"],
    queryFn: () => apiData<PositionRecord[]>("/api/v1/positions"),
  });
  const contracts = useQuery({
    queryKey: ["contracts", employee.id],
    queryFn: () => apiData<ContractRecord[]>(`/api/v1/employees/${employee.id}/contracts`),
  });
  const pay = useQuery({
    queryKey: ["compensation", employee.id],
    queryFn: () => apiData<CompensationRecord[]>(`/api/v1/employees/${employee.id}/compensation-profiles`),
  });
  const [departmentId, setDepartmentId] = useState(employee.departmentId ?? "");
  const [positionId, setPositionId] = useState(employee.positionId ?? "");
  const [departmentName, setDepartmentName] = useState("");
  const [positionName, setPositionName] = useState("");
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [assignmentErrors, setAssignmentErrors] = useState<Record<string, string>>({});
  const [contractType, setContractType] = useState("PKWT");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [contractError, setContractError] = useState<string | null>(null);
  const [contractErrors, setContractErrors] = useState<Record<string, string>>({});
  const [baseSalaryIdr, setBaseSalaryIdr] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [payError, setPayError] = useState<string | null>(null);
  const [payErrors, setPayErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const positionChoices = (positions.data ?? []).filter(
    (item) => !departmentId || item.departmentId === null || item.departmentId === departmentId,
  );

  async function refreshEmployee(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["employees"] });
  }

  function failRequest(caught: unknown, setError: (value: string) => void, setFields: (value: Record<string, string>) => void) {
    if (caught instanceof ApiRequestError && caught.status === 401) {
      void navigate({ to: "/sign-in" });
      return;
    }
    if (caught instanceof ApiRequestError) {
      setFields(fieldMap(caught.fields));
      setError(caught.fields.length > 0 ? "Check the highlighted fields." : caught.message);
      return;
    }
    setError("That change could not be saved.");
  }

  async function onDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseDepartmentCreate({ name: departmentName });
    if (!parsed.ok) {
      setAssignmentErrors(fieldMap(parsed.fields));
      setAssignmentError("Check the highlighted fields.");
      return;
    }
    setPending(true);
    setAssignmentError(null);
    setAssignmentErrors({});
    try {
      const created = await apiData<DepartmentRecord>("/api/v1/departments", {
        method: "POST",
        body: JSON.stringify(parsed.value),
      });
      setDepartmentName("");
      setDepartmentId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["departments"] });
    } catch (caught) {
      failRequest(caught, setAssignmentError, setAssignmentErrors);
    } finally {
      setPending(false);
    }
  }

  async function onPosition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parsePositionCreate({ name: positionName, departmentId: departmentId || null });
    if (!parsed.ok) {
      setAssignmentErrors(fieldMap(parsed.fields));
      setAssignmentError("Check the highlighted fields.");
      return;
    }
    setPending(true);
    setAssignmentError(null);
    setAssignmentErrors({});
    try {
      const created = await apiData<PositionRecord>("/api/v1/positions", {
        method: "POST",
        body: JSON.stringify(parsed.value),
      });
      setPositionName("");
      setPositionId(created.id);
      await queryClient.invalidateQueries({ queryKey: ["positions"] });
    } catch (caught) {
      failRequest(caught, setAssignmentError, setAssignmentErrors);
    } finally {
      setPending(false);
    }
  }

  async function onAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setAssignmentError(null);
    setAssignmentErrors({});
    try {
      await apiData<EmployeeRecord>(`/api/v1/employees/${employee.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          departmentId: departmentId || null,
          positionId: positionId || null,
        }),
      });
      await refreshEmployee();
    } catch (caught) {
      failRequest(caught, setAssignmentError, setAssignmentErrors);
    } finally {
      setPending(false);
    }
  }

  async function onContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseContractCreate({
      contractType,
      startDate,
      endDate: contractType === "PKWTT" ? null : endDate,
    });
    if (!parsed.ok) {
      setContractErrors(fieldMap(parsed.fields));
      setContractError("Check the highlighted fields.");
      return;
    }
    setPending(true);
    setContractError(null);
    setContractErrors({});
    try {
      await apiData<ContractRecord>(`/api/v1/employees/${employee.id}/contracts`, {
        method: "POST",
        body: JSON.stringify({
          contractType: parsed.value.contractType,
          startDate: parsed.value.startDate,
          endDate: parsed.value.endDate,
        }),
      });
      setEndDate("");
      await queryClient.invalidateQueries({ queryKey: ["contracts", employee.id] });
      await refreshEmployee();
    } catch (caught) {
      failRequest(caught, setContractError, setContractErrors);
    } finally {
      setPending(false);
    }
  }

  async function onPay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseCompensationCreate({ baseSalaryIdr, effectiveFrom });
    if (!parsed.ok) {
      setPayErrors(fieldMap(parsed.fields));
      setPayError("Check the highlighted fields.");
      return;
    }
    setPending(true);
    setPayError(null);
    setPayErrors({});
    try {
      await apiData<CompensationRecord>(`/api/v1/employees/${employee.id}/compensation-profiles`, {
        method: "POST",
        body: JSON.stringify({ baseSalaryIdr, effectiveFrom: parsed.value.effectiveFrom }),
      });
      setBaseSalaryIdr("");
      await queryClient.invalidateQueries({ queryKey: ["compensation", employee.id] });
    } catch (caught) {
      failRequest(caught, setPayError, setPayErrors);
    } finally {
      setPending(false);
    }
  }

  const payRows = pay.data ?? [];

  return (
    <section className="mt-8 max-w-xl border-t border-border pt-6" aria-label="Employee profile">
      <button className="min-h-11 underline" type="button" onClick={onClose}>
        Back to directory
      </button>
      <h2 className="mt-2 text-xl font-semibold [overflow-wrap:anywhere]">{employee.fullName}</h2>
      <p className="text-sm text-muted-foreground">{employee.employeeCode}</p>
      <h3 className="mt-6 text-base font-semibold">Assignment</h3>
      <p className="mt-2">{entity?.companyName ?? "Legal entity unavailable"}</p>
      <p>{branch?.name ?? "Branch unavailable"}</p>
      <p>
        {employee.departmentName ?? "No department"}
        {" · "}
        {employee.positionName ?? "No position"}
      </p>
      {canWrite ? (
        <form noValidate onSubmit={(event) => void onAssignment(event)}>
          {assignmentError ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {assignmentError}
            </p>
          ) : null}
          <SelectField
            id="assignedDepartment"
            label="Department"
            value={departmentId}
            error={assignmentErrors.departmentId ?? null}
            disabled={pending}
            onChange={(value) => {
              setDepartmentId(value);
              setPositionId("");
            }}
            options={(departments.data ?? []).map((item) => ({ value: item.id, label: item.name }))}
          />
          <SelectField
            id="assignedPosition"
            label="Position"
            value={positionId}
            error={assignmentErrors.positionId ?? null}
            disabled={pending}
            onChange={setPositionId}
            options={positionChoices.map((item) => ({ value: item.id, label: item.name }))}
          />
          <Button className="mt-4 min-h-11" type="submit" variant="outline" disabled={pending}>
            Save assignment
          </Button>
        </form>
      ) : null}
      {canWrite ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <form noValidate onSubmit={(event) => void onDepartment(event)}>
            <TextField
              id="newDepartment"
              label="New department"
              value={departmentName}
              onChange={setDepartmentName}
              error={assignmentErrors.name ?? null}
              readOnly={pending}
              inputMode="text"
              autoComplete="off"
            />
            <Button className="mt-4 min-h-11" type="submit" variant="outline" disabled={pending}>
              Add department
            </Button>
          </form>
          <form noValidate onSubmit={(event) => void onPosition(event)}>
            <TextField
              id="newPosition"
              label="New position"
              value={positionName}
              onChange={setPositionName}
              error={null}
              readOnly={pending}
              inputMode="text"
              autoComplete="off"
            />
            <Button className="mt-4 min-h-11" type="submit" variant="outline" disabled={pending}>
              Add position
            </Button>
          </form>
        </div>
      ) : null}
      <h3 className="mt-8 text-base font-semibold">Contracts</h3>
      {contracts.isPending ? <p className="mt-2 text-sm text-muted-foreground">Loading contracts…</p> : null}
      {contracts.data && contracts.data.length === 0 ? <p className="mt-2">No contract yet.</p> : null}
      <ul className="mt-2">
        {(contracts.data ?? []).map((contract) => (
          <li key={contract.id} className="border-b border-border py-2">
            <span className="font-medium">{contract.contractType}</span>
            <span className="mt-1 block text-sm">
              {formatDirectoryDate(contract.startDate)}
              {" – "}
              {contractEndLabel(contract.endDate, today)}
            </span>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <form noValidate onSubmit={(event) => void onContract(event)}>
          {contractError ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {contractError}
            </p>
          ) : null}
          <SelectField
            id="contractType"
            label="Contract type"
            value={contractType}
            error={contractErrors.contractType ?? null}
            disabled={pending}
            onChange={setContractType}
            options={contractOptions}
          />
          <TextField
            id="contractStart"
            label="Start date"
            value={startDate}
            onChange={setStartDate}
            error={contractErrors.startDate ?? null}
            readOnly={pending}
            inputMode="text"
            autoComplete="off"
            type="date"
          />
          {contractType === "PKWT" ? (
            <TextField
              id="contractEnd"
              label="End date"
              value={endDate}
              onChange={setEndDate}
              error={contractErrors.endDate ?? null}
              readOnly={pending}
              inputMode="text"
              autoComplete="off"
              type="date"
            />
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">A PKWTT contract has no end date.</p>
          )}
          <Button className="mt-4 min-h-11" type="submit" variant="outline" disabled={pending}>
            Add contract
          </Button>
        </form>
      ) : null}
      <h3 className="mt-8 text-base font-semibold">Pay</h3>
      {pay.isPending ? <p className="mt-2 text-sm text-muted-foreground">Loading pay…</p> : null}
      {payRows.length === 0 && !pay.isPending ? <p className="mt-2">No pay profile yet.</p> : null}
      <ul className="mt-2">
        {payRows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2">
            <span>
              {formatDirectoryDate(row.effectiveFrom)}
              <span className="ml-2 text-sm text-muted-foreground">{payNote(payRows, row, today)}</span>
            </span>
            <span className="font-medium">{formatIdr(BigInt(row.baseSalaryIdr))}</span>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <form noValidate onSubmit={(event) => void onPay(event)}>
          {payError ? (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {payError}
            </p>
          ) : null}
          <TextField
            id="baseSalaryIdr"
            label="Base salary"
            value={baseSalaryIdr}
            onChange={setBaseSalaryIdr}
            error={payErrors.baseSalaryIdr ?? null}
            readOnly={pending}
            inputMode="decimal"
            autoComplete="off"
          />
          <TextField
            id="effectiveFrom"
            label="Effective date"
            value={effectiveFrom}
            onChange={setEffectiveFrom}
            error={payErrors.effectiveFrom ?? null}
            readOnly={pending}
            inputMode="text"
            autoComplete="off"
            type="date"
          />
          <Button className="mt-4 min-h-11" type="submit" variant="outline" disabled={pending}>
            Add pay
          </Button>
        </form>
      ) : null}
      <h3 className="mt-8 text-base font-semibold">NIK</h3>
      <p className="mt-2 font-mono">{employee.nikMask}</p>
      {revealOpen ? (
        <form noValidate onSubmit={onReveal}>
          <TextField
            id="reason"
            label="Reason"
            value={reason}
            onChange={onReason}
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
      ) : (
        <button className="mt-2 min-h-11 underline" type="button" onClick={onStartReveal}>
          Reveal NIK
        </button>
      )}
      {revealedNik ? (
        <p className="mt-4 text-base" role="status">
          NIK {revealedNik}
        </p>
      ) : null}
    </section>
  );
}

function payNote(rows: CompensationRecord[], row: CompensationRecord, today: string): string {
  if (row.effectiveFrom > today) return "Scheduled";
  const current = rows.find((item) => item.effectiveFrom <= today);
  return current?.id === row.id ? "Current" : "Earlier";
}

function fieldMap(fields: FieldIssue[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const field of fields) {
    if (field.field === "body") continue;
    map[field.field] = field.message;
  }
  return map;
}
