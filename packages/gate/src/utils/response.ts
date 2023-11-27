import { Context } from "hono"

export enum StatusCodes {
  "OK" = 200,
  "CREATED" = 201,
  "UNAUTHORIZED" = 401,
  "NOT_FOUND" = 404,
  "BAD_REQUEST" = 400
}

export type ResponseReturnType<T> = {
  method: Request['method']
  data: T | null
  error: string | null
}

export const Response = <T>(
  context: Context,
  statusCode: StatusCodes,
  method: Request['method'],
  error: string | Zod.IssueData[] | null,
  data: T | null
) => {
  return context.json({
    method,
    data,
    error
  }, statusCode);
};