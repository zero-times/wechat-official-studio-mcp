#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MAX_REPORT_DAYS,
  MAX_RESPONSE_CHARACTERS,
  SERVER_NAME,
  SERVER_VERSION,
  DRAFT_MAX_ARTICLES,
  DRAFT_MIN_ARTICLES,
  TITLE_MAX_LENGTH,
  AUTHOR_MAX_LENGTH,
  DIGEST_MAX_LENGTH,
  CONTENT_HTML_MAX_LENGTH,
} from "./constants.js";
import { errorPayload, WechatMcpError } from "./services/errors.js";
import {
  parseAccountInfo,
  parseEditorContext,
  parsePublicArticle,
  parsePublishedArticlePage,
  parseReportPage,
  validateDraftArticles,
  buildDraftPayload,
  parseWriteResponse,
} from "./services/parsers.js";
import { validateImageFile } from "./services/config.js";
import { WechatClient } from "./services/wechat-client.js";

const client = new WechatClient();
const responseFormatSchema = z.enum(["markdown", "json"]).default("markdown");

function formatResult(data: Record<string, unknown>, markdown: string, format: "markdown" | "json") {
  return {
    content: [
      {
        type: "text" as const,
        text: format === "json" ? JSON.stringify(data, null, 2) : markdown,
      },
    ],
    structuredContent: data,
  };
}

function toolError(error: unknown) {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function assertDateRange(beginDate: string, endDate: string): void {
  const begin = new Date(`${beginDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const days = Math.floor((end.getTime() - begin.getTime()) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > MAX_REPORT_DAYS) {
    throw new Error(`Date range must contain 1-${MAX_REPORT_DAYS} days.`);
  }
}

function reportMarkdown(title: string, page: ReturnType<typeof parseReportPage>): string {
  if (!page.rows.length) return `# ${title}\n\n该时间范围内没有数据。`;
  const lines = [
    `# ${title}`,
    "",
    `共 ${page.total} 行，本次返回 ${page.count} 行（偏移 ${page.offset}）。`,
    "",
  ];
  for (const [index, row] of page.rows.entries()) {
    lines.push(`## ${page.offset + index + 1}`);
    for (const [key, value] of Object.entries(row)) lines.push(`- ${key}: ${value}`);
    lines.push("");
  }
  if (page.hasMore) lines.push(`还有更多数据，下次 offset=${page.nextOffset}。`);
  return lines.join("\n");
}

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    instructions:
      "Access to the user's logged-in WeChat Official Account. Call wechat_official_check_auth before backend tools. Never ask for or echo cookie values. Upload and draft-save tools require confirm=true and never publish. A write timeout is ambiguous: inspect the material library or draft box and never retry automatically.",
  },
);

