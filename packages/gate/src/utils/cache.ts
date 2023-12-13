import { z } from 'zod'

export class Cache {
  constructor() { }

  getKey(params: CacheCreateKey) {
    return new URL(`${params.domain}/cache/${params.version}/${params.slug}`)
  }

  public async set(params: CacheSet) {
    const request = new Request(this.getKey(params))
    const response = new Response(JSON.stringify(params.body), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${5 * 60}`
      }
    })

    await caches.default.put(request, response)
  }

  public async remove(params: CacheDeleteKey) {
    await Promise.all([
      caches.default.delete(this.getKey(params).toString())
    ])
  }

  public async get(params: CacheGet) {
    const response = await caches.default.match(new Request(this.getKey(params)))
    if (!response || !response.ok) {
      // Cache miss
      return null
    }

    return response
  }
}

export const cacheCreateKeySchema = z.object({
  version: z.string().default('v0').optional(),
  domain: z.string(),
  slug: z.string()
})
export type CacheCreateKey = z.infer<typeof cacheCreateKeySchema>

export const cacheSetSchema = z.object({
  body: z.record(z.any())
}).merge(cacheCreateKeySchema)
export type CacheSet = z.infer<typeof cacheSetSchema>

export const cacheDeleteKeySchema = cacheCreateKeySchema
export type CacheDeleteKey = z.infer<typeof cacheDeleteKeySchema>

export const cacheGet = cacheCreateKeySchema
export type CacheGet = z.infer<typeof cacheGet>
