---
name: wechat-official-studio
description: Safely inspect a logged-in WeChat Official Account backend, read published articles and analytics, upload approved local images, and save reviewed article drafts through the wechat_official MCP server. Use when requests mention 微信公众号后台、公众号文章、已发表内容、图文或用户分析、素材上传、封面上传、正文图片、写入草稿箱、创建公众号草稿、Cookie 过期、登录超时, or reading a public WeChat article URL.
---

# WeChat Official Studio

Use the `wechat_official` MCP server. Default to reads. Permit only the two supported writes: upload an image and save a new draft. Never publish, mass-send, delete, or edit an existing draft.

## Authenticate

1. Locate tools whose names start with `wechat_official_`.
2. Call `wechat_official_check_auth` before any authenticated read or write.
3. Never request, print, summarize, copy, or commit a Cookie, token, ticket, `.wechat-cookie`, or `.env` value.
4. If the MCP is missing, explain that it must be built and registered, then ask the user to restart Codex or open a new task after enabling it.

For `AUTH_REQUIRED`, `AUTH_EXPIRED`, or a read-side `REQUEST_TIMEOUT`, read [references/cookie-setup.md](references/cookie-setup.md), give the local reset steps, and stop authenticated calls. Do not retry more than once. After the user confirms the Cookie was replaced locally, call `wechat_official_check_auth` again.

## Route reads

- Account name, original ID, avatar, or type: call `wechat_official_get_account_info`.
- Own published history or title search: call `wechat_official_list_published_articles`; paginate with the returned `nextOffset` and keep pages small.
- One public `mp.weixin.qq.com/s` URL: call `wechat_official_read_article`. This route does not send the backend Cookie.
- Article performance: call `wechat_official_get_article_report`.
- Follower changes: call `wechat_official_get_follower_report`.
- Mixed analysis: collect the needed pages, then compute total, mean, median, and trend. Separate recommended and search traffic only when source columns provide that split.

For analytics conclusions, treat only records from the current calendar year as valid by default. Exclude older records from totals, averages, medians, trends, and comparisons unless the user explicitly requests an archival view; label any such older-data view as non-current context.

## Upload images and save drafts

Read [references/write-safety.md](references/write-safety.md) before the first write in a task.

1. Confirm authentication and the intended account.
2. Call `wechat_official_validate_draft` with the complete article payload. Resolve validation errors and surface warnings.
3. Show a concise preview: account, titles, content lengths, cover filenames, comment settings, source URLs, and validation warnings. Do not expose absolute local paths.
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
