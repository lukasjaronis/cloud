export enum StatusCodes {
  "OK" = 200,
  "CREATED" = 201,
  "UNAUTHORIZED" = 401,
  "NOT_FOUND" = 404,
  "BAD_REQUEST" = 400,
  "TOO_MANY_REQUESTS" = 429,
}

export type ResponseReturnType<T> = {
  method: Request["method"];
  data: T | null;
  error: string | null;
};

export const APIResponse = <T>(
  statusCode: StatusCodes,
  method: Request["method"],
  error: string | Zod.IssueData[] | null,
  data: T | null
) => {
  return new Response(JSON.stringify({ data, method, error }), {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": "86400",
      "Content-Type": "application/json",
    },
    status: statusCode,
  });
};
