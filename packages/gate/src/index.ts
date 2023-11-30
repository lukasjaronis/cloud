import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import {
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { Key, KeyCreateParams, KeyVerifiyHashParams } from "./key";
import { metrics } from "./metrics/axiom";
import { getCacheKey } from "./utils/cache";
import { ResponseReturnType } from "./utils/response";
import { Storage } from "./objects/storage";

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
      delete(cacheName: string): Promise<boolean>
    };
  }
}

export type Bindings = {
  GateStorage: DurableObjectNamespace;
  RateLimitStorage: DurableObjectNamespace;
  AUTHENTICATION_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

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
    token: c.env.AUTHENTICATION_TOKEN,
  });

  await auth(c, next);

  c.executionCtx.waitUntil(Promise.all([metrics.flush()]));
});

app.post("/api/keys/create", async (c) => {
  const body = await c.req.json<KeyCreateParams>();
  const instance = new Key(c);
  return await instance.create(body);
});

app.post("/api/keys/verify", async (c) => {
  const body = await c.req.json<KeyVerifiyHashParams>();
  const instance = new Key(c);
  return await instance.verify(body);
});

// app.post("/api/keys/update", async (c) => {
//   const body = await c.req.json<KeyUpdateParams>()
//   const instance = new Key(c)
//   return await instance.update(body)
// })

export { GateStorage } from "./objects/storage";
export { RateLimitStorage } from "./objects/rate_limit";
export default app;
