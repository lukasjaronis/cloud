import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { bearerAuth } from "hono/bearer-auth";
import { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";
import { CreateKeyParams, VerifyKeyParams, createKey, verifyKey } from "./utils/keys";
import { apiResponse } from "./types";
import { getHeaders } from "./utils/headers";

interface Env {
  Bindings: {
    gate: KVNamespace;
    AUTHENTICATION_TOKEN: string;
  };
}

const app = new Hono<Env>();
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

app.post("/api/keys/create", async (c, next) => {
  const body = await c.req.json<CreateKeyParams>();
  const { value, hash } = await createKey({ prefix: body.prefix });

  const headers = getHeaders(c)

  await c.env.gate.put(
    value,
    JSON.stringify(headers),
    { metadata: body.metadata, expiration: body.expires }
  );

  return apiResponse(c, `Key created.`, 200, c.req.method, { value });
});

// app.get("/api/keys/verify", async (c, next) => {
//   // const body = await c.req.json<VerifyKeyParams>()

//   // const key = await c.env.gate.get(body.key)

//   // // const verified = await verifyKey({ key: "test", hex: data })

//   // return apiResponse(c, "Here you go", 200, c.req.method, {
//   //   null,
//   //   // verification
//   // });
// });

// app.delete("/api/keys/delete", async (c, next) => {
//   const body = await c.req.json()
//   // const verification = await verifyKey({ key: "test", hex: data })

//   // return apiResponse(c, "Here you go", 200, c.req.method, {
//   //   null,
//   //   // verification
//   // });
// });

export default app;
