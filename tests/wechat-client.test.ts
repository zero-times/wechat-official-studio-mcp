import assert from "node:assert/strict";
import test from "node:test";
import { errorPayload, WechatMcpError } from "../src/services/errors.js";
import { WechatClient } from "../src/services/wechat-client.js";
import { READ_ONLY_BACKEND_PATHS, WRITE_GET_PATHS, WRITE_POST_PATHS } from "../src/constants.js";

test("accepts modern /s/article-id public URLs without sending a cookie", async () => {
  let cookieHeader: string | null = null;
  const fetchImplementation = (async (_input, init) => {
    cookieHeader = new Headers(init?.headers).get("cookie");
    return new Response("<html>article</html>", { status: 200 });
  }) as typeof fetch;
  const client = new WechatClient(fetchImplementation);

  const html = await client.getPublicArticle("https://mp.weixin.qq.com/s/article-id");
  assert.equal(html, "<html>article</html>");
  assert.equal(cookieHeader, null);
});

test("marks request timeouts as requiring a local cookie refresh check", async () => {
  const fetchImplementation = (async () => {
    throw new DOMException("The operation timed out", "TimeoutError");
  }) as typeof fetch;
  const client = new WechatClient(fetchImplementation);

  await assert.rejects(
    () => client.getPublicArticle("https://mp.weixin.qq.com/s/article-id"),
    (error: unknown) => {
      assert.ok(error instanceof WechatMcpError);
      assert.equal(error.code, "REQUEST_TIMEOUT");
      assert.equal(error.requiresCookieRefresh, true);
      return true;
    },
  );
});

test("marks write timeouts as ambiguous and never requests an automatic retry", async () => {
  const previousCookie = process.env.WECHAT_OFFICIAL_COOKIE;
  const previousToken = process.env.WECHAT_OFFICIAL_TOKEN;
  process.env.WECHAT_OFFICIAL_COOKIE = `session=${"x".repeat(32)}`;
  process.env.WECHAT_OFFICIAL_TOKEN = "987654";
  try {
    const client = new WechatClient((async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as typeof fetch);

    await assert.rejects(
      () => client.postForm("/cgi-bin/operate_appmsg", { sub: "create" }, { title0: "Example" }),
      (error: unknown) => {
        assert.ok(error instanceof WechatMcpError);
        assert.equal(error.code, "REQUEST_TIMEOUT");
        assert.equal(error.requiresCookieRefresh, false);
        assert.equal(error.details?.write_result_ambiguous, true);
        assert.match(String(errorPayload(error).next_action), /Do not retry automatically/);
        return true;
      },
    );
  } finally {
    if (previousCookie === undefined) delete process.env.WECHAT_OFFICIAL_COOKIE;
    else process.env.WECHAT_OFFICIAL_COOKIE = previousCookie;
    if (previousToken === undefined) delete process.env.WECHAT_OFFICIAL_TOKEN;
    else process.env.WECHAT_OFFICIAL_TOKEN = previousToken;
  }
});

test("rejects non-WeChat article hosts before making a request", async () => {
  const client = new WechatClient(async () => {
    throw new Error("fetch should not run");
  });

  await assert.rejects(
    () => client.getPublicArticle("https://example.com/s/article-id"),
    (error: unknown) => error instanceof WechatMcpError && error.code === "UPSTREAM_ERROR",
  );
});

// ── GET/POST endpoint allowlisting ──

test("WRITE_GET_PATHS includes all READ_ONLY_BACKEND_PATHS", () => {
  for (const path of READ_ONLY_BACKEND_PATHS) {
    assert.ok(WRITE_GET_PATHS.has(path), `WRITE_GET_PATHS should include ${path}`);
  }
});

test("WRITE_GET_PATHS includes editor context endpoint", () => {
  assert.ok(WRITE_GET_PATHS.has("/cgi-bin/appmsg"));
  assert.ok(WRITE_GET_PATHS.has("/cgi-bin/filepage"));
});

test("WRITE_POST_PATHS includes material upload, body image upload, and draft save", () => {
  assert.ok(WRITE_POST_PATHS.has("/cgi-bin/filetransfer"));
  assert.ok(WRITE_POST_PATHS.has("/cgi-bin/uploadimg2cdn"));
  assert.ok(WRITE_POST_PATHS.has("/cgi-bin/operate_appmsg"));
});

test("WRITE_POST_PATHS does not include read-only paths", () => {
  assert.equal(WRITE_POST_PATHS.has("/cgi-bin/home"), false);
  assert.equal(WRITE_POST_PATHS.has("/cgi-bin/appmsgpublish"), false);
  assert.equal(WRITE_POST_PATHS.has("/misc/appmsganalysis"), false);
});

test("WRITE_POST_PATHS does not allow publishing endpoints", () => {
  assert.equal(WRITE_POST_PATHS.has("/cgi-bin/appmsgpublish"), false);
  assert.equal(WRITE_POST_PATHS.has("/cgi-bin/delete"), false);
  const publishPaths = [...WRITE_POST_PATHS].filter((p) =>
    /publish|delete|mass|send|broadcast/i.test(p),
  );
  assert.equal(publishPaths.length, 0, `No publish/delete paths allowed: ${publishPaths.join(", ")}`);
});

// ── Confirm enforcement (tested via error construction pattern) ──

test("WRITE_CONFIRMATION_REQUIRED error code is defined", () => {
  const error = new WechatMcpError(
    "WRITE_CONFIRMATION_REQUIRED",
    'The tool "wechat_official_upload_image" is a write operation. Set confirm=true to proceed.',
  );
  assert.equal(error.code, "WRITE_CONFIRMATION_REQUIRED");
  assert.equal(error.requiresCookieRefresh, false);
  assert.match(error.message, /confirm=true/);
});

test("UPLOAD_ERROR and VALIDATION_ERROR codes are defined", () => {
  const uploadError = new WechatMcpError("UPLOAD_ERROR", "Test upload error");
  assert.equal(uploadError.code, "UPLOAD_ERROR");

  const validationError = new WechatMcpError("VALIDATION_ERROR", "Test validation error");
  assert.equal(validationError.code, "VALIDATION_ERROR");
});
