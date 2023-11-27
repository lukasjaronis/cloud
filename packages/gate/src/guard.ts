import { z } from "zod";

// TODO: add rate limiting

export class Guard {
  private readonly store: GuardParams;
  private readonly timestamp = Math.floor(Date.now() / 1000);

  constructor(params: GuardParams) {
    this.store = params;
  }

  evaluate(): EvaluateReturnType {
    const usesEval = this.evalUses();
    const expirationEval = this.evalExpiration();

    /**
     * Not a fan of this current implementation.
     * Fix later
     */
    const state =
      usesEval.state === "delete" || expirationEval.state === "delete"
        ? "delete"
        : "update";

    const evaluateReturn: EvaluateReturnType = {
      state,
      uses: usesEval,
      expiration: expirationEval,
    };

    return evaluateReturn;
  }

  private evalUses(): EvaluationReturnType<{ uses: number }> {
    if (this.store.uses == null) {
      return { state: "idle", data: null };
    }

    if (this.store.uses === 0) {
      return { state: "delete", data: null };
    }

    /**
     * If .uses is neither null or 0, it is most likely higher than 0, that means
     * we can just invoke an update
     */

    return { state: "update", data: { uses: this.store.uses - 1 } };
  }

  private evalExpiration(): EvaluationReturnType<null> {
    if (this.store.expires == null) {
      return { state: "idle", data: null };
    } 

    console.log({
      timestamp: this.timestamp
    })

    // If current timestamp is higher than what the unix expiration is, return delete
    if (this.timestamp > this.store.expires) {
      // Expiration is expired
      return { state: "delete", data: null };
    }

    // If expiration has not yet met curent timestamp
    return { state: "idle", data: null };
  }
}

const guardSchema = z.object({
  expires: z.number().nullable(),
  uses: z.number().nullable(),
});

export type GuardParams = z.infer<typeof guardSchema>;

function evaluationReturnSchema<T>(data: z.ZodType<T>) {
  return z.object({
    state: z.enum(["idle", "update", "delete"]),
    data: data.nullable(),
  });
}

export type EvaluationReturnType<T> = z.infer<
  ReturnType<typeof evaluationReturnSchema<T>>
>;

const evaluateReturnSchema = z.object({
  state: z.enum(["delete", "update"]),
  uses: evaluationReturnSchema(z.object({})),
  expiration: evaluationReturnSchema(z.object({})),
});

export type EvaluateReturnType = z.infer<typeof evaluateReturnSchema>;
