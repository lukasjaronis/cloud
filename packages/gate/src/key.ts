import crypto from "node:crypto";
import { Storage } from "./objects/storage";
import { Context } from "hono";
import { z } from "zod";
import { Bindings } from ".";
import { APIResponse, ResponseReturnType, StatusCodes } from "./utils/response";
import {
  CfProperties,
  RequestInfo,
  RequestInit,
} from "@cloudflare/workers-types";
import { Metric, metrics } from "./metrics/axiom";
import { dataFactory } from "./utils/factory";
import { getCacheKey } from "./utils/cache";

export class Key {
  private c: Context<{ Bindings: Bindings }>;
  private metrics: Metric;
  private url: URL;

  constructor(c: Context<{ Bindings: Bindings }>) {
    this.c = c;
    this.metrics = metrics;
    this.url = new URL(c.req.url);
  }

  async create(params: KeyCreateParams) {
    const validatedParams = keyCreateSchema.safeParse(params);

    if (!validatedParams.success) {
      return APIResponse(
        StatusCodes.BAD_REQUEST,
        validatedParams.error.issues,
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

    const t0 = performance.now();

    const response = (await this.fetchGateObject(
      identifier,
      this.url.origin + "/object/create",
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
    )) as Response;

    // if (data.rateLimit !== null) {
    //   await this.fetchRateLimitObject(identifier, this.c.req.url, {
    //     method: "POST",
    //     headers: {
    //       "Content-Type": "application/json",
    //     },
    //     body: JSON.stringify(data.rateLimit),
    //   });
    // }

    this.metrics.ingest({
      dataset: "core",
      fields: {
        event: "key-create",
        latency: performance.now() - t0,
      },
    });

    if (response.ok) {
      const CACHE_KEY = getCacheKey(identifier)

      this.c.executionCtx.waitUntil(caches.default.put(CACHE_KEY, response.clone()))

      return APIResponse(StatusCodes.CREATED, {
        key,
      });
    }

    return response;
  }

  async verifyCold(
    validatedBody: KeyVerifyParams,
    objectId: string,
    cachekey: string
  ) {
    const data = dataFactory<Storage>()

    const t0 = performance.now();

    const response = (await this.fetchGateObject(
      objectId,
      this.url.origin + "/object/verify"
    )) as Response;

    if (response.ok) {
      // Clone before reading stream
      await caches.default.put(cachekey, response.clone());

      const json = await response.json<ResponseReturnType<Storage>>();

      if (json.data !== null) {
        data.setInitial(json.data);

        if (json.data.uses !== null && json.data.uses == 0) {
          return APIResponse(
            StatusCodes.OK,
            data.response<{ valid: boolean }>({ valid: false })
          );
        } 

        const isValid = await this.verifyHash(validatedBody.key, data.get("hash") as string);

        this.metrics.ingest({
          dataset: "core",
          fields: {
            event: "key-verify-not-cached",
            latency: performance.now() - t0,
            custom: json,
          },
        });

        return APIResponse(
          StatusCodes.OK,
          data.response<{ valid: boolean; remaining?: number }>({
            valid: isValid,
            remaining: data.get("uses") as number,
          }),
        );
      } else {
        return APIResponse(StatusCodes.OK, {
          isValid: false,
        });
      }
    }

    return response
  }

  async verifyHot(
    cachedResponse: Response,
    validatedBody: KeyVerifyParams,
    objectId: string,
    cacheKey: string
  ) {
    const data = dataFactory<Storage>()

    const t0 = performance.now();
    const json = await cachedResponse.json<ResponseReturnType<Storage>>();

    if (json.data !== null) {
      data.setInitial(json.data);

      if (json.data.uses !== null) {
        if (json.data.uses == 0) {
          this.c.executionCtx.waitUntil(
            Promise.all([
              // Invalidate cache
              caches.default.delete(cacheKey),
              // Destroy object
              this.fetchGateObject(
                objectId,
                this.url.origin + "/object/destroy"
              ),
            ])
          );

          return APIResponse(
            StatusCodes.OK, data.response<{ valid: boolean }>({ valid: false })
          )
        }

        if (json.data.uses > 0) {
          data.set("uses", json.data.uses - 1);

          // Sync object in the background
          this.c.executionCtx.waitUntil(
            this.fetchGateObject(objectId, this.url.origin + "/object/sync", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(data.object()),
            })
          );
        }
      }

      // Create a new cached response
      const newCacheResponse = new Response(
        JSON.stringify({ data: data.object() }),
        {
          status: cachedResponse.status,
          headers: cachedResponse.headers,
        }
      );

      // Cache is set before handler termination
      this.c.executionCtx.waitUntil(
        caches.default.put(cacheKey, newCacheResponse)
      );

      this.metrics.ingest({
        dataset: "core",
        fields: {
          event: "key-verify-cached",
          latency: performance.now() - t0,
        },
      });

      const isValid = await this.verifyHash(validatedBody.key, data.get('hash') as string);

      return APIResponse(
        StatusCodes.OK,
        data.response<{ valid: boolean; remaining?: number }>({
          valid: isValid,
          remaining: data.get("uses") as number,
        })
      );
    }

    return APIResponse(
      StatusCodes.OK, data.response<{ valid: boolean }>({ valid: false })
    )
  }

  private async verifyHash(key: string, hash: Storage['hash']) {
    const t0 = performance.now();

    let prefix = "";
    let value = key;
    if (key.includes("_")) {
      const splitKey = key.split("_");
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

    this.metrics.ingest({
      dataset: "core",
      fields: {
        event: "key-verify-hash",
        latency: performance.now() - t0,
      },
    });

    return computedHash === hash;
  }

  private computeKey(params: { prefix?: string; keyBytes?: number }) {
    const t0 = performance.now();
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

    this.metrics.ingest({
      dataset: "core",
      fields: {
        event: "key-compute",
        latency: performance.now() - t0,
      },
    });

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

  getObjectId(params: { key: string }) {
    const key = /_/.test(params.key) ? params.key.split("_")[1] : params.key;

    const took = this.take(key);
    const id = this.getIdentifier(took);
    return id;
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
        null,
        "Could not fetch storage object.",
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
        null,
        "Could not fetch ratelimiting storage object.",
      );
    }
  }
}

export const keyCreateSchema = z.object({
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

export const keyVerifySchema = z.object({
  key: z.string(),
});

export type KeyVerifyParams = z.infer<typeof keyVerifySchema>;

export const keyVerifyHashSchema = z.object({
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
