import assert from "node:assert/strict";
import test from "node:test";
import type { DraftArticle, EditorContext } from "../src/types.js";
import {
  parseAccountInfo,
  parseEditorContext,
  parsePublicArticle,
  parsePublishedArticlePage,
  parseReportPage,
  validateDraftArticles,
  validateDraftHtml,
  buildDraftPayload,
  parseWriteResponse,
} from "../src/services/parsers.js";

test("parses account fields without exposing session data", () => {
  const result = parseAccountInfo(`
    <script>
      wx.cgiData.nick_name = "\u793a\u4f8b\u516c\u4f17\u53f7";
      wx.cgiData.user_name = "internal-account-id";
      wx.cgiData.alias = "example-account";
      wx.cgiData.head_img = "https:\\/\\/example.com\\/avatar.png";
    </script>
  `);
  assert.equal(result.nickname, "示例公众号");
  assert.equal(result.originalId, "example-account");
  assert.equal(result.avatarUrl, "https://example.com/avatar.png");
  assert.equal("username" in result, false);
});

test("flattens stringified publication payloads", () => {
  const publishInfo = JSON.stringify({
    publish_time: 1_700_000_000,
    appmsgex: [
      {
        title: "测试文章",
        link: "https://mp.weixin.qq.com/s/example",
        digest: "摘要",
        msgid: "123",
        read_num: 42,
        like_num: 3,
        share_num: 2,
      },
    ],
  });
  const result = parsePublishedArticlePage(
    { publish_page: JSON.stringify({ total_count: 1, publish_list: [{ publish_info: publishInfo }] }) },
    0,
  );
  assert.equal(result.total, 1);
  assert.equal(result.articles[0]?.title, "测试文章");
  assert.equal(result.articles[0]?.messageId, "123");
  assert.equal(result.articles[0]?.readNum, 42);
  assert.equal(result.articles[0]?.likeNum, 3);
  assert.equal(result.articles[0]?.shareNum, 2);
});

