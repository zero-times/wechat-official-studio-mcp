#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetPath = resolve(
  process.env.WECHAT_OFFICIAL_COOKIE_FILE || resolve(projectRoot, ".wechat-cookie"),
);

function cleanCookie(value) {
  return value.trim().replace(/^Cookie\s*:\s*/i, "").replace(/[\r\n]+/g, "");
}

function validateCookie(value) {
  if (value.length < 20 || !value.includes("=")) {
    throw new Error("看起来不是完整的 Cookie：应包含多个 name=value 片段。");
  }
  if (/^(Cookie\s*:|Set-Cookie\s*:)/i.test(value)) {
    throw new Error("请只提供 Cookie 的值，不要包含请求头名。");
  }
}

async function readClipboard() {
  if (process.platform === "darwin") {
    return (await execFileAsync("pbpaste", [], { maxBuffer: 1024 * 1024 })).stdout;
  }
  if (process.platform === "win32") {
    return (
      await execFileAsync(
        "powershell",
        ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
        { maxBuffer: 1024 * 1024 },
      )
    ).stdout;
  }
  for (const [command, args] of [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
  ]) {
    try {
      return (await execFileAsync(command, args, { maxBuffer: 1024 * 1024 })).stdout;
    } catch {
      // Try the next clipboard utility.
    }
  }
  throw new Error("未找到可用的剪贴板工具，请不带参数运行并使用隐藏输入。");
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    throw new Error("当前不是交互式终端，请使用 --from-clipboard。");
  }

  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  let value = "";

  try {
    for await (const chunk of process.stdin) {
      for (const char of chunk) {
        if (char === "\u0003") throw new Error("已取消。");
        if (char === "\r" || char === "\n") {
          process.stdout.write("\n");
          return value;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return value;
}

async function main() {
  const fromClipboard = process.argv.includes("--from-clipboard");
  const raw = fromClipboard
    ? await readClipboard()
    : await readHidden("粘贴微信公众平台 Cookie（输入不回显）：");
  const cookie = cleanCookie(raw);
  validateCookie(cookie);

  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${cookie}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);

  process.stdout.write(`Cookie 已安全写入 ${targetPath}\n`);
  process.stdout.write("该文件已被 Git 忽略，MCP 会在下次调用时自动重新读取。\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
