import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import {
  DurableObjectNamespace,
} from "@cloudflare/workers-types";
import { Key, KeyCreateParams, KeyVerifiyHashParams } from "./key";

export type Bindings = {
  GateStorage: DurableObjectNamespace;
  RateLimitStorage: DurableObjectNamespace
  AUTHENTICATION_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["PUT", "GET", "POST"],
    maxAge: 600,
    credentials: true,
  })
);
app.use("*", async (c, next) => {
  const auth = bearerAuth({
    token: c.env.AUTHENTICATION_TOKEN,
  });

  return await auth(c, next);
});

app.post("/api/keys/create", async (c) => {
  const body = await c.req.json<KeyCreateParams>();
  const instance = new Key(c)
  return await instance.create(body)
});

app.post("/api/keys/verify", async (c) => {
  const body = await c.req.json<KeyVerifiyHashParams>();
  const instance = new Key(c)
  return await instance.verify(body)
});

// app.post("/api/keys/update", async (c) => {
//   const body = await c.req.json<KeyUpdateParams>()
//   const instance = new Key(c)
//   return await instance.update(body)
// })


export { GateStorage } from "./objects/storage";
export { RateLimitStorage } from './objects/rate_limit'
export default app;