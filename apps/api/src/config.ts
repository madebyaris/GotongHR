export type DeploymentMode = "single_tenant" | "multi_tenant_saas" | "holding_multi_tenant";

export interface AppConfig {
  role: "monolith";
  deploymentMode: DeploymentMode;
  storageDriver: "local" | "s3";
  queueDriver: "pgboss";
  port: number;
  host: string;
}

const deploymentModes = new Set<DeploymentMode>([
  "single_tenant",
  "multi_tenant_saas",
  "holding_multi_tenant",
]);

export function readConfig(env: NodeJS.ProcessEnv): AppConfig {
  const role = env.GOTONG_ROLE ?? "monolith";
  if (role !== "monolith") {
    throw new Error(`GOTONG_ROLE ${role} does not boot from the monolith entrypoint.`);
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
  if (queueDriver !== "pgboss") {
    throw new Error("QUEUE_DRIVER must be pgboss.");
  }
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT is invalid.");
  }
  return {
    role: "monolith",
    deploymentMode: deploymentMode as DeploymentMode,
    storageDriver,
    queueDriver,
    port,
    host: env.HOST ?? "0.0.0.0",
  };
}
