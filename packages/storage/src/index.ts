import path from "node:path";
import { createLocalStorage, type LocalObjectStorage } from "./local.ts";
import { createS3Storage, type S3ObjectStorage } from "./s3.ts";
import { requiredText } from "./required.ts";

export { createLocalStorage, type LocalObjectStorage, type LocalStorageOptions } from "./local.ts";
export { createS3Storage, type S3ObjectStorage, type S3StorageOptions } from "./s3.ts";
export { MAX_UPLOAD_BYTES } from "./types.ts";
export type { ObjectStorage, PresignPutInput, PresignedGet, PresignedPut } from "./types.ts";

const blockedStorageSecrets = new Set([
  "change-me",
  "changeme",
  "secret",
  "password",
  "replace-me",
  "replace-with-a-long-random-string",
]);

function storageSecret(value: string | undefined): string {
  const secret = requiredText(value, "STORAGE_LOCAL_SECRET");
  if (blockedStorageSecrets.has(secret)) {
    throw new Error("STORAGE_LOCAL_SECRET is a placeholder.");
  }
  return secret;
}

export function createStorage(env: NodeJS.ProcessEnv): LocalObjectStorage | S3ObjectStorage {
  const driver = env.STORAGE_DRIVER ?? "local";
  if (driver === "local") {
    return createLocalStorage({
      rootDir: env.STORAGE_LOCAL_ROOT ?? path.resolve(process.cwd(), ".data/objects"),
      secret: storageSecret(env.STORAGE_LOCAL_SECRET),
      urlPrefix: env.STORAGE_URL_PREFIX ?? "/api",
    });
  }
  if (driver === "s3") {
    const accessKeyId = env.S3_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must both be set.");
    }
    return createS3Storage({
      bucket: requiredText(env.S3_BUCKET, "S3_BUCKET"),
      region: requiredText(env.S3_REGION, "S3_REGION"),
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }
  throw new Error("STORAGE_DRIVER must be local or s3.");
}
