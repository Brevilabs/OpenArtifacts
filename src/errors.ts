/**
 * The JSON error contract for publisher APIs and non-page serving failures.
 * The code is stable for clients to match; the message stays free to change.
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

/**
 * The one answer every publisher-facing endpoint gives for a doc that does not
 * exist, is not the caller's, or was deleted.
 *
 * It lives here rather than in each handler because being *identical* across
 * all three causes and all three endpoints is the point: a 403 on someone
 * else's doc, or a differently worded 404, would confirm that the id is real
 * and turn the id space into something worth probing. Two copies of this
 * message would be two places for that property to drift. The id is echoed back
 * only because the caller supplied it.
 */
export function docNotFound(docId: string): Response {
  return errorResponse("not_found", `No doc with id ${docId}.`);
}
