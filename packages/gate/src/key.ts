import crypto from "node:crypto";
import { Context } from "hono";
import { z } from "zod";
import { APIResponse, Errors, StatusCodes } from "./utils/response";
import { dataFactory } from "./utils/factory";
import { Cache } from "./utils/cache";
import { ENV } from "./env";
import { metrics } from ".";
import { DBKeyReturnType, dbKeyReturnSchema } from "./db/types";

export class Key {
  private c: Context<{ Bindings: ENV }>;
  private cache = new Cache()

  constructor(c: Context<{ Bindings: ENV }>) {
    this.c = c;
  }

  async create(params: KeyCreateParams) {
    const validatedParams = keyCreateSchema.safeParse(params);

    if (!validatedParams.success) {
      return APIResponse(
        StatusCodes.BAD_REQUEST,
        validatedParams.error.issues,
      );
    }

    const { slug, bytes, keyValue } = this.computeKey({
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

    // const t0 = performance.now();
    try {
      const insertedKey = await this.c.env.GateDB.prepare(
        `insert into keys (slug, hash, expires, uses, metadata) values (?, ?, ?, ?, ?)`
      ).bind(slug, hash, data.expires ?? null, data.uses ?? null, data.metadata ?? null).run()

      if (data.rateLimit) {
        const insertedRateLimit = await this.c.env.GateDB.prepare(
          `insert into rate_limits (keyID, maxTokens, tokens, refillRate, refillInterval, lastFilled) values (?, ?, ?, ?, ?, ?)`
        ).bind(insertedKey.meta.last_row_id, data.rateLimit.maxTokens, data.rateLimit.maxTokens, data.rateLimit.refillRate, data.rateLimit.refillInterval, Date.now()).run()

        if (!insertedRateLimit.success) {

          /**
           * If there is an error inserting into rate limit table
           * Delete the key
           */
          this.c.executionCtx.waitUntil(this.c.env.GateDB.prepare('delete from keys where id = ?').bind(insertedKey.meta.last_row_id).run())

          return APIResponse(StatusCodes.BAD_REQUEST, null, "Could not create rate_limit entry.")
        }
      }

      if (insertedKey.success) {
        const body: DBKeyReturnType = {
          id: insertedKey.meta.last_row_id,
          keyID: insertedKey.meta.last_row_id,
          slug,
          hash,
          expires: data.expires ?? undefined,
          uses: data.uses ?? undefined,
          metadata: JSON.stringify(data.metadata) ?? undefined,
          maxTokens: data.rateLimit?.maxTokens ?? undefined,
          tokens: data.rateLimit?.maxTokens ?? undefined,
          refillRate: data.rateLimit?.refillRate ?? undefined,
          refillInterval: data.rateLimit?.refillInterval ?? undefined,
          lastFilled: data.rateLimit ? Date.now() : undefined,
        }

        this.cache.set({ body, domain: this.c.env.WORKER_DOMAIN, slug })

        return APIResponse(StatusCodes.CREATED, {
          key,
        });
      } else {
        return APIResponse(StatusCodes.BAD_REQUEST, null, "Could not insert into DB.")
      }
    } catch (error) {
      console.log(error, 'error')
      return APIResponse(StatusCodes.BAD_REQUEST, null);
    }
  }

  async verify(params: KeyVerifyParams) {
    const t0 = performance.now()
    const state = dataFactory<DBKeyReturnType>()

    const slug = this.getKeyID({ key: params.key })

    const cachedDBResponse = await this.cache.get({ domain: this.c.env.WORKER_DOMAIN, slug })
  
    // Verify hot
    if (cachedDBResponse && cachedDBResponse.ok) {
      const json = await cachedDBResponse.json<DBKeyReturnType>()
      state.setInitial(json)
    } else {
      // Verify cold
      const result = await this.c.env.GateDB.prepare('SELECT keys.*, rate_limits.* FROM keys LEFT JOIN rate_limits ON keys.id = rate_limits.keyID WHERE keys.slug = ?').bind(slug).first<DBKeyReturnType>();
      if (result) {
        state.setInitial(result)
      } else {
        return APIResponse(StatusCodes.NOT_FOUND, null, Errors.NOT_FOUND)
      }
    }

    if (state.object().uses !== null) {
      if (state.object().uses as number === 0) {
        this.c.executionCtx.waitUntil(Promise.all([
          this.c.env.GateDB.prepare('DELETE FROM keys WHERE slug = ?').bind(slug).run(),
          this.cache.remove({ domain: this.c.env.WORKER_DOMAIN, slug })
        ]))

        // Delete
        return APIResponse(StatusCodes.BAD_REQUEST, null, Errors.LIMITS_EXCEEDED)
      }
      if (state.object().uses as number > 0) {
        state.set('uses', state.object().uses as number - 1)

        this.c.executionCtx.waitUntil(
          this.c.env.GateDB.prepare('UPDATE keys SET uses = ? WHERE slug = ?').bind(state.object().uses, slug).run()
        )
      }
    }
    if (state.object().expires !== null) {
      if (Date.now() > (state.object().expires as number)) {
        this.c.executionCtx.waitUntil(Promise.all([
          this.c.env.GateDB.prepare('DELETE FROM keys WHERE slug = ?').bind(slug).run(),
          this.cache.remove({ domain: this.c.env.WORKER_DOMAIN, slug })
        ]))
        return APIResponse(StatusCodes.BAD_REQUEST, Errors.EXPIRATION_EXCEEDED)
      }
    }

    this.c.executionCtx.waitUntil(
      this.cache.set({ body: state.object(), domain: this.c.env.WORKER_DOMAIN, slug })
    )

    const isValid = await this.verifyHash(params.key, state.object().hash as string)

    const cf = this.c.req.raw['cf']
  
    metrics.ingest({
      dataset: "core",
      fields: {
        event: "key-verify",
        latency: performance.now() - t0,
        custom: {
          data: {
            cacheStatus: cachedDBResponse?.headers.get('cf-cache-status'),
            datacenter: cachedDBResponse?.headers.get('cf-ray'),
            origin: {
              country: cf.country,
              city: cf.city,
              region: cf.region,
            }
          },
        },
      },
    });

    return APIResponse(StatusCodes.OK, state.response<{ isValid: boolean, remaining?: number, expires?: number }>({ isValid, remaining: state.object().uses as number, expires: state.object().expires as number }))
  }

  private async verifyHash(key: string, hash: Storage['hash']) {
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
    const slug = this.getSlug(took);

    return {
      slug,
      keyValue,
      bytes: computedKeyBytes,
    };
  }

  private take(str: string) {
    const byteSize = new Blob([str]).size;
    const half = Math.ceil(byteSize / 2);
    return str.slice(0, half);
  }

  private getSlug(str: string) {
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

  getKeyID(params: { key: string }) {
    const key = /_/.test(params.key) ? params.key.split("_")[1] : params.key;

    const took = this.take(key);
    const id = this.getSlug(took);
    return id;
  }
}

export const keyCreateSchema = z.object({
  prefix: z.string().optional(),
  keyBytes: z.number().optional(),
  rateLimit: dbKeyReturnSchema.pick({ maxTokens: true, refillInterval: true, refillRate: true }).optional()
}).merge(dbKeyReturnSchema.omit({
  id: true,
  keyID: true,
  slug: true,
  hash: true,
  maxTokens: true,
  refillInterval: true,
  refillRate: true,
  lastFilled: true,
  tokens: true
}));

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
