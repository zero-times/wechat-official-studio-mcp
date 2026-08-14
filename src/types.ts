export type ResponseFormat = "markdown" | "json";

export type RuntimeConfig = {
  cookie: string;
  cookieSource: "environment" | "cookie_file";
  token?: string;
  timeoutMs: number;
};

export type AccountInfo = {
  nickname?: string;
  originalId?: string;
  avatarUrl?: string;
  accountType?: string;
};

export type PublishedArticle = {
  title: string;
  url?: string;
  digest?: string;
  author?: string;
  coverUrl?: string;
  publishedAt?: string;
  messageId?: string;
  itemIndex?: number;
  readNum?: number;
  likeNum?: number;
  oldLikeNum?: number;
  shareNum?: number;
  commentNum?: number;
  totalCommentCount?: number;
  reprintNum?: number;
  momentLikeNum?: number;
};

export type PublishedArticlePage = {
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  articles: PublishedArticle[];
};

export type ReportPage = {
  total: number;
  count: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
  columns: string[];
  rows: Record<string, string>[];
  title?: string;
};

// ── Draft & write types ──

export type DraftArticle = {
  title: string;
  author?: string;
  digest?: string;
  content_html: string;
  source_url?: string;
  cover_media_id?: string;
  show_cover: boolean;
  open_comment: boolean;
  fans_only_comment: boolean;
};

export type PreparedHtmlDraft = {
  title: string;
  digest?: string;
  content_html: string;
  source_filename: string;
  removed_link_count: number;
  removed_publish_config_count: number;
  removed_title_count: number;
  compacted_list_count: number;
  removed_empty_list_item_count: number;
  normalized_bordered_callout_count: number;
  preserved_ad_count: number;
  inline_style_count: number;
};

export type DraftValidationResult = {
  valid: boolean;
  errors: { article_index: number; field: string; message: string }[];
  warnings: { article_index: number; field: string; message: string }[];
  summaries: {
    index: number;
    title: string;
    char_count: number;
    digest_length: number;
    image_count: number;
    has_cover: boolean;
    show_cover: boolean;
    open_comment: boolean;
    fans_only_comment: boolean;
    source_url?: string;
  }[];
};

export type ImageUploadResult = {
  ok: boolean;
  filename: string;
  size: number;
  mime: string;
  media_id?: string;
  cdn_url?: string;
};

export type DraftCreateResult = {
  ok: boolean;
  status: string;
  draft_msgid?: string;
  article_count: number;
};

/** Internal editor context — never exposed to callers. */
export type EditorContext = {
  ticket: string;
  user_name: string;
  svr_time: number;
  appmsgid: string;
  data_seq: number;
  is_use_flag: number;
  template_version: string;
};
