import { readFile } from "node:fs/promises";
import { realpathSync, statSync, readFileSync } from "node:fs";
import { dirname, resolve, extname, basename, relative, isAbsolute, sep, parse as parsePath } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import {
  DEFAULT_TIMEOUT_MS,
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_SIZE,
  MAX_HTML_SOURCE_SIZE,
  ALLOWED_HTML_EXTENSIONS,
  UPLOAD_ROOTS_ENV,
} from "../constants.js";
import type { RuntimeConfig } from "../types.js";
import { WechatMcpError } from "./errors.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function normalizeCookie(value: string): string {
  return value.trim().replace(/^Cookie\s*:\s*/i, "").replace(/[\r\n]+/g, "");
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const envPath = process.env.WECHAT_OFFICIAL_ENV_FILE || resolve(projectRoot, ".env");
  const parsedEnv = parse((await readOptionalFile(envPath)) || "");
  const cookieFile =
    process.env.WECHAT_OFFICIAL_COOKIE_FILE ||
    parsedEnv.WECHAT_OFFICIAL_COOKIE_FILE ||
    resolve(projectRoot, ".wechat-cookie");
  const inlineCookie = process.env.WECHAT_OFFICIAL_COOKIE || parsedEnv.WECHAT_OFFICIAL_COOKIE;
  const fileCookie = inlineCookie ? undefined : await readOptionalFile(cookieFile);
  const cookie = normalizeCookie(inlineCookie || fileCookie || "");

  if (!cookie || cookie.length < 20 || !cookie.includes("=")) {
    throw new WechatMcpError(
      "AUTH_REQUIRED",
      "No valid local WeChat Official Platform cookie is configured.",
      true,
    );
  }

  const timeoutValue =
    process.env.WECHAT_OFFICIAL_TIMEOUT_MS ||
    parsedEnv.WECHAT_OFFICIAL_TIMEOUT_MS ||
    String(DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number(timeoutValue);

  return {
    cookie,
    cookieSource: inlineCookie ? "environment" : "cookie_file",
    token: process.env.WECHAT_OFFICIAL_TOKEN || parsedEnv.WECHAT_OFFICIAL_TOKEN || undefined,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 120_000
        ? timeoutMs
        : DEFAULT_TIMEOUT_MS,
  };
}

export { projectRoot };

// ── Upload path policy ──

export type ValidatedImage = {
  resolvedPath: string;
  buffer: Buffer;
  filename: string;
  mime: (typeof ALLOWED_IMAGE_MIME_TYPES)[number];
  size: number;
};

export type ValidatedHtmlSource = {
  resolvedPath: string;
  html: string;
  filename: string;
  size: number;
};

const MAGIC_BYTES: Record<string, number[]> = {
  "image/jpeg": [0xff, 0xd8],
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/gif": [0x47, 0x49, 0x46],
};

const EXTENSION_MIME: Record<string, (typeof ALLOWED_IMAGE_MIME_TYPES)[number]> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
};

function detectImageMime(buffer: Buffer): (typeof ALLOWED_IMAGE_MIME_TYPES)[number] {
  for (const [mime, bytes] of Object.entries(MAGIC_BYTES)) {
    if (bytes.every((b, i) => buffer[i] === b)) {
      return mime as (typeof ALLOWED_IMAGE_MIME_TYPES)[number];
    }
  }
  throw new WechatMcpError(
    "UPLOAD_ERROR",
    "File does not have a valid JPEG, PNG, or GIF magic-byte signature.",
  );
}

