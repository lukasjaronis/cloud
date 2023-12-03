import { z } from 'zod'
import { DurableObjectNamespace } from "@cloudflare/workers-types";

export const envSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'production']).default('development'),
  WORKER_DOMAIN: z.string(),
  AXIOM_TOKEN: z.string(),
  AXIOM_ORG_ID: z.string(),
  AUTHENTICATION_TOKEN: z.string(),
  GateStorage: z.custom<DurableObjectNamespace>((namespace) => typeof namespace === "object"),
  RateLimitStorage: z.custom<DurableObjectNamespace>((namespace) => typeof namespace === "object")
})

export type ENV = z.infer<typeof envSchema>