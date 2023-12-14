import { z } from 'zod'

export const dbTablesSchema = z.enum(['keys', 'rate_limit'])
export type DBTablesSchema = z.infer<typeof dbTablesSchema>

export const dbKeyReturnSchema = z.object({
  id: z.string(),
  slug: z.string(),
  hash: z.string(),
  expires: z.number().optional(),
  uses: z.number().optional(),
  metadata: z.string().optional(),
  maxTokens: z.number().optional(),
  tokens: z.number().optional(),
  refillRate: z.number().optional(),
  refillInterval: z.number().optional(),
  lastFilled: z.number().optional()
})

export type DBKeyReturnType = z.infer<typeof dbKeyReturnSchema>