import { createHash } from "node:crypto";
import { WRITE_GET_PATHS, WRITE_POST_PATHS, WECHAT_BASE_URL } from "../constants.js";
import type { RuntimeConfig } from "../types.js";
import { loadRuntimeConfig } from "./config.js";
import { WechatMcpError } from "./errors.js";

type BackendResponse = {
  response: Response;
  finalUrl: URL;
  config: RuntimeConfig;
};

type Session = {
  token: string;
  cookieFingerprint: string;
  config: RuntimeConfig;
};

export type VerifiedSession = {
  session: Session;
  homeHtml: string;
};

type FetchImplementation = typeof fetch;

export type PublicArticleAuthentication = "auto" | "never" | "required";
export type PublicArticleResponse = {
  html: string;
  accessMode: "anonymous" | "authenticated";
};

const AUTH_TEXT_PATTERN =
  /(请重新登录|登录超时|登录失效|微信扫码登录|login\s*(expired|required)|invalid\s*(session|token))/i;
const PUBLIC_ARTICLE_CHALLENGE_PATTERN =
  /(环境异常|完成验证后即可继续访问|访问过于频繁|wappoc_appmsgcaptcha)/i;

export class WechatClient {
  private cachedSession?: Session;

  constructor(private readonly fetchImpl: FetchImplementation = fetch) {}

  private fingerprint(cookie: string): string {
    return createHash("sha256").update(cookie).digest("hex").slice(0, 16);
  }

  private validateBackendUrl(url: URL, method: "GET" | "POST"): void {
    const allowedPaths = method === "GET" ? WRITE_GET_PATHS : WRITE_POST_PATHS;
    if (url.origin !== WECHAT_BASE_URL || !allowedPaths.has(url.pathname)) {
      throw new WechatMcpError(
        "UPSTREAM_ERROR",
        `Blocked ${method} WeChat backend URL: ${url.origin}${url.pathname}`,
      );
    }
  }