test("uses appmsg_info when appmsgex is present but empty", () => {
  const publishInfo = JSON.stringify({
    sent_info: { time: 1_700_000_000 },
    appmsgex: [],
    appmsg_info: [{ title: "新结构文章", appmsgid: 456, read_num: 9 }],
  });
  const result = parsePublishedArticlePage(
    { publish_page: JSON.stringify({ total_count: 1, publish_list: [{ publish_info: publishInfo }] }) },
    0,
  );
  assert.equal(result.articles[0]?.title, "新结构文章");
  assert.equal(result.articles[0]?.publishedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(result.articles[0]?.readNum, 9);
});

test("paginates CSV analytics", () => {
  const csv = new TextEncoder().encode("日期,阅读人数\n2026-08-01,10\n2026-08-02,20\n");
  const result = parseReportPage(csv.buffer, 0, 1);
  assert.equal(result.total, 2);
  assert.equal(result.rows[0]?.["阅读人数"], "10");
  assert.equal(result.nextOffset, 1);
});

test("extracts a public article into readable text", () => {
  const result = parsePublicArticle(
    `<html><head><meta name="description" content="摘要"></head><body>
      <h1 id="activity-name">标题</h1><span id="js_name">示例公众号</span>
      <div id="js_content"><p>第一段</p><p><a href="https://example.com">链接</a></p></div>
    </body></html>`,
    20_000,
  );
  assert.equal(result.title, "标题");
  assert.match(result.content, /第一段/);
  assert.match(result.content, /\[链接\]\(https:\/\/example\.com\)/);
});

// ── Editor context parsing ──

test("parses editor context from HTML without exposing session data", () => {
  const html = `
    <script>
      wx.data.ticket = "abc123ticket";
      wx.data.user_name = "example-user-name";
      wx.data.time = "1718112000";
      wx.version = "20260811";
      wx.cgiData.line_info = { is_use_flag: 1 };
      var appmsgid = "100000001";
      var data_seq = "0";
    </script>
  `;
  const ctx = parseEditorContext(html);
  assert.equal(ctx.ticket, "abc123ticket");
  assert.equal(ctx.user_name, "example-user-name");
  assert.equal(ctx.svr_time, 1718112000);
  assert.equal(ctx.appmsgid, "100000001");
  assert.equal(ctx.data_seq, 0);
  assert.equal(ctx.is_use_flag, 1);
  assert.equal(ctx.template_version, "20260811");
});

test("parses editor context from JSON-style assignments", () => {
  const html = `
    ticket: "ticket-json",
    user_name: "example-user",
    time: "1718200000",
    AppMsgId: "200000002",
    data_seq: "5",
    is_use_flag: "0",
    template_version: "v2"
  `;
  const ctx = parseEditorContext(html);
  assert.equal(ctx.ticket, "ticket-json");
  assert.equal(ctx.user_name, "example-user");
  assert.equal(ctx.svr_time, 1718200000);
  assert.equal(ctx.appmsgid, "200000002");
  assert.equal(ctx.data_seq, 5);
  assert.equal(ctx.is_use_flag, 0);
  assert.equal(ctx.template_version, "v2");
});

test("parses a numeric editor template version", () => {
  const ctx = parseEditorContext("wx.version = 20260811;");
  assert.equal(ctx.template_version, "20260811");
});

test("derives the editor template version from the versioned stylesheet", () => {
  const ctx = parseEditorContext(
    '<link rel="stylesheet" href="https://res.wx.qq.com/mpres/zh_CN/htmledition/js/media/appmsg_edit_v2_gray.987654.css">',
  );
  assert.equal(ctx.template_version, "987654");
});

// ── Draft HTML validation ──

test("accepts clean HTML", () => {
  const result = validateDraftHtml("<p>Hello <b>world</b></p>", 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.match(result.sanitized, /Hello/);
});

test("rejects script tags", () => {
  const result = validateDraftHtml("<p>hi</p><script>alert(1)</script>", 0);
  assert.ok(result.errors.some((e) => /script/i.test(e)));
  assert.ok(!result.sanitized.includes("<script"));
});

test("rejects iframe and object tags", () => {
  const result = validateDraftHtml('<iframe src="x"></iframe><object data="x"></object>', 0);
  assert.ok(result.errors.some((e) => /iframe/i.test(e)));
  assert.ok(result.errors.some((e) => /object/i.test(e)));
});

test("rejects embed and form tags", () => {
  const result = validateDraftHtml('<embed src="x"><form action="x"></form>', 0);
  assert.ok(result.errors.some((e) => /embed/i.test(e)));
  assert.ok(result.errors.some((e) => /form/i.test(e)));
});

test("rejects javascript: URLs", () => {
  const result = validateDraftHtml('<a href="javascript:void(0)">link</a>', 0);
  assert.ok(result.errors.some((e) => /URL/i.test(e)));
});

test("rejects data: URLs", () => {
  const result = validateDraftHtml('<img src="data:image/png;base64,abc">', 0);
  assert.ok(result.errors.some((e) => /URL/i.test(e)));
});

test("warns about non-WeChat HTTPS image hosts", () => {
  const result = validateDraftHtml('<img src="https://example.com/img.png">', 0);
  assert.ok(result.warnings.some((w) => /non-WeChat/i.test(w)));
});

test("does not warn about WeChat image hosts", () => {
  const result = validateDraftHtml('<img src="https://mmbiz.qpic.cn/img.png">', 0);
  assert.equal(result.warnings.length, 0);
});

test("rejects empty HTML", () => {
  const result = validateDraftHtml("", 0);
  assert.ok(result.errors.some((e) => /empty/i.test(e)));
});

test("sanitizes forbidden tags but preserves safe content", () => {
  const result = validateDraftHtml("<p>safe</p><script>unsafe</script><b>bold</b>", 0);
  assert.ok(result.sanitized.includes("safe"));
  assert.ok(result.sanitized.includes("<b>bold</b>"));
  assert.ok(!result.sanitized.includes("unsafe"));
});

// ── Draft article validation ──

function makeArticle(overrides: Partial<DraftArticle> = {}): DraftArticle {
  return {
    title: "Test Title",
    content_html: "<p>Hello world</p>",
    cover_media_id: "media123",
    show_cover: true,
    open_comment: false,
    fans_only_comment: false,
    ...overrides,
  };
}

test("validates a clean single article", () => {
  const result = validateDraftArticles([makeArticle()]);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("rejects empty article array", () => {
  const result = validateDraftArticles([]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /1-8/.test(e.message)));
});

test("rejects too many articles", () => {
  const articles = Array.from({ length: 9 }, () => makeArticle());
  const result = validateDraftArticles(articles);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /1-8/.test(e.message)));
});

test("rejects missing title", () => {
  const result = validateDraftArticles([makeArticle({ title: "" })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === "title"));
});

test("rejects too-long title", () => {
  const result = validateDraftArticles([makeArticle({ title: "x".repeat(65) })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /Title length/i.test(e.message)));
});

test("rejects too-long author", () => {
  const result = validateDraftArticles([makeArticle({ author: "x".repeat(33) })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /Author length/i.test(e.message)));
});

test("rejects too-long digest", () => {
  const result = validateDraftArticles([makeArticle({ digest: "x".repeat(121) })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /Digest length/i.test(e.message)));
});

test("allows preview before cover upload but requires cover before saving", () => {
  const preview = validateDraftArticles([makeArticle({ cover_media_id: "" })]);
  assert.equal(preview.valid, true);
  assert.ok(preview.warnings.some((e) => e.field === "cover_media_id"));

  const final = validateDraftArticles(
    [makeArticle({ cover_media_id: "" })],
    { requireCover: true },
  );
  assert.equal(final.valid, false);
  assert.ok(final.errors.some((e) => e.field === "cover_media_id"));
});

test("warns when fan-only comments are set while comments are disabled", () => {
  const result = validateDraftArticles([
    makeArticle({ open_comment: false, fans_only_comment: true }),
  ]);
  assert.ok(result.warnings.some((warning) => warning.field === "fans_only_comment"));
});

test("rejects non-HTTPS source_url", () => {
  const result = validateDraftArticles([makeArticle({ source_url: "http://example.com" })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /HTTPS/i.test(e.message)));
});

test("rejects invalid source_url", () => {
  const result = validateDraftArticles([makeArticle({ source_url: "not-a-url" })]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === "source_url"));
});

