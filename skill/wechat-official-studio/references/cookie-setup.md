# Local Cookie reset

Use these steps only after `AUTH_REQUIRED`, `AUTH_EXPIRED`, or `REQUEST_TIMEOUT`.

1. Ask the user to open `https://mp.weixin.qq.com` in their own browser and confirm that the intended Official Account backend is logged in.
2. Ask them to open browser developer tools, choose Network, refresh the backend page, and select a request whose host is exactly `mp.weixin.qq.com`.
3. In Request Headers, copy only the value after `Cookie:`. Never ask them to paste it into chat.
4. Ask them to open a local terminal in the `wechat-official-studio-mcp` repository root and run:

   `npm run configure-cookie -- --from-clipboard`

   They may instead run `npm run configure-cookie` and paste into the hidden prompt.
5. After they confirm completion, call `wechat_official_check_auth` again.

The configurator writes `.wechat-cookie` with owner-only permissions. The MCP reloads that file on the next call, so a server restart is normally unnecessary. If an explicit `WECHAT_OFFICIAL_COOKIE` environment variable is configured, it takes precedence over the file and requires updating the MCP configuration plus restarting the client.

Never read the Cookie file back into the conversation or use shell commands that print it. A timeout that occurs after a write request begins is ambiguous: inspect the material library or draft box before retrying.
