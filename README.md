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
- 将已确认的文章保存到草稿箱。

写入能力属于实验功能：它依赖微信公众号后台网页当前使用的非公开接口。首次使用或微信后台改版后，应先用测试图片和测试草稿验证，不要把草稿保存成功等同于可直接发布。

项目**不提供**发布、群发、删除、修改已有草稿、跨账号操作、任意公众号爬取、音视频上传。

## 安全设计

- Cookie 只从本地 `.wechat-cookie` 或环境变量读取，不作为 MCP 工具参数；
- `.wechat-cookie` 由配置脚本以 `0600` 权限写入，并被项目级 `.gitignore` 排除；
- 后台请求采用 GET/POST 独立路径白名单，未登记路径会被拒绝；
- 所有上传和草稿写入都要求 `confirm=true`；
- 上传文件必须位于 `WECHAT_OFFICIAL_UPLOAD_ROOTS` 指定目录内，并经过真实路径、扩展名、文件头和大小校验；
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

## 配置允许上传的目录

默认禁止读取任何本地图片。使用上传工具前，必须显式设置允许目录：

```bash
export WECHAT_OFFICIAL_UPLOAD_ROOTS="/absolute/path/to/covers:/absolute/path/to/article-images"
```

macOS/Linux 使用冒号分隔多个目录，Windows 使用分号。只配置确实需要上传的素材目录，不要配置用户主目录、磁盘根目录或包含密钥的目录。

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
| `wechat_official_read_article` | 读取 | 读取一篇公开公众号文章，不发送后台 Cookie |
| `wechat_official_get_article_report` | 读取 | 获取图文分析导出数据 |
| `wechat_official_get_follower_report` | 读取 | 获取用户分析导出数据 |
| `wechat_official_validate_draft` | 本地读取 | 校验草稿字段、HTML 和图片来源，返回脱敏预览 |
| `wechat_official_upload_image` | 写入 | 经目录与图片校验后上传素材或正文图片，要求确认 |
| `wechat_official_create_draft` | 写入 | 保存新草稿，不发布，要求确认 |

## 写入参数概要

- `wechat_official_upload_image`
  - `file_path`：已批准上传目录内的图片路径；
  - `usage=material`：上传封面或素材库图片，返回 `media_id`；
  - `usage=article`：上传正文图片，返回 `cdn_url`；
  - `confirm=true`：必须在用户确认文件和用途后设置。
- `wechat_official_create_draft`
  - `articles`：1—8 篇；每篇包含标题、HTML 正文、封面素材 ID，并可设置作者、摘要、来源链接和评论；
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
