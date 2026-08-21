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
  prepareDraftHtmlDocument,
} from "./services/parsers.js";
import { validateHtmlSourceFile, validateImageFile } from "./services/config.js";
import {
  buildLegacyMaterialUploadQuery,
  buildMaterialUploadQuery,
  extractMaterialGroupIds,
  WechatClient,
} from "./services/wechat-client.js";
import type { DraftArticle } from "./types.js";

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
      "Access to the user's logged-in WeChat Official Account. Call wechat_official_check_auth before a workflow. Every authenticated backend tool also performs a fresh lightweight authentication preflight and stops before its requested operation if verification fails. Never ask for or echo cookie values. Upload and draft-save tools require confirm=true and never publish. A write timeout is ambiguous: inspect the material library or draft box and never retry automatically.",
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
      const { session, homeHtml: html } = await client.verifyAuthentication();
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
      const { homeHtml: html } = await client.verifyAuthentication();
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
      await client.verifyAuthentication();
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
      "Extract title, account, author, date, summary, images, links, and readable text from one public mp.weixin.qq.com/s article URL. Defaults to an anonymous request, then performs an authentication preflight and retries once with the local backend Cookie only if WeChat returns an environment challenge.",
    inputSchema: z
      .object({
        url: z.string().url(),
        max_characters: z.number().int().min(1_000).max(MAX_RESPONSE_CHARACTERS).default(20_000),
        authentication: z
          .enum(["auto", "never", "required"])
          .default("auto")
          .describe("auto: anonymous first with one authenticated fallback; never: never send the backend Cookie; required: preflight and use the Cookie immediately"),
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
  async ({ url, max_characters, authentication, response_format }) => {
    try {
      const { html, accessMode } = await client.getPublicArticle(url, authentication);
      const article = parsePublicArticle(html, max_characters);
      const markdown = [
        `# ${article.title}`,
        "",
        article.account_name ? `- 公众号：${article.account_name}` : undefined,
        article.author ? `- 作者：${article.author}` : undefined,
        article.published_at ? `- 发布时间：${article.published_at}` : undefined,
        article.description ? `- 摘要：${article.description}` : undefined,
        `- 访问方式：${accessMode === "anonymous" ? "匿名公开页面" : "已验证本地会话回退"}`,
        "",
        article.content,
      ]
        .filter((value) => value !== undefined)
        .join("\n");
      return formatResult(
        { ok: true, url, access_mode: accessMode, ...article },
        markdown,
        response_format,
      );
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
      await client.verifyAuthentication();
      assertDateRange(begin_date, end_date);
      const buffer = await client.getReport("/misc/appmsganalysis", {
        action: "report",
        begin_date,
        end_date,
        type: "daily",
        download: 1,
        source: 99999999,
      });
      const page = parseReportPage(buffer, offset, limit, { begin_date, end_date });
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
      await client.verifyAuthentication();
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

const draftArticleShape = {
  title: z
    .string()
    .min(1)
    .max(TITLE_MAX_LENGTH)
    .optional()
    .describe("Article title (1-64 chars); inferred from source_html_path when omitted"),
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
    .optional()
    .describe("HTML body content (1-500000 chars); use either this or source_html_path"),
  source_html_path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Local .html/.htm source inside WECHAT_OFFICIAL_UPLOAD_ROOTS. CSS is inlined; the duplicate body h1, outer layout margins, links, publish-config section, and empty list rows are removed; real bullets, internal styles, and ad copy are preserved.",
    ),
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
};

function makeDraftArticleSchema(requireCover: boolean) {
  return z
    .object({
      ...draftArticleShape,
      cover_media_id: requireCover
        ? z.string().min(1).max(512).describe("Media/file ID from upload_image")
        : draftArticleShape.cover_media_id,
    })
    .strict()
    .superRefine((value, context) => {
      const sourceCount = Number(Boolean(value.content_html)) + Number(Boolean(value.source_html_path));
      if (sourceCount !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide exactly one of content_html or source_html_path.",
          path: ["content_html"],
        });
      }
      if (!value.source_html_path && !value.title) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "title is required when content_html is supplied directly.",
          path: ["title"],
        });
      }
    });
}

