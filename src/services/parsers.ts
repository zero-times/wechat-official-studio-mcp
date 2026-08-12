import { load } from "cheerio";
import { parse as parseCsv } from "csv-parse/sync";
import type {
  AccountInfo,
  DraftArticle,
  DraftValidationResult,
  EditorContext,
  PublishedArticle,
  PublishedArticlePage,
  ReportPage,
} from "../types.js";
import {
  DRAFT_MIN_ARTICLES,
  DRAFT_MAX_ARTICLES,
  TITLE_MIN_LENGTH,
  TITLE_MAX_LENGTH,
  AUTHOR_MAX_LENGTH,
  DIGEST_MAX_LENGTH,
  CONTENT_HTML_MAX_LENGTH,
} from "../constants.js";
import { WechatMcpError } from "./errors.js";

function decodeJavascriptString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value.replace(/\\\//g, "/");
  }
}

function findAssignment(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(new RegExp(`${escaped}\\s*[:=]\\s*["']((?:\\\\.|[^"'])*)["']`));
    if (match?.[1]) return decodeJavascriptString(match[1]);
  }
  return undefined;
}

function findNumericAssignment(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = html.match(new RegExp(`${escaped}\\s*[:=]\\s*(\\d+)`));
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function parseAccountInfo(html: string): AccountInfo {
  const nickname = findAssignment(html, [
    "wx.cgiData.nick_name",
    "wx.commonData.data.nick_name",
  ]);
  const username = findAssignment(html, ["wx.cgiData.user_name", "wx.commonData.data.user_name"]);
  const originalId = findAssignment(html, [
    "wx.cgiData.alias",
    "wx.commonData.data.alias",
    "wx.cgiData.original_id",
  ]);
  const avatarUrl = findAssignment(html, [
    "wx.cgiData.head_img",
    "wx.commonData.data.head_img",
  ]);
  const accountType = findAssignment(html, [
    "wx.cgiData.service_type",
    "wx.commonData.data.service_type",
  ]);

  if (!nickname && !username && !avatarUrl) {
    throw new WechatMcpError(
      "INVALID_RESPONSE",
      "The account page loaded, but its account fields could not be recognized.",
      false,
    );
  }
  // `username` is used only as a structural fallback. It is an internal account
  // identifier and must not be returned by public tools.
  return { nickname, originalId, avatarUrl, accountType };
}

export function parseNestedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function formatTimestamp(value: unknown): string | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return undefined;
  const milliseconds = number < 10_000_000_000 ? number * 1_000 : number;
  return new Date(milliseconds).toISOString();
}

function normalizeArticle(
  value: unknown,
  fallback: Record<string, unknown>,
  itemIndex: number,
): PublishedArticle | undefined {
  const article = asRecord(parseNestedJson(value));
  const title = firstString(article, ["title", "appmsg_title"]);
  if (!title) return undefined;
  return {
    title,
    url: firstString(article, ["link", "url", "content_url"]),
    digest: firstString(article, ["digest", "desc"]),
    author: firstString(article, ["author", "author_name"]),
    coverUrl: firstString(article, ["cover", "cover_url", "cdn_url"]),
    publishedAt:
      formatTimestamp(article.publish_time) ||
      formatTimestamp(article.create_time) ||
      formatTimestamp(fallback.publish_time) ||
      formatTimestamp(fallback.sent_time) ||
      formatTimestamp(fallback.time),
    messageId: firstString(article, ["msgid", "appmsgid", "id"]),
    itemIndex:
      typeof article.itemidx === "number"
        ? article.itemidx
        : typeof article.idx === "number"
          ? article.idx
          : itemIndex,
    readNum: firstNumber(article, ["read_num", "readNum"]),
    likeNum: firstNumber(article, ["like_num", "likeNum"]),
    oldLikeNum: firstNumber(article, ["old_like_num", "oldLikeNum"]),
    shareNum: firstNumber(article, ["share_num", "shareNum"]),
    commentNum: firstNumber(article, ["comment_num", "commentNum"]),
    totalCommentCount: firstNumber(article, [
      "total_comment_count_contains_reply",
      "total_comment_count",
    ]),
    reprintNum: firstNumber(article, ["reprint_num", "reprintNum"]),
    momentLikeNum: firstNumber(article, ["moment_like_num", "momentLikeNum"]),
  };
}

