import { Context } from "hono";

export const getHeaders = (c: Context) => {
  const clientIP = c.req.raw.headers.get("cf-connecting-ip")
  const clientIPCountry = c.req.raw.headers.get('cf-ipcountry')
  const userAgent = c.req.raw.headers.get('user-agent')

  return {
    clientIP,
    clientIPCountry,
    userAgent
  }
}