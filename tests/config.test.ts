import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateImageFile } from "../src/services/config.js";
import { WechatMcpError } from "../src/services/errors.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function withUploadRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "wechat-studio-upload-"));
  const previous = process.env.WECHAT_OFFICIAL_UPLOAD_ROOTS;
  process.env.WECHAT_OFFICIAL_UPLOAD_ROOTS = root;
  try {
    run(root);
  } finally {
    if (previous === undefined) delete process.env.WECHAT_OFFICIAL_UPLOAD_ROOTS;
    else process.env.WECHAT_OFFICIAL_UPLOAD_ROOTS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts a matching image inside an approved upload root", () => {
  withUploadRoot((root) => {
    const image = join(root, "cover.png");
    writeFileSync(image, PNG_BYTES);
    const result = validateImageFile(image);
    assert.equal(result.filename, "cover.png");
    assert.equal(result.mime, "image/png");
    assert.equal(result.size, PNG_BYTES.length);
  });
});

test("rejects an extension that disagrees with image magic bytes", () => {
  withUploadRoot((root) => {
    const image = join(root, "cover.jpg");
    writeFileSync(image, PNG_BYTES);
    assert.throws(
      () => validateImageFile(image),
      (error: unknown) =>
        error instanceof WechatMcpError &&
        error.code === "UPLOAD_ERROR" &&
        /does not match/.test(error.message),
    );
  });
});

test("rejects a symbolic-link escape without exposing an absolute path", () => {
  withUploadRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), "wechat-studio-outside-"));
    const outsideImage = join(outside, "outside.png");
    const link = join(root, "linked.png");
    try {
      writeFileSync(outsideImage, PNG_BYTES);
      symlinkSync(outsideImage, link);
      assert.throws(
        () => validateImageFile(link),
        (error: unknown) => {
          assert.ok(error instanceof WechatMcpError);
          assert.equal(error.code, "UPLOAD_ERROR");
          assert.equal(error.message.includes(outside), false);
          assert.equal(error.message.includes(root), false);
          return true;
        },
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
