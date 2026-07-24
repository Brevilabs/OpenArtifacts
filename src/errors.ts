/**
 * The error contract: every failure is `{error: {code, message}}` with the
 * status derived from the code, so the code is the stable thing clients match
 * on and the message stays free to change.
 */
export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "gone"
  | "too_large"
  | "quota_exceeded"
  | "internal";

const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  gone: 410,
  too_large: 413,
  quota_exceeded: 429,
  internal: 500,
};

/** The wire shape. Clients match on `code`; `message` is human-facing only. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export function errorResponse(code: ErrorCode, message: string, headers?: HeadersInit): Response {
  const body: ErrorBody = { error: { code, message } };
  return Response.json(body, { status: ERROR_STATUS[code], headers });
}
