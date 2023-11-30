import { DurableObjectState } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { APIResponse, StatusCodes } from "../utils/response";
import { z } from "zod";
import { Bindings } from "..";

export const storageSchema = z.object({
  hash: z.string(),
  expires: z.number().nullable(),
  uses: z.number().nullable(),
  rateLimit: z
    .object({
      /**
       * Allowed requests per timeframe
       *
       * ex: 3 requests per 10 seconds
       */
      requests: z.number(),
      timeframe: z.number(),
    })
    .nullable(),
  metadata: z.object({}).nullable(),
});

export type Storage = z.infer<typeof storageSchema>;

export class GateStorage {
  private readonly timestamp = Math.floor(Date.now() / 1000);
  state: DurableObjectState;
  app: Hono<{ Bindings: Bindings }> = new Hono<{ Bindings: Bindings }>();

  constructor(state: DurableObjectState) {
    this.state = state;

    /**
     * Responsible for creating a durable object following the
     * storageSchema schema.
     */
    this.app.post("/api/keys/create/object", async (c) => {
      const body = await c.req.json<Storage>();

      const validatedBody = storageSchema.safeParse(body);

      if (!validatedBody.success) {
        return APIResponse(
          StatusCodes.BAD_REQUEST,
          c.req.method,
          validatedBody.error.issues,
          null
        );
      }

      try {
        await Promise.allSettled(
          Object.entries(validatedBody.data).map(async ([key, value]) => {
            await this.state.storage.put(key, value);
          })
        );

        return APIResponse(StatusCodes.CREATED, c.req.method, null, null);
      } catch (error) {
        return APIResponse(
          StatusCodes.BAD_REQUEST,
          c.req.method,
          "Could not access storage.",
          null
        );
      }
    });

    /**
     * Responsible for evaluating and veriftying a durable object.
     */
    this.app.get("/api/keys/verify/object", async (c) => {
      try {
        const data = await this.state.storage.list();
        const maybeStaleObject = Object.fromEntries(data) as Storage;
        let freshObject = maybeStaleObject

        if (maybeStaleObject.uses !== null) {
          if (maybeStaleObject.uses == 0) {
            await this.state.storage.deleteAll()
          }

          if (maybeStaleObject.uses > 0) {
            freshObject["uses"] = maybeStaleObject.uses - 1;
            await this.state.storage.put('uses', freshObject['uses'])
          }
        }

        if (freshObject.expires !== null) {
          if (this.timestamp > freshObject.expires) {
            await this.state.storage.deleteAll()
          }
        }

        return APIResponse(
          StatusCodes.OK,
          c.req.method,
          null,
          freshObject
        );
      } catch (error) {
        return APIResponse(
          StatusCodes.BAD_REQUEST,
          c.req.method,
          "Could not access storage.",
          null
        );
      }
    });

    this.app.post('/api/keys/verify/sync', async (c) => {
      const body = await c.req.json<Storage>();
      for (const [key, value] of Object.entries(body)) {
        await this.state.storage.put(key, value)
      }
    })

    this.app.get('/api/keys/verify/destroy', async (c) => {
      await this.state.storage.deleteAll()
    })

    this.app.get('/api/storage', async (c) => {
      const data = await this.state.storage.list();
      const storage = Object.fromEntries(data) as Storage; 

      return APIResponse(
        StatusCodes.OK,
        c.req.method,
        null,
        storage
      );
    })
  }

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}
