# Makima TUI

Makima TUI 是运行在 DeepSeek Harness / dsh 中的终端智能体界面插件。
它基于 React + Ink，提供流式对话、工具调用、审批确认、问题询问、计划模式、会话恢复、模型选择和子代理状态展示。

默认视觉主题采用深色编辑器风格：石墨黑背景，粉色作为品牌主色，青色用于导航与信息，紫色用于边框和推理元数据，绿色/红色/黄色分别表达成功、失败和警告状态。界面同时适配亮色终端、ANSI 256 色终端和 `NO_COLOR` 环境。

## 功能

- 流式 Markdown 对话与思考状态
- 工具调用轨迹、命令结果和结构化 Diff
- Shell、文件系统、搜索等 Harness 工具接入
- 审批弹窗与用户问题弹窗
- `/plan`、`/model`、`/sessions`、`/resume`、`/agents` 等命令
- 会话新建、恢复、重命名和标题管理
- 子代理、目标、Todo 和 Token 状态
- inline scrollback 与 alternate screen 两种显示模式
- truecolor、ANSI 256 色、亮色终端和 `NO_COLOR` 兼容

## 安装

要求：Node.js ≥ 22.19、npm、pnpm 和 dsh CLI。

```sh
npm install -g @deepseek-ai/dsh
npm install
npm run build
./install.sh
dsh --profile makima-tui
```

也可以直接使用启动器：

```sh
node ./bin/makima-tui.js
```

启动器默认使用 `makima-tui` profile，可通过 `MAKIMA_TUI_PROFILE` 覆盖。

## dsh 插件安装

```sh
dsh plugin --profile makima-tui add "$PWD"
dsh --profile makima-tui
```

插件 bundle 行由 `cordis.patch.yml` 提供，插件 ID 和名称均为 `makima-tui`。

## 凭据

Makima TUI 不保存 API Key。Harness 会从 dsh 凭据存储读取密钥：

```yaml
DEEPSEEK_API_KEY: sk-...
```

默认位置为 `~/.dsh/.credentials.yaml`。建议设置 `~/.dsh` 为 700、凭据文件为 600。
也可以使用 `DEEPSEEK_API_KEY=sk-... dsh --profile makima-tui` 临时覆盖。

### ChatGPT / Codex OAuth

Makima 也可通过**你自己注册并获 OpenAI 授权的 OAuth client**使用 ChatGPT/Codex 订阅。插件不内置、也不会复用第三方应用的 OAuth `client_id`、`originator` 或 token。

```sh
# 必填：这些值必须来自你的 OAuth client 注册信息和获准的服务端点。
export MAKIMA_OPENAI_CODEX_CLIENT_ID='your-client-id'
export MAKIMA_OPENAI_CODEX_REDIRECT_URI='http://127.0.0.1:1455/callback'
export MAKIMA_OPENAI_CODEX_API_BASE_URL='https://your-authorized-codex-endpoint'

# 可选：默认值分别是 OpenAI OAuth 端点、标准 OIDC scope 和 makima-tui。
export MAKIMA_OPENAI_CODEX_AUTHORIZE_URL='https://auth.openai.com/oauth/authorize'
export MAKIMA_OPENAI_CODEX_TOKEN_URL='https://auth.openai.com/oauth/token'
export MAKIMA_OPENAI_CODEX_SCOPES='openid profile email offline_access'
export MAKIMA_OPENAI_CODEX_ORIGINATOR='makima-tui'
# 可选：仅当你自己的 OAuth client 被服务端明确授权 Device Code grant 时设置；四项必须同时存在。
export MAKIMA_OPENAI_CODEX_DEVICE_AUTHORIZE_URL='https://your-authorized-oauth-endpoint/device-authorize'
export MAKIMA_OPENAI_CODEX_DEVICE_TOKEN_URL='https://your-authorized-oauth-endpoint/device-token'
export MAKIMA_OPENAI_CODEX_DEVICE_VERIFICATION_URI='https://your-authorized-device-verification-page'
export MAKIMA_OPENAI_CODEX_DEVICE_REDIRECT_URI='https://your-authorized-oauth-endpoint/device-callback'
```

