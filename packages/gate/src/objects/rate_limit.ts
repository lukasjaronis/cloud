import { DurableObjectState } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { Bindings } from "..";
import { APIResponse, StatusCodes } from "../utils/response";
import { z } from "zod";
import { Storage, storageSchema } from "./storage";

export class RateLimitStorage {
  private readonly timestamp = Math.floor(Date.now() / 1000);
  state: DurableObjectState;
  app: Hono<{ Bindings: Bindings }> = new Hono();

  constructor(state: DurableObjectState) {
    this.state = state;

    /**
     * Responsible for creating a rate limiting durable object
     * with the same ID as the Gate durable object
     */
    this.app.post("/api/keys/create", async (c) => {
      const body = await c.req.json();

      // Creates an empty rate limiting queue for durable object
      await this.state.storage.put({
        queue: [],
      });

      return APIResponse( StatusCodes.CREATED, c.req.method, null, null);
    });

    /**
     * Responsible for verifying rate limits against gate storage
     * configs.
     */
    this.app.post("/api/keys/verify", async (c) => {
      const body = await c.req.json<Storage["rateLimit"]>();

      const validatedSchema = storageSchema.pick({ rateLimit: true }).transform((data) => {
        if (data.rateLimit && typeof data.rateLimit === 'object') {
          return data;
        } else {
          return null
        }
      }).safeParse(body)

      if (!validatedSchema.success) {
        return APIResponse(
          StatusCodes.BAD_REQUEST,
          c.req.method,
          validatedSchema.error.issues,
          null
        );
      }

      const data = await this.state.storage.list();
      const object = Object.fromEntries(data) as { queue: number[] };
      let queue = object.queue;

      return APIResponse(StatusCodes.OK, c.req.method, null, {
        allowed: true,
      });

      // const diff = Date.now() - validatedSchema.data.rateLimit?.timeframe

      // while (queue[queue.length - 1] <= diff) {
      //   queue.pop();
      // }

      // if (queue.length < body.requests) {
      //   queue.unshift(Date.now());

      //   await this.state.storage.put("queue", queue);

      //   return Response(c, StatusCodes.OK, c.req.method, null, {
      //     allowed: true,
      //   });
      // } else {
      //   await this.state.storage.put("queue", queue);

      //   return Response(
      //     c,
      //     StatusCodes.TOO_MANY_REQUESTS,
      //     c.req.method,
      //     "Too many requests in a short period of time, please try again.",
      //     { allowed: false }
      //   );
      // }
    });
  }

  async fetch(request: Request) {
    console.log("RateLimitStorage Fetch Invoked");
    return this.app.fetch(request);
  }
}
