import { DurableObjectState } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { Response, StatusCodes } from "../utils/response";
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
    this.app.post("/api/keys/create", async (c) => {
      const body = await c.req.json<Storage>();

      const validatedBody = storageSchema.safeParse(body);

      if (!validatedBody.success) {
        return Response(
          c,
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

        return Response(c, StatusCodes.CREATED, c.req.method, null, null);
      } catch (error) {
        return Response(
          c,
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
    this.app.get("/api/keys/verify", async (c) => {
      try {
        const data = await this.state.storage.list();
        const object = Object.fromEntries(data) as Storage;

        const hasExceededLimits = await this.evaluateLimits(object);

        if (hasExceededLimits) {
          return Response(
            c,
            StatusCodes.UNAUTHORIZED,
            c.req.method,
            null,
            null
          )
        }

        return Response(
          c,
          StatusCodes.OK,
          c.req.method,
          null,
          object
        );
      } catch (error) {
        return Response(
          c,
          StatusCodes.BAD_REQUEST,
          c.req.method,
          "Could not access storage.",
          null
        );
      }
    });

    /**
     * Responsible for updating a durable object
     */
    // this.app.get("/api/keys/update", async (c) => {
    //   try {
    //     const body = await c.req.json<Omit<KeyUpdateParams, "key">>();
    //     const data = await this.state.storage.list();
    //     const object = Object.fromEntries(data) as Storage;

    //     const newData = deepMergeObjects(body, object);

    //     /**
    //      * Populate durable object
    //      */
    //     await Promise.allSettled(
    //       Object.entries(newData).map(async ([key, value]) => {
    //         await this.state.storage.put(key, value);
    //       })
    //     );

    //     return Response(c, StatusCodes.OK, c.req.method, null, null);
    //   } catch (error) {
    //     return Response(
    //       c,
    //       StatusCodes.BAD_REQUEST,
    //       c.req.method,
    //       "Could not access storage.",
    //       null
    //     );
    //   }
    // })
  }

  async evaluateLimits(params: Storage) {
    if (params.uses !== null) {
      /**
       * If uses = 0, storage should be deleted.
       */
      if (params.uses == 0) {
        await this.state.storage.deleteAll();
        return true;
      }

      /**
       * If uses > 0, update new uses.
       */
      if (params.uses > 0) {
        await this.state.storage.put("uses", params.uses - 1);
        return false;
      }
    }

    if (params.expires !== null) {
      /**
       * If current timestamp exceeds expiration date, storage should
       * be deleted.
       */
      if (this.timestamp > params.expires) {
        await this.state.storage.deleteAll();
        return true;
      }
    }

    return false;
  }

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}

function deepMergeObjects<T>(target: T, source: T): T {
  const merged = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      if (
        typeof source[key] === "object" &&
        !Array.isArray(source[key]) &&
        source[key] !== null
      ) {
        if (
          typeof merged[key] === "object" &&
          !Array.isArray(merged[key]) &&
          merged[key] !== null
        ) {
          merged[key] = deepMergeObjects(merged[key], source[key]);
        } else {
          merged[key] = { ...source[key] };
        }
      } else if (source[key] !== merged[key]) {
        merged[key] = source[key];
      }
    }
  }

  return merged;
}