重新启动 Makima 后，在 `/model` 中选择 **OpenAI ChatGPT / Codex**，按 Enter 打开浏览器授权链接。完成登录时，本机回调仅接受已验证的单次 PKCE `state`，并将 access token、refresh token 和过期时间以独立 JSON 文件存储在 `~/.makima-tui/openai-codex-oauth.json`（可用 `MAKIMA_OPENAI_CODEX_CREDENTIAL_PATH` 覆盖）。该文件不进入会话、TUI RPC 返回值、日志或提示词；模型选择器的 `Ctrl+D` 将只删除此本地 OAuth 会话。

浏览器登录可使用已注册的 `http://localhost/...` 或 `http://127.0.0.1/...` 回调 URI；推荐显式注册并使用 `127.0.0.1`，避免本机 IPv4/IPv6 的 `localhost` 解析差异。若已完整配置 Device Code 端点，可在授权界面先按 `Esc`/`c` 取消当前浏览器流程，再按 `d` 启动设备码；此功能不会使用任何内置或第三方 OAuth client。

另提供独立命令：`makima-tui-auth login openai-codex --browser`、`makima-tui-auth login openai-codex --device-code`、`makima-tui-auth status openai-codex` 与 `makima-tui-auth logout openai-codex`。这些命令与 TUI 共享同一份本地凭据，但只输出脱敏状态。

> Codex backend 和 OAuth 授权范围由服务提供方决定。仅使用你获授权的 client、redirect URI 和 API base URL；配置缺失时 provider 不会注册。

## 配置

环境变量统一使用 `MAKIMA_TUI_` 前缀：

| 变量 | 说明 |
|---|---|
| `MAKIMA_TUI_THEME=light\|dark` | 选择终端明暗模式 |
| `MAKIMA_TUI_INLINE=0` | 使用 alternate screen |
| `MAKIMA_TUI_HOME` | Makima 数据目录，默认 `~/.makima-tui` |
| `MAKIMA_TUI_FPS=1` | 显示 FPS 信息 |
| `MAKIMA_TUI_TRUECOLOR=1` | 显式启用 truecolor |
| `MAKIMA_TUI_WORKSPACE` | 指定工作目录 |
| `MAKIMA_TUI_RESUME` | 启动时恢复指定会话 |
| `MAKIMA_OPENAI_CODEX_CLIENT_ID` | 启用 Codex OAuth 所需的自有 OAuth client ID |
| `MAKIMA_OPENAI_CODEX_REDIRECT_URI` | 已注册的 `http://localhost/...` 或 `http://127.0.0.1/...` OAuth 回调 URI |
| `MAKIMA_OPENAI_CODEX_API_BASE_URL` | 获授权的 Codex Responses API base URL |
| `MAKIMA_OPENAI_CODEX_CREDENTIAL_PATH` | OAuth 凭据文件覆盖路径 |
| `MAKIMA_OPENAI_CODEX_DEVICE_*` | 可选 Device Code 四个端点；仅在自有 client 获准该 grant 时完整配置 |

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
```

主要目录：

```text
src/harness/              dsh / Harness 适配层
src/components/           TUI 组件
src/app/                  应用状态和交互控制
src/theme.ts              Makima 主题与终端色彩兼容层
packages/makima-tui-ink/  vendored Ink 渲染器
```

## 主题色

```text
背景       #000000
主色       #E84393
边框       #B366FF
信息       #7DD3E8
文字       #EEEAF4
次要文字   #7E7888
成功       #00FF9C
错误       #FF3B6B
警告       #FFD060
```

## 许可与来源

本项目使用 MIT License。部分 TUI 实现源自 MIT 许可的 clawcodex ui-tui 和 dsh-TUI 项目；具体来源见 [NOTICE.md](NOTICE.md)。
