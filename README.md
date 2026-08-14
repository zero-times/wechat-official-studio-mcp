# WeChat Official Studio MCP

一个面向微信公众号运营的本地 MCP Server 与配套 Codex Skill。它使用用户已经登录的微信公众平台网页会话，读取账号自己的文章和数据，并在明确确认后上传图片素材、保存公众号草稿。

> 非微信官方项目，与腾讯、微信不存在隶属或背书关系。微信公众平台网页接口未公开且可能变化；请只操作自己有权管理的账号。

## 项目命名

- GitHub 仓库：`wechat-official-studio-mcp`
- MCP npm 包与服务名：`wechat-official-studio-mcp-server`
- Codex Skill：`wechat-official-studio`
- 推荐 MCP 配置 ID：`wechat_official`（保持工具名前缀稳定）
- 中文名：微信公众号工作台

## 能力范围

### 读取

- 检查当前公众号登录状态；
- 读取账号基本信息；
- 分页读取或搜索本账号已发表文章；
- 读取公开 `mp.weixin.qq.com/s` 文章正文；
- 获取图文分析和用户分析导出数据。

### 写入

- 上传 JPEG、PNG、GIF 图片到素材库或正文图片空间；
- 校验一至八篇文章组成的草稿；
- 直接导入允许目录内的原始 HTML：将文档 CSS 内联为富文本样式，移除正文重复标题、超链接、“发布配置”区和最外层版心边距，压紧列表空白行，保留正文广告位文案；
- 将已确认的文章保存到草稿箱。

写入能力属于实验功能：它依赖微信公众号后台网页当前使用的非公开接口。首次使用或微信后台改版后，应先用测试图片和测试草稿验证，不要把草稿保存成功等同于可直接发布。

项目**不提供**发布、群发、删除、修改已有草稿、跨账号操作、任意公众号爬取、音视频上传。

## 安全设计

- Cookie 只从本地 `.wechat-cookie` 或环境变量读取，不作为 MCP 工具参数；
- `.wechat-cookie` 由配置脚本以 `0600` 权限写入，并被项目级 `.gitignore` 排除；
- 后台请求采用 GET/POST 独立路径白名单，未登记路径会被拒绝；
- 所有上传和草稿写入都要求 `confirm=true`；
- 上传图片和导入的 HTML 必须位于 `WECHAT_OFFICIAL_UPLOAD_ROOTS` 指定目录内，并经过真实路径、扩展名和大小校验；图片还会校验文件头；
- 工具结果不返回 Cookie、token、ticket、账号内部标识、原始上游响应或本地绝对路径；
- 超时后的写入结果可能不确定，MCP 不会自动重试，避免重复素材或重复草稿；
- 不包含发布和删除工具，草稿必须回到微信公众平台人工检查后再发布。

## 环境要求

- Node.js 20 或更高版本；
- 已登录、且有权管理的微信公众平台账号；
- Codex 或其他支持 stdio MCP 的客户端。

## 安装

```bash
npm install
npm run build
```

## 配置登录 Cookie

1. 在浏览器登录 `https://mp.weixin.qq.com` 并进入目标公众号后台。
2. 打开开发者工具的 Network，刷新页面，选择主机名为 `mp.weixin.qq.com` 的后台请求。
3. 在 Request Headers 里复制 `Cookie` 的值，不要包含 `Cookie:` 字样。
4. 把 Cookie 放入剪贴板，然后在项目目录执行：

```bash
npm run configure-cookie -- --from-clipboard
```

也可以执行 `npm run configure-cookie`，在隐藏输入中粘贴。不要把 Cookie 发到聊天、Issue、README、终端历史或 Git 提交中。

Cookie 更新后会在下一次调用时重新读取，通常不需要重启 MCP。如果配置了 `WECHAT_OFFICIAL_COOKIE` 环境变量，它会优先于文件，此时需要更新客户端配置并重启 MCP 进程。

## 配置允许读取的本地内容目录

默认禁止读取本地图片和 HTML。使用上传或 HTML 导入前，必须显式设置允许目录：

```bash
export WECHAT_OFFICIAL_UPLOAD_ROOTS="/absolute/path/to/article-batch:/absolute/path/to/other-approved-content"
```

macOS/Linux 使用冒号分隔多个目录，Windows 使用分号。只配置确实需要导入或上传的内容目录，不要配置用户主目录、磁盘根目录或包含密钥的目录。

## 注册 MCP

Codex 的配置示例：

```toml
[mcp_servers.wechat_official]
command = "node"
args = ["/absolute/path/to/wechat-official-studio-mcp/dist/index.js"]
env = { WECHAT_OFFICIAL_UPLOAD_ROOTS = "/absolute/path/to/approved-images" }
```

重新打开任务后，先调用 `wechat_official_check_auth`。

## 安装配套 Skill

仓库内的 `skill/wechat-official-studio` 是配套 Codex Skill：

```bash
cp -R skill/wechat-official-studio "${CODEX_HOME:-$HOME/.codex}/skills/"
```

重新打开任务后，可使用 `$wechat-official-studio`。Skill 会先检查登录、执行草稿校验和预览确认，再允许上传与保存草稿。

