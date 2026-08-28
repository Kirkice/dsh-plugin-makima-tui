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
