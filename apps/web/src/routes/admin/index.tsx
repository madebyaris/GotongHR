import {
  canWriteOrg,
  idrToJson,
  parseBranchDraft,
  parseLegalEntityCreate,
  parseUmpIdr,
  type BranchRecord,
  type FieldIssue,
  type LegalEntityRecord,
  type MeContext,
} from "@gotonghr/contracts";
import { formatIdr } from "@gotonghr/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ApiRequestError, apiData } from "@/lib/api";
import { fieldClass, SetupColumn, SetupHeader, TextField } from "../shell";
import { AdminFrame } from "./frame";

const timezones = [
  { value: "Asia/Jakarta", label: "WIB · Jakarta" },
  { value: "Asia/Makassar", label: "WITA · Makassar" },
  { value: "Asia/Jayapura", label: "WIT · Jayapura" },
] as const;

const fieldOrder = [
  "companyName",
  "npwp16",
  "name",
  "nitku22",
  "timezone",
  "umpUmkIdr",
  "latitude",
  "longitude",
  "geofenceRadiusM",
];

export default function AdminPage() {
  return (
    <AdminFrame>
      <CompanyPage />
    </AdminFrame>
  );
}

function CompanyPage() {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["me", "context"],
    queryFn: () => apiData<MeContext>("/api/v1/me/context"),
    retry: false,
  });

  useEffect(() => {
    if (query.error instanceof ApiRequestError && query.error.status === 401) {
      void navigate({ to: "/sign-in" });
    }
  }, [navigate, query.error]);

  if (query.isPending) {
    return (
      <SetupColumn>
        <SetupHeader title="Set up the company" detail={null} />
        <p className="mt-4 text-base text-muted-foreground">Loading company setup…</p>
      </SetupColumn>
    );
  }

  if (query.error instanceof ApiRequestError && query.error.status === 401) {
    return (
      <SetupColumn>
        <SetupHeader title="Set up the company" detail={null} />
        <p className="mt-4 text-base">Sign in to continue.</p>
      </SetupColumn>
    );
  }

  if (!query.data) {
    return (
      <SetupColumn>
        <SetupHeader title="Set up the company" detail={null} />
        <p className="mt-4 text-base" role="alert">
          The company setup could not be loaded.
        </p>
        <Button className="mt-6 min-h-11" type="button" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </SetupColumn>
    );
  }

  return <CompanySetup context={query.data} />;
}