const draftArticleSchema = makeDraftArticleSchema(false);
const draftArticleWithCoverSchema = makeDraftArticleSchema(true);

type DraftArticleToolInput = z.infer<typeof draftArticleSchema>;

function resolveDraftArticleInputs(inputs: DraftArticleToolInput[]) {
  const htmlImports: Array<Record<string, unknown>> = [];
  const articles: DraftArticle[] = inputs.map((input, index) => {
    let title = input.title;
    let digest = input.digest;
    let contentHtml = input.content_html;

    if (input.source_html_path) {
      const source = validateHtmlSourceFile(input.source_html_path);
      const prepared = prepareDraftHtmlDocument(source.html, source.filename);
      title = title || prepared.title;
      digest = digest || prepared.digest;
      contentHtml = prepared.content_html;
      htmlImports.push({
        article_index: index,
        source_filename: prepared.source_filename,
        source_size: source.size,
        removed_link_count: prepared.removed_link_count,
        removed_publish_config_count: prepared.removed_publish_config_count,
        removed_title_count: prepared.removed_title_count,
        compacted_list_count: prepared.compacted_list_count,
        removed_empty_list_item_count: prepared.removed_empty_list_item_count,
        normalized_bordered_callout_count: prepared.normalized_bordered_callout_count,
        preserved_ad_count: prepared.preserved_ad_count,
        inline_style_count: prepared.inline_style_count,
      });
    }

    if (!title || !contentHtml) {
      throw new WechatMcpError(
        "VALIDATION_ERROR",
        `Article ${index + 1} could not resolve a title and HTML body.`,
      );
    }

    return {
      title,
      ...(input.author ? { author: input.author } : {}),
      ...(digest ? { digest } : {}),
      content_html: contentHtml,
      ...(input.source_url ? { source_url: input.source_url } : {}),
      ...(input.cover_media_id ? { cover_media_id: input.cover_media_id } : {}),
      show_cover: input.show_cover,
      open_comment: input.open_comment,
      fans_only_comment: input.fans_only_comment,
    };
  });
  return { articles, htmlImports };
}

server.registerTool(
  "wechat_official_validate_draft",
  {
    title: "Validate a draft before saving",
    description:
      "Local-only validation of article drafts for a WeChat Official Account. Can import an approved original HTML file, inline its CSS like rich-text browser copy, remove the duplicate body title and outer layout margins, compact list whitespace, normalize simple bordered blocks to a WeChat-compatible rounded paragraph callout, remove hyperlinks and publish configuration, preserve real bullets and ad copy, and validate the resulting draft. Does not access WeChat.",
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
      const resolved = resolveDraftArticleInputs(articles as DraftArticleToolInput[]);
      const result = validateDraftArticles(resolved.articles);
      const responseData = { ...result, html_imports: resolved.htmlImports };
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
        ...(resolved.htmlImports.length > 0
          ? [
              "",
              "## HTML imports",
              ...resolved.htmlImports.map(
                (item) =>
                  `- ${item.source_filename}: ${item.inline_style_count} inline styles, ${item.removed_link_count} links removed, ${item.removed_title_count} duplicate body title(s) removed, ${item.compacted_list_count} list(s) compacted, ${item.removed_empty_list_item_count} empty list item(s) removed, ${item.normalized_bordered_callout_count} bordered callout(s) normalized, ${item.removed_publish_config_count} publish-config section(s) removed, ${item.preserved_ad_count} ad block(s) preserved`,
              ),
            ]
          : []),
      ].join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: response_format === "json" ? JSON.stringify(responseData, null, 2) : markdown,
          },
        ],
        structuredContent: responseData,
      };
    } catch (error) {
      return buildDraftToolError(error);
    }
  },
);

// ── Material diagnostics and image upload tools ──