## MCP 工具

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `wechat_official_check_auth` | 读取 | 检查本地登录状态，不返回认证材料 |
| `wechat_official_get_account_info` | 读取 | 获取当前公众号基本信息 |
| `wechat_official_list_published_articles` | 读取 | 分页读取或搜索本账号发表历史 |
| `wechat_official_read_article` | 读取 | 读取一篇公开公众号文章；默认匿名优先，遇环境验证时才校验登录态并携带本地 Cookie 重试一次 |
| `wechat_official_get_article_report` | 读取 | 获取图文分析导出数据 |
| `wechat_official_get_follower_report` | 读取 | 获取用户分析导出数据 |
| `wechat_official_validate_draft` | 本地读取 | 校验草稿；可从 `source_html_path` 直接导入 HTML、内联 CSS、移除链接和发布配置，并返回脱敏预览 |
| `wechat_official_upload_image` | 写入 | 经目录与图片校验后上传素材或正文图片，要求确认 |
| `wechat_official_create_draft` | 写入 | 保存新草稿，不发布，要求确认 |

除公开文章的匿名首请求和本地草稿校验外，每个使用后台会话的操作都会在实际执行前请求一次轻量登录验证。该验证不会信任缓存 token；一旦发现 Cookie/token 失效、登录跳转或验证超时，当前操作会直接中止，并明确要求用户在本地重新设置 Cookie、再次执行 `wechat_official_check_auth`。只有验证返回 `authenticated` 后才继续后续流程。

公开文章读取支持 `authentication=auto|never|required`。默认 `auto` 不发送 Cookie；只有检测到 `/mp/wappoc_appmsgcaptcha`、“环境异常”等验证页时，才执行登录预检并携带本地 Cookie 重试一次。两次仍被拦截时返回 `PUBLIC_ARTICLE_CHALLENGE`，要求用户在自己的浏览器完成环境验证，不会密集重试。公开页面只用于正文和公开元数据，阅读、分享、点赞等运营指标仍从已登录后台报表读取。

## 写入参数概要

- `wechat_official_upload_image`
  - `file_path`：已批准上传目录内的图片路径；
  - `usage=material`：上传封面或素材库图片，返回 `media_id`；
  - `usage=article`：上传正文图片，返回 `cdn_url`；
  - `confirm=true`：必须在用户确认文件和用途后设置。
- `wechat_official_create_draft`
  - `articles`：1—8 篇；每篇必须提供 `content_html` 或 `source_html_path` 之一，以及封面素材 ID；标题和摘要可从原 HTML 推断；
  - `source_html_path`：从允许目录直接读取 `.html/.htm`。MCP 会把 `<style>` 计算为元素内联样式，删除正文 `<h1>`（标题仍写入公众号标题字段）、“发布配置”区和最外层容器的宽度/左右边距，把 `<a>` 转成无链接的 `<span>`；列表会移除空项和节点间空白，并把有效 `<li>` 的上下 margin 归零；正文中显式带边框、没有嵌套块级内容的卡片会转成已验证兼容的 `<p>` 蓝色圆角卡片，保留正常项目符号、锚文本、数据属性和 `.ad` 广告位文案；
  - `confirm=true`：必须在最终草稿预览经用户确认后设置；
  - 只创建新草稿，不修改已有草稿，也不发布。

## 推荐工作流

### 读取与分析

1. `wechat_official_check_auth`
2. 按需读取发表记录或分析报表
3. 分页、小批量处理
4. Cookie 过期时在本机重新配置，然后再次检查登录

### 上传并保存草稿

1. `wechat_official_check_auth`
2. `wechat_official_validate_draft`
   - 原 HTML 已存在时优先传 `source_html_path`，不要先转纯文本或重新拼装正文；
3. 向用户展示账号、标题、内容长度、图片文件名、评论设置与警告
4. 用户明确确认
5. `wechat_official_upload_image`，传入 `confirm=true`
6. 把素材 ID 作为封面 ID，或把正文图片 URL 写入正文 HTML
7. 再次校验最终内容
8. `wechat_official_create_draft`，传入 `confirm=true`
9. 回到公众号草稿箱人工检查样式与链接后再发布

如果上传或草稿保存发生超时，不要直接重试。先检查素材库或草稿箱是否已经生成对应内容，再决定是否重新调用。

## 开发与验证

```bash
npm test
npm run check
npm run build
npm run security:scan
```

`security:scan` 会检查项目级忽略规则、Cookie 文件权限、硬编码 Cookie/token/ticket、真实本机路径及可能的账号标识转储。它只报告文件名、行号和规则名，不打印命中的敏感内容。

## 上传 GitHub 前检查

```bash
npm run verify
git status --short --ignored
```

确认 `.wechat-cookie`、`.env`、`node_modules/`、`dist/` 只显示为 ignored，且提交内容中没有真实账号名称、原始 ID、Cookie、token、ticket、数据报表、文章草稿或本地绝对路径。

## 登录过期与上游变化

- `AUTH_REQUIRED`、`AUTH_EXPIRED`：在本机重新配置 Cookie，然后调用 `wechat_official_check_auth`。
- 读取请求 `REQUEST_TIMEOUT`：检查网络与 Cookie 后最多重试一次。
- 写入请求 `REQUEST_TIMEOUT`：结果不确定，先人工检查素材库或草稿箱，禁止自动重试。
- `UPSTREAM_CHANGED`：微信网页返回结构发生变化；停止写入并更新解析器，不要猜测替代字段或接口。

## 隐私说明

本项目不会把 Cookie 发送给模型或写入普通日志，但 Cookie 仍代表公众号后台登录权限。请仅在受信任的本机使用，限制文件权限和上传目录，不要共享 `.wechat-cookie`，不要把带真实运营数据的测试输出提交到公开仓库。
