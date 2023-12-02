export enum StatusCodes {
  "OK" = 200,
  "CREATED" = 201,
  "UNAUTHORIZED" = 401,
  "NOT_FOUND" = 404,
  "BAD_REQUEST" = 400,
  "TOO_MANY_REQUESTS" = 429,
}

export type ResponseReturnType<T> = {
  data: T | null;
  error: string | null;
};

export const APIResponse = <T>(
  statusCode: StatusCodes,
  data: T | null,
  error?: string | Zod.IssueData[],
) => {
  return new Response(JSON.stringify({ data, error }), {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
      "Content-Type": "application/json",
    },
    status: statusCode,
  });
};