export function parsePublishedArticlePage(
  payload: unknown,
  offset: number,
): PublishedArticlePage {
  const root = asRecord(payload);
  const page = asRecord(parseNestedJson(root.publish_page ?? root.publishPage ?? root));
  const publishList = Array.isArray(page.publish_list)
    ? page.publish_list
    : Array.isArray(page.list)
      ? page.list
      : [];
  const articles: PublishedArticle[] = [];

  for (const entryValue of publishList) {
    const entry = asRecord(parseNestedJson(entryValue));
    const publishInfo = asRecord(parseNestedJson(entry.publish_info ?? entry.publishInfo ?? entry));
    const sentInfo = asRecord(parseNestedJson(publishInfo.sent_info ?? entry.sent_info));
    const fallback = { ...entry, ...sentInfo, ...publishInfo };
    const candidateGroups = [
      publishInfo.appmsgex,
      publishInfo.appmsg_info,
      publishInfo.appmsg_list,
      entry.appmsgex,
      entry.appmsg_info,
    ];
    const candidates = candidateGroups.find(
      (candidate) => Array.isArray(candidate) && candidate.length > 0,
    );
    const list = Array.isArray(candidates) ? candidates : [publishInfo];
    list.forEach((candidate, index) => {
      const article = normalizeArticle(candidate, fallback, index + 1);
      if (article) articles.push(article);
    });
  }

  const totalValue = page.total_count ?? page.total ?? root.total_count;
  const total = typeof totalValue === "number" ? totalValue : Number(totalValue || articles.length);
  const hasMore = Number.isFinite(total) && total > offset + publishList.length;
  return {
    total: Number.isFinite(total) ? total : articles.length,
    count: articles.length,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + publishList.length } : {}),
    articles,
  };
}

function decodeReport(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = new TextDecoder("utf-8").decode(bytes);
  const replacements = (text.match(/\uFFFD/g) || []).length;
  if (replacements > 2) {
    try {
      text = new TextDecoder("gb18030").decode(bytes);
    } catch {
      // Keep the UTF-8 attempt when this Node build lacks the legacy decoder.
    }
  }
  return text.replace(/^\uFEFF/, "");
}

