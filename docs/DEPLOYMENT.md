# 部署指南

本文介绍在自己的电脑上运行茶馆。程序监听 `127.0.0.1`，没有公网部署所需的多用户认证；GitHub Pages 也不能运行 Fastify、SQLite 和本机凭据后端。

## 环境

- Node.js **24**，建议使用该大版本的最新维护版，包含 npm；数据库使用 Node 内置 SQLite。
- Git（仅通过克隆获取源码时需要）。
- 现代浏览器。实验浏览器连接和浏览器测试另需已安装的 Edge 或 Chrome。
- 首次安装需要访问 npm；选择云模型时还需访问对应供应商。

执行 `node --version` 和 `npm --version` 检查环境。Windows 若阻止 `npm.ps1`，使用 `npm.cmd`。无需安装独立数据库，也无需打开 Harness 桌面客户端。

Windows 提供专用启动脚本；macOS / Linux 使用通用 npm 命令。平台差异主要在凭据保护、系统代理和可选的官方 Codex / 浏览器运行环境。

## 通用启动方式

```sh
git clone https://github.com/plutoCC/chat-teahouse.git
cd chat-teahouse
npm ci
npm run build
npm start
```

访问 http://127.0.0.1:4317/ 。必须保留启动终端，使用 `Ctrl+C` 正常停止。关闭网页不会停止正在运行的讨论。

也可下载 Release 的源码 ZIP，解压后在含有 `package.json` 的目录执行后三条命令。ZIP 方式没有 Git 元数据，不适用 `git pull` 和 Git 发布检查。

**不要只安装生产依赖**：当前服务使用 `tsx` 直接启动 TypeScript，安装需要保留 `devDependencies`。仓库不附带 `node_modules`、`dist` 或用户数据；第一次运行会创建数据目录和演示成员。

## Windows 隐藏后台

双击根目录 **`Launch-Teahouse.cmd`**（`Start-Teahouse.cmd` 同样支持），或者在 PowerShell 中运行：

```powershell
.\Start-Teahouse.ps1 -OpenBrowser
```

脚本会检查 Node.js 版本，在依赖缺失时安装、构建界面并启动隐藏后台进程，健康检查通过后打开默认浏览器。首次运行需要等待安装与构建。启动窗口关闭后后台仍运行，重复启动会打开现有服务，不创建第二个实例。端口占用或启动失败时不会打开错误的页面，窗口会保留错误提示。没有设置开机自动启动。

可以创建启动脚本的桌面快捷方式，但不要单独移动脚本。CMD 入口只对本次 PowerShell 子进程使用 `-ExecutionPolicy Bypass`，不会修改系统执行策略；组织组策略仍可能阻止脚本。直接运行 PowerShell 脚本时，省略 `-OpenBrowser` 可只启动后台；该参数不与 `-Foreground` 同用。自定义端口示例：`.\Start-Teahouse.ps1 -OpenBrowser -Port 4318`。

```powershell
.\Start-Teahouse.ps1 -Action Status
.\Start-Teahouse.ps1 -Action Stop
# 在当前终端运行，方便查看启动输出
.\Start-Teahouse.ps1 -Foreground
```

也可双击 `Stop-Teahouse.cmd`。后台服务日志位于当前数据目录的 `service-logs/`；这些文件仅供本机排错，不应直接上传到 Issue。

## 可选配置

配置通过启动进程的环境变量传入。`.env.example` 只是参考，程序**不会自动加载 `.env` 文件**。API Key 应通过应用界面保存，不需要设置到环境中。

| 变量 | 默认值 / 用途 |
| --- | --- |
| `PORT` | `4317`，范围 1024–65535；仍只监听本机 |
| `CHAT_TEA_DATA_DIR` | `./data`；必须是专用数据目录，不能指向用户主目录或整个项目 |
| `CHAT_TEA_BROWSER_CHANNEL` | 运行时在 Windows 默认 `msedge`，其他平台默认 `chrome`；需已安装该浏览器 |
| `CHAT_TEA_CODEX_PATH` | 可选的官方 Codex 可执行文件绝对路径；只在使用订阅渠道时需要 |
| `CHAT_TEA_USE_SYSTEM_PROXY` | Windows 脚本设为 `0` 时不自动导入本机系统代理 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 手动指定启动进程使用的代理；使用 Node 环境代理时配合 `NODE_USE_ENV_PROXY=1` |

Windows 示例：