server.registerTool(
  "wechat_official_list_material_groups",
  {
    title: "List WeChat material group IDs",
    description:
      "Read the logged-in account's material-library page and return only detected numeric group IDs. Does not expose page HTML or authentication fields and does not modify WeChat.",
    inputSchema: z
      .object({ response_format: z.enum(["markdown", "json"]).default("markdown") })
      .strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ response_format }) => {
    try {
      await client.verifyAuthentication();
      const materialHtml = await client.getMaterialPage(0);
      const groupIds = extractMaterialGroupIds(materialHtml);
      return formatResult(
        { ok: true, group_ids: groupIds },
        ["# Material groups", "", `- Group IDs: ${groupIds.length ? groupIds.join(", ") : "none detected"}`].join("\n"),
        response_format,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

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
        group_id: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional()
          .describe("Optional material-library group ID; used only with usage=material"),
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
  async ({ file_path, usage, group_id, confirm, response_format }) => {
    try {
      if (!confirm) return confirmError("wechat_official_upload_image");

      await client.verifyAuthentication();

      const validated = validateImageFile(file_path);

      let result: unknown;
      if (usage === "article") {
        result = await client.postMultipart(
          "/cgi-bin/uploadimg2cdn",
          { t: "ajax-editor-upload-img" },
          {
            id: validated.filename,
            name: validated.filename,
            type: validated.mime,
            lastModifiedDate: new Date().toString(),
            size: String(validated.size),
          },
          "upfile",
          validated.filename,
          validated.buffer,
          validated.mime,
        );
      } else {
        const usesCurrentMaterialLibrary = group_id !== undefined;
        const contextHtml = usesCurrentMaterialLibrary
          ? await client.getMaterialPage(group_id)
          : await client.getEditorPage();
        const context = parseEditorContext(contextHtml);
        if (!context.ticket || !context.user_name || !context.svr_time) {
          throw new WechatMcpError(
            "UPSTREAM_CHANGED",
            usesCurrentMaterialLibrary
              ? "The WeChat material library no longer exposes the fields required for material upload."
              : "The WeChat editor no longer exposes the fields required for legacy material upload.",
          );
        }

        const uploadContext = {
          user_name: context.user_name,
          ticket: context.ticket,
          svr_time: context.svr_time,
        };

        result = await client.postMultipart(
          "/cgi-bin/filetransfer",
          usesCurrentMaterialLibrary
            ? buildMaterialUploadQuery(uploadContext, group_id)
            : buildLegacyMaterialUploadQuery(uploadContext),
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
        parsed.data.file_id ??
        parsed.data.nested_media_id ??
        parsed.data.nested_fileid ??
        parsed.data.nested_file_id;
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
      if (usage === "material" && mediaId) {
        const materialGroupId = group_id ?? 0;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const materialVisible = await client.hasMaterialImage(
          materialGroupId,
          String(mediaId),
          validated.filename,
        );
        if (!materialVisible) {
          throw new WechatMcpError(
            "UPSTREAM_CHANGED",
            "WeChat returned a material ID, but the uploaded image was not visible in the target material group.",
            false,
            { write_result_ambiguous: true, group_id: materialGroupId },
          );
        }
      }
      const safeResult = {
        ok: true,
        filename: validated.filename,
        size: validated.size,
        mime: validated.mime,
        usage,
        group_id: usage === "material" ? (group_id ?? 0) : undefined,
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
      "Create and save up to 8 articles as a draft. Accepts direct HTML or an approved source_html_path; source files keep CSS as inline styles while the duplicate body title, outer layout margins, empty list rows, hyperlinks, and publish configuration are removed. Simple bordered blocks are normalized to a WeChat-compatible rounded paragraph callout; real bullets and ad copy are preserved. Requires uploaded cover media IDs and confirm=true. Never publishes.",
    inputSchema: z
      .object({
        articles: z
          .array(draftArticleWithCoverSchema)
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

      await client.verifyAuthentication();

      const resolved = resolveDraftArticleInputs(articles as DraftArticleToolInput[]);

      // Validate locally first
      const validation = validateDraftArticles(
        resolved.articles,
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
      const fields = buildDraftPayload(resolved.articles, context);
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
        article_count: resolved.articles.length,
        titles: resolved.articles.map((article) => article.title),
        html_imports: resolved.htmlImports,
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
