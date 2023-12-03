import { Buffer } from 'node:buffer';

export const getCacheKey = (domain: string, id: string) => {
  const encoded = new TextEncoder().encode(JSON.stringify({ id }));
  const buffer = Buffer.from(encoded);
  return domain + buffer.toString('base64');
}