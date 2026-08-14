export const SERVER_NAME = "wechat-official-studio-mcp-server";
export const SERVER_VERSION = "0.3.0";
export const WECHAT_BASE_URL = "https://mp.weixin.qq.com";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_CHARACTERS = 40_000;
export const MAX_REPORT_DAYS = 100;

export const READ_ONLY_BACKEND_PATHS = new Set([
  "/",
  "/cgi-bin/home",
  "/cgi-bin/appmsgpublish",
  "/cgi-bin/filepage",
  "/misc/appmsganalysis",
  "/misc/useranalysis",
]);

// ── Write-safe endpoint allowlisting ──

/** GET paths allowed for write-flow operations (includes all read paths plus editor context). */
export const WRITE_GET_PATHS = new Set([
  ...READ_ONLY_BACKEND_PATHS,
  "/cgi-bin/appmsg", // editor context
]);

/** POST paths allowed for write operations. */
export const WRITE_POST_PATHS = new Set([
  "/cgi-bin/filetransfer",  // material upload
  "/cgi-bin/uploadimg2cdn", // body image upload
  "/cgi-bin/operate_appmsg", // draft save
]);

// ── Upload policy ──

export const UPLOAD_ROOTS_ENV = "WECHAT_OFFICIAL_UPLOAD_ROOTS";
export const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MiB
export const MAX_HTML_SOURCE_SIZE = 2 * 1024 * 1024; // 2 MiB
export const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif"]);
export const ALLOWED_HTML_EXTENSIONS = new Set([".html", ".htm"]);
export const ALLOWED_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/gif"] as const;

// ── Draft validation ──

export const DRAFT_MIN_ARTICLES = 1;
export const DRAFT_MAX_ARTICLES = 8;
export const TITLE_MIN_LENGTH = 1;
export const TITLE_MAX_LENGTH = 64;
export const AUTHOR_MAX_LENGTH = 32;
export const DIGEST_MAX_LENGTH = 120;
export const CONTENT_HTML_MAX_LENGTH = 500_000;

export const FORBIDDEN_HTML_TAGS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "form",
]);

export const FORBIDDEN_URL_SCHEMES = new Set(["javascript:", "data:"]);
