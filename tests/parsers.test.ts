import assert from "node:assert/strict";
import test from "node:test";
import { load } from "cheerio";
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
  prepareDraftHtmlDocument,
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

test("imports rendered HTML with inline styles while removing only links and publish config", () => {
  const result = prepareDraftHtmlDocument(`
    <!doctype html><html><head><title>备用标题</title><style>
      article{padding:20px;background:#fff} .conclusion{color:#135790;font-weight:700}
      .ad{border:1px dashed #999} a{color:#008000;text-decoration:none}
    </style></head><body><article>
      <h1>原始标题</h1>
      <p class="conclusion">保留样式</p>
      <div class="ad">文中程序化广告位｜保留广告配置文案</div>
      <div class="miniapp" data-miniapp-path="pages/material/index" style="padding:20px;border-radius:12px;background:#f0f8f7;border:1px solid #cce5df"><strong>材料整理：</strong>生成补充清单。</div>
      <p>进入<a href="https://example.com/path">材料整理</a>继续。</p>
      <ul><li style="margin:8px 0">第一项</li>\n  <li>   </li>\n  <li style="margin-top:8px;margin-bottom:8px">第二项</li></ul>
      <section class="editor"><h2>发布配置</h2><p><strong>摘要：</strong>这是摘要。</p><p><strong>广告位：</strong>约 50% 处。</p></section>
    </article></body></html>
  `, "source.html");

  assert.equal(result.title, "原始标题");
  assert.equal(result.digest, "这是摘要。");
  assert.equal(result.source_filename, "source.html");
  assert.equal(result.removed_link_count, 1);
  assert.equal(result.removed_publish_config_count, 1);
  assert.equal(result.removed_title_count, 1);
  assert.equal(result.compacted_list_count, 1);
  assert.equal(result.removed_empty_list_item_count, 1);
  assert.equal(result.normalized_bordered_callout_count, 2);
  assert.equal(result.preserved_ad_count, 1);
  assert.ok(result.inline_style_count >= 3);
  assert.match(result.content_html, /color:\s*#135790/i);
  assert.doesNotMatch(result.content_html, /border:\s*1px dashed #999/i);
  assert.match(result.content_html, /保留广告配置文案/);
  assert.match(result.content_html, /材料整理/);
  assert.doesNotMatch(result.content_html, /<a\b/i);
  assert.doesNotMatch(result.content_html, /href=/i);
  assert.doesNotMatch(result.content_html, /发布配置/);
  assert.doesNotMatch(result.content_html, /约 50% 处/);
  assert.doesNotMatch(result.content_html, /<h1\b/i);
  const rootStyle = load(result.content_html)("article").attr("style") ?? "";
  assert.doesNotMatch(rootStyle, /(?:^|;)\s*(?:margin|padding|max-width|width)\s*:/i);
  assert.match(rootStyle, /background:\s*#fff/i);
  const preparedDocument = load(result.content_html);
  const normalizedCallouts = preparedDocument("p.ad, p.miniapp");
  assert.equal(normalizedCallouts.length, 2);
  normalizedCallouts.each((_, item) => {
    const style = preparedDocument(item).attr("style") ?? "";
    assert.match(style, /padding:\s*18px 20px/i);
    assert.match(style, /border-radius:\s*10px/i);
    assert.match(style, /background:\s*#edf6ff/i);
    assert.match(style, /color:\s*#244a70/i);
    assert.doesNotMatch(style, /(?:^|;)\s*border(?:-(?:top|right|bottom|left))?\s*:/i);
  });
  assert.equal(preparedDocument("p.miniapp").attr("data-miniapp-path"), "pages/material/index");
  assert.equal(preparedDocument("ul > li").length, 2);
  preparedDocument("ul > li").each((_, item) => {
    const style = preparedDocument(item).attr("style") ?? "";
    assert.match(style, /margin:\s*0/i);
    assert.doesNotMatch(style, /margin-(?:top|bottom)/i);
  });
  const listHtml = preparedDocument("ul").html() ?? "";
  assert.doesNotMatch(listHtml, />\s+</);
});

test("keeps existing inline styles during draft validation", () => {
  const result = validateDraftHtml(
    '<p style="margin:0 0 18px;color:#253044"><strong style="font-weight:700">正文</strong></p>',
    0,
  );
  assert.equal(result.errors.length, 0);
  assert.match(result.sanitized, /margin:0 0 18px/);
  assert.match(result.sanitized, /font-weight:700/);
});

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

test("parses current article-image errcode response", () => {
  const result = parseWriteResponse({
    errcode: 0,
    file_id: "image-file-id",
    url: "http://mmbiz.qpic.cn/example/0?wx_fmt=jpeg",
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.file_id, "image-file-id");
  assert.equal(result.data.url, "https://mmbiz.qpic.cn/example/0?wx_fmt=jpeg");
});

test("parses JSON nested in content field", () => {
  const result = parseWriteResponse({
    base_resp: { ret: 0 },
    content: JSON.stringify({ ret: 0, appmsgid: "nested789" }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.nested_appmsgid, "nested789");
});

test("normalizes protocol-relative WeChat CDN URLs and strips session query fields", () => {
  const result = parseWriteResponse({
    base_resp: { ret: 0 },
    cdn_url: "//mmbiz.qpic.cn/example/0?wx_fmt=png&token=secret&ticket=secret",
  });
  assert.equal(
    result.data.cdn_url,
    "https://mmbiz.qpic.cn/example/0?wx_fmt=png",
  );
});

test("finds aliased HTTP WeChat image URLs in safe nested containers", () => {
  const result = parseWriteResponse({
    base_resp: { ret: 0 },
    data: { image_url: "http://mmbiz.qpic.cn/example/0?wx_fmt=jpeg" },
  });
  assert.equal(
    result.data.nested_cdn_url,
    "https://mmbiz.qpic.cn/example/0?wx_fmt=jpeg",
  );
});

test("does not upgrade or return non-WeChat HTTP image URLs", () => {
  const result = parseWriteResponse({
    base_resp: { ret: 0 },
    data: { image_url: "http://example.com/image.png" },
  });
  assert.equal(result.data.nested_cdn_url, undefined);
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

// ── XLS report parsing (OLE2 + BIFF8) ──

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isOle2, parseXlsReport, extractReportRange, parseBiff8Workbook } from "../src/services/xls.js";

const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "appmsganalysis-template.xls");

function readFixture(): ArrayBuffer {
  const bytes = readFileSync(fixturePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// Minimal OLE2 + BIFF8 writer: single Workbook stream of 4608 bytes living in
// regular sectors (no mini stream), one directory sector, one FAT sector.
function buildXls(title: string, header: string[], rows: (string | number)[][]): ArrayBuffer {
  const sectorSize = 512;
  const biff = buildBiff(title, header, rows);
  const workbookSize = 4608;
  const workbook = new Uint8Array(workbookSize);
  workbook.set(biff, 0);
  // pad with unknown-type records; parsers skip unknown records
  for (let p = biff.length; p + 4 <= workbookSize; p += 4) {
    workbook[p] = 0x00;
    workbook[p + 1] = 0x00;
    workbook[p + 2] = 0x00;
    workbook[p + 3] = 0x00;
  }
  const out = new Uint8Array(512 + 11 * sectorSize);
  // header
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  out[24] = 0x3e; out[25] = 0x00; // minor version
  out[26] = 0x03; out[27] = 0x00; // major version
  out[28] = 0xfe; out[29] = 0xff; // byte order
  out.set([9, 0], 30); // sector shift 512
  out.set([6, 0], 32); // mini sector shift 64
  out.set([1, 0, 0, 0], 40); // directory sector count (deprecated)
  out.set([1, 0, 0, 0], 44); // FAT count
  out.set([9, 0, 0, 0], 48); // first directory sector
  out.set([0, 0, 0, 0], 52); // transaction
  out.set([0, 0, 16, 0], 56); // mini stream cutoff 4096
  out.set([0xff, 0xff, 0xff, 0xfe], 60); // no mini FAT
  out.set([0, 0, 0, 0], 64); // mini FAT count
  out.set([0xff, 0xff, 0xff, 0xfe], 68); // no DIFAT chain
  out.set([0, 0, 0, 0], 72); // DIFAT count
  out.set([10, 0, 0, 0], 76); // DIFAT[0] -> FAT sector 10
  for (let i = 1; i < 109; i++) out.set([0xff, 0xff, 0xff, 0xff], 76 + i * 4);
  // workbook data sectors 0..8
  for (let i = 0; i < 9; i++) out.set(workbook.subarray(i * sectorSize, (i + 1) * sectorSize), 512 + i * sectorSize);
  // directory sector 9
  const dir = 512 + 9 * sectorSize;
  writeUtf16(out, dir, "Root Entry");
  out[dir + 64] = 0; out[dir + 65] = 0; // name length 10 chars (2 bytes each)
  out[dir + 66] = 5; // root entry
  out.set([0xff, 0xff, 0xff, 0xfe], dir + 116); // no mini stream
  writeUtf16(out, dir + 128, "Workbook");
  out[dir + 128 + 64] = 16; out[dir + 128 + 65] = 0; // name length 8 chars
  out[dir + 128 + 66] = 2; // stream entry
  out.set([0, 0, 0, 0], dir + 128 + 116); // first sector 0
  out.set([0x00, 0x12, 0x00, 0x00], dir + 128 + 120); // size 4608
  // FAT sector 10
  const fat = 512 + 10 * sectorSize;
  for (let i = 0; i < 8; i++) out.set([i + 1, 0, 0, 0], fat + i * 4);
  out.set([0xfe, 0xff, 0xff, 0xff], fat + 8 * 4); // end of workbook chain
  out.set([0xfe, 0xff, 0xff, 0xff], fat + 9 * 4); // end of directory chain
  out.set([0xfe, 0xff, 0xff, 0xff], fat + 10 * 4); // end of FAT chain
  for (let i = 11; i < 128; i++) out.set([0xff, 0xff, 0xff, 0xff], fat + i * 4);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

function writeUtf16(out: Uint8Array, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[offset + i * 2] = code & 0xff;
    out[offset + i * 2 + 1] = (code >> 8) & 0xff;
  }
}

function biffRecord(type: number, data: Uint8Array): Uint8Array {
  const record = new Uint8Array(4 + data.length);
  record[0] = type & 0xff;
  record[1] = (type >> 8) & 0xff;
  record[2] = data.length & 0xff;
  record[3] = (data.length >> 8) & 0xff;
  record.set(data, 4);
  return record;
}

function biffLabel(row: number, col: number, text: string): Uint8Array {
  // Record layout: row(2) col(2) xf(2) cch(2) flags(1) chars...
  const head = new Uint8Array(9);
  head[0] = row & 0xff; head[1] = (row >> 8) & 0xff;
  head[2] = col & 0xff; head[3] = (col >> 8) & 0xff;
  head[4] = 0; head[5] = 0; // xf
  head[6] = text.length & 0xff; head[7] = (text.length >> 8) & 0xff;
  head[8] = 0x01; // flags: wide string
  const chars = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    chars[i * 2] = code & 0xff;
    chars[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return biffRecord(0x0204, concatBytes(head, chars));
}

function biffNumber(row: number, col: number, value: number): Uint8Array {
  const head = new Uint8Array(6);
  head[0] = row & 0xff; head[1] = (row >> 8) & 0xff;
  head[2] = col & 0xff; head[3] = (col >> 8) & 0xff;
  head[4] = 0; head[5] = 0;
  const valueBytes = new Uint8Array(8);
  new DataView(valueBytes.buffer).setFloat64(0, value, true);
  return biffRecord(0x0203, concatBytes(head, valueBytes));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function buildBiff(title: string, header: string[], rows: (string | number)[][]): Uint8Array {
  const parts: Uint8Array[] = [];
  // globals BOF + sheet BOF (type 0x0010 worksheet)
  const globalsBof = new Uint8Array(16);
  globalsBof[0] = 0x00; globalsBof[1] = 0x06; globalsBof[2] = 0x05; globalsBof[3] = 0x00;
  parts.push(biffRecord(0x0809, globalsBof));
  const sheetBof = new Uint8Array(16);
  sheetBof[0] = 0x00; sheetBof[1] = 0x06; sheetBof[2] = 0x10; sheetBof[3] = 0x00;
  parts.push(biffRecord(0x0809, sheetBof));
  const grid: (string | number | null)[][] = [[title], [ ...header ], ...rows];
  grid.forEach((row, r) => row.forEach((value, c) => {
    if (value === null) return;
    if (typeof value === "string") parts.push(biffLabel(r, c, value));
    else parts.push(biffNumber(r, c, value));
  }));
  parts.push(biffRecord(0x000a, new Uint8Array(0)));
  return concatBytes(...parts);
}

test("detects OLE2 magic on the real WeChat export", () => {
  assert.equal(isOle2(new Uint8Array(readFixture())), true);
  assert.equal(isOle2(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), false);
});

test("extracts the range from the report title", () => {
  assert.deepEqual(extractReportRange("全部群发详细数据-日报（2025-10-01至2025-11-01）"), {
    begin: "2025-10-01",
    end: "2025-11-01",
  });
  assert.equal(extractReportRange("无范围标题"), undefined);
});

test("parses the real WeChat template export into a sheet", () => {
  const sheet = parseXlsReport(readFixture());
  assert.ok(sheet);
  assert.match(sheet.title ?? "", /日报/);
  assert.deepEqual(sheet.rows[1]?.slice(1, 11), [
    "日期",
    "阅读次数",
    "阅读人数",
    "分享次数",
    "分享人数",
    "阅读原文次数",
    "阅读原文人数",
    "收藏次数",
    "收藏人数",
    "渠道",
  ]);
  assert.equal(sheet.rows.length, 290);
});

test("parseReportPage rejects the zeroed template with a clear error", () => {
  assert.throws(
    () => parseReportPage(readFixture(), 0, 30, { begin_date: "2026-08-05", end_date: "2026-08-12" }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return error instanceof Error && (error as { code?: string }).code === "NO_DATA" && /template/i.test(message);
    },
  );
});

test("parseReportPage parses a synthetic XLS with real values", () => {
  const xls = buildXls("全部群发详细数据-日报（2026-08-05至2026-08-12）", ["日期", "阅读次数", "渠道"], [
    ["2026-08-05", 0, "公众号消息"],
    ["2026-08-05", 0, "搜一搜"],
    ["2026-08-05", 120, "推荐"],
    ["2026-08-06", 8, "搜一搜"],
  ]);
  const page = parseReportPage(xls, 0, 10, { begin_date: "2026-08-05", end_date: "2026-08-12" });
  assert.equal(page.total, 4);
  assert.equal(page.rows[0]?.["日期"], "2026-08-05");
  assert.equal(page.rows[0]?.["阅读次数"], "0");
  assert.equal(page.rows[0]?.["渠道"], "公众号消息");
  assert.equal(page.rows[2]?.["阅读次数"], "120");
  assert.equal(page.rows[2]?.["渠道"], "推荐");
  assert.equal(page.title, "全部群发详细数据-日报（2026-08-05至2026-08-12）");
});

test("parseBiff8Workbook skips unknown records", () => {
  const xls = buildXls("t", ["a"], [["1"]]);
  const workbook = parseOle2ForTest(xls);
  assert.ok(workbook);
});

import { parseOle2Streams } from "../src/services/xls.js";
function parseOle2ForTest(xls: ArrayBuffer): Uint8Array | undefined {
  return parseOle2Streams(new Uint8Array(xls)).get("Workbook");
}
