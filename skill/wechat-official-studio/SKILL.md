---
name: wechat-official-studio
description: Safely inspect a logged-in WeChat Official Account backend, read published articles and analytics, upload approved local images, and save reviewed article drafts through the wechat_official MCP server. Use when requests mention 微信公众号后台、公众号文章、已发表内容、图文或用户分析、素材上传、封面上传、正文图片、写入草稿箱、创建公众号草稿、Cookie 过期、登录超时, or reading a public WeChat article URL.
---

# WeChat Official Studio

Use the `wechat_official` MCP server. Default to reads. Permit only the two supported writes: upload an image and save a new draft. Never publish, mass-send, delete, or edit an existing draft.

## Authenticate

1. Locate tools whose names start with `wechat_official_`.
2. Call `wechat_official_check_auth` before any authenticated read or write.
   Every authenticated backend tool also performs its own lightweight preflight check and stops before the requested operation if that check fails. Local draft validation is exempt. Public-article reads start anonymously but may perform the same preflight before one authenticated fallback.
3. Never request, print, summarize, copy, or commit a Cookie, token, ticket, `.wechat-cookie`, or `.env` value.
4. If the MCP is missing, explain that it must be built and registered, then ask the user to restart Codex or open a new task after enabling it.

For `AUTH_REQUIRED`, `AUTH_EXPIRED`, or a read-side `REQUEST_TIMEOUT`, read [references/cookie-setup.md](references/cookie-setup.md), give the local reset steps, and stop the whole authenticated workflow. Do not continue to the requested read or write and do not retry more than once. After the user manually replaces the Cookie and confirms that step, call `wechat_official_check_auth` again. Resume only after it reports `authenticated`.

## Route reads

- Account name, original ID, avatar, or type: call `wechat_official_get_account_info`.
- Own published history or title search: call `wechat_official_list_published_articles`; paginate with the returned `nextOffset` and keep pages small.
- One public `mp.weixin.qq.com/s` URL: call `wechat_official_read_article` with the default `authentication=auto`. It first sends no Cookie. Only if WeChat returns an environment challenge may it verify the local backend session and retry once with the Cookie. Use `authentication=never` when the Cookie must never be sent, or `required` when the user explicitly wants an authenticated first attempt.
- Article performance: call `wechat_official_get_article_report`.
- Follower changes: call `wechat_official_get_follower_report`.
- Mixed analysis: collect the needed pages, then compute total, mean, median, and trend. Separate recommended and search traffic only when source columns provide that split.

For analytics conclusions, treat only records from the current calendar year as valid by default. Exclude older records from totals, averages, medians, trends, and comparisons unless the user explicitly requests an archival view; label any such older-data view as non-current context.

Public article HTML provides readable content and metadata, not authoritative operator metrics. For reads, shares, likes, comments, or follower data, use the authenticated report tools. If both anonymous and authenticated public-article attempts reach `PUBLIC_ARTICLE_CHALLENGE`, ask the user to open that URL in their own browser and complete WeChat's environment verification. Do not retry again automatically and do not claim that the backend Cookie is expired unless `wechat_official_check_auth` also fails.

## Article body generation rules

Apply these rules every time article content is prepared for a draft; they exist so pasted
content does not reproduce known formatting problems:

1. **The body never includes the title.** The editor fills the title in a separate field;
   a body that starts with the `h1` renders a duplicated heading. Always pass the original
   `.html` file through `source_html_path` (or the equivalent `prepareDraftHtmlDocument`
   preparation) — it captures the title and removes **all** body `h1` elements.
2. **Build the body as if it were copied from the HTML and pasted into the editor.** Never
   hand-assemble a `content_html` fragment from the source file. Use the import path so the
   MCP inlines the document CSS (rich-text paste behaviour), removes links (keeping
   `data-miniprogram-*` attributes so `weapp_text_link` entries still open the mini program),
   and keeps `mp-common-miniprogram` cards intact.
