import {
  int,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const keys = mysqlTable("keys", {
  id: varchar("id", { length: 256 }).primaryKey(),
  slug: varchar("slug", { length: 256 }).notNull(),
  hash: varchar("hash", { length: 256 }).notNull(),
  expires: int('expires'),
  uses: int("uses"),
  metadata: text("metadata"),
  maxTokens: int("max_tokens"),
  tokens: int("tokens"),
  refillRate: int("refill_rate"),
  refillInterval: int("refill_interval")
}, (table) => ({
  hashIndex: uniqueIndex("hash_idx").on(table.hash),
  slugIndex: uniqueIndex("slug_idx").on(table.slug)
}))