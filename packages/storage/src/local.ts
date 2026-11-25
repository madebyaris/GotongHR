import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
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
    async delete(input) {
      await rm(resolveObjectPath(rootDir, input.key), { force: true });
    },
    async registerRoutes(app) {
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
            const temporary = `${destination}.${randomBytes(8).toString("hex")}.partial`;
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