```powershell
$env:PORT = '4318'
$env:CHAT_TEA_DATA_DIR = Join-Path $env:LOCALAPPDATA 'ChatTeahouseData'
npm.cmd start
```

macOS / Linux 示例：

```sh
PORT=4318 CHAT_TEA_DATA_DIR="$HOME/.local/share/chat-teahouse" npm start
```

程序会限制数据目录访问权限，因此要使用专用路径。API 模式不要求安装 Codex；订阅模式通过已安装的官方 Codex app-server 运行，若自动查找失败，可配置 `CHAT_TEA_CODEX_PATH`。账号登录必须在官方页面完成。

### 代理

Windows 启动脚本只自动采用系统中已经启用的**本机 HTTP / HTTPS 代理**，不修改系统代理，也不会关闭 TLS 校验。已有进程环境代理优先；远程代理、含凭据的代理或 PAC 不会被自动导入。修改系统代理后需要重启后台。

使用 `npm start` 时代理需自行配置；请确保 `localhost`、`127.0.0.1`、`::1` 在 `NO_PROXY` 中，避免本机 API 和 Ollama 被代理。浏览器能访问某个站点，不代表 Node 后台使用相同代理。

### 本机 Ollama

先自行安装和启动 Ollama，下载需要的模型。应用固定连接 `127.0.0.1:11434`；按轮圆桌使用 `/api`，自主模式使用 `/v1/chat/completions` 的工具协议。自主讨论必须选择支持工具调用的模型，下载后在界面刷新模型列表。

## 备份与恢复

1. 暂停讨论，并用停止脚本或 `Ctrl+C` 正常退出服务。
2. 复制整个专用数据目录到自己的安全备份位置。
3. 恢复前停止服务并保留现有数据备份，再恢复所需数据。

数据包括 SQLite 数据库、加密凭据、私有 Harness 会话、浏览器配置、订阅配置和运行日志。数据库可能使用 WAL / SHM；**不要在服务运行时仅复制一个 `.sqlite` 文件**。本机操作系统凭据存储中的订阅登录状态不一定随数据目录备份，应准备重新登录。

Windows DPAPI 与当前用户/机器相关，不能作为通用可移植密钥。跨机器迁移时，先备份旧目录，将聊天数据库及需要的独立会话迁移到新环境，重新配置 API 凭据与官方登录；不要混用旧的 `master.dpapi` 和新的 `secrets.enc.json`。浏览器配置也不应当作可移植登录令牌分享。详情见 [安全说明](../SECURITY.md)。

界面导出的 Markdown / JSON 适合阅读和存档，不是完整数据库备份，也没有完整的 JSON 群聊回导流程。导出不会包含凭据库，但聊天里本身存在的敏感文字仍然会被导出。

## 升级

先停止服务并备份。Git 克隆安装可执行：

```sh
git pull --ff-only
npm ci
npm run build
npm start
```

有自己的源码修改时，先提交或备份修改并处理冲突，不要强制覆盖。Windows 后台方式在安装与构建后重新运行启动脚本即可。ZIP 安装建议解压到新目录，再按上述数据迁移方式恢复。

升级不会自动开始讨论。继续讨论沿用本场预算和截止时间；达到时限时可在界面重新开始。预稳定版本可能有存储迁移，不能保证旧程序能直接读取新版数据库，回退应同时恢复对应版本备份。

## 常见问题

| 现象 | 检查方式 |
| --- | --- |
| 页面连接中断 | 后台是否运行、端口是否正确；恢复后页面自动重连，避免刷新丢失尚未发送的草稿 |
| 提示缺少 `tsx` | 重新 `npm ci`，不要省略开发依赖 |
| 无法识别 SQLite API | 检查实际启动服务的 Node 版本是否为 24 |
| 保存 Key 后仍无回复 | 检查连接是否启用、成员选中的连接、讨论是否开始，以及模型工具支持 |
| HTTP 429 | 额度不足需要处理供应商账单；临时限流采用有限退避，不能靠改模型名修复欠费 |
| 模型列表成功但生成失败 | 目录权限不等于推理权限；核对模型 ID、地区、工具支持和生成额度 |
| 官方余额查询失败 | 部分接口要求管理/财务凭据，与推理 API Key 不同 |
| 浏览器连接无法找到输入框 | 确认独立浏览器已登录；官网更新或验证可能使预设失效 |
| 订阅连接无法启动 | 检查官方 Codex 安装、路径、账号授权、系统凭据存储和版本兼容性 |

反馈问题时使用虚构复现，只提供必要的错误类别和版本，不上传数据目录或真实上下文。
