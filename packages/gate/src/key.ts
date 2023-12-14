import crypto from "node:crypto";
import { Context } from "hono";
import { z } from "zod";
import { APIResponse, Errors, StatusCodes } from "./utils/response";
import { dataFactory } from "./utils/factory";
import { ENV } from "./config/env";
import { metrics, cache, db } from ".";
import { DBKeyReturnType, dbKeyReturnSchema } from "./config/db/types";
import { keys } from "./config/db/schema";
import { eq } from 'drizzle-orm'

export class Key {
  private c: Context<{ Bindings: ENV }>;

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

    const t0 = performance.now();
    try {
      const id = this.computeKey({}).keyValue
      const insertedKey = await this.c.env.GateDB.prepare(
        `insert into keys (id, slug, hash, expires, uses, metadata, maxTokens, tokens, refillRate, refillInterval) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, slug, hash, data.expires ?? null, data.uses ?? null, data.metadata ?? null, data.rateLimit?.maxTokens ?? null, data.rateLimit?.maxTokens ?? null, data.rateLimit?.refillRate ?? null, data.rateLimit?.refillInterval ?? null).run()

      if (insertedKey.success) {
        const body: DBKeyReturnType = {
          id,
          slug,
          hash,
          expires: data.expires ?? undefined,
          uses: data.uses ?? undefined,
          metadata: JSON.stringify(data.metadata) ?? undefined,
          maxTokens: data.rateLimit?.maxTokens ?? undefined,
          tokens: data.rateLimit?.maxTokens ?? undefined,
          refillRate: data.rateLimit?.refillRate ?? undefined,
          refillInterval: data.rateLimit?.refillInterval ?? undefined,
          // lastFilled: data.rateLimit ? Date.now() : undefined,
        }

        cache.set({ input: body, domain: this.c.env.WORKER_DOMAIN, slug })

        metrics.ingest({
          dataset: "core",
          fields: {
            event: "key-create-d1",
            latency: performance.now() - t0,
          },
        });

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

  async createPS(params: KeyCreateParams) {
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

    const t0 = performance.now();
    try {
      const id = this.computeKey({}).keyValue
      const insertedKey = await db.db.insert(keys).values({ id, slug, hash, expires: data.expires, uses: data.uses, metadata: data.metadata, maxTokens: data.rateLimit?.maxTokens, tokens: data.rateLimit?.maxTokens, refillInterval: data.rateLimit?.refillInterval, refillRate: data.rateLimit?.refillRate })

      if (insertedKey.rowsAffected === 1) {
        const body: DBKeyReturnType = {
          id,
          slug,
          hash,
          expires: data.expires ?? undefined,
          uses: data.uses ?? undefined,
          metadata: JSON.stringify(data.metadata) ?? undefined,
          maxTokens: data.rateLimit?.maxTokens ?? undefined,
          tokens: data.rateLimit?.maxTokens ?? undefined,
          refillRate: data.rateLimit?.refillRate ?? undefined,
          refillInterval: data.rateLimit?.refillInterval ?? undefined,
          // lastFilled: data.rateLimit ? Date.now() : undefined,
        }

        cache.set({ input: body, domain: this.c.env.WORKER_DOMAIN, slug })

        metrics.ingest({
          dataset: "core",
          fields: {
            event: "key-create-ps",
            latency: performance.now() - t0,
          },
        });

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

    const cachedResponse = await cache.get({ domain: this.c.env.WORKER_DOMAIN, slug })
    const isResponse = typeof cachedResponse !== 'string'

    if (cachedResponse && isResponse && cachedResponse.ok) {
      const json = await cachedResponse.json<DBKeyReturnType>()
      state.setInitial(json)
    } else if (cachedResponse && !isResponse) {
      const json = JSON.parse(cachedResponse) as DBKeyReturnType
      state.setInitial(json)
    } else {
      // Verify cold
      const result = await this.c.env.GateDB.prepare('SELECT * FROM keys WHERE slug = ?').bind(slug).first<DBKeyReturnType>();
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
          cache.remove({ domain: this.c.env.WORKER_DOMAIN, slug })
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
          cache.remove({ domain: this.c.env.WORKER_DOMAIN, slug })
        ]))
        return APIResponse(StatusCodes.BAD_REQUEST, Errors.EXPIRATION_EXCEEDED)
      }
    }

    this.c.executionCtx.waitUntil(
      cache.set({ input: state.object() as DBKeyReturnType, domain: this.c.env.WORKER_DOMAIN, slug })
    )

    const isValid = await this.verifyHash(params.key, state.object().hash as string)

    metrics.ingest({
      dataset: "core",
      fields: {
        event: "key-verify-d1",
        latency: performance.now() - t0,
      },
    });

    return APIResponse(StatusCodes.OK, state.response<{ isValid: boolean, remaining?: number, expires?: number }>({ isValid, remaining: state.object().uses as number, expires: state.object().expires as number }))
  }

  async verifyPS(params: KeyVerifyParams) {
    const t0 = performance.now()
    const state = dataFactory<DBKeyReturnType>()

    const slug = this.getKeyID({ key: params.key })

    const cachedResponse = await cache.get({ domain: this.c.env.WORKER_DOMAIN, slug })
    const isResponse = typeof cachedResponse !== 'string'

    if (cachedResponse && isResponse && cachedResponse.ok) {
      const json = await cachedResponse.json<DBKeyReturnType>()
      state.setInitial(json)
    } else if (cachedResponse && !isResponse) {
      const json = JSON.parse(cachedResponse) as DBKeyReturnType
      state.setInitial(json)
    } else {
      // Verify cold
      const result = await db.db.query.keys.findFirst({ where: (table) => eq(table.slug, slug) })

      if (result) {
        state.setInitial(result as DBKeyReturnType)
      } else {
        return APIResponse(StatusCodes.NOT_FOUND, null, Errors.NOT_FOUND)
      }
    }

    if (state.object().uses !== null) {
      if (state.object().uses as number === 0) {
        this.c.executionCtx.waitUntil(Promise.all([
          db.db.delete(keys).where(eq(keys.slug, slug)),
          cache.remove({ domain: this.c.env.WORKER_DOMAIN, slug })
        ]))

        // Delete
        return APIResponse(StatusCodes.BAD_REQUEST, null, Errors.LIMITS_EXCEEDED)
      }
      if (state.object().uses as number > 0) {
        state.set('uses', state.object().uses as number - 1)

        this.c.executionCtx.waitUntil(
          db.db.update(keys).set({ uses: state.object().uses as number }).where(eq(keys.slug, slug)),
        )
      }
    }
    if (state.object().expires !== null) {
      if (Date.now() > (state.object().expires as number)) {
        this.c.executionCtx.waitUntil(Promise.all([
          db.db.delete(keys).where(eq(keys.slug, slug)),
          cache.remove({ domain: this.c.env.WORKER_DOMAIN, slug })
        ]))
        return APIResponse(StatusCodes.BAD_REQUEST, Errors.EXPIRATION_EXCEEDED)
      }
    }

    this.c.executionCtx.waitUntil(
      cache.set({ input: state.object() as DBKeyReturnType, domain: this.c.env.WORKER_DOMAIN, slug })
    )

    const isValid = await this.verifyHash(params.key, state.object().hash as string)

    metrics.ingest({
      dataset: "core",
      fields: {
        event: "key-verify-ps",
        latency: performance.now() - t0,
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
