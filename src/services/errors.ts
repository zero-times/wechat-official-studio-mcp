export type WechatErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "REQUEST_TIMEOUT"
  | "UPSTREAM_CHANGED"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE"
  | "WRITE_CONFIRMATION_REQUIRED"
  | "UPLOAD_ERROR"
  | "VALIDATION_ERROR";

export class WechatMcpError extends Error {
  constructor(
    public readonly code: WechatErrorCode,
    message: string,
    public readonly requiresCookieRefresh = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WechatMcpError";
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof WechatMcpError) {
    const writeResultAmbiguous = error.details?.write_result_ambiguous === true;
    return {
      ok: false,
      code: error.code,
      message: error.message,
      requires_cookie_refresh: error.requiresCookieRefresh,
      next_action: writeResultAmbiguous
        ? "Do not retry automatically. Inspect the WeChat material library or draft box first, then retry only after explicit confirmation."
        : error.requiresCookieRefresh
          ? "Run npm run configure-cookie in the MCP server directory, then call wechat_official_check_auth again."
          : "Inspect the error and retry only after correcting the request.",
      ...(error.details ? { details: error.details } : {}),
    };
  }

  return {
    ok: false,
    code: "UPSTREAM_ERROR",
    message: error instanceof Error ? error.message : String(error),
    requires_cookie_refresh: false,
  };
}