server.registerTool(
  "wechat_official_check_auth",
  {
    title: "Check WeChat Official Account login",
    description:
      "Validate the locally stored WeChat Official Platform cookie and return non-secret session/account status. Call this first before backend reads. Never pass a cookie as an argument.",
    inputSchema: z.object({ response_format: responseFormatSchema }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ response_format }) => {
    try {
      const session = await client.getSession();
      const html = await client.getText("/cgi-bin/home", { t: "home/index" });
      const account = parseAccountInfo(html);
      const data = {
        ok: true,
        status: "authenticated",
        credential_source: session.config.cookieSource,
        account,
      };
      return formatResult(
        data,
        `已登录微信公众平台${account.nickname ? `：${account.nickname}` : ""}。Cookie 来自本地${session.config.cookieSource === "cookie_file" ? "安全文件" : "环境变量"}。`,
        response_format,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "wechat_official_get_account_info",
  {
    title: "Get current WeChat Official Account info",
    description:
      "Read the nickname, original ID, avatar, and account type for the currently logged-in WeChat Official Account. Does not expose cookies or login tokens.",
    inputSchema: z.object({ response_format: responseFormatSchema }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ response_format }) => {
    try {
      const html = await client.getText("/cgi-bin/home", { t: "home/index" });
      const account = parseAccountInfo(html);
      return formatResult(
        { ok: true, account },
        [
          "# 公众号信息",
          "",
          account.nickname ? `- 名称：${account.nickname}` : undefined,
          account.originalId ? `- 原始 ID：${account.originalId}` : undefined,
          account.accountType ? `- 类型：${account.accountType}` : undefined,
          account.avatarUrl ? `- 头像：${account.avatarUrl}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
        response_format,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "wechat_official_list_published_articles",
  {
    title: "List published WeChat articles",
    description:
      "List or search articles published by the currently logged-in account. This reads the account's own publication history; it is not an arbitrary third-party account crawler.",
    inputSchema: z
      .object({
        query: z.string().trim().max(100).optional().describe("Optional title keyword"),
        limit: z.number().int().min(1).max(20).default(10),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormatSchema,
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ query, limit, offset, response_format }) => {
    try {
      const payload = await client.getJson("/cgi-bin/appmsgpublish", {
        sub: query ? "search" : "list",
        begin: offset,
        count: limit,
        f: "json",
        ajax: 1,
        ...(query ? { query, search_field: 7 } : {}),
      });
      const page = parsePublishedArticlePage(payload, offset);
      const lines = [
        "# 已发表文章",
        "",
        `共 ${page.total} 组发表记录，本次返回 ${page.count} 篇文章。`,
        "",
      ];
      for (const article of page.articles) {
        lines.push(`## ${article.title}`);
        if (article.publishedAt) lines.push(`- 发表时间：${article.publishedAt}`);
        if (article.digest) lines.push(`- 摘要：${article.digest}`);
        if (article.readNum !== undefined) lines.push(`- 阅读：${article.readNum}`);
        if (article.likeNum !== undefined) lines.push(`- 在看/喜欢：${article.likeNum}`);
        if (article.shareNum !== undefined) lines.push(`- 分享：${article.shareNum}`);
        if (article.commentNum !== undefined) lines.push(`- 留言：${article.commentNum}`);
        if (article.reprintNum !== undefined) lines.push(`- 转载：${article.reprintNum}`);
        if (article.url) lines.push(`- 链接：${article.url}`);
        lines.push("");
      }
      if (page.hasMore) lines.push(`还有更多，下次 offset=${page.nextOffset}。`);
      return formatResult({ ok: true, ...page }, lines.join("\n"), response_format);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "wechat_official_read_article",
  {
    title: "Read a public WeChat article",
    description:
      "Extract title, account, author, date, summary, images, links, and readable text from one public mp.weixin.qq.com/s article URL. The backend cookie is not sent with this public request.",
    inputSchema: z
      .object({
        url: z.string().url(),
        max_characters: z.number().int().min(1_000).max(MAX_RESPONSE_CHARACTERS).default(20_000),
        response_format: responseFormatSchema,
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ url, max_characters, response_format }) => {
    try {
      const html = await client.getPublicArticle(url);
      const article = parsePublicArticle(html, max_characters);
      const markdown = [
        `# ${article.title}`,
        "",
        article.account_name ? `- 公众号：${article.account_name}` : undefined,
        article.author ? `- 作者：${article.author}` : undefined,
        article.published_at ? `- 发布时间：${article.published_at}` : undefined,
        article.description ? `- 摘要：${article.description}` : undefined,
        "",
        article.content,
      ]
        .filter((value) => value !== undefined)
        .join("\n");
      return formatResult({ ok: true, url, ...article }, markdown, response_format);
    } catch (error) {
      return toolError(error);
    }
  },
);

const reportInputSchema = z
  .object({
    begin_date: z.string().date().describe("Inclusive start date in YYYY-MM-DD"),
    end_date: z.string().date().describe("Inclusive end date in YYYY-MM-DD"),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
    response_format: responseFormatSchema,
  })
  .strict();

server.registerTool(
  "wechat_official_get_article_report",
  {
    title: "Get WeChat article analytics",
    description:
      "Read the currently logged-in account's official exported article analytics for a fixed date range of at most 100 days. Returns the columns supplied by WeChat without inventing metrics.",
    inputSchema: reportInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ begin_date, end_date, limit, offset, response_format }) => {
    try {
      assertDateRange(begin_date, end_date);
      const buffer = await client.getReport("/misc/appmsganalysis", {
        action: "report",
        begin_date,
        end_date,
        type: "daily",
        download: 1,
        source: 99999999,
      });
      const page = parseReportPage(buffer, offset, limit);
      return formatResult(
        { ok: true, begin_date, end_date, ...page },
        reportMarkdown("图文分析", page),
        response_format,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "wechat_official_get_follower_report",
  {
    title: "Get WeChat follower analytics",
    description:
      "Read the currently logged-in account's official exported follower analytics for a fixed date range of at most 100 days. Returns the source columns as supplied by WeChat.",
    inputSchema: reportInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ begin_date, end_date, limit, offset, response_format }) => {
    try {
      assertDateRange(begin_date, end_date);
      const buffer = await client.getReport("/misc/useranalysis", {
        download: 1,
        begin_date,
        end_date,
        source: 99999999,
      });
      const page = parseReportPage(buffer, offset, limit);
      return formatResult(
        { ok: true, begin_date, end_date, ...page },
        reportMarkdown("用户分析", page),
        response_format,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

// ── Write-safety helpers ──

function confirmError(toolName: string): never {
  throw new WechatMcpError(
    "WRITE_CONFIRMATION_REQUIRED",
    `The tool "${toolName}" is a write operation. Set confirm=true to proceed. ` +
      "This tool only saves drafts and uploads images; it never publishes.",
  );
}

function buildDraftToolError(error: unknown) {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

// ── Draft validate tool ──

const draftArticleSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(TITLE_MAX_LENGTH)
    .describe("Article title (1-64 chars)"),
  author: z
    .string()
    .max(AUTHOR_MAX_LENGTH)
    .optional()
    .describe("Author name (max 32 chars)"),
  digest: z
    .string()
    .max(DIGEST_MAX_LENGTH)
    .optional()
    .describe("Digest/summary (max 120 chars)"),
  content_html: z
    .string()
    .min(1)
    .max(CONTENT_HTML_MAX_LENGTH)
    .describe("HTML body content (1-500000 chars)"),
  source_url: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://"), "source_url must use HTTPS")
    .optional()
    .describe("Optional HTTPS source URL"),
  cover_media_id: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe("Media/file ID from a prior wechat_official_upload_image call"),
  show_cover: z
    .boolean()
    .default(true)
    .describe("Show cover image in article"),
  open_comment: z
    .boolean()
    .default(false)
    .describe("Allow comments"),
  fans_only_comment: z
    .boolean()
    .default(false)
    .describe("Restrict comments to fans only"),
});

server.registerTool(
  "wechat_official_validate_draft",
  {
    title: "Validate a draft before saving",
    description:
      "Local-only validation of article drafts for a WeChat Official Account. Checks title/author/digest lengths, HTML content for forbidden tags and URLs, and cover media IDs. Returns errors, warnings, and per-article summaries. Does not access the network.",
    inputSchema: z
      .object({
        articles: z
          .array(draftArticleSchema)
          .min(DRAFT_MIN_ARTICLES)
          .max(DRAFT_MAX_ARTICLES)
          .describe("1-8 draft articles"),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ articles, response_format }) => {
    try {
      const result = validateDraftArticles(articles as import("./types.js").DraftArticle[]);
      const markdown = [
        result.valid ? "# Draft looks good" : "# Draft has issues",
        "",
        `**${result.errors.length} error(s), ${result.warnings.length} warning(s)**`,
        "",
        ...(result.errors.length > 0
          ? ["## Errors", ...result.errors.map((e) => `- Article ${e.article_index + 1}, ${e.field}: ${e.message}`), ""]
          : []),
        ...(result.warnings.length > 0
          ? ["## Warnings", ...result.warnings.map((w) => `- Article ${w.article_index + 1}, ${w.field}: ${w.message}`), ""]
          : []),
        "## Summaries",
        ...result.summaries.map(
          (s) =>
            `- **#${s.index + 1}** "${s.title}" — ${s.char_count} text chars, ${s.image_count} image(s), cover: ${s.has_cover ? "yes" : "pending"}, comments: ${s.open_comment ? (s.fans_only_comment ? "fans only" : "open") : "off"}`,
        ),
      ].join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: response_format === "json" ? JSON.stringify(result, null, 2) : markdown,
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return buildDraftToolError(error);
    }
  },
);

// ── Image upload tool ──

server.registerTool(
  "wechat_official_upload_image",
  {
    title: "Upload an image to WeChat Official Account",
    description:
      "Upload one local JPEG, PNG, or GIF image to the logged-in WeChat Official Account as material (cover) or article body image. Returns safe metadata (filename, size, MIME, media_id, CDN URL). Requires confirm=true. Never publishes.",
    inputSchema: z
      .object({
        file_path: z.string().min(1).describe("Local path to the image file (must be within WECHAT_OFFICIAL_UPLOAD_ROOTS)"),
        usage: z
          .enum(["material", "article"])
          .default("material")
          .describe("Upload as material (cover/library) or article (inline body image)"),
        confirm: z
          .boolean()
          .describe("Must be set to true to proceed with the upload."),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ file_path, usage, confirm, response_format }) => {
    try {
      if (!confirm) return confirmError("wechat_official_upload_image");

      const validated = validateImageFile(file_path);

      let result: unknown;
      if (usage === "article") {
        result = await client.postMultipart(
          "/cgi-bin/uploadimg2cdn",
          { t: "ajax-editor-upload-img" },
          {},
          "img",
          validated.filename,
          validated.buffer,
          validated.mime,
        );
      } else {
        const editorHtml = await client.getEditorPage();
        const context = parseEditorContext(editorHtml);
        if (!context.ticket || !context.user_name || !context.svr_time) {
          throw new WechatMcpError(
            "UPSTREAM_CHANGED",
            "The WeChat editor no longer exposes the fields required for material upload.",
          );
        }

        result = await client.postMultipart(
          "/cgi-bin/filetransfer",
          {
            action: "upload_material",
            f: "json",
            ticket_id: context.user_name,
            ticket: context.ticket,
            svr_time: String(context.svr_time),
          },
          {},
          "file",
          validated.filename,
          validated.buffer,
          validated.mime,
        );
      }

      const parsed = parseWriteResponse(result);
      const mediaId =
        parsed.data.media_id ??
        parsed.data.fileid ??
        parsed.data.nested_media_id ??
        parsed.data.nested_fileid;
      const cdnUrl =
        parsed.data.cdn_url ??
        parsed.data.url ??
        parsed.data.nested_cdn_url ??
        parsed.data.nested_url;
      if (usage === "material" && !mediaId) {
        throw new WechatMcpError(
          "UPSTREAM_CHANGED",
          "The material upload succeeded but no recognized material ID was returned.",
        );
      }
      if (usage === "article" && !cdnUrl) {
        throw new WechatMcpError(
          "UPSTREAM_CHANGED",
          "The article image upload succeeded but no recognized HTTPS CDN URL was returned.",
        );
      }
      const safeResult = {
        ok: true,
        filename: validated.filename,
        size: validated.size,
        mime: validated.mime,
        usage,
        media_id: mediaId ? String(mediaId) : undefined,
        cdn_url: cdnUrl ? String(cdnUrl) : undefined,
      };

      const markdown = [
        "# Image uploaded",
        "",
        `- File: ${safeResult.filename}`,
        `- Size: ${safeResult.size} bytes`,
        `- Type: ${safeResult.mime}`,
        safeResult.media_id ? `- Media ID: ${safeResult.media_id}` : undefined,
        safeResult.cdn_url ? `- CDN URL: ${safeResult.cdn_url}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: response_format === "json" ? JSON.stringify(safeResult, null, 2) : markdown,
          },
        ],
        structuredContent: safeResult,
      };
    } catch (error) {
      return buildDraftToolError(error);
    }
  },
);

// ── Create draft tool ──

server.registerTool(
  "wechat_official_create_draft",
  {
    title: "Create and save a WeChat draft",
    description:
      "Create and save up to 8 articles as a draft on the logged-in WeChat Official Account. Uses cover media IDs from prior uploads. Requires confirm=true. The draft is saved but never published.",
    inputSchema: z
      .object({
        articles: z
          .array(draftArticleSchema.extend({ cover_media_id: z.string().min(1).max(512) }))
          .min(DRAFT_MIN_ARTICLES)
          .max(DRAFT_MAX_ARTICLES)
          .describe("1-8 draft articles with cover media IDs from prior upload_image calls"),
        confirm: z
          .boolean()
          .describe("Must be set to true to proceed with the draft save."),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ articles, confirm, response_format }) => {
    try {
      if (!confirm) return confirmError("wechat_official_create_draft");

      // Validate locally first
      const validation = validateDraftArticles(
        articles as import("./types.js").DraftArticle[],
        { requireCover: true },
      );
      if (!validation.valid) {
        const errorText = [
          "# Draft validation failed",
          "",
          ...validation.errors.map((e) => `- Article ${e.article_index + 1}, ${e.field}: ${e.message}`),
        ].join("\n");
        return {
          isError: true,
          content: [{ type: "text" as const, text: errorText }],
        };
      }

      // Get editor context
      const editorHtml = await client.getEditorPage();
      const context = parseEditorContext(editorHtml);
      if (!context.template_version) {
        throw new WechatMcpError(
          "UPSTREAM_CHANGED",
          "The WeChat editor no longer exposes the template version required for draft creation.",
        );
      }

      // Build and send payload
      const fields = buildDraftPayload(articles as import("./types.js").DraftArticle[], context);
      const result = await client.postForm(
        "/cgi-bin/operate_appmsg",
        { t: "ajax-response", sub: "create", type: "77" },
        fields,
      );

      const parsed = parseWriteResponse(result);

      const safeResult = {
        ok: true,
        status: "draft_saved",
        draft_msgid: String(parsed.data.msgid ?? parsed.data.appmsgid ?? parsed.data.nested_msgid ?? ""),
        article_count: articles.length,
        titles: articles.map((article) => article.title),
      };

      const markdown = [
        "# Draft saved",
        "",
        `- Status: ${safeResult.status}`,
        safeResult.draft_msgid ? `- Draft msgid: ${safeResult.draft_msgid}` : "",
        `- Articles: ${safeResult.article_count}`,
      ]
        .filter((line) => line !== "")
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: response_format === "json" ? JSON.stringify(safeResult, null, 2) : markdown,
          },
        ],
        structuredContent: safeResult,
      };
    } catch (error) {
      return buildDraftToolError(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