test("returns per-article summaries", () => {
  const result = validateDraftArticles([
    makeArticle({ title: "First" }),
    makeArticle({ title: "Second" }),
  ]);
  assert.equal(result.summaries.length, 2);
  assert.equal(result.summaries[0]?.title, "First");
  assert.equal(result.summaries[1]?.title, "Second");
  assert.equal(result.summaries[0]?.has_cover, true);
});

test("counts images in summaries", () => {
  const result = validateDraftArticles([
    makeArticle({
      content_html: '<img src="https://mmbiz.qpic.cn/a.png"><img src="https://mmbiz.qpic.cn/b.png">',
    }),
  ]);
  assert.equal(result.summaries[0]?.image_count, 2);
});

// ── Draft payload construction ──

function makeContext(overrides: Partial<EditorContext> = {}): EditorContext {
  return {
    ticket: "test-ticket",
    user_name: "example-user",
    svr_time: 1718112000,
    appmsgid: "",
    data_seq: 0,
    is_use_flag: 1,
    template_version: "v2",
    ...overrides,
  };
}

test("builds payload with indexed fields", () => {
  const payload = buildDraftPayload([makeArticle({ title: "Hello" })], makeContext());
  assert.equal(payload.title0, "Hello");
  assert.equal(payload.author0, "");
  assert.equal(payload.digest0, "");
  assert.equal(payload.content0, "<p>Hello world</p>");
  assert.equal(payload.fileid0, "media123");
  assert.equal(payload.show_cover_pic0, "1");
  assert.equal(payload.need_open_comment0, "0");
  assert.equal(payload.only_fans_can_comment0, "0");
  assert.equal(payload.copyright_type0, "0");
});

