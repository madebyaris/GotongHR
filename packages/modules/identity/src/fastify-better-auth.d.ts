declare module "fastify-better-auth" {
  import type { FastifyInstance } from "fastify";

  interface FastifyBetterAuthOptions {
    auth: unknown;
  }

  export default function fastifyBetterAuth(
    fastify: FastifyInstance,
    options: FastifyBetterAuthOptions,
  ): Promise<void>;
}
