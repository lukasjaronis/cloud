import crypto from "node:crypto";
import { Storage } from "./objects/storage";
import { Context } from "hono";
import { ZodSchema, z } from "zod";
import { Bindings } from ".";
import { APIResponse, ResponseReturnType, StatusCodes } from "./utils/response";
import {
  CfProperties,
  RequestInfo,
  RequestInit,
} from "@cloudflare/workers-types";
import { Metric, metrics } from "./metrics/axiom";
import { getCacheKey } from "./utils/cache";

export const RESPONSE_CACHE_DURATION = 5 * 60;

export class Key {
  private readonly timestamp = Math.floor(Date.now() / 1000);
  private metrics: Metric = metrics;
  private c: Context<{ Bindings: Bindings }>;

  constructor(c: Context<{ Bindings: Bindings }>) {
    this.c = c;
  }

  async create(params: KeyCreateParams) {
    const validatedParams = keyCreateSchema.safeParse(params);

    if (!validatedParams.success) {
      return APIResponse(
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        validatedParams.error.issues,
        null
      );
    }

    const { identifier, bytes, keyValue } = this.computeKey({
      prefix: validatedParams.data.prefix,
    });

    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const key = validatedParams.data.prefix
      ? `${validatedParams.data.prefix}_${keyValue}`
      : keyValue;

    const {
      prefix: _unused_prefix,
      keyBytes: _unused_keybytes,
      ...data
    } = validatedParams.data;

    const beginObjectsFetch = performance.now();

    const gateObjectResponse = await this.fetchGateObject(
      identifier,
      this.c.req.url + '/object',
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          hash,
          ...data,
        }),
      }
    ) as Response

    // Think about this more
    // if (data.rateLimit !== null) {
    //   await this.fetchRateLimitObject(identifier, this.c.req.url, {
    //     method: "POST",
    //     headers: {
    //       "Content-Type": "application/json",
    //     },
    //     body: JSON.stringify(data.rateLimit),
    //   });
    // }

    this.metrics.send("metric.key.create", {
      latency: performance.now() - beginObjectsFetch,
    });

    if (gateObjectResponse.ok) {
      return APIResponse(StatusCodes.CREATED, this.c.req.method, null, {
        key,
      });
    }

    return gateObjectResponse;
  }

  async verify(params: KeyVerifyParams) {
    const validatedParams = keyVerifySchema.safeParse(params);

    if (!validatedParams.success) {
      return APIResponse(
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        validatedParams.error.issues,
        null
      );
    }

    const id = this.getObjectId({ key: params.key });

    const CACHE_KEY = getCacheKey(id)
  
    const beginGateObjectFetch = performance.now();
    const cachedResponse = await caches.default.match(CACHE_KEY) as Response | undefined

    if (cachedResponse && cachedResponse.ok) {
      const json = await cachedResponse.json<ResponseReturnType<Storage>>()
  
      if (json.data !== null) {
        let freshObject: Storage = json.data

        if (json.data.uses !== null) {

          if (json.data.uses == 0) {
            // Invalidate key & destroy object
            this.c.executionCtx.waitUntil(Promise.all([
              await caches.default.delete(CACHE_KEY),
              this.fetchGateObject(id, this.c.req.url + '/destroy')
            ]))

            return APIResponse(StatusCodes.OK, this.c.req.method, null, {
              isValid: false
            })
          }

          if (json.data.uses > 0) {
            freshObject['uses'] = json.data.uses - 1

            // Sync object
            this.c.executionCtx.waitUntil(this.fetchGateObject(id, this.c.req.url + '/sync', {
              method: 'POST',
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(freshObject)
            }))
          }
        }

        // Create a new cached response
        const newCacheResponse = new Response(JSON.stringify({ data: freshObject }), {
          status: cachedResponse.status,
          headers: cachedResponse.headers,
        });

        // We update the cache with the new fresh object for the next user
        await caches.default.put(CACHE_KEY, newCacheResponse)
        
        const isValid = await this.verifyHash({
          hash: json.data.hash,
          key: validatedParams.data.key,
        });

        this.metrics.send("metric.key.verify", {
          latency: performance.now() - beginGateObjectFetch,
          cached: true,
          data: freshObject
        });

        return APIResponse(StatusCodes.OK, this.c.req.method, null, {
          isValid,
        });
      }

      return APIResponse(StatusCodes.OK, this.c.req.method, null, {
        isValid: false,
      });
    } else {
      // Fetch DO
      const gateStorageResponse = await this.fetchGateObject(id, this.c.req.url + '/object') as Response

      if (gateStorageResponse.ok) {
        // Cache the fresh object response
     
        await caches.default.put(CACHE_KEY, gateStorageResponse.clone())

        // Fresh object
        const json = await gateStorageResponse.json<ResponseReturnType<Storage>>();

        /**
         * Since this object is fresh, we don't need to evaluate limits because it has already been done
         */

        this.metrics.send("metric.key.verify", {
          latency: performance.now() - beginGateObjectFetch,
          cached: false,
          data: json
        });

        if (json.data !== null) {
          const isValid = await this.verifyHash({
            hash: json.data.hash,
            key: validatedParams.data.key,
          });

          return APIResponse(StatusCodes.OK, this.c.req.method, null, {
            isValid,
          });
        }

        return APIResponse(StatusCodes.OK, this.c.req.method, null, {
          isValid: false,
        });
      }
    }
    
    return APIResponse(StatusCodes.OK, this.c.req.method, null, {
      isValid: false,
    });
  }
  
  private async verifyHash(params: KeyVerifiyHashParams) {
    const validatedParams = keyVerifySchema.safeParse(params);

    if (!validatedParams.success) {
      return APIResponse(
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        validatedParams.error.issues,
        null
      );
    }

    let prefix = "";
    let value = params.key;
    if (params.key.includes("_")) {
      const splitKey = params.key.split("_");
      prefix = splitKey[0];
      value = splitKey[1];
    }

    const valueBytes = this.hexToBytes(value);

    let prefixedBytes = valueBytes;

    if (prefix) {
      const prefixBytes = new TextEncoder().encode(prefix);
      const totalByteLength = prefixBytes.length + valueBytes.length;
      prefixedBytes = new Uint8Array(totalByteLength);
      prefixedBytes.set(prefixBytes);
      prefixedBytes.set(valueBytes, prefixBytes.length);
    }

    const hashBuffer = await crypto.subtle.digest("SHA-256", prefixedBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const computedHash = hashArray
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return computedHash === params.hash;
  }

  private computeKey(params: { prefix?: string; keyBytes?: number }) {
    const prefix = params?.prefix
      ? new TextEncoder().encode(params.prefix)
      : new Uint8Array();
    const key = crypto.webcrypto.getRandomValues(
      new Uint8Array(params?.keyBytes ?? 16)
    );

    // ----- Key computation
    const totalKeyByteLength = prefix.length + key.length;
    const computedKeyBytes = new Uint8Array(totalKeyByteLength);

    computedKeyBytes.set(prefix);
    computedKeyBytes.set(key, prefix.length);
    // -----

    // Hex key value
    const keyValue = this.bytesToHex(key);

    /**
     * Use bit shifting to create an identifier out of keyValue
     * note: KeyValue might or might not have a prefix
     */
    const took = this.take(keyValue);
    const identifier = this.getIdentifier(took);

    return {
      identifier,
      keyValue,
      bytes: computedKeyBytes,
    };
  }

  private take(str: string) {
    const byteSize = new Blob([str]).size;
    const half = Math.ceil(byteSize / 2);
    return str.slice(0, half);
  }

  private getIdentifier(str: string) {
    let id = "";
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      const randomizedCharCode = charCode ^ i;
      id += String.fromCharCode(randomizedCharCode);
    }

    return id;
  }

  private bytesToHex(bytes: Uint8Array) {
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  private hexToBytes(hex: string) {
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0, j = 0; i < hex.length; i += 2, j++) {
      bytes[j] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  private async fetchGateObject(
    id: string,
    input: RequestInfo<unknown, CfProperties<unknown>>,
    init?: RequestInit<CfProperties<unknown>>
  ) {
    try {
      const objectId = this.c.env.GateStorage.idFromName(id);
      const object = this.c.env.GateStorage.get(objectId);
      return object.fetch(input, init);
    } catch (error) {
      return APIResponse(
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        "Could not fetch storage object.",
        null
      );
    }
  }

  private async fetchRateLimitObject(
    id: string,
    input: RequestInfo<unknown, CfProperties<unknown>>,
    init?: RequestInit<CfProperties<unknown>>
  ) {
    try {
      const objectId = this.c.env.RateLimitStorage.idFromName(id);
      const object = this.c.env.RateLimitStorage.get(objectId);
      return object.fetch(input, init);
    } catch (error) {
      return APIResponse(
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        "Could not fetch ratelimiting storage object.",
        null
      );
    }
  }

  getObjectId(params: { key: string }) {
    const key = /_/.test(params.key) ? params.key.split("_")[1] : params.key;

    const took = this.take(key);
    const id = this.getIdentifier(took);
    return id;
  }
}

const keyCreateSchema = z.object({
  // Key compute params
  prefix: z.string().optional(),
  keyBytes: z.number().optional(),

  // Storage params
  expires: z.number().nullable(),
  uses: z.number().nullable(),
  metadata: z.object({}).nullable(),
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
});

export type KeyCreateParams = z.infer<typeof keyCreateSchema>;

const keyVerifySchema = z.object({
  key: z.string(),
});

export type KeyVerifyParams = z.infer<typeof keyVerifySchema>;

const keyVerifyHashSchema = z.object({
  hash: z.string(),
  key: z.string(),
});

export type KeyVerifiyHashParams = z.infer<typeof keyVerifyHashSchema>;

const keyUpdateSchema = z.object({
  key: z.string(),
  expires: z.number().nullable(),
  uses: z.number().nullable(),
  metadata: z.object({}).nullable(),
});

export type KeyUpdateParams = z.infer<typeof keyUpdateSchema>;
