import { z } from 'zod'

export class Cache {
  memoryCache = new Map() as Map<string | Request, string | Response>
  constructor() {}

  getKey({ domain, version = 'v0', slug }: CacheCreateKey) {
    return new URL(`https://${domain}/cache/${version}/${slug}`)
  }

  /**
   * Sets in-memory cache
   * Sets local cache (colo cache)
   */
  public async set(params: CacheSet) {
    const key = this.getKey(params).toString()
    const response = jsonResponse(params.value, {
      headers: {
        "Cache-Control": `max-age=${5 * 60}`
      }
    })
    
    this.memoryCache.set(key, JSON.stringify(params.value))
    await caches.default.put(key, response)
  }

  /**
   * Remove from in-memory
   * Remove from local cache (colo cache)
   */
  public async remove(params: CacheDeleteKey) {
    const key = this.getKey(params).toString()

    this.memoryCache.delete(key)
    await caches.default.delete(key)
  } 
  /**
   * Check in-memory cache
   * Check local cache (colo cache)
   */
  public async get(params: CacheGet) {
    const key = this.getKey(params).toString()

    return this.memoryCache.get(key) || await caches.default.match(key)
  }
}

export const cacheCreateKeySchema = z.object({
  version: z.string().default('v0').optional(),
  domain: z.string(),
  value: z.any(),
  slug: z.string()
})
export type CacheCreateKey = z.infer<typeof cacheCreateKeySchema>

export const cacheSetSchema = cacheCreateKeySchema
export type CacheSet = z.infer<typeof cacheSetSchema>

export const cacheDeleteKeySchema = cacheCreateKeySchema
export type CacheDeleteKey = z.infer<typeof cacheDeleteKeySchema>

export const cacheGet = cacheCreateKeySchema
export type CacheGet = z.infer<typeof cacheGet>

function jsonResponse(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
}