3. **Source HTML styling must use plain rounded backgrounds, not bordered blocks.** WeChat's
   editor inconsistently preserves borders on `div`/`p`. Style callouts as pure
   `background` + `border-radius` without any `border` declaration. The import normalizes any
   remaining simple bordered block to a compatible plain blue rounded paragraph as a
   fallback, but the source should not rely on it.
4. **Lists must not produce blank `<li>` lines.** Write one `<li>` per line with no empty
   lines between items, never emit empty `<li>` elements, and do not style `li` with
   `margin-top`/`margin-bottom` (the import zeroes item margins and compacts list whitespace).
5. **Local publishing placeholders never enter the draft body.** Remove `.ad` (in-article ad
   slot) and `.cps` (commission product slot) placeholder blocks before saving; the platform
   or a human inserts those later.
6. **Mini-program entries are copied from the fixed template draft, never hand-written.**
   The `weapp_text_link` in-article entry and the `mp-common-miniprogram` end card must be
   copy-pasted from the account's template draft **appmsgid=100001069** (draft box, titled
   "测试"; editor page:
   `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=100001069&isMul=1&replaceScene=0&isSend=0&isFreePublish=0&lang=zh_CN`,
   session `token` taken from the current logged-in session, never committed). That draft
   provides 4 cards (`pages/timeline/index`, `pages/material/index`, `pages/checklist/index`,
   `pages/redact/index`) and 5 text links (same four plus `pages/index/index`). Copy the
   matching page's element verbatim — do not invent `data-miniprogram-*` attributes, appid
   `wx5c7262a5d15521d7`, nicknames, or card images. If the template draft is missing,
   stop and ask the user to restore it before writing the draft.

## Upload images and save drafts

Read [references/write-safety.md](references/write-safety.md) before the first write in a task.

1. Confirm authentication and the intended account.
2. Call `wechat_official_validate_draft` with the complete article payload. Resolve validation errors and surface warnings.
   When an approved original `.html`/`.htm` file exists, pass it as `source_html_path` instead of reconstructing `content_html`. The MCP inlines document CSS to match rich-text browser copy, removes **all** body `h1` elements (the title is a separate field), removes outer layout width/margins, compacts list whitespace and empty `<li>` lines while retaining real bullets, normalizes simple bordered blocks to the compatible blue rounded paragraph-callout style, converts links to styled non-link text (keeping `data-miniprogram-*` attributes), removes the publish-configuration section, and preserves body ad copy and other article content. Follow the rules in "Article body generation rules" above.
3. Show a concise preview: account, titles, content lengths, cover filenames, comment settings, source URLs, validation warnings, and HTML import counts for inline styles, removed links, normalized bordered callouts, removed publish-config sections, and preserved ad blocks. Do not expose absolute local paths.
4. Obtain explicit user approval for that preview. A request to “help write an article” is not approval to write the account; approval must name or clearly refer to saving the reviewed content to the draft box.
5. Call `wechat_official_upload_image` only for approved files inside configured upload roots, with `confirm=true`. Use `usage=material` for covers/material-library images and `usage=article` for body-image URLs.
6. Insert returned body-image URLs into HTML when needed. Use the returned material/file ID as `cover_media_id`.
7. Call `wechat_official_create_draft` with the final validated payload and `confirm=true`.
8. Report the safe result: draft ID, article titles, uploaded basenames, and warnings. Ask the user to review formatting in the official draft box before publishing.

Do not retry a timed-out upload or draft creation automatically: the upstream result is ambiguous and a retry can create duplicates. Ask the user to inspect the material library or draft box, then check authentication before any deliberate retry.

## Handle upstream changes

Treat the WeChat web backend as undocumented and changeable.

- For `UPSTREAM_CHANGED`, report the affected tool and response type. Do not invent fields or substitute a publishing endpoint.
- Read and write only data visible to the logged-in account.
- Do not claim arbitrary third-party account crawling is supported.
- Avoid dense retries because repeated calls can trigger forced logout or duplicate writes.

## Report results

Lead with the answer and covered range, article count, or safe write result. Separate source fields from derived calculations. State pagination, truncation, unavailable fields, warnings, and upstream limitations. Never include authentication material, raw upstream responses, or absolute upload paths.
