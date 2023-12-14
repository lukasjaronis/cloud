import { z } from 'zod'
import { D1Database } from "@cloudflare/workers-types";

export const envSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'production']).default('development'),
  WORKER_DOMAIN: z.string(),
  AXIOM_TOKEN: z.string(),
  AXIOM_ORG_ID: z.string(),
  AUTHENTICATION_TOKEN: z.string(),
  GateDB: z.custom<D1Database>(),
  PLANETSCALE_HOST: z.string(),
  PLANETSCALE_USERNAME: z.string(),
  PLANETSCALE_PASSWORD: z.string()
})

export type ENV = z.infer<typeof envSchema>