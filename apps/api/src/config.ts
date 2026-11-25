export type DeploymentMode = "single_tenant" | "multi_tenant_saas" | "holding_multi_tenant";

export const appRoles = ["monolith", "attendance", "worker", "ai"] as const;

export type AppRole = (typeof appRoles)[number];

export type PortTransport = "inproc" | "http";

export type QueueDriver = "pgboss" | "sqs";

export type PayrollPortName = "core-hr" | "attendance" | "statutory";

export interface PortUrls {
  coreHr: string;
  attendance: string;
  statutory: string;
}

export interface AppConfig {
  role: AppRole;
  deploymentMode: DeploymentMode;
  storageDriver: "local" | "s3";
  queueDriver: QueueDriver;
  portTransport: PortTransport;
  port: number;
  host: string;
  /** Present when `PORT_TRANSPORT=http`. */
  internalSecret: string | null;
  /** Present when this process calls payroll ports over HTTP. */
  portUrls: PortUrls | null;
}

const deploymentModes = new Set<DeploymentMode>([
  "single_tenant",
  "multi_tenant_saas",
  "holding_multi_tenant",
]);

const roleSet = new Set<string>(appRoles);

/**
 * Core HR and the statutory table have no process of their own.
 * Attendance answers workforce reads. The AI process answers the published table.
 * The monolith answers all three when it is the only process.
 */
export function ownedPayrollPorts(role: AppRole): readonly PayrollPortName[] {
  if (role === "monolith") return ["core-hr", "attendance", "statutory"];
  if (role === "attendance") return ["core-hr", "attendance"];
  if (role === "ai") return ["statutory"];
  return [];
}

/** Payroll is the caller. The monolith is too, when ports leave the process. */
export function consumesPayrollPorts(role: AppRole): boolean {
  return role === "monolith" || role === "worker";
}

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const role = env.GOTONG_ROLE ?? "monolith";
  if (!roleSet.has(role)) {
    throw new Error(`GOTONG_ROLE ${role} is not a GotongHR role.`);
  }
  const deploymentMode = env.GOTONG_DEPLOYMENT_MODE ?? "single_tenant";
  if (!deploymentModes.has(deploymentMode as DeploymentMode)) {
    throw new Error("GOTONG_DEPLOYMENT_MODE is invalid.");
  }
  const storageDriver = env.STORAGE_DRIVER ?? "local";
  if (storageDriver !== "local" && storageDriver !== "s3") {
    throw new Error("STORAGE_DRIVER must be local or s3.");
  }
  const queueDriver = env.QUEUE_DRIVER ?? "pgboss";
  if (queueDriver !== "pgboss" && queueDriver !== "sqs") {
    throw new Error("QUEUE_DRIVER must be pgboss or sqs.");
  }
  const portTransport = env.PORT_TRANSPORT ?? "inproc";
  if (portTransport !== "inproc" && portTransport !== "http") {
    throw new Error("PORT_TRANSPORT must be inproc or http.");
  }
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT is invalid.");
  }
  const typedRole = role as AppRole;
  const http = portTransport === "http";
  return {
    role: typedRole,
    deploymentMode: deploymentMode as DeploymentMode,
    storageDriver,
    queueDriver,
    portTransport,
    port,
    host: env.HOST ?? "0.0.0.0",
    internalSecret: http ? readInternalSecret(env) : null,
    portUrls: http && consumesPayrollPorts(typedRole) ? readPortUrls(env) : null,
  };
}

function readInternalSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.INTERNAL_SERVICE_SECRET ?? "";
  if (secret.length < 16) {
    throw new Error("INTERNAL_SERVICE_SECRET must be at least 16 characters when PORT_TRANSPORT=http.");
  }
  return secret;
}

function readPortUrls(env: NodeJS.ProcessEnv): PortUrls {
  return {
    coreHr: readOrigin(env, "CORE_HR_PORT_URL"),
    attendance: readOrigin(env, "ATTENDANCE_PORT_URL"),
    statutory: readOrigin(env, "STATUTORY_PORT_URL"),
  };
}

function readOrigin(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be http or https.`);
  }
  return parsed.origin;
}
