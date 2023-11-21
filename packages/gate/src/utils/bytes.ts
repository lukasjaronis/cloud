import crypto from "node:crypto";

export type GetRandomParams = {
  bytes?: number
  prefix?: string
}

export const generateBytes = (params?: GetRandomParams) => { 
  const prefix = params?.prefix ? new TextEncoder().encode(params.prefix) : new Uint8Array()
  const bytes = crypto.webcrypto.getRandomValues(new Uint8Array(params?.bytes ?? 16))
  const totalBytelength = prefix.length + bytes.length
  // TODO: I feel like a better name here would be ideal
  const prefixedBytes = new Uint8Array(totalBytelength)

  prefixedBytes.set(prefix)
  prefixedBytes.set(bytes, prefix.length)

  const value = bytesToValue(bytes)

  return {
    value,
    bytes: prefixedBytes
  }
}

export const bytesToValue = (bytes: Uint8Array) => {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}