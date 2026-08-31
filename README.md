# Makima TUI

Makima TUI 是运行在 DeepSeek Harness / dsh 中的终端智能体界面插件。
它基于 React + Ink，提供流式对话、工具调用、审批确认、问题询问、计划模式、会话恢复、模型选择和子代理状态展示。

默认视觉主题采用深色编辑器风格：石墨黑背景，粉色作为品牌主色，青色用于导航与信息，紫色用于边框和推理元数据，绿色/红色/黄色分别表达成功、失败和警告状态。界面同时适配亮色终端、ANSI 256 色终端和 `NO_COLOR` 环境。

## 功能

- 流式 Markdown 对话与思考状态
- 工具调用轨迹、命令结果和结构化 Diff
- Shell、文件系统、搜索等 Harness 工具接入
- 审批弹窗与用户问题弹窗
- `/plan`、`/providers`、`/model`、`/sessions`、`/resume`、`/agents` 等命令
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

Makima 内置已获维护者授权的 OpenAI OAuth public client，因此**无需环境变量或 API Key**：启动后输入 `/providers`，按 `o` 打开 ChatGPT / Codex 面板，再按 `b` 即可完成浏览器 PKCE 登录；按 `d` 可使用设备代码登录。浏览器回调固定为 `http://localhost:1455/auth/callback`，本机仅接受匹配单次 PKCE `state` 的回调。

登录完成后，access token、refresh token 和过期时间保存在 `~/.makima-tui/openai-codex-oauth.json`（可用 `MAKIMA_OPENAI_CODEX_CREDENTIAL_PATH` 覆盖）。凭据不进入会话、TUI RPC 响应、日志或提示词；在 OAuth 面板按 `l`，或在模型选择器按 `Ctrl+D`，会删除本地 OAuth 会话。

默认使用 ChatGPT Codex backend、OpenAI OAuth 端点及 Device Code 端点。仅在开发、私有部署或需要使用另一获授权 OAuth client 时，才可使用下列可选覆盖项；若更改 client 或回调地址，必须保证其已在 OAuth 应用注册中获授权：

```sh
export MAKIMA_OPENAI_CODEX_CLIENT_ID='your-authorized-client-id'
export MAKIMA_OPENAI_CODEX_REDIRECT_URI='http://localhost:1455/auth/callback'
export MAKIMA_OPENAI_CODEX_API_BASE_URL='https://your-authorized-codex-endpoint'
export MAKIMA_OPENAI_CODEX_AUTHORIZE_URL='https://auth.openai.com/oauth/authorize'
export MAKIMA_OPENAI_CODEX_TOKEN_URL='https://auth.openai.com/oauth/token'
export MAKIMA_OPENAI_CODEX_SCOPES='openid profile email offline_access'
export MAKIMA_OPENAI_CODEX_ORIGINATOR='makima-tui'
export MAKIMA_OPENAI_CODEX_DEVICE_AUTHORIZE_URL='https://your-authorized-oauth-endpoint/device-authorize'
export MAKIMA_OPENAI_CODEX_DEVICE_TOKEN_URL='https://your-authorized-oauth-endpoint/device-token'
export MAKIMA_OPENAI_CODEX_DEVICE_VERIFICATION_URI='https://your-authorized-device-verification-page'
export MAKIMA_OPENAI_CODEX_DEVICE_REDIRECT_URI='https://your-authorized-oauth-endpoint/device-callback'
```

另提供独立命令：`makima-tui-auth login openai-codex --browser`、`makima-tui-auth login openai-codex --device-code`、`makima-tui-auth status openai-codex` 与 `makima-tui-auth logout openai-codex`。这些命令与 TUI 共享同一份本地凭据，但只输出脱敏状态。

> 可用模型、额度及 OAuth 协议由 OpenAI 和已登录 ChatGPT 账号决定；服务端变更时可能需要更新 Makima。

### `/providers`：统一 Provider 管理

输入 `/providers` 打开 Provider 管理器。它不会改变既有快捷命令：`/provider <route>` 仍用于快速切换 Provider，`/model` 仍用于选择模型和推理强度。

- 按 `a` 新增一个 OpenAI 兼容的 API-key Provider：填写显示名称、HTTP(S) Base URL、API key、至少一个模型 ID，并在 `openai-completions`、`openai-responses` 或 `anthropic-messages` 协议中选择服务端实际兼容的协议。
- 按 Enter 编辑 Makima 创建的 Provider。API key 一栏留空会保留已有密钥；界面只展示“已配置”状态，永不回传或显示密钥文本。
- 在编辑界面按 `x` 并确认，可删除该 Provider 的配置及其密钥。安全起见，只有 `/providers` 自行创建、路由名以 `makima-` 开头的 Provider 可以删除；内置或 composition Provider 仅展示。
- 按 `o` 管理 **ChatGPT / Codex**。无需预先配置即可启动浏览器 PKCE 或 Device Code 授权，也可取消挂起授权或退出本地 OAuth 会话。

新建 API-key Provider 的密钥通过 Harness credential service 存储为 `MAKIMA_TUI_PROVIDER_*_API_KEY`，而不是写入 settings、会话、日志或 RPC 列表响应。保存 Provider 后，Harness 会动态注册路由，随后可通过 `/provider` 或 `/model` 直接选用。

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
