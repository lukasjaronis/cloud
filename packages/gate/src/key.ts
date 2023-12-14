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
import base_x from 'base-x'
export class Key {
  private c: Context<{ Bindings: ENV }>;

  constructor(c: Context<{ Bindings: ENV }>) {
    this.c = c;
  }

  async create(params: KeyCreateParams) {
    const keyID = await this.computeId(params.prefix)
    const keyHash = await this.computeHash(keyID)

    const t0 = performance.now();
    try {
      const id = await this.computeId()
      const slug = this.computeIdSlug(keyID)

      const insertedKey = await this.c.env.GateDB.prepare(
        `insert into keys (id, slug, hash, expires, uses, metadata, maxTokens, tokens, refillRate, refillInterval) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, slug, keyHash, params.expires ?? null, params.uses ?? null, params.metadata ?? null, params.rateLimit?.maxTokens ?? null, params.rateLimit?.maxTokens ?? null, params.rateLimit?.refillRate ?? null, params.rateLimit?.refillInterval ?? null).run()

      if (insertedKey.success) {
        const value: DBKeyReturnType = {
          id,
          hash: keyHash,
          slug,
          expires: params.expires ?? undefined,
          uses: params.uses ?? undefined,
          metadata: JSON.stringify(params.metadata) ?? undefined,
          maxTokens: params.rateLimit?.maxTokens ?? undefined,
          tokens: params.rateLimit?.maxTokens ?? undefined,
          refillRate: params.rateLimit?.refillRate ?? undefined,
          refillInterval: params.rateLimit?.refillInterval ?? undefined,
          // lastFilled: data.rateLimit ? Date.now() : undefined,
        }

        cache.set({ domain:this.c.env.WORKER_DOMAIN, slug, value })

        metrics.ingest({
          dataset: "core",
          fields: {
            event: "key-create-d1",
            latency: performance.now() - t0,
          },
        });

        return APIResponse(StatusCodes.CREATED, {
          key: keyID,
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
    const keyID = await this.computeId(params.prefix)
    const keyHash = await this.computeHash(keyID)

    const t0 = performance.now();
    try {
      const id = await this.computeId()
      const slug = this.computeIdSlug(keyID)
      const insertedKey = await db.insert(keys).values({ id, slug, hash: keyHash, expires: params.expires, uses: params.uses, metadata: params.metadata, maxTokens: params.rateLimit?.maxTokens, tokens: params.rateLimit?.maxTokens, refillInterval: params.rateLimit?.refillInterval, refillRate: params.rateLimit?.refillRate })
    
      if (insertedKey.rowsAffected === 1) {
        const value: DBKeyReturnType = {
          id,
          hash: keyHash,
          slug,
          expires: params.expires ?? undefined,
          uses: params.uses ?? undefined,
          metadata: JSON.stringify(params.metadata) ?? undefined,
          maxTokens: params.rateLimit?.maxTokens ?? undefined,
          tokens: params.rateLimit?.maxTokens ?? undefined,
          refillRate: params.rateLimit?.refillRate ?? undefined,
          refillInterval: params.rateLimit?.refillInterval ?? undefined,
          // lastFilled: data.rateLimit ? Date.now() : undefined,
        }

        cache.set({ domain:this.c.env.WORKER_DOMAIN, slug, value })

        metrics.ingest({
          dataset: "core",
          fields: {
            event: "key-create-ps",
            latency: performance.now() - t0,
          },
        });

        return APIResponse(StatusCodes.CREATED, {
          key: keyID,
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
    const slug = this.computeIdSlug(params.key)

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
      cache.set({ value: state.object(), domain: this.c.env.WORKER_DOMAIN, slug })
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
    const slug = this.computeIdSlug(params.key)

    const cachedResponse = await cache.get({ domain:this.c.env.WORKER_DOMAIN, slug })
    const isResponse = typeof cachedResponse !== 'string'

    if (cachedResponse && isResponse && cachedResponse.ok) {
      const json = await cachedResponse.json<DBKeyReturnType>()
      state.setInitial(json)
    } else if (cachedResponse && !isResponse) {
      const json = JSON.parse(cachedResponse) as DBKeyReturnType
      state.setInitial(json)
    } else {
      // Verify cold
      const result = await db.query.keys.findFirst({ where: (table) => eq(table.slug, slug) })

      if (result) {
        state.setInitial(result as DBKeyReturnType)
      } else {
        return APIResponse(StatusCodes.NOT_FOUND, null, Errors.NOT_FOUND)
      }
    }

    if (state.object().uses !== null) {
      if (state.object().uses as number === 0) {
        this.c.executionCtx.waitUntil(Promise.all([
          db.delete(keys).where(eq(keys.slug, slug)),
          cache.remove({ domain:this.c.env.WORKER_DOMAIN, slug })
        ]))

        // Delete
        return APIResponse(StatusCodes.BAD_REQUEST, null, Errors.LIMITS_EXCEEDED)
      }
      if (state.object().uses as number > 0) {
        state.set('uses', state.object().uses as number - 1)

        this.c.executionCtx.waitUntil(
          db.update(keys).set({ uses: state.object().uses as number }).where(eq(keys.slug, slug)),
        )
      }
    }
    if (state.object().expires !== null) {
      if (Date.now() > (state.object().expires as number)) {
        this.c.executionCtx.waitUntil(Promise.all([
          db.delete(keys).where(eq(keys.slug, slug)),
          cache.remove({ domain:this.c.env.WORKER_DOMAIN, slug })
        ]))
        return APIResponse(StatusCodes.BAD_REQUEST, Errors.EXPIRATION_EXCEEDED)
      }
    }

    this.c.executionCtx.waitUntil(
      cache.set({ domain:this.c.env.WORKER_DOMAIN, slug, value:state.object() })
    )

    const isValid = await this.verifyHash(params.key, state.object().hash)

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
    const inputBuffer = new TextEncoder().encode(key)
    const digestBuffer = await crypto.subtle.digest('SHA-256', inputBuffer)
    const hashArray = Array.from(new Uint8Array(digestBuffer))
    const $hash = hashArray
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(""); 

    return $hash === hash
  }

  private async computeId(prefix?: string, bytes?: number) {
    const base = base_x('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz')
    const encoded = base.encode(crypto.webcrypto.getRandomValues(new Uint8Array(bytes ?? 16)))
    const result = [encoded]
    if (prefix) result.unshift(prefix)

    const key = result.join('-')
    return key
  }

  private async computeHash(input: string) {
    const inputBuffer = new TextEncoder().encode(input)
    const digestBuffer = await crypto.subtle.digest("SHA-256", inputBuffer)
    const hashArray = Array.from(new Uint8Array(digestBuffer))
    return hashArray
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  }

  private computeIdSlug(key: string) {
    const $key = /-/.test(key) ? key.split("-")[1] : key;

    const took = this.half($key);
    const id = this.bitShift(took);
    return id;
  }

  private half(str: string) {
    const byteSize = new Blob([str]).size;
    const half = Math.ceil(byteSize / 2);
    return str.slice(0, half);
  }

  private bitShift(str: string) {
    let id = "";
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      const randomizedCharCode = charCode ^ i;
      id += String.fromCharCode(randomizedCharCode);
    }

    return id;
  }
}

export const keyCreateSchema = z.object({
  prefix: z.string().optional(),
  keyBytes: z.number().optional(),
  rateLimit: dbKeyReturnSchema.pick({ maxTokens: true, refillInterval: true, refillRate: true }).optional()
}).merge(dbKeyReturnSchema.omit({
  id: true,
  slug: true,
  keyID: true,
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
