import http from "k6/http";
import { check } from "k6";

export const options = {}

export default function () {
  const response = http.post(
    "",
    JSON.stringify({
      key: "",
    }),
    {
      headers: {
        "Authorization": "Bearer ...",
        "Content-Type": "application/json",
      }
    }
  );

  check(response, {
    "is200": (r) => r.status === 200,
  });
}