function resolveUploadRoots(): string[] {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parse(readFileSync(resolve(projectRoot, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new WechatMcpError("UPLOAD_ERROR", "The local environment file could not be read.");
    }
  }
  const raw = process.env[UPLOAD_ROOTS_ENV] || fileEnv[UPLOAD_ROOTS_ENV];
  if (!raw || !raw.trim()) {
    throw new WechatMcpError(
      "UPLOAD_ERROR",
      `Uploads are disabled because ${UPLOAD_ROOTS_ENV} is not set. ` +
        "Set it to one or more colon-separated allowed directory paths.",
    );
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  return raw.split(delimiter).filter(Boolean).map((rootValue, index) => {
    try {
      const root = realpathSync(rootValue);
      if (!statSync(root).isDirectory()) throw new Error("not-directory");
      const filesystemRoot = parsePath(root).root;
      const userHome = realpathSync(homedir());
      if (root === filesystemRoot || root === userHome) {
        throw new WechatMcpError(
          "UPLOAD_ERROR",
          `Upload root #${index + 1} is too broad. Configure a dedicated image directory.`,
        );
      }
      return root;
    } catch {
      throw new WechatMcpError(
        "UPLOAD_ERROR",
        `Upload root #${index + 1} does not exist, is inaccessible, or is not a safe directory.`,
      );
    }
  });
}

function isUnderRoot(resolvedPath: string, root: string): boolean {
  const child = relative(root, resolvedPath);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

export function validateImageFile(filePath: string): ValidatedImage {
  const resolvedPath = (() => {
    try {
      return realpathSync(filePath);
    } catch {
      throw new WechatMcpError("UPLOAD_ERROR", "The selected image file was not found or is inaccessible.");
    }
  })();

  const roots = resolveUploadRoots();
  const allowed = roots.some((root) => isUnderRoot(resolvedPath, root));
  if (!allowed) {
    throw new WechatMcpError(
      "UPLOAD_ERROR",
      `File is not inside an allowed upload root. ` +
        `Check ${UPLOAD_ROOTS_ENV}.`,
    );
  }

  const ext = extname(resolvedPath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    throw new WechatMcpError(
      "UPLOAD_ERROR",
      `File extension "${ext}" is not allowed. ` +
        "Only JPEG (.jpg/.jpeg), PNG (.png), and GIF (.gif) are accepted.",
    );
  }

  const st = (() => {
    try {
      return statSync(resolvedPath);
    } catch {
      throw new WechatMcpError("UPLOAD_ERROR", `Cannot stat file: ${basename(resolvedPath)}`);
    }
  })();

  if (!st.isFile()) {
    throw new WechatMcpError("UPLOAD_ERROR", "Path does not point to a regular file.");
  }
  if (st.size === 0) {
    throw new WechatMcpError("UPLOAD_ERROR", "File is empty.");
  }
  if (st.size > MAX_UPLOAD_SIZE) {
    throw new WechatMcpError(
      "UPLOAD_ERROR",
      `File size ${st.size} bytes exceeds the maximum of ${MAX_UPLOAD_SIZE} bytes (10 MiB).`,
    );
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(resolvedPath);
  } catch {
    throw new WechatMcpError("UPLOAD_ERROR", `Cannot read file: ${basename(resolvedPath)}`);
  }

  const mime = detectImageMime(buffer);
  const filename = basename(resolvedPath);
  if (EXTENSION_MIME[ext] !== mime) {
    throw new WechatMcpError(
      "UPLOAD_ERROR",
      "The image extension does not match its detected file type.",
    );
  }
  if (/["\r\n]/.test(filename)) {
    throw new WechatMcpError("UPLOAD_ERROR", "The image filename contains unsupported characters.");
  }

  return { resolvedPath, buffer, filename, mime, size: st.size };
}

export function validateHtmlSourceFile(filePath: string): ValidatedHtmlSource {
  const resolvedPath = (() => {
    try {
      return realpathSync(filePath);
    } catch {
      throw new WechatMcpError(
        "VALIDATION_ERROR",
        "The selected HTML source file was not found or is inaccessible.",
      );
    }
  })();

  const roots = resolveUploadRoots();
  if (!roots.some((root) => isUnderRoot(resolvedPath, root))) {
    throw new WechatMcpError(
      "VALIDATION_ERROR",
      `HTML source is not inside an allowed local root. Check ${UPLOAD_ROOTS_ENV}.`,
    );
  }

  const ext = extname(resolvedPath).toLowerCase();
  if (!ALLOWED_HTML_EXTENSIONS.has(ext)) {
    throw new WechatMcpError(
      "VALIDATION_ERROR",
      "Only .html and .htm source files can be imported into a draft.",
    );
  }

  const st = (() => {
    try {
      return statSync(resolvedPath);
    } catch {
      throw new WechatMcpError("VALIDATION_ERROR", "Cannot inspect the HTML source file.");
    }
  })();
  if (!st.isFile() || st.size === 0) {
    throw new WechatMcpError(
      "VALIDATION_ERROR",
      "The HTML source must be a non-empty regular file.",
    );
  }
  if (st.size > MAX_HTML_SOURCE_SIZE) {
    throw new WechatMcpError(
      "VALIDATION_ERROR",
      `HTML source exceeds the ${MAX_HTML_SOURCE_SIZE}-byte limit.`,
    );
  }

  let html: string;
  try {
    html = readFileSync(resolvedPath, "utf8");
  } catch {
    throw new WechatMcpError("VALIDATION_ERROR", "Cannot read the HTML source file.");
  }
  if (html.includes("\0")) {
    throw new WechatMcpError("VALIDATION_ERROR", "HTML source contains invalid null bytes.");
  }

  return { resolvedPath, html, filename: basename(resolvedPath), size: st.size };
}
