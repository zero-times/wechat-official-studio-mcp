import assert from "node:assert/strict";
import test from "node:test";
import { errorPayload, WechatMcpError } from "../src/services/errors.js";
import {
  buildLegacyMaterialUploadQuery,
  buildMaterialUploadQuery,
  extractMaterialGroupIds,
  WechatClient,
} from "../src/services/wechat-client.js";
import { READ_ONLY_BACKEND_PATHS, WRITE_GET_PATHS, WRITE_POST_PATHS } from "../src/constants.js";

test("accepts modern /s/article-id public URLs without sending a cookie", async () => {
  let cookieHeader: string | null = null;
  const fetchImplementation = (async (_input, init) => {
    cookieHeader = new Headers(init?.headers).get("cookie");
    return new Response("<html>article</html>", { status: 200 });
  }) as typeof fetch;
  const client = new WechatClient(fetchImplementation);

  const result = await client.getPublicArticle("https://mp.weixin.qq.com/s/article-id");
  assert.equal(result.html, "<html>article</html>");
  assert.equal(result.accessMode, "anonymous");
  assert.equal(cookieHeader, null);
});

test("does not blame the local cookie for an anonymous public request timeout", async () => {
  const fetchImplementation = (async () => {
    throw new DOMException("The operation timed out", "TimeoutError");
  }) as typeof fetch;
  const client = new WechatClient(fetchImplementation);

  await assert.rejects(
    () => client.getPublicArticle("https://mp.weixin.qq.com/s/article-id"),
    (error: unknown) => {
      assert.ok(error instanceof WechatMcpError);
      assert.equal(error.code, "REQUEST_TIMEOUT");
      assert.equal(error.requiresCookieRefresh, false);
      return true;
    },
  );
});

test("retries a challenged public article once after authentication preflight", async () => {
  const previousCookie = process.env.WECHAT_OFFICIAL_COOKIE;
  const previousToken = process.env.WECHAT_OFFICIAL_TOKEN;
  process.env.WECHAT_OFFICIAL_COOKIE = `session=${"x".repeat(32)}`;
  process.env.WECHAT_OFFICIAL_TOKEN = "987654";
  const requests: Array<{ path: string; cookie: string | null }> = [];
  try {
    const client = new WechatClient((async (input, init) => {
      const url = new URL(String(input));
      const cookie = new Headers(init?.headers).get("cookie");
      requests.push({ path: url.pathname, cookie });
      if (url.pathname === "/cgi-bin/home") {
        return new Response("<html>authenticated home</html>", { status: 200 });
      }
      if (!cookie) {
        return new Response("", {
          status: 302,
          headers: { location: "/mp/wappoc_appmsgcaptcha?poc_token=test" },
        });
      }
      return new Response("<html>article after authentication</html>", { status: 200 });
    }) as typeof fetch);

    const result = await client.getPublicArticle("https://mp.weixin.qq.com/s/article-id");
    assert.equal(result.html, "<html>article after authentication</html>");
    assert.equal(result.accessMode, "authenticated");
    assert.deepEqual(requests.map((request) => request.path), [
      "/s/article-id",
      "/cgi-bin/home",
      "/s/article-id",
    ]);
    assert.equal(requests[0]?.cookie, null);
    assert.ok(requests[1]?.cookie);
    assert.ok(requests[2]?.cookie);
  } finally {
    if (previousCookie === undefined) delete process.env.WECHAT_OFFICIAL_COOKIE;
    else process.env.WECHAT_OFFICIAL_COOKIE = previousCookie;
    if (previousToken === undefined) delete process.env.WECHAT_OFFICIAL_TOKEN;
    else process.env.WECHAT_OFFICIAL_TOKEN = previousToken;
  }
});