function CompanySetup({ context }: { context: MeContext }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const entity = context.legalEntities[0] ?? null;
  const branch = entity
    ? (context.branches.find((item) => item.legalEntityId === entity.id) ?? null)
    : null;
  const canWrite = canWriteOrg(context.role);
  const [companyName, setCompanyName] = useState(entity?.companyName ?? "");
  const [npwp16, setNpwp16] = useState(entity?.npwp16 ?? "");
  const [name, setName] = useState(branch?.name ?? "");
  const [nitku22, setNitku22] = useState(branch?.nitku22 ?? "");
  const [timezone, setTimezone] = useState(branch?.timezone ?? "");
  const [umpUmkIdr, setUmpUmkIdr] = useState(branch?.umpUmkIdr ?? "");
  const [latitude, setLatitude] = useState(branch?.latitude ?? "");
  const [longitude, setLongitude] = useState(branch?.longitude ?? "");
  const [radius, setRadius] = useState(radiusText(branch));
  const [entityId, setEntityId] = useState<string | null>(entity?.id ?? null);
  const [branchId, setBranchId] = useState<string | null>(branch?.id ?? null);
  const [saved, setSaved] = useState<SavedCompany | null>(() => savedCompany(entity, branch));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const wage = parseUmpIdr(umpUmkIdr);
  const otherEntities = context.legalEntities.slice(entity ? 1 : 0);
  const otherBranches = context.branches.filter((item) => item.id !== branch?.id);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite) return;
    const entityParsed = parseLegalEntityCreate({ companyName, npwp16 });
    const branchParsed = parseBranchDraft({
      name,
      nitku22,
      timezone,
      umpUmkIdr,
      latitude: blankToNull(latitude),
      longitude: blankToNull(longitude),
      geofenceRadiusM: blankToNull(radius),
    });
    const clientFields = [
      ...(entityParsed.ok ? [] : entityParsed.fields),
      ...(branchParsed.ok ? [] : branchParsed.fields),
    ];
    if (clientFields.length > 0) {
      const nextErrors = fieldMap(clientFields);
      setErrors(nextErrors);
      setFormError(formMessage(clientFields, "Check the highlighted fields."));
      focusFirst(nextErrors);
      return;
    }
    if (!entityParsed.ok || !branchParsed.ok) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      let nextEntityId = entityId;
      let savedCompanyName = entityParsed.value.companyName;
      const entityBody = {
        companyName: entityParsed.value.companyName,
        npwp16: entityParsed.value.npwp16,
      };
      if (!nextEntityId) {
        const created = await apiData<LegalEntityRecord>("/api/v1/legal-entities", {
          method: "POST",
          body: JSON.stringify(entityBody),
        });
        nextEntityId = created.id;
        savedCompanyName = created.companyName;
        setEntityId(created.id);
        setCompanyName(created.companyName);
        setNpwp16(created.npwp16);
      } else {
        const updated = await apiData<LegalEntityRecord>(`/api/v1/legal-entities/${nextEntityId}`, {
          method: "PATCH",
          body: JSON.stringify(entityBody),
        });
        savedCompanyName = updated.companyName;
        setCompanyName(updated.companyName);
        setNpwp16(updated.npwp16);
      }
      const branchBody = {
        legalEntityId: nextEntityId,
        name: branchParsed.value.name,
        nitku22: branchParsed.value.nitku22,
        timezone: branchParsed.value.timezone,
        umpUmkIdr: idrToJson(branchParsed.value.umpUmkIdr),
        latitude: branchParsed.value.latitude,
        longitude: branchParsed.value.longitude,
        geofenceRadiusM: branchParsed.value.geofenceRadiusM,
      };
      const savedBranch = branchId
        ? await apiData<BranchRecord>(`/api/v1/branches/${branchId}`, {
            method: "PATCH",
            body: JSON.stringify(branchBody),
          })
        : await apiData<BranchRecord>("/api/v1/branches", {
            method: "POST",
            body: JSON.stringify(branchBody),
          });
      setBranchId(savedBranch.id);
      setName(savedBranch.name);
      setNitku22(savedBranch.nitku22);
      setTimezone(savedBranch.timezone);
      setUmpUmkIdr(savedBranch.umpUmkIdr);
      setLatitude(savedBranch.latitude ?? "");
      setLongitude(savedBranch.longitude ?? "");
      setRadius(savedBranch.geofenceRadiusM === null ? "" : String(savedBranch.geofenceRadiusM));
      setSaved({
        companyName: savedCompanyName,
        branchName: savedBranch.name,
        wage: formatIdr(BigInt(savedBranch.umpUmkIdr)),
      });
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        if (caught.status === 401) {
          void navigate({ to: "/sign-in" });
          return;
        }
        const nextErrors = fieldMap(caught.fields);
        setErrors(nextErrors);
        setFormError(formMessage(caught.fields, caught.message));
        focusFirst(nextErrors);
      } else {
        setFormError("The company setup could not be saved.");
      }
    } finally {
      setPending(false);
      await queryClient.invalidateQueries({ queryKey: ["me", "context"] });
    }
  }

  const status = statusText(entityId, saved);

  return (
    <SetupColumn>
      <SetupHeader title="Set up the company" detail={`${context.tenant.name} · ${context.user.email}`} />
      <p className="mt-4 text-base" role="status">
        {status}
      </p>
      {otherEntities.length > 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Other legal entities: {otherEntities.map((item) => item.companyName).join(", ")}
        </p>
      ) : null}
      <form className="mt-2" noValidate onSubmit={(event) => void onSubmit(event)}>
        {formError ? (
          <p className="mt-4 text-base text-destructive" role="alert">
            {formError}
          </p>
        ) : null}
        <section className="mt-8 border-t border-border pt-8" aria-labelledby="legal-entity-heading">
          <h2 className="text-lg font-semibold" id="legal-entity-heading">
            1 · Legal entity
          </h2>
          <TextField
            id="companyName"
            label="Company name"
            value={companyName}
            onChange={setCompanyName}
            error={errors.companyName ?? null}
            readOnly={!canWrite || pending}
            inputMode="text"
            autoComplete="organization"
          />
          <TextField
            id="npwp16"
            label="NPWP (16 digits)"
            value={npwp16}
            onChange={setNpwp16}
            error={errors.npwp16 ?? null}
            readOnly={!canWrite || pending}
            inputMode="numeric"
            autoComplete="off"
          />
        </section>
        <section className="mt-10 border-t border-border pt-8" aria-labelledby="branch-heading">
          <h2 className="text-lg font-semibold" id="branch-heading">
            2 · Branch
          </h2>
          <TextField
            id="name"
            label="Branch name"
            value={name}
            onChange={setName}
            error={errors.name ?? null}
            readOnly={!canWrite || pending}
            inputMode="text"
            autoComplete="off"
          />
          <TextField
            id="nitku22"
            label="NITKU (22 digits)"
            value={nitku22}
            onChange={setNitku22}
            error={errors.nitku22 ?? null}
            readOnly={!canWrite || pending}
            inputMode="numeric"
            autoComplete="off"
          />
          <div className="mt-4">
            <label className="block text-base font-medium" htmlFor="timezone">
              Timezone
            </label>
            <select
              id="timezone"
              name="timezone"
              className={fieldClass}
              value={timezone}
              disabled={!canWrite || pending}
              aria-invalid={errors.timezone ? true : undefined}
              aria-describedby={errors.timezone ? "timezone-error" : undefined}
              onChange={(event) => setTimezone(event.target.value)}
            >
              <option value="">Choose WIB, WITA, or WIT</option>
              {timezones.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {errors.timezone ? (
              <p className="mt-1 text-sm text-destructive" id="timezone-error">
                {errors.timezone}
              </p>
            ) : null}
          </div>
          <TextField
            id="umpUmkIdr"
            label="UMP/UMK (rupiah)"
            value={umpUmkIdr}
            onChange={setUmpUmkIdr}
            error={errors.umpUmkIdr ?? null}
            readOnly={!canWrite || pending}
            inputMode="numeric"
            autoComplete="off"
          />
          {!branchId && wage.ok ? (
            <p className="mt-1 text-sm text-muted-foreground">{formatIdr(wage.value)} per month</p>
          ) : null}
          <fieldset className="mt-6">
            <legend className="text-base font-medium">Geofence</legend>
            <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-3">
              <TextField
                id="latitude"
                label="Latitude"
                value={latitude}
                onChange={setLatitude}
                error={errors.latitude ?? null}
                readOnly={!canWrite || pending}
                inputMode="decimal"
                autoComplete="off"
              />
              <TextField
                id="longitude"
                label="Longitude"
                value={longitude}
                onChange={setLongitude}
                error={errors.longitude ?? null}
                readOnly={!canWrite || pending}
                inputMode="decimal"
                autoComplete="off"
              />
              <TextField
                id="geofenceRadiusM"
                label="Radius (m)"
                value={radius}
                onChange={setRadius}
                error={errors.geofenceRadiusM ?? null}
                readOnly={!canWrite || pending}
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
          </fieldset>
          {otherBranches.length > 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Other branches: {otherBranches.map((item) => item.name).join(", ")}
            </p>
          ) : null}
        </section>
        {canWrite ? (
          <Button className="mt-8 min-h-11 w-full text-base" type="submit" disabled={pending} aria-busy={pending}>
            {pending ? "Saving…" : branchId ? "Save changes" : "Save company setup"}
          </Button>
        ) : (
          <p className="mt-8 text-base">An owner or HR admin can change this.</p>
        )}
      </form>
    </SetupColumn>
  );
}

interface SavedCompany {
  companyName: string;
  branchName: string;
  wage: string;
}

function savedCompany(entity: LegalEntityRecord | null, branch: BranchRecord | null): SavedCompany | null {
  if (!entity || !branch) return null;
  return {
    companyName: entity.companyName,
    branchName: branch.name,
    wage: formatIdr(BigInt(branch.umpUmkIdr)),
  };
}

function statusText(entityId: string | null, saved: SavedCompany | null): string {
  if (saved) return `Saved. ${saved.companyName} · ${saved.branchName}. ${saved.wage} per month.`;
  if (entityId) return "Legal entity saved. Add the branch.";
  return "No legal entity yet.";
}

function formMessage(fields: FieldIssue[], fallback: string): string {
  const body = fields.find((field) => field.field === "body")?.message;
  if (body) return body;
  if (fields.some((field) => field.field !== "body")) return "Check the highlighted fields.";
  return fallback;
}

function radiusText(branch: BranchRecord | null): string {
  if (!branch || branch.geofenceRadiusM === null) return "";
  return String(branch.geofenceRadiusM);
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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
