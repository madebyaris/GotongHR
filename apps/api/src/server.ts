import { fail, ok } from "@gotonghr/contracts";
import type { LocalObjectStorage, S3ObjectStorage } from "@gotonghr/storage";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { resolveTrustProxy } from "./trust-proxy.ts";

const readySchema = z.object({
  data: z.object({ status: z.literal("ready") }).nullable(),
  meta: z.null(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export interface ServerDeps {
  checkReady: () => Promise<void>;
  storage?: LocalObjectStorage | S3ObjectStorage;
  logger?: boolean;
  /** Fastify trustProxy. A number is a hop count from a private peer. Default 1. */
  trustProxy?: boolean | number | string | string[];
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ? { level: "info" } : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: resolveTrustProxy(deps.trustProxy),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get("/healthz", async () => ok({ status: "ok" }));

  app.get(
    "/readyz",
    {
      schema: {
        response: {
          200: readySchema,
          503: readySchema,
        },
      },
    },
    async (_request, reply) => {
      try {
        await deps.checkReady();
        return ok({ status: "ready" as const });
      } catch (error) {
        app.log.error({ err: error }, "readyz check failed");
        return reply.code(503).send(fail("not_ready", "not ready"));
      }
    },
  );

  if (deps.storage?.kind === "local") {
    await deps.storage.registerRoutes(app);
  }

  return app;
}
