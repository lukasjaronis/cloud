import { DurableObjectState } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { APIResponse, StatusCodes } from "../utils/response";
import { z } from "zod";
import { Bindings } from "..";
import { Metric, metrics } from "../metrics/axiom";
import { dataFactory } from "../utils/factory";

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
  private metrics: Metric = metrics;
  private readonly timestamp = Math.floor(Date.now() / 1000);

  state: DurableObjectState;
  app: Hono<{ Bindings: Bindings }> = new Hono<{ Bindings: Bindings }>();

  constructor(state: DurableObjectState) {
    this.state = state;

    this.app.post("/object/create", async (c) => {
      const body = await c.req.json<Storage>();

      const validatedBody = storageSchema.safeParse(body);

      if (!validatedBody.success) {
        return APIResponse(StatusCodes.BAD_REQUEST, validatedBody.error.issues);
      }

      const t0 = performance.now();
      try {
        await this.state.storage.put(validatedBody.data);

        return APIResponse(StatusCodes.CREATED, validatedBody.data);
      } catch (error) {
        return APIResponse(
          StatusCodes.BAD_REQUEST,
          null,
          "Could not write to storage."
        );
      } finally {
        this.metrics.ingest({
          dataset: "core",
          fields: {
            event: "object-create",
            latency: performance.now() - t0,
          },
        });
      }
    });

    this.app.get("/object/verify", async () => {
      const t0 = performance.now();

      try {
        const maybeStaleStorage = (await this.state.storage.list()) as Map<
          keyof Storage,
          Storage[keyof Storage]
        >;
        const freshStorage = new Map(maybeStaleStorage);

        const uses = freshStorage.get('uses') as number
        const expires = freshStorage.get('expires') as number
        if (uses !== null) {
          if (uses == 0) {
            await this.state.storage.deleteAll()
          } 

          if (uses > 0) {
            freshStorage.set('uses', uses - 1)
          }
        }

        if (expires !== null) {
          if (this.timestamp > expires) {
            await this.state.storage.deleteAll()
          }
        }

        const freshStorageObject = Object.fromEntries(freshStorage)

        // Update storage
        await this.state.storage.put(freshStorageObject)

        return APIResponse(StatusCodes.OK, freshStorageObject)
      } catch (error) {
        return APIResponse(
          StatusCodes.BAD_REQUEST,
          null,
          "Could not access storage."
        );
      } finally {
        this.metrics.ingest({
          dataset: "core",
          fields: {
            event: "object-verify",
            latency: performance.now() - t0,
          },
        });
      }
    });

    this.app.post("/object/sync", async (c) => {
      const body = await c.req.json<Storage>();

      const t0 = performance.now();
      try {
        await this.state.storage.put(body);
      } catch (error) {
        return APIResponse(
          StatusCodes.BAD_REQUEST,
          null,
          "Could not write to storage."
        );
      } finally {
        this.metrics.ingest({
          dataset: "core",
          fields: {
            event: "object-sync",
            latency: performance.now() - t0,
          },
        });
      }
    });

    this.app.get("/object/destroy", async () => {
      const t0 = performance.now();
      try {
        await this.state.storage.deleteAll();
      } catch (error) {
        return APIResponse(
          StatusCodes.BAD_REQUEST,
          null,
          "Could not destroy storage."
        );
      } finally {
        this.metrics.ingest({
          dataset: "core",
          fields: {
            event: "object-destroy",
            latency: performance.now() - t0,
          },
        });
      }
    });

    this.app.get("/object/storage", async (c) => {
      const data = await this.state.storage.list();
      const storage = Object.fromEntries(data) as Storage;

      return APIResponse(StatusCodes.OK, storage);
    });
  }

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}