test("builds payload for multiple articles", () => {
  const payload = buildDraftPayload(
    [makeArticle({ title: "First" }), makeArticle({ title: "Second", cover_media_id: "media456" })],
    makeContext(),
  );
  assert.equal(payload.title0, "First");
  assert.equal(payload.title1, "Second");
  assert.equal(payload.fileid1, "media456");
  assert.equal(payload.count, "2");
  assert.equal(payload.articlenum, "2");
});

test("includes req JSON with idx_infos", () => {
  const payload = buildDraftPayload([makeArticle({ title: "Test" })], makeContext());
  assert.ok(payload.req);
  const req = JSON.parse(payload.req);
  assert.ok(Array.isArray(req.idx_infos));
  assert.equal(req.idx_infos.length, 1);
  assert.deepEqual(req.idx_infos[0], { save_old: 0, cps_info: { cps_import: 0 } });
  assert.equal(req.appmsg_id, 0);
  assert.equal(req.is_use_flag, 1);
  assert.equal(req.template_version, "v2");
  assert.equal(JSON.stringify(req).includes("<p>Hello world</p>"), false);
});

test("includes metadata fields", () => {
  const payload = buildDraftPayload([makeArticle()], makeContext());
  assert.equal(payload.isnew, "0");
  assert.equal(payload.ajax, "1");
  assert.equal(payload.isneedsave, "0");
  assert.equal(payload.autosave_log, "");
  assert.equal(payload.pre_timesend_set, "0");
  assert.equal(payload.operate_from, "Chrome");
});

test("uses AppMsgId from context", () => {
  const payload = buildDraftPayload([makeArticle()], makeContext({ appmsgid: "90001" }));
  assert.equal(payload.AppMsgId, "90001");
});

// ── Write response parsing ──

test("parses successful base_resp response", () => {
  const result = parseWriteResponse({ base_resp: { ret: 0, err_msg: "ok" }, media_id: "m123" });
  assert.equal(result.ok, true);
  assert.equal(result.data.media_id, "m123");
});

test("parses successful root-level ret response", () => {
  const result = parseWriteResponse({ ret: 0, msgid: "msg456" });
  assert.equal(result.ok, true);
  assert.equal(result.data.msgid, "msg456");
});

test("parses JSON nested in content field", () => {
  const result = parseWriteResponse({
    base_resp: { ret: 0 },
    content: JSON.stringify({ ret: 0, appmsgid: "nested789" }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.nested_appmsgid, "nested789");
});

test("throws on nested content error", () => {
  assert.throws(
    () =>
      parseWriteResponse({
        base_resp: { ret: 0 },
        content: JSON.stringify({ ret: 1, err_msg: "nested fail" }),
      }),
    /nested error/,
  );
});

test("throws on upstream error ret", () => {
  assert.throws(
    () => parseWriteResponse({ base_resp: { ret: 100, err_msg: "bad" } }),
    /ret=100/,
  );
});

test("throws on unexpected structure (UPSTREAM_CHANGED)", () => {
  assert.throws(
    () => parseWriteResponse({ foo: "bar" }),
    /unexpected structure/i,
  );
});

test("throws auth expired on session ret codes", () => {
  for (const ret of [200003, 200013, -6, -14]) {
    assert.throws(
      () => parseWriteResponse({ base_resp: { ret, err_msg: "session" } }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "AUTH_EXPIRED",
    );
  }
});

test("does not leak sensitive data in parsed response", () => {
  const result = parseWriteResponse({
    base_resp: { ret: 0 },
    cookie: "secret",
    token: "secret",
    ticket: "secret",
    user_name: "secret",
    media_id: "safe_media",
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.media_id, "safe_media");
  assert.equal("cookie" in result.data, false);
  assert.equal("token" in result.data, false);
  assert.equal("ticket" in result.data, false);
});
