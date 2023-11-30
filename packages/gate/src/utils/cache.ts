import { Buffer } from 'node:buffer';

export const getCacheKey = (id: string) => {
  const encoded = new TextEncoder().encode(JSON.stringify({ id }));
  const buffer = Buffer.from(encoded);
  return "https://worker.yebuntu.com/" + buffer.toString('base64');
}