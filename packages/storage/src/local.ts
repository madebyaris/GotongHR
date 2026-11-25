import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  assertObjectKey,
  readToken,
  resolveObjectPath,
  signToken,
  tokenExpiry,
  type ObjectToken,
} from "./keys.ts";
import { MAX_UPLOAD_BYTES, type ObjectStorage, type PresignPutInput } from "./types.ts";

export interface LocalStorageOptions {
  rootDir: string;
  secret: string;
  /** Public prefix in front of the route. Caddy strips `/api`. */
  urlPrefix?: string;
}

export interface LocalObjectStorage extends ObjectStorage {
  kind: "local";
  registerRoutes(app: FastifyInstance): Promise<void>;
}

function objectUrl(prefix: string, token: string): string {
  const pathAndQuery = `/storage/local/objects?token=${encodeURIComponent(token)}`;
  if (!prefix) return pathAndQuery;
  return `${prefix}${pathAndQuery}`;
}

function envelope(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({
    data: null,
    meta: null,
    error: { code, message },
  });
}

/** Outside the object-key namespace: keys must start with a letter or digit. */
const STAGING_DIR_NAME = ".upload-partials";
const partialUploadName = /^[0-9a-f]{32}\.partial$/;
const MAX_PARTIAL_SWEEP = 200;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function stagingDirectory(rootDir: string): string {
  return path.resolve(rootDir, STAGING_DIR_NAME);
}

/** A real directory only. `mkdir` follows a symlink that `lstat` would reject. */
async function ensureStagingDirectory(rootDir: string): Promise<string> {
  const dir = stagingDirectory(rootDir);
  let info = await lstat(dir).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (info && !info.isDirectory()) {
    throw new Error("Upload staging path must be a directory.");
  }
  if (!info) {
    await mkdir(dir, { recursive: true });
    info = await lstat(dir);
    if (!info.isDirectory()) {
      throw new Error("Upload staging path must be a directory.");
    }
  }
  return dir;
}

/** Removes crash leftovers from the staging directory only. */
async function sweepPartialUploads(rootDir: string): Promise<void> {
  const dir = stagingDirectory(rootDir);
  let entries;
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return;
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (removed >= MAX_PARTIAL_SWEEP) break;
    if (!entry.isFile() || !partialUploadName.test(entry.name)) continue;
    const resolved = path.resolve(dir, entry.name);
    if (!resolved.startsWith(`${dir}${path.sep}`)) continue;
    await rm(resolved, { force: true });
    removed += 1;
  }
}

function claimsFromQuery(
  query: unknown,
  secret: string,
  method: ObjectToken["method"],
): ObjectToken {
  if (!query || typeof query !== "object" || !("token" in query)) {
    throw new Error("Object token is missing.");
  }
  const token = (query as { token?: unknown }).token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Object token is missing.");
  }
  return readToken(token, secret, method);
}

export function createLocalStorage(options: LocalStorageOptions): LocalObjectStorage {
  const prefix = options.urlPrefix ?? "/api";
  const rootDir = options.rootDir;
  const secret = options.secret;

  return {
    kind: "local",
    async presignPut(input: PresignPutInput) {
      assertObjectKey(input.key);
      if (input.maxBytes < 1 || input.maxBytes > MAX_UPLOAD_BYTES) {
        throw new Error("Upload cap cannot exceed 2 MB.");
      }
      const token = signToken(
        {
          key: input.key,
          method: "PUT",
          exp: tokenExpiry(input.expiresInSeconds),
          maxBytes: input.maxBytes,
        },
        secret,
      );
      return {
        url: objectUrl(prefix, token),
        method: "PUT",
        headers: { "content-type": input.contentType },
      };
    },
    async put(input) {
      assertObjectKey(input.key);
      if (input.contentType.trim().length === 0) {
        throw new Error("Content type is required.");
      }
      if (input.body.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error("Upload cap cannot exceed 2 MB.");
      }
      const destination = resolveObjectPath(rootDir, input.key);
      const staging = await ensureStagingDirectory(rootDir);
      const temporary = path.join(staging, `${randomBytes(16).toString("hex")}.partial`);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await writeFile(temporary, input.body);
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async presignGet(input) {
      assertObjectKey(input.key);
      const token = signToken(
        {
          key: input.key,
          method: "GET",
          exp: tokenExpiry(input.expiresInSeconds),
          maxBytes: MAX_UPLOAD_BYTES,
        },
        secret,
      );
      return { url: objectUrl(prefix, token), method: "GET" };
    },
    async openRead(input) {
      assertObjectKey(input.key);
      const file = resolveObjectPath(rootDir, input.key);
      try {
        await access(file);
      } catch {
        throw new Error("Object was not found.");
      }
      return createReadStream(file);
    },
    async stat(input) {
      assertObjectKey(input.key);
      try {
        const info = await stat(resolveObjectPath(rootDir, input.key));
        if (!info.isFile()) return null;
        return { byteSize: info.size };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async delete(input) {
      await rm(resolveObjectPath(rootDir, input.key), { force: true });
    },
    async registerRoutes(app) {
      try {
        await sweepPartialUploads(rootDir);
      } catch (error) {
        app.log.warn({ err: error }, "partial upload sweep failed");
      }
      await app.register(async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser(
          "*",
          { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
          (_request, body, done) => {
            done(null, body);
          },
        );

        scope.put(
          "/storage/local/objects",
          { bodyLimit: MAX_UPLOAD_BYTES },
          async (request, reply) => {
            let claims: ObjectToken;
            try {
              claims = claimsFromQuery(request.query, secret, "PUT");
            } catch (error) {
              return envelope(reply, 403, "forbidden", error instanceof Error ? error.message : "forbidden");
            }
            const body = request.body;
            if (!Buffer.isBuffer(body)) {
              return envelope(reply, 400, "empty_body", "Upload body is missing.");
            }
            if (body.length > claims.maxBytes) {
              return envelope(reply, 413, "too_large", `Upload exceeds ${claims.maxBytes} bytes.`);
            }
            const destination = resolveObjectPath(rootDir, claims.key);
            const staging = await ensureStagingDirectory(rootDir);
            const temporary = path.join(staging, `${randomBytes(16).toString("hex")}.partial`);
            await mkdir(path.dirname(destination), { recursive: true });
            try {
              await writeFile(temporary, body);
              await rename(temporary, destination);
            } catch (error) {
              await rm(temporary, { force: true });
              throw error;
            }
            return { data: { key: claims.key }, meta: null, error: null };
          },
        );

        scope.get("/storage/local/objects", async (request, reply) => {
          let claims: ObjectToken;
          try {
            claims = claimsFromQuery(request.query, secret, "GET");
          } catch (error) {
            return envelope(reply, 403, "forbidden", error instanceof Error ? error.message : "forbidden");
          }
          const file = resolveObjectPath(rootDir, claims.key);
          try {
            await access(file);
          } catch {
            return envelope(reply, 404, "not_found", "Object was not found.");
          }
          return reply.type("application/octet-stream").send(createReadStream(file));
        });
      });
    },
  };
}
