import { Axiom } from "@axiomhq/js";
import { z } from "zod";
import { ENV } from "../env";

const metricSchema = z.object({
  dataset: z.enum(["core"]),
  fields: z.object({
    event: z.string(),
    latency: z.number().optional(),
    custom: z.object({
      data: z.record(z.any())
    }).optional(),
  }),
});

type MetricSchema = z.infer<typeof metricSchema>;

export class Metrics {
  private axiom: Axiom;

  constructor(env: ENV) {
    this.axiom = new Axiom({
      token: env.AXIOM_TOKEN,
      orgId: env.AXIOM_ORG_ID,
    });
  }

  ingest(params: MetricSchema) {
    const validatedSchema = metricSchema.safeParse(params);

    if (!validatedSchema.success) {
      return new Error("Error parsing metric schema.");
    }

    const { dataset, fields } = validatedSchema.data;

    this.axiom.ingest(dataset, {
      _time: Date.now(),
        ...fields,
    });
  }

  async flush() {
    try {
      await this.axiom.flush();
    } catch (error) {
      console.error("Could not flush.");
    }
  }
}
