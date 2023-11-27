import { DurableObjectState } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { Response, StatusCodes } from "./utils/response";
import { z } from "zod";
import { EvaluateReturnType, Guard } from "./guard";

const storageSchema = z.object({
  hash: z.string(),
  expires: z.number().nullable(),
  uses: z.number().nullable(),
});

export type Storage = z.infer<typeof storageSchema>;

export const storageVerifyReturnTypeSchema = z.object({
  isDeleted: z.boolean(),
  hash: z.string()
});

export type StorageVerifyReturnType = z.infer<
  typeof storageVerifyReturnTypeSchema
>;

export type FilterType = Omit<EvaluateReturnType, "state">;

export class GateStorage {
  state: DurableObjectState;
  app: Hono = new Hono();

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
        /**
         * Populate durable object
         */
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
          "Could not store in durable object.",
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
        const guard = new Guard(object);

        console.log(object, 'object')

        const evaluations = guard.evaluate();

        if (evaluations.state === "delete") {
          /**
           * Regardless of any updates to make, if the state comes back as 'delete',
           * we will delete the entire object.
           *
           * At this point the user calling this API will be able to access
           * the endpoint, but the object itself will be deleted here.
           */

          try {
            await this.state.storage.deleteAll();

            return Response(
              c,
              StatusCodes.OK,
              c.req.method,
              null,
              Object.fromEntries(data.set("isDeleted", true))
            );
          } catch (error) {
            return Response(
              c,
              StatusCodes.BAD_REQUEST,
              c.req.method,
              "Failed to nuke object.",
              null
            );
          }
        }

        if (evaluations.state === "update") {
          /**
           * If the state comes back as 'changed', we will update the object.
           */

          const filtered = Object.keys(evaluations)
            .filter((key): key is keyof FilterType => key !== "state")
            .reduce((obj: FilterType, key) => {
              const k = key as keyof typeof evaluations;
              if (k !== "state") {
                obj[key] = evaluations[k];
              }

              return obj;
            }, {} as FilterType);

          for (const key in filtered) {
            const typedKey = key as keyof FilterType;

            // We can ignore 'idle' states
            if (
              filtered[typedKey].state === "update" &&
              filtered[typedKey].data !== null
            ) {
              // Invoke storage put

              for (const key in filtered[typedKey].data) {
                // @ts-expect-error // TODO: fix this later
                await this.state.storage.put(key, filtered[typedKey].data[key]);
              }
            }
          }
        }

        return Response(
          c,
          StatusCodes.OK,
          c.req.method,
          null,
          Object.fromEntries(data)
        );
      } catch (error) {
        return Response(
          c,
          StatusCodes.BAD_REQUEST,
          c.req.method,
          "Could not store in durable object.",
          {
            stored: false,
          }
        );
      }
    });
  }

  async fetch(request: Request) {
    return this.app.fetch(request);
  }
}
