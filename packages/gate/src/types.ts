import { Context } from "hono";
import { getFormattedTimestamp } from "./utils/date";

export type ApiResponse<T> = {
  statusCode: number;
  method: string;
  message: string;
  data: T;
  created: string
};

export const apiResponse = (
  context: Context,
  message: string,
  statusCode: number,
  method: string,
  data: any | null
) => {
  const jsonResponse: ApiResponse<any> = {
    statusCode,
    message,
    method,
    data,
    created: getFormattedTimestamp()
  }
  
  return context.json(jsonResponse, statusCode)
};