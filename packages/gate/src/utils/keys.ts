import crypto from "node:crypto";
import { generateBytes } from "./bytes";

export type CreateKeyParams = {
  /**
   * Prefix for key.
   *
   * @default Empty
   */
  prefix?: string;
  /**
   * Timestamp in UNIX on when this key expires.
   *
   * @default Never
   */
  expires?: number;
  /**
   * Number of uses this key has before it gets removed from KV
   *
   * @default Unlimited
   */
  uses?: number;

  bytes?: number;

  /**
   * Metadata
   */
  metadata?: {};
};

/**
 *
 * This will return the hash to the authorization party and
 * store the key in KV.
 */
export const createKey = async (params?: CreateKeyParams) => {
  const { bytes, value } = generateBytes({
    prefix: params?.prefix,
    bytes: params?.bytes,
  });
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return {
    value: params?.prefix ? `${params.prefix}_${value}` : value,
    hash,
  };
};

export type VerifyKeyParams = {
  key: string;
  hex: string;
};

export const verifyKey = async (props: VerifyKeyParams) => {
  const data = new TextEncoder().encode(props.key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return hex === props.hex;
};
