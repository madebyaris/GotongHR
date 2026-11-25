import {
  applyDatabaseUrls,
  createTenantDatabase,
  loadRepoEnv,
  requiredEnv,
} from "@gotonghr/db";
import {
  bootstrapOwner,
  createAuth,
  readBootstrapInput,
  readDeploymentMode,
  type BootstrapResult,
} from "@gotonghr/identity";

export async function runBootstrap(env: NodeJS.ProcessEnv = process.env): Promise<BootstrapResult> {
  loadRepoEnv();
  applyDatabaseUrls(env);
  const mode = readDeploymentMode(env);
  if (mode !== "single_tenant") {
    throw new Error("bootstrap is only available when GOTONG_DEPLOYMENT_MODE=single_tenant");
  }
  const input = readBootstrapInput(env);
  const appDb = createTenantDatabase(requiredEnv(env, "DATABASE_URL_APP"), 2);
  try {
    const auth = createAuth({ appDb, env });
    return await bootstrapOwner(
      auth,
      appDb,
      {
        email: input.email,
        password: input.password,
        name: input.ownerName,
        tenantName: input.tenantName,
      },
      mode,
    );
  } finally {
    await appDb.end();
  }
}
