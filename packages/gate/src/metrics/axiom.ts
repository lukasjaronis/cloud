import { Axiom } from '@axiomhq/js';

export class Metric {
  private axiom: Axiom = new Axiom({
    token: "...",
    orgId: "...",
  })

  constructor() {}

  send(dataset: string, fields: {}) {
    this.axiom.ingest(dataset, [{
      _time: Date.now(),
      ...fields
    }])
  }

  async flush() {
    try {
      await this.axiom.flush()
      console.log("Metrics sent to Axiom.")
    } catch (error) {
      console.error("Could not flush.")
    }
  }
}

export const metrics = new Metric()