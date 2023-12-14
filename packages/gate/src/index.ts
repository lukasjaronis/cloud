import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import {
  Key,
  KeyCreateParams,
  KeyVerifyParams,
  keyVerifySchema,
} from "./key";
import { APIResponse, StatusCodes } from "./utils/response";
import { Metrics } from "./config/metrics/axiom";
import { ENV, envSchema } from "./config/env";
import { NOOP } from "./utils/noop";
import { CfProperties } from "@cloudflare/workers-types";
import { Cache } from "./utils/cache";
import { Database } from "./config/db/db";

/**
 * Not sure why .default is not typed with the latest versions.
 *
 * Fix for now.
 */
declare global {
  interface CacheStorage {
    default: {
      put(request: Request | string, response: Response): Promise<undefined>;
      match(request: Request | string): Promise<Response | undefined>;
      delete(cacheName: string): Promise<boolean>;
    };
  }

  interface Request {
    cf: CfProperties
  }
}

export let cache = new Cache
export let db: Database = new NOOP() as Database
export let metrics: Metrics = new NOOP() as Metrics

const app = new Hono<{ Bindings: ENV }>();

app.use("*", async (c, next) => {
  logger();

  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["PUT", "GET", "POST"],
    maxAge: 600,
    credentials: true,
  });

  const auth = bearerAuth({
    token: c.env.AUTHENTICATION_TOKEN
  });

  await auth(c, next);

  c.executionCtx.waitUntil(metrics.flush());
});


app.post("/api/keys/create", async (c) => {
  const body = await c.req.json<KeyCreateParams>();
  const instance = new Key(c);
  return await instance.create(body);
});

app.post("/api/keys/create/ps", async (c) => {
  const body = await c.req.json<KeyCreateParams>();
  const instance = new Key(c);
  return await instance.createPS(body);
});

app.post("/api/keys/verify", async (c) => {
  const body = await c.req.json<KeyVerifyParams>();

  const validatedBody = keyVerifySchema.safeParse(body);

  if (!validatedBody.success) {
    return APIResponse(
      StatusCodes.BAD_REQUEST,
      validatedBody.error.issues,
    );
  }

  const instance = new Key(c); 
  return await instance.verify(validatedBody.data)
});

app.post("/api/keys/verify/ps", async (c) => {
  const body = await c.req.json<KeyVerifyParams>();

  const validatedBody = keyVerifySchema.safeParse(body);

  if (!validatedBody.success) {
    return APIResponse(
      StatusCodes.BAD_REQUEST,
      validatedBody.error.issues,
    );
  }

  const instance = new Key(c); 
  return await instance.verifyPS(validatedBody.data)
});

export default {
  async fetch(request: Request, env: ENV, ctx: ExecutionContext) {
    const validatedEnv = envSchema.safeParse(env)

    if (!validatedEnv.success) {
      return APIResponse(StatusCodes.BAD_REQUEST, null, validatedEnv.error.issues)
    }

    if (!(metrics instanceof Metrics)) {
      metrics = new Metrics(validatedEnv.data)
    }

    if (!(db instanceof Database)) {
      db = new Database(validatedEnv.data)
    }

    return app.fetch(request, validatedEnv.data, ctx)
  }
}