export function parseReportPage(
  buffer: ArrayBuffer,
  offset: number,
  limit: number,
): ReportPage {
  const text = decodeReport(buffer).trim();
  if (!text) {
    return { total: 0, count: 0, offset, hasMore: false, columns: [], rows: [] };
  }
  if (text.startsWith("<")) {
    throw new WechatMcpError(
      "UPSTREAM_CHANGED",
      "WeChat returned an HTML page instead of a data report. The backend export endpoint may have changed.",
    );
  }

  const records = parseCsv(text, {
    bom: true,
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
  const rows = records.slice(offset, offset + limit);
  const columns = records[0] ? Object.keys(records[0]) : [];
  const hasMore = records.length > offset + rows.length;
  return {
    total: records.length,
    count: rows.length,
    offset,
    hasMore,
    ...(hasMore ? { nextOffset: offset + rows.length } : {}),
    columns,
    rows,
  };
}

export function parsePublicArticle(html: string, maxCharacters: number) {
  const $ = load(html);
  const title =
    $("#activity-name").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim();
  const accountName = $("#js_name").first().text().trim() || undefined;
  const author = $("#js_author_name").first().text().trim() || undefined;
  const publishedAt =
    $("#publish_time").first().text().trim() ||
    formatTimestamp(
      html.match(/(?:create_time|createTime)\s*[:=]\s*["']?(\d{10,13})["']?/)?.[1],
    );
  const description = $('meta[name="description"]').attr("content")?.trim() || undefined;
  const content = $("#js_content").first();

  if (!title || !content.length) {
    throw new WechatMcpError(
      "INVALID_RESPONSE",
      "The page does not look like a readable WeChat article, or access was challenged.",
    );
  }

  content.find("script,style,noscript").remove();
  content.find("br").replaceWith("\n");
  content.find("a").each((_, element) => {
    const link = $(element);
    const label = link.text().trim();
    const href = link.attr("href");
    if (label && href) link.replaceWith(`[${label}](${href})`);
  });
  content.find("img").each((_, element) => {
    const image = $(element);
    const src = image.attr("data-src") || image.attr("src");
    const alt = image.attr("alt") || "图片";
    image.replaceWith(src ? `\n![${alt}](${src})\n` : "");
  });
  content.find("p,div,section,h1,h2,h3,h4,li,blockquote").each((_, element) => {
    $(element).prepend("\n").append("\n");
  });

  const fullText = content
    .text()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = fullText.length > maxCharacters;

  return {
    title,
    account_name: accountName,
    author,
    published_at: publishedAt,
    description,
    content: truncated ? `${fullText.slice(0, maxCharacters)}\n\n[内容已截断]` : fullText,
    truncated,
    original_length: fullText.length,
  };
}

// ── Editor context parsing ──

/**
 * Extract editor context from the
 * WeChat editor HTML page. Never expose these values; use them only internally.
 */
export function parseEditorContext(html: string): EditorContext {
  const ticket =
    findAssignment(html, ["wx.data.ticket", "wx.cgiData.ticket", "ticket"]) ?? "";
  const userName =
    findAssignment(html, ["wx.data.user_name", "wx.cgiData.user_name", "user_name"]) ?? "";

  const timeMatch =
    html.match(/time\s*[:=]\s*["']?(\d{10,13})["']?/) ??
    html.match(/svr_time\s*[:=]\s*["']?(\d{10,13})["']?/) ??
    html.match(/wx\.cgiData\.time\s*=\s*["']?(\d{10,13})["']?/);
  const svrTime = timeMatch?.[1] ? Number(timeMatch[1]) : 0;

  const appmsgidMatch =
    html.match(/appmsgid\s*[:=]\s*["']?(\d+)["']?/i) ??
    html.match(/AppMsgId\s*[:=]\s*["']?(\d+)["']?/);
  const appmsgid = appmsgidMatch?.[1] ?? "";

  const dataSeqMatch = html.match(/data_seq\s*[:=]\s*["']?(\d+)["']?/i);
  const dataSeq = dataSeqMatch?.[1] ? Number(dataSeqMatch[1]) : 0;

  const useFlagMatch = html.match(/is_use_flag\s*[:=]\s*["']?(\d+)["']?/i);
  const isUseFlag = useFlagMatch?.[1] ? Number(useFlagMatch[1]) : 0;

  const templateVersion =
    findAssignment(html, ["wx.version", "template_version"]) ??
    findNumericAssignment(html, ["wx.version", "template_version"]) ??
    html.match(/appmsg_edit_v2_gray\.(\d+)\.css/i)?.[1] ??
    "";

  return {
    ticket,
    user_name: userName,
    svr_time: svrTime,
    appmsgid,
    data_seq: dataSeq,
    is_use_flag: isUseFlag,
    template_version: templateVersion,
  };
}

// ── Draft HTML validation ──

const FORBIDDEN_TAGS = ["script", "iframe", "object", "embed", "form"] as const;

function isWechatImageHost(hostname: string): boolean {
  return ["qpic.cn", "weixin.qq.com", "wechat.com", "wx.qq.com"].some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

export function validateDraftHtml(
  html: string,
  articleIndex: number,
): { sanitized: string; warnings: string[]; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (html.length === 0 || html.trim().length === 0) {
    errors.push(`Article ${articleIndex + 1}: content_html is empty.`);
  }
  if (html.length > CONTENT_HTML_MAX_LENGTH) {
    errors.push(
      `Article ${articleIndex + 1}: content_html length ${html.length} exceeds ${CONTENT_HTML_MAX_LENGTH}.`,
    );
  }

  const $ = load(html, undefined, false);
  for (const tag of FORBIDDEN_TAGS) {
    const elements = $(tag);
    if (elements.length > 0) {
      errors.push(`Article ${articleIndex + 1}: content_html contains forbidden tag: ${tag}.`);
      elements.remove();
    }
  }

  $("*").each((_, element) => {
    if (!("attribs" in element)) return;
    for (const attribute of Object.keys(element.attribs ?? {})) {
      if (/^on/i.test(attribute)) {
        errors.push(
          `Article ${articleIndex + 1}: content_html contains an event-handler attribute.`,
        );
        $(element).removeAttr(attribute);
      }
      if (attribute === "href" || attribute === "src" || attribute === "data-src") {
        const value = ($(element).attr(attribute) ?? "").trim().toLowerCase();
        if (/^(?:javascript|data|vbscript)\s*:/.test(value)) {
          errors.push(
            `Article ${articleIndex + 1}: content_html contains a forbidden URL scheme.`,
          );
          $(element).removeAttr(attribute);
        }
      }
    }
  });

  $("img").each((_, element) => {
    const src = $(element).attr("src") || $(element).attr("data-src");
    if (!src) {
      warnings.push(`Article ${articleIndex + 1}: an image has no source URL.`);
      return;
    }
    try {
      const url = new URL(src);
      if (url.protocol !== "https:") {
        errors.push(`Article ${articleIndex + 1}: image URLs must use HTTPS.`);
      } else if (!isWechatImageHost(url.hostname)) {
        warnings.push(
          `Article ${articleIndex + 1}: non-WeChat HTTPS image host (${url.hostname}). ` +
            "Images from non-WeChat hosts may not render correctly.",
        );
      }
    } catch {
      errors.push(`Article ${articleIndex + 1}: an image source is not a valid absolute URL.`);
    }
  });

  const sanitized = $.html() ?? "";

  return { sanitized, warnings, errors };
}

// ── Draft article validation ──

export function validateDraftArticles(
  articles: DraftArticle[],
  options: { requireCover?: boolean } = {},
): DraftValidationResult {
  const errors: DraftValidationResult["errors"] = [];
  const warnings: DraftValidationResult["warnings"] = [];
  const summaries: DraftValidationResult["summaries"] = [];

  if (articles.length < DRAFT_MIN_ARTICLES || articles.length > DRAFT_MAX_ARTICLES) {
    errors.push({
      article_index: -1,
      field: "articles",
      message: `Draft must contain ${DRAFT_MIN_ARTICLES}-${DRAFT_MAX_ARTICLES} articles, got ${articles.length}.`,
    });
  }

  for (let i = 0; i < articles.length; i += 1) {
    const a = articles[i]!;

    if (!a.title || a.title.trim().length < TITLE_MIN_LENGTH) {
      errors.push({ article_index: i, field: "title", message: "Title is required." });
    } else if (a.title.length > TITLE_MAX_LENGTH) {
      errors.push({
        article_index: i,
        field: "title",
        message: `Title length ${a.title.length} exceeds ${TITLE_MAX_LENGTH}.`,
      });
    }

    if (a.author && a.author.length > AUTHOR_MAX_LENGTH) {
      errors.push({
        article_index: i,
        field: "author",
        message: `Author length ${a.author.length} exceeds ${AUTHOR_MAX_LENGTH}.`,
      });
    }

    if (a.digest && a.digest.length > DIGEST_MAX_LENGTH) {
      errors.push({
        article_index: i,
        field: "digest",
        message: `Digest length ${a.digest.length} exceeds ${DIGEST_MAX_LENGTH}.`,
      });
    }

    const htmlResult = validateDraftHtml(a.content_html, i);
    for (const msg of htmlResult.errors) {
      errors.push({ article_index: i, field: "content_html", message: msg });
    }
    for (const msg of htmlResult.warnings) {
      warnings.push({ article_index: i, field: "content_html", message: msg });
    }

    if (a.source_url) {
      try {
        const parsed = new URL(a.source_url);
        if (parsed.protocol !== "https:") {
          errors.push({
            article_index: i,
            field: "source_url",
            message: "source_url must use HTTPS.",
          });
        }
      } catch {
        errors.push({
          article_index: i,
          field: "source_url",
          message: "source_url must be a valid HTTPS URL.",
        });
      }
    }

    if (!a.cover_media_id || a.cover_media_id.trim().length === 0) {
      const issue = {
        article_index: i,
        field: "cover_media_id",
        message: options.requireCover
          ? "cover_media_id is required before saving a draft."
          : "cover_media_id is not set yet; upload and assign a cover before saving.",
      };
      if (options.requireCover) errors.push(issue);
      else warnings.push(issue);
    } else if (a.cover_media_id.length > 512 || /[\u0000-\u001F\u007F]/.test(a.cover_media_id)) {
      errors.push({
        article_index: i,
        field: "cover_media_id",
        message: "cover_media_id is too long or contains control characters.",
      });
    }

    if (a.fans_only_comment && !a.open_comment) {
      warnings.push({
        article_index: i,
        field: "fans_only_comment",
        message: "fans_only_comment has no effect while comments are disabled.",
      });
    }

    const fragment = load(a.content_html ?? "", undefined, false);
    summaries.push({
      index: i,
      title: a.title?.trim() || "(no title)",
      char_count: fragment.text().replace(/\s+/g, " ").trim().length,
      digest_length: a.digest?.trim().length ?? 0,
      image_count: fragment("img").length,
      has_cover: !!a.cover_media_id,
      show_cover: a.show_cover,
      open_comment: a.open_comment,
      fans_only_comment: a.fans_only_comment,
      ...(a.source_url ? { source_url: a.source_url } : {}),
    });
  }

  return { valid: errors.length === 0, errors, warnings, summaries };
}

// ── Draft payload construction ──

export function buildDraftPayload(
  articles: DraftArticle[],
  context: EditorContext,
): Record<string, string> {
  const fields: Record<string, string> = {
    AppMsgId: context.appmsgid || "0",
    count: String(articles.length),
    articlenum: String(articles.length),
    data_seq: String(context.data_seq),
    isnew: "0",
    ajax: "1",
    isneedsave: "0",
    autosave_log: "",
    pre_timesend_set: "0",
    operate_from: "Chrome",
  };

  const idxInfos: Record<string, unknown>[] = [];

  for (let i = 0; i < articles.length; i += 1) {
    const a = articles[i]!;
    const idx = String(i);
    fields[`title${idx}`] = a.title.trim();
    fields[`author${idx}`] = (a.author ?? "").trim();
    fields[`digest${idx}`] = (a.digest ?? "").trim();
    fields[`content${idx}`] = a.content_html;
    fields[`sourceurl${idx}`] = a.source_url ?? "";
    if (!a.cover_media_id) {
      throw new WechatMcpError(
        "VALIDATION_ERROR",
        `Article ${i + 1} is missing cover_media_id.`,
      );
    }
    fields[`fileid${idx}`] = a.cover_media_id;
    fields[`show_cover_pic${idx}`] = a.show_cover ? "1" : "0";
    fields[`need_open_comment${idx}`] = a.open_comment ? "1" : "0";
    fields[`only_fans_can_comment${idx}`] = a.fans_only_comment ? "1" : "0";
    fields[`copyright_type${idx}`] = "0";

    idxInfos.push({ save_old: 0, cps_info: { cps_import: 0 } });
  }

  fields.req = JSON.stringify({
    idx_infos: idxInfos,
    appmsg_id: Number(context.appmsgid || 0),
    is_use_flag: context.is_use_flag,
    template_version: context.template_version,
  });

  return fields;
}

// ── Write response parsing ──

export type ParsedWriteResponse = {
  ok: boolean;
  code: string;
  message: string;
  data: Record<string, unknown>;
};

/**
 * Parse write-endpoint responses (upload, draft save).
 * Handles base_resp, nested JSON in content, and unexpected shapes.
 */
export function parseWriteResponse(payload: unknown): ParsedWriteResponse {
  const root = asRecord(payload);
  const base = asRecord(root.base_resp);
  const ret = Number(base.ret ?? root.ret ?? root.errcode ?? -1);

  if (ret === 0) {
    const data: Record<string, unknown> = {};
    const idKeys = ["msgid", "appmsgid", "media_id", "fileid"];
    const urlKeys = ["url", "cdn_url"];
    const copySafeScalars = (source: Record<string, unknown>, prefix = "") => {
      for (const key of idKeys) {
        const value = source[key];
        if (
          (typeof value === "string" || typeof value === "number") &&
          /^[A-Za-z0-9_+\/=.-]{1,512}$/.test(String(value))
        ) {
          data[`${prefix}${key}`] = String(value);
        }
      }
      for (const key of urlKeys) {
        const value = source[key];
        if (typeof value !== "string" || value.length > 2_048) continue;
        try {
          const url = new URL(value);
          if (url.protocol === "https:") data[`${prefix}${key}`] = value;
        } catch {
          // Ignore non-URL upstream fields rather than echoing them.
        }
      }
    };
    copySafeScalars(root);

    const content = root.content;
    if (typeof content === "string") {
      const nested = parseNestedJson(content);
      if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
        const nestedObj = asRecord(nested);
        const nestedRet = Number(nestedObj.ret ?? 0);
        if (nestedRet === 0) {
          copySafeScalars(nestedObj, "nested_");
        } else {
          throw new WechatMcpError(
            "UPSTREAM_ERROR",
            `WeChat returned a nested error for the write operation (ret=${nestedRet}).`,
            false,
            { ret: nestedRet },
          );
        }
      } else if (/^[A-Za-z0-9_+\/=.-]{1,512}$/.test(content.trim())) {
        data.fileid = content.trim();
      } else {
        try {
          const url = new URL(content.trim());
          if (url.protocol === "https:") data.url = url.toString();
        } catch {
          // Never return an unrecognized raw content field.
        }
      }
    }

    return { ok: true, code: "SUCCESS", message: "OK", data };
  }

  if ([200003, 200013, -6, -14].includes(ret)) {
    throw new WechatMcpError(
      "AUTH_EXPIRED",
      `WeChat rejected the write operation (ret=${ret}).`,
      true,
    );
  }

  if (
    ret === -1 &&
    !("base_resp" in root) &&
    !("ret" in root) &&
    !("errcode" in root)
  ) {
    throw new WechatMcpError(
      "UPSTREAM_CHANGED",
      "The WeChat write response had an unexpected structure.",
    );
  }

  throw new WechatMcpError(
    "UPSTREAM_ERROR",
    `WeChat returned a write error (ret=${ret}).`,
    false,
    { ret },
  );
}
