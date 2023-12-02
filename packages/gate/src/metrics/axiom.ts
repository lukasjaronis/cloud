import { Axiom } from "@axiomhq/js";
import { z } from "zod";

const metricSchema = z.object({
  dataset: z.enum(["core"]),
  fields: z.object({
    event: z.string(),
    latency: z.number().optional(),
    custom: z.object({}).optional(),
  }),
});

type MetricSchema = z.infer<typeof metricSchema>;

export class Metric {
  private axiom: Axiom;

  constructor() {
    this.axiom = new Axiom({
      token: "...",
      orgId: "...",
    });
  }

  ingest(params: MetricSchema) {
    const validatedSchema = metricSchema.safeParse(params);

    if (!validatedSchema.success) {
      return new Error("Error parsing metric schema.");
    }

    const { dataset, fields } = validatedSchema.data;

    this.axiom.ingest(dataset, [
      {
        _time: Date.now(),
        ...fields,
      },
    ]);
  }

  async flush() {
    try {
      await this.axiom.flush();
    } catch (error) {
      console.error("Could not flush.");
    }
  }
}

export const metrics = new Metric();
