import crypto from "node:crypto";
import { StorageVerifyReturnType } from "./storage";
import { Context } from "hono";
import { z } from "zod";
import { Bindings } from ".";
import { Response, ResponseReturnType, StatusCodes } from "./utils/response";
import { CfProperties } from "@cloudflare/workers-types";

export class Key {
  private c: Context<{ Bindings: Bindings }>;

  constructor(c: Context<{ Bindings: Bindings }>) {
    this.c = c;
  }

  async create(params: KeyCreateParams) {
    const validatedParams = keyCreateSchema.safeParse(params);

    if (!validatedParams.success) {
      return Response(
        this.c,
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        validatedParams.error.issues,
        null
      );
    }

    const { identifier, bytes, keyValue } = this.computeKey({
      prefix: validatedParams.data.prefix,
    });

    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const key = validatedParams.data.prefix
      ? `${validatedParams.data.prefix}_${keyValue}`
      : keyValue;

    const data = {
      hash,
      expires: validatedParams.data.expires,
      uses: validatedParams.data.uses,
    };

    const response = await this.fetchObject(identifier, this.c.req.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (response.ok) {
      return Response(this.c, StatusCodes.CREATED, this.c.req.method, null, {
        key,
      });
    }

    return response as Response;
  }

  async verify(params: KeyVerifyParams) {
    const validatedParams = keyVerifySchema.safeParse(params);

    if (!validatedParams.success) {
      return Response(
        this.c,
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        validatedParams.error.issues,
        null
      );
    }

    const key = /_/.test(params.key) ? params.key.split("_")[1] : params.key;

    const took = this.take(key);
    const id = this.getIdentifier(took);

    const response = await this.fetchObject(id, this.c.req.url);

    if (response.ok) {
      const json =
        await response.json<ResponseReturnType<StorageVerifyReturnType>>();

      if (json.data) {
        /**
         * Any invalidation will result in the object
         * being deleted and thus throwing an invalid key response.
         */
        if (json.data.isDeleted) {
          return Response(this.c, StatusCodes.OK, this.c.req.method, null, {
            isValid: false,
          });
        }

        const isValid = await this.verifyHash({
          hash: json.data.hash,
          key: validatedParams.data.key,
        });

        return Response(this.c, StatusCodes.OK, this.c.req.method, null, {
          isValid,
        });
      } else {
        return Response(
          this.c,
          StatusCodes.BAD_REQUEST,
          this.c.req.method,
          "There was a problem retrieving storage data.",
          null
        );
      }
    }

    return response as Response;
  }

  private async verifyHash(params: KeyVerifiyHashParams) {
    const validatedParams = keyVerifySchema.safeParse(params);

    if (!validatedParams.success) {
      return Response(
        this.c,
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        validatedParams.error.issues,
        null
      );
    }

    let prefix = "";
    let value = params.key;
    if (params.key.includes("_")) {
      const splitKey = params.key.split("_");
      prefix = splitKey[0];
      value = splitKey[1];
    }

    const valueBytes = this.hexToBytes(value);

    let prefixedBytes = valueBytes;

    if (prefix) {
      const prefixBytes = new TextEncoder().encode(prefix);
      const totalByteLength = prefixBytes.length + valueBytes.length;
      prefixedBytes = new Uint8Array(totalByteLength);
      prefixedBytes.set(prefixBytes);
      prefixedBytes.set(valueBytes, prefixBytes.length);
    }

    const hashBuffer = await crypto.subtle.digest("SHA-256", prefixedBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const computedHash = hashArray
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return computedHash === params.hash;
  }

  private computeKey(params: { prefix?: string; keyBytes?: number }) {
    const prefix = params?.prefix
      ? new TextEncoder().encode(params.prefix)
      : new Uint8Array();
    const key = crypto.webcrypto.getRandomValues(
      new Uint8Array(params?.keyBytes ?? 16)
    );

    // ----- Key computation
    const totalKeyByteLength = prefix.length + key.length;
    const computedKeyBytes = new Uint8Array(totalKeyByteLength);

    computedKeyBytes.set(prefix);
    computedKeyBytes.set(key, prefix.length);
    // -----

    // Hex key value
    const keyValue = this.bytesToHex(key);

    /**
     * Use bit shifting to create an identifier out of keyValue
     * note: KeyValue might or might not have a prefix
     */
    const took = this.take(keyValue);
    const identifier = this.getIdentifier(took);

    return {
      identifier,
      keyValue,
      bytes: computedKeyBytes,
    };
  }

  private take(str: string) {
    const byteSize = new Blob([str]).size;
    const half = Math.ceil(byteSize / 2);
    return str.slice(0, half);
  }

  private getIdentifier(str: string) {
    let id = "";
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      const randomizedCharCode = charCode ^ i;
      id += String.fromCharCode(randomizedCharCode);
    }

    return id;
  }

  private bytesToHex(bytes: Uint8Array) {
    return Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  private hexToBytes(hex: string) {
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0, j = 0; i < hex.length; i += 2, j++) {
      bytes[j] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }

  private async fetchObject(
    id: string,
    input: RequestInfo<unknown, CfProperties<unknown>>,
    init?: RequestInit<CfProperties<unknown>>
  ) {
    try {
      const objectId = this.c.env.GateStorage.idFromName(id);
      const object = this.c.env.GateStorage.get(objectId);
      return object.fetch(input, init);
    } catch (error) {
      return Response(
        this.c,
        StatusCodes.BAD_REQUEST,
        this.c.req.method,
        "Could not fetch storage object.",
        null
      );
    }
  }
}

const keyCreateSchema = z.object({
  // Key compute params
  prefix: z.string().optional(),
  keyBytes: z.number().optional(),

  // Storage params
  expires: z.number().nullable(),
  uses: z.number().nullable(),
  metadata: z.object({}).nullable()
});

export type KeyCreateParams = z.infer<typeof keyCreateSchema>;

const keyVerifySchema = z.object({
  key: z.string(),
});

export type KeyVerifyParams = z.infer<typeof keyVerifySchema>;

const keyVerifyHashSchema = z.object({
  hash: z.string(),
  key: z.string(),
});

export type KeyVerifiyHashParams = z.infer<typeof keyVerifyHashSchema>;
