import type { Config } from "drizzle-kit";

export default {
  schema: "./src/config/db/schema.ts",
  out: "./src/config/db/drizzle",
  driver: "mysql2",
  dbCredentials: {
    uri: process.env.PLANETSCALE_URI as string
  },
} satisfies Config;

  