  private async fetchWithTimeout(
    url: URL,
    config: RuntimeConfig,
    includeCookie: boolean,
    method: "GET" | "POST" = "GET",
    body?: BodyInit,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: {
          Accept: "text/html,application/json,text/csv;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.5",
          Referer: `${WECHAT_BASE_URL}/`,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36",
          "X-Requested-With": "XMLHttpRequest",
          ...(includeCookie ? { Cookie: config.cookie } : {}),
          ...(extraHeaders ?? {}),
        },
        body,
      });
    } catch (error) {
      if (
        error instanceof DOMException ||
        (error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`))
      ) {
        const isWrite = method === "POST";
        const requiresCookieRefresh = !isWrite && includeCookie;
        throw new WechatMcpError(
          "REQUEST_TIMEOUT",
          isWrite
            ? "The WeChat write request timed out and may have succeeded. Inspect the material library or draft box before any retry."
            : includeCookie
              ? "The authenticated WeChat request timed out. Check connectivity, then refresh the local cookie before retrying."
              : "The public WeChat request timed out before authentication was used. Check connectivity before retrying.",
          requiresCookieRefresh,
          isWrite ? { write_result_ambiguous: true } : undefined,
        );
      }
      throw new WechatMcpError(
        "UPSTREAM_ERROR",
        method === "POST"
          ? "The WeChat write connection failed and the result may be ambiguous."
          : "Could not reach WeChat.",
        false,
        method === "POST" ? { write_result_ambiguous: true } : undefined,
      );
    }
  }

  private async requestBackend(
    url: URL,
    method: "GET" | "POST" = "GET",
    body?: BodyInit,
    extraHeaders?: Record<string, string>,
  ): Promise<BackendResponse> {
    const config = await loadRuntimeConfig();
    let current = new URL(url);

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      this.validateBackendUrl(current, method);
      const response = await this.fetchWithTimeout(current, config, true, method, body, extraHeaders);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) break;
        const next = new URL(location, current);
        if (next.origin !== WECHAT_BASE_URL) {
          throw new WechatMcpError(
            "AUTH_EXPIRED",
            "WeChat redirected the request outside the authenticated backend.",
            true,
          );
        }
        if (/login|scanlogin|cgi-bin\/bizlogin/i.test(next.pathname + next.search)) {
          throw new WechatMcpError(
            "AUTH_EXPIRED",
            "The WeChat Official Platform session has expired.",
            true,
          );
        }
        if (method === "POST") {
          throw new WechatMcpError(
            "UPSTREAM_CHANGED",
            "WeChat redirected a write request. The result is ambiguous and the request was not replayed.",
            false,
            { write_result_ambiguous: true },
          );
        }
        current = next;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new WechatMcpError(
          "AUTH_EXPIRED",
          `WeChat rejected the session with HTTP ${response.status}.`,
          true,
        );
      }
      if (!response.ok) {
        throw new WechatMcpError(
          "UPSTREAM_ERROR",
          `WeChat returned HTTP ${response.status} ${response.statusText}.`,
          false,
          method === "POST" ? { write_result_ambiguous: true } : undefined,
        );
      }
      return { response, finalUrl: current, config };
    }

    throw new WechatMcpError("UPSTREAM_ERROR", "Too many redirects from WeChat.");
  }

  private detectAuthFailure(text: string): void {
    if (AUTH_TEXT_PATTERN.test(text) || /\/cgi-bin\/loginpage/i.test(text)) {
      throw new WechatMcpError(
        "AUTH_EXPIRED",
        "The WeChat response indicates that the login session has expired.",
        true,
      );
    }
  }

  /**
   * Perform a lightweight, real network check before an authenticated tool does
   * any account read or write. This deliberately does not trust cached tokens.
   */
  async verifyAuthentication(): Promise<VerifiedSession> {
    try {
      const session = await this.getSession();
      const url = new URL("/cgi-bin/home", WECHAT_BASE_URL);
      for (const [key, value] of Object.entries({
        t: "home/index",
        token: session.token,
        lang: "zh_CN",
      })) {
        url.searchParams.set(key, String(value));
      }
      const { response } = await this.requestBackend(url);
      const homeHtml = await response.text();
      this.detectAuthFailure(homeHtml);
      return { session, homeHtml };
    } catch (error) {
      // Never let a previously cached token bypass the next explicit check.
      this.cachedSession = undefined;
      throw error;
    }
  }

  private inspectJson(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const root = payload as Record<string, unknown>;
    const base =
      root.base_resp && typeof root.base_resp === "object"
        ? (root.base_resp as Record<string, unknown>)
        : undefined;
    const ret = Number(base?.ret ?? root.ret ?? 0);
    const message = String(base?.err_msg ?? root.err_msg ?? root.errmsg ?? "");
    if (ret !== 0) {
      if ([200003, 200013, -6, -14].includes(ret) || AUTH_TEXT_PATTERN.test(message)) {
        throw new WechatMcpError(
          "AUTH_EXPIRED",
          `WeChat rejected the current session (ret=${ret}).`,
          true,
        );
      }
      throw new WechatMcpError(
        "UPSTREAM_ERROR",
        `WeChat returned an upstream error (ret=${ret}).`,
        false,
        { ret },
      );
    }
  }

  async getSession(): Promise<Session> {
    const config = await loadRuntimeConfig();
    const cookieFingerprint = this.fingerprint(config.cookie);
    if (this.cachedSession?.cookieFingerprint === cookieFingerprint) {
      return { ...this.cachedSession, config };
    }
    if (config.token) {
      this.cachedSession = { token: config.token, cookieFingerprint, config };
      return this.cachedSession;
    }

    const { response, finalUrl } = await this.requestBackend(new URL("/", WECHAT_BASE_URL));
    const body = await response.text();
    this.detectAuthFailure(body);
    const token =
      finalUrl.searchParams.get("token") ||
      body.match(/[?&]token=(\d+)/)?.[1] ||
      body.match(/(?:token|t)\s*[:=]\s*["']?(\d+)/)?.[1];
    if (!token) {
      throw new WechatMcpError(
        "AUTH_EXPIRED",
        "A logged-in token could not be inferred from the WeChat backend response.",
        true,
      );
    }
    this.cachedSession = { token, cookieFingerprint, config };
    return this.cachedSession;
  }

  async getText(path: string, query: Record<string, string | number>): Promise<string> {
    const session = await this.getSession();
    const url = new URL(path, WECHAT_BASE_URL);
    for (const [key, value] of Object.entries({ ...query, token: session.token, lang: "zh_CN" })) {
      url.searchParams.set(key, String(value));
    }
    const { response } = await this.requestBackend(url);
    const text = await response.text();
    this.detectAuthFailure(text);
    return text;
  }

  async getJson(path: string, query: Record<string, string | number>): Promise<unknown> {
    const text = await this.getText(path, query);
    try {
      const payload = JSON.parse(text) as unknown;
      this.inspectJson(payload);
      return payload;
    } catch (error) {
      if (error instanceof WechatMcpError) throw error;
      throw new WechatMcpError(
        "UPSTREAM_CHANGED",
        "WeChat returned a non-JSON response where JSON was expected.",
      );
    }
  }

  async getReport(path: string, query: Record<string, string | number>): Promise<ArrayBuffer> {
    const session = await this.getSession();
    const url = new URL(path, WECHAT_BASE_URL);
    for (const [key, value] of Object.entries({ ...query, token: session.token, lang: "zh_CN" })) {
      url.searchParams.set(key, String(value));
    }
    const { response } = await this.requestBackend(url);
    const contentType = response.headers.get("content-type") || "";
    const buffer = await response.arrayBuffer();
    if (/json|html/i.test(contentType)) {
      const text = new TextDecoder().decode(buffer);
      this.detectAuthFailure(text);
      if (/json/i.test(contentType)) {
        try {
          this.inspectJson(JSON.parse(text) as unknown);
        } catch (error) {
          if (error instanceof WechatMcpError) throw error;
        }
      }
    }
    return buffer;
  }

  private validatePublicArticleUrl(urlValue: string): URL {
    const url = new URL(urlValue);
    if (
      url.origin !== WECHAT_BASE_URL ||
      !(url.pathname === "/s" || url.pathname === "/s/" || url.pathname.startsWith("/s/"))
    ) {
      throw new WechatMcpError(
        "UPSTREAM_ERROR",
        "Only public mp.weixin.qq.com/s article URLs are accepted.",
      );
    }
    return url;
  }

  private async fetchPublicArticleAttempt(
    initialUrl: URL,
    config: RuntimeConfig,
    includeCookie: boolean,
  ): Promise<{ html?: string; challenged: boolean }> {
    let url = new URL(initialUrl);
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const response = await this.fetchWithTimeout(url, config, includeCookie);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) break;
        const next = new URL(location, url);
        if (next.origin !== WECHAT_BASE_URL) {
          throw new WechatMcpError(
            "UPSTREAM_ERROR",
            "The public article redirected outside mp.weixin.qq.com.",
          );
        }
        if (/\/mp\/wappoc_appmsgcaptcha/i.test(next.pathname)) {
          return { challenged: true };
        }
        url = next;
        continue;
      }
      if (response.status === 403) return { challenged: true };
      if (!response.ok) {
        throw new WechatMcpError(
          "UPSTREAM_ERROR",
          `The public article returned HTTP ${response.status}.`,
        );
      }
      const html = await response.text();
      return PUBLIC_ARTICLE_CHALLENGE_PATTERN.test(html)
        ? { challenged: true }
        : { html, challenged: false };
    }
    throw new WechatMcpError("UPSTREAM_ERROR", "Too many redirects for the public article.");
  }

  async getPublicArticle(
    urlValue: string,
    authentication: PublicArticleAuthentication = "auto",
  ): Promise<PublicArticleResponse> {
    const url = this.validatePublicArticleUrl(urlValue);
    const anonymousConfig = await loadRuntimeConfig().catch(() => ({
      cookie: "",
      cookieSource: "cookie_file" as const,
      timeoutMs: 30_000,
    }));

    if (authentication !== "required") {
      const anonymous = await this.fetchPublicArticleAttempt(url, anonymousConfig, false);
      if (!anonymous.challenged && anonymous.html !== undefined) {
        return { html: anonymous.html, accessMode: "anonymous" };
      }
      if (authentication === "never") {
        throw new WechatMcpError(
          "PUBLIC_ARTICLE_CHALLENGE",
          "WeChat requires environment verification for this public article, and authenticated fallback is disabled.",
        );
      }
    }

    const { session } = await this.verifyAuthentication();
    const authenticated = await this.fetchPublicArticleAttempt(url, session.config, true);
    if (authenticated.challenged || authenticated.html === undefined) {
      throw new WechatMcpError(
        "PUBLIC_ARTICLE_CHALLENGE",
        "WeChat still requires environment verification after one authenticated retry.",
      );
    }
    return { html: authenticated.html, accessMode: "authenticated" };
  }

  // ── Write-safe methods ──

  /** Fetch the editor page HTML for a new draft (type=77). Returns raw HTML — never expose. */
  async getEditorPage(): Promise<string> {
    const session = await this.getSession();
    const url = new URL("/cgi-bin/appmsg", WECHAT_BASE_URL);
    url.searchParams.set("t", "media/appmsg_edit_v2");
    url.searchParams.set("action", "edit");
    url.searchParams.set("type", "77");
    url.searchParams.set("isNew", "1");
    url.searchParams.set("token", session.token);
    url.searchParams.set("lang", "zh_CN");

    const { response } = await this.requestBackend(url, "GET");
    const text = await response.text();
    this.detectAuthFailure(text);
    return text;
  }

  /** POST multipart form data (for image uploads). Returns parsed JSON. */
  async postMultipart(
    path: string,
    queryParams: Record<string, string>,
    formFields: Record<string, string>,
    fileField: string,
    filename: string,
    fileBuffer: Buffer,
    fileMime: string,
  ): Promise<unknown> {
    const session = await this.getSession();
    const url = new URL(path, WECHAT_BASE_URL);
    for (const [key, value] of Object.entries({ ...queryParams, token: session.token, lang: "zh_CN" })) {
      url.searchParams.set(key, String(value));
    }

    // Build multipart form data
    const boundary = `----WechatMcpBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    const crlf = "\r\n";
    for (const [key, value] of Object.entries(formFields)) {
      parts.push(Buffer.from(`--${boundary}${crlf}`));
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${key}"${crlf}${crlf}`));
      parts.push(Buffer.from(`${value}${crlf}`));
    }
    // File part
    parts.push(Buffer.from(`--${boundary}${crlf}`));
    parts.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${fileField}"; filename="${filename}"${crlf}`,
      ),
    );
    parts.push(Buffer.from(`Content-Type: ${fileMime}${crlf}${crlf}`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`${crlf}--${boundary}--${crlf}`));

    const body = Buffer.concat(parts);
    const extraHeaders = { "Content-Type": `multipart/form-data; boundary=${boundary}` };

    const { response } = await this.requestBackend(url, "POST", body, extraHeaders);
    const text = await response.text();
    this.detectAuthFailure(text);

    try {
      const payload = JSON.parse(text) as unknown;
      this.inspectJson(payload);
      return payload;
    } catch (error) {
      if (error instanceof WechatMcpError) throw error;
      throw new WechatMcpError(
        "UPSTREAM_CHANGED",
        "WeChat returned a non-JSON response after upload.",
        false,
        { write_result_ambiguous: true },
      );
    }
  }

  /** POST form-urlencoded data (for draft save). Returns parsed JSON. */
  async postForm(
    path: string,
    queryParams: Record<string, string>,
    formFields: Record<string, string>,
  ): Promise<unknown> {
    const session = await this.getSession();
    const url = new URL(path, WECHAT_BASE_URL);
    for (const [key, value] of Object.entries({ ...queryParams, token: session.token, lang: "zh_CN" })) {
      url.searchParams.set(key, String(value));
    }

    const body = new URLSearchParams(formFields).toString();
    const extraHeaders = { "Content-Type": "application/x-www-form-urlencoded" };

    const { response } = await this.requestBackend(url, "POST", body, extraHeaders);
    const text = await response.text();
    this.detectAuthFailure(text);

    try {
      const payload = JSON.parse(text) as unknown;
      this.inspectJson(payload);
      return payload;
    } catch (error) {
      if (error instanceof WechatMcpError) throw error;

      throw new WechatMcpError(
        "UPSTREAM_CHANGED",
        "WeChat returned a non-JSON response for the draft save.",
        false,
        { write_result_ambiguous: true },
      );
    }
  }
}
