import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  Key,
  KeyCreateParams,
  KeyVerifyParams,
  keyVerifySchema,
} from "./key";
import { getCacheKey } from "./utils/cache";
import { APIResponse, ResponseReturnType, StatusCodes } from "./utils/response";
import { Storage } from "./objects/storage";
import { Metrics } from "./config/metrics/axiom";
import { ENV, envSchema } from "./env";
import { NOOP } from "./utils/noop";

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
}

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

  const objectId = instance.getObjectId({ key: body.key });
  const CACHE_KEY = getCacheKey(c.env.WORKER_DOMAIN, objectId);

  const cachedResponse = await caches.default.match(CACHE_KEY);

  if (cachedResponse && cachedResponse.ok) {
    return await instance.verifyHot(
      cachedResponse,
      validatedBody.data,
      objectId,
      CACHE_KEY
    );
  }

  return await instance.verifyCold(validatedBody.data, objectId, CACHE_KEY);
});

app.get("/api/keys/:key/storage", async (c) => {
  const url = new URL(c.req.url);
  const { key } = c.req.param();

  const instance = new Key(c);
  const keyIdentifier = instance.getObjectId({ key });

  const CACHE_KEY = getCacheKey(c.env.WORKER_DOMAIN, keyIdentifier);

  const objectId = c.env.GateStorage.idFromName(keyIdentifier);
  const object = c.env.GateStorage.get(objectId);

  const response = await object.fetch(url.origin + '/object/storage');
  let json = await response.json<ResponseReturnType<Storage>>();

  const cachedResponse = await caches.default.match(CACHE_KEY);

  return c.json({
    storage: json.data,
    cachedStorage:
      cachedResponse && cachedResponse.ok ? await cachedResponse.json() : null,
  });
});

export { GateStorage } from "./objects/storage";
export { RateLimitStorage } from "./objects/rate_limit";

export default {
  async fetch(request: Request, env: ENV, ctx: ExecutionContext) {
    const validatedEnv = envSchema.safeParse(env)

    if (!validatedEnv.success) {
      return APIResponse(StatusCodes.BAD_REQUEST, null, validatedEnv.error.issues)
    }

    if (!(metrics instanceof Metrics)) {
      metrics = new Metrics(validatedEnv.data)
    }

    return app.fetch(request, validatedEnv.data, ctx)
  }
}
