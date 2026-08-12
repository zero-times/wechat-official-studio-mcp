import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredNames = new Set([
  ".git",
  ".wechat-cookie",
  ".env",
  "node_modules",
  "dist",
  "coverage",
]);
const textExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".ts", ".yaml", ".yml"]);
const rules = [
  ["literal-cookie-header", /\bCookie\s*:\s*["'][^"']{20,}["']/i],
  ["inline-cookie-secret", /WECHAT_OFFICIAL_COOKIE\s*=\s*["']?[^<\s"'][^\s"']{19,}/i],
  ["literal-token-query", /[?&]token=\d{6,}/i],
  ["literal-ticket-query", /[?&]ticket=[A-Za-z0-9_-]{20,}/i],
  ["local-user-path", /\/(?:Users|Volumes)\/[^/\s"']+/],
  ["account-identifier-dump", /\buin_base64\b/i],
  ["wechat-internal-username", /["']gh_[A-Za-z0-9_-]{8,}["']/i],
  ["wechat-biz-query", /[?&]__biz=[A-Za-z0-9_=-]{8,}/i],
  ["wechat-fakeid", /\bfakeid\s*[:=]\s*["'][A-Za-z0-9_=-]{8,}["']/i],
  ["private-project-name", /\u6709\u70b9\u529e\u6cd5/u],
  ["private-business-sample", /\u4e3e\u62a5|\u6295\u8bc9|\x31\x32\x33\x34\x35|\x31\x32\x33\x37\x37|\u5de5\u5355|\u67e5\u8be2\u7801/u],
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (
      ignoredNames.has(entry.name) ||
      (entry.name.startsWith(".env.") && entry.name !== ".env.example")
    ) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (
      textExtensions.has(extname(entry.name)) ||
      entry.name === ".gitignore" ||
      entry.name === ".npmignore" ||
      entry.name === ".env.example"
    ) files.push(path);
  }
  return files;
}

const gitignore = await readFile(join(projectRoot, ".gitignore"), "utf8");
for (const required of [".wechat-cookie", ".env", ".env.*", "node_modules/", "dist/"]) {
  if (!gitignore.split(/\r?\n/).includes(required)) {
    throw new Error(`.gitignore is missing required entry: ${required}`);
  }
}

const cookiePath = join(projectRoot, ".wechat-cookie");
try {
  const cookieStat = await stat(cookiePath);
  if ((cookieStat.mode & 0o077) !== 0) {
    throw new Error(".wechat-cookie permissions must be 0600 or stricter.");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const violations = [];
for (const path of await walk(projectRoot)) {
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const [rule, pattern] of rules) {
      if (pattern.test(lines[index])) {
        violations.push({ file: relative(projectRoot, path), line: index + 1, rule });
      }
    }
  }
}

if (violations.length) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, scanned_files: (await walk(projectRoot)).length }));