test("stops a challenged public article when authenticated fallback is disabled", async () => {
  let requestCount = 0;
  const client = new WechatClient((async () => {
    requestCount += 1;
    return new Response("<html><h2>环境异常</h2><p>完成验证后即可继续访问</p></html>", {
      status: 200,
    });
  }) as typeof fetch);

  await assert.rejects(
    () => client.getPublicArticle("https://mp.weixin.qq.com/s/article-id", "never"),
    (error: unknown) => {
      assert.ok(error instanceof WechatMcpError);
      assert.equal(error.code, "PUBLIC_ARTICLE_CHALLENGE");
      assert.equal(error.requiresCookieRefresh, false);
      assert.match(String(errorPayload(error).next_action), /own browser/);
      return true;
    },
  );
  assert.equal(requestCount, 1);
});

test("stops before authenticated article retry when the local session is expired", async () => {
  const previousCookie = process.env.WECHAT_OFFICIAL_COOKIE;
  const previousToken = process.env.WECHAT_OFFICIAL_TOKEN;
  process.env.WECHAT_OFFICIAL_COOKIE = `session=${"x".repeat(32)}`;
  process.env.WECHAT_OFFICIAL_TOKEN = "987654";
  const requestedPaths: string[] = [];
  try {
    const client = new WechatClient((async (input) => {
      const path = new URL(String(input)).pathname;
      requestedPaths.push(path);
      if (path === "/cgi-bin/home") {
        return new Response("<html>登录超时，请重新登录</html>", { status: 200 });
      }
      return new Response("", {
        status: 302,
        headers: { location: "/mp/wappoc_appmsgcaptcha?poc_token=test" },
      });
    }) as typeof fetch);

    await assert.rejects(
      () => client.getPublicArticle("https://mp.weixin.qq.com/s/article-id"),
      (error: unknown) =>
        error instanceof WechatMcpError &&
        error.code === "AUTH_EXPIRED" &&
        error.requiresCookieRefresh,
    );
    assert.deepEqual(requestedPaths, ["/s/article-id", "/cgi-bin/home"]);
  } finally {
    if (previousCookie === undefined) delete process.env.WECHAT_OFFICIAL_COOKIE;
    else process.env.WECHAT_OFFICIAL_COOKIE = previousCookie;
    if (previousToken === undefined) delete process.env.WECHAT_OFFICIAL_TOKEN;
    else process.env.WECHAT_OFFICIAL_TOKEN = previousToken;
  }
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

test("authentication preflight makes a real request even when a token is configured", async () => {
  const previousCookie = process.env.WECHAT_OFFICIAL_COOKIE;
  const previousToken = process.env.WECHAT_OFFICIAL_TOKEN;
  process.env.WECHAT_OFFICIAL_COOKIE = `session=${"x".repeat(32)}`;
  process.env.WECHAT_OFFICIAL_TOKEN = "987654";
  const requestedPaths: string[] = [];
  try {
    const client = new WechatClient((async (input) => {
      requestedPaths.push(new URL(String(input)).pathname);
      return new Response("<html>authenticated home</html>", { status: 200 });
    }) as typeof fetch);

    await client.verifyAuthentication();
    assert.deepEqual(requestedPaths, ["/cgi-bin/home"]);
  } finally {
    if (previousCookie === undefined) delete process.env.WECHAT_OFFICIAL_COOKIE;
    else process.env.WECHAT_OFFICIAL_COOKIE = previousCookie;
    if (previousToken === undefined) delete process.env.WECHAT_OFFICIAL_TOKEN;
    else process.env.WECHAT_OFFICIAL_TOKEN = previousToken;
  }
});

test("material page reads use the current token and requested material group", async () => {
  const previousCookie = process.env.WECHAT_OFFICIAL_COOKIE;
  const previousToken = process.env.WECHAT_OFFICIAL_TOKEN;
  process.env.WECHAT_OFFICIAL_COOKIE = `session=${"x".repeat(32)}`;
  process.env.WECHAT_OFFICIAL_TOKEN = "987654";
  let requestedUrl: URL | undefined;
  try {
    const client = new WechatClient((async (input) => {
      requestedUrl = new URL(String(input));
      return new Response("<html>material page</html>", { status: 200 });
    }) as typeof fetch);

    await client.getMaterialPage(103, 50, 0);
    assert.equal(requestedUrl?.pathname, "/cgi-bin/filepage");
    assert.equal(requestedUrl?.searchParams.get("group_id"), "103");
    assert.equal(requestedUrl?.searchParams.get("token"), "987654");
    assert.equal(requestedUrl?.searchParams.get("type"), "2");
  } finally {
    if (previousCookie === undefined) delete process.env.WECHAT_OFFICIAL_COOKIE;
    else process.env.WECHAT_OFFICIAL_COOKIE = previousCookie;
    if (previousToken === undefined) delete process.env.WECHAT_OFFICIAL_TOKEN;
    else process.env.WECHAT_OFFICIAL_TOKEN = previousToken;
  }
});

test("material upload query opts into the current double-write library", () => {
  assert.deepEqual(
    buildMaterialUploadQuery(
      { user_name: "account", ticket: "ticket", svr_time: 42 },
      103,
    ),
    {
      action: "upload_material",
      f: "json",
      ticket_id: "account",
      ticket: "ticket",
      svr_time: "42",
      writetype: "doublewrite",
      groupid: "103",
    },
  );
});

test("legacy material upload query omits current-library routing fields", () => {
  assert.deepEqual(
    buildLegacyMaterialUploadQuery({ user_name: "account", ticket: "ticket", svr_time: 42 }),
    {
      action: "upload_material",
      f: "json",
      ticket_id: "account",
      ticket: "ticket",
      svr_time: "42",
    },
  );
});

test("extracts only bounded material group IDs from library HTML", () => {
  assert.deepEqual(
    extractMaterialGroupIds(
      `<script>window.groups=[{"group_id":103},{"groupid":"7"}]</script><a href="?group_id=18">x</a>`,
    ),
    [7, 18, 103],
  );
});

test("material verification reads the current JSON file list", async () => {
  const previousCookie = process.env.WECHAT_OFFICIAL_COOKIE;
  const previousToken = process.env.WECHAT_OFFICIAL_TOKEN;
  process.env.WECHAT_OFFICIAL_COOKIE = `session=${"x".repeat(32)}`;
  process.env.WECHAT_OFFICIAL_TOKEN = "987654";
  try {
    const client = new WechatClient((async () =>
      new Response(
        JSON.stringify({
          base_resp: { ret: 0 },
          page_info: { file_item: [{ file_id: 65, name: "cover.png" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch);
    assert.equal(await client.hasMaterialImage(103, "65", "other.png"), true);
    assert.equal(await client.hasMaterialImage(103, "99", "cover.png"), true);
    assert.equal(await client.hasMaterialImage(103, "99", "missing.png"), false);
  } finally {
    if (previousCookie === undefined) delete process.env.WECHAT_OFFICIAL_COOKIE;
    else process.env.WECHAT_OFFICIAL_COOKIE = previousCookie;
    if (previousToken === undefined) delete process.env.WECHAT_OFFICIAL_TOKEN;
    else process.env.WECHAT_OFFICIAL_TOKEN = previousToken;
  }
});

test("authentication preflight never trusts a previously verified cached token", async () => {
  const previousCookie = process.env.WECHAT_OFFICIAL_COOKIE;
  const previousToken = process.env.WECHAT_OFFICIAL_TOKEN;
  process.env.WECHAT_OFFICIAL_COOKIE = `session=${"x".repeat(32)}`;
  process.env.WECHAT_OFFICIAL_TOKEN = "987654";
  let requestCount = 0;
  try {
    const client = new WechatClient((async () => {
      requestCount += 1;
      return new Response(
        requestCount === 1 ? "<html>authenticated home</html>" : "<html>登录超时，请重新登录</html>",
        { status: 200 },
      );
    }) as typeof fetch);

    await client.verifyAuthentication();
    await assert.rejects(
      () => client.verifyAuthentication(),
      (error: unknown) => {
        assert.ok(error instanceof WechatMcpError);
        assert.equal(error.code, "AUTH_EXPIRED");
        assert.equal(error.requiresCookieRefresh, true);
        assert.match(String(errorPayload(error).next_action), /Stop the current workflow/);
        return true;
      },
    );
    assert.equal(requestCount, 2);
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
