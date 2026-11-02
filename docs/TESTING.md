# 测试与发布检查

## 网站与上下文回归

`tests/hosting-gateway.test.ts` 用虚构账号与回环模拟服务验证登录、会话到期/撤销、Host/Origin、身份头、代理过滤、SSE 隔离与并发限制；`hosting-policy.test.ts` 验证管理路由拒绝、模型允许列表和默认演示成员；`hosting-budget.test.ts` 验证每日/月/全站/个人额度、并发预留、实际与未知用量，以及重启后的保守账本。`hosting-integration.test.ts` 启动真实的独立用户工作区，验证群聊、笔记、资源、CSRF 和重启隔离，使用虚构数据，不调用云端模型。

`context-compaction.test.ts` 使用模拟摘要模型，验证旧历史投影、完整工具边界、独立成员缓存、失败后保留原文、缓存限额和摘要计费。上述测试不会证明所有供应商的摘要质量或真实公网隧道可用；真实域名和 HTTPS/SSE 上线验收须按 [部署说明](HOSTING.md) 单独执行。

## 常规检查

```sh
npm ci
npm run check
npm test
npm run build
npm run check:publication
```

Node.js 使用 24。`npm test` 运行 `tests/*.test.ts`，覆盖调度、Harness 工具循环、消息隔离、取消与恢复、费用、凭据加密、HTTP/SSE、来源校验、模型协议与迁移。模型和财务接口使用模拟响应，不要求真实密钥，不产生真实推理费用。

部分测试需要临时回环端口或操作系统凭据能力，严格沙箱可能阻止这些操作。测试在 `.test-artifacts/` 创建独立临时目录并检查清理路径，不使用默认 `data/`。

`sharing-manager.test.ts` 覆盖本机分享助手的配置校验、固定命令边界、邀请/撤销，以及避免覆盖无关隧道配置；使用临时数据与模拟子进程，不操作真实 Tailscale 或模型。Windows 窗口可通过 `scripts/sharing-manager.ps1 -PreviewPath <绝对PNG路径>` 使用虚构状态渲染预览；该模式不读取真实网站数据、不发起管理动作。桌面界面依赖 Windows 自带 WPF，不增加对外管理接口。

邀请码与设置的回归涵盖加密找回、旧码校验导入、重置后的会话撤销、版本冲突，以及只读状态查询不改变在途费用预留。公共成员池回归检查跨账号形象/头像共享、创建者编辑权限、私人群聊和笔记隔离、迁移幂等与既有群成员快照不被改写。`dynamic-discussion-limits.test.ts` 使用模拟生成器验证圆桌和自主群聊合计的并发群数、运行中改变成员并发，以及消息容量限制的释放，不调用真实模型。

## 浏览器验收

先安装 Edge 或 Chrome，并完成构建：

```sh
npm run build
npm run test:browser
```

测试默认浏览器为 Edge。非 Windows 平台可选择已安装的 Chrome：

```sh
CHAT_TEA_BROWSER_CHANNEL=chrome npm run test:browser
```

Windows PowerShell 写法：

```powershell
$env:CHAT_TEA_BROWSER_CHANNEL = 'msedge'
npm.cmd run test:browser
```

浏览器测试使用独立本机服务和虚构数据，截图写入已忽略的 `output/playwright/`。`playwright-core` 不会自动下载浏览器；测试不会登录第三方账号，也不能证明官网布局或真实模型质量。

## CI

GitHub Actions 在 Windows 和 Linux 上使用 Node.js 24 安装锁定依赖、检查发布文件、类型检查、后端测试和构建。Windows 额外运行核心群聊和发送状态的浏览器用例。Workflow 只请求源码读取权限，不需要模型密钥。

CI 不上传本机数据、截图或日志附件。Dependabot 为 npm 和 GitHub Actions 提供更新建议；更新仍需检查兼容性和测试结果。

## 公开发布前

`npm run check:publication` 从 Git 暂存区读取文件对象，检查路径白名单、常见凭据模式、私有数据类型、符号链接和异常大小。它需要 Git 工作副本，源码 ZIP 没有暂存区时不适用。失败只输出文件、行号和问题类型，不打印疑似密钥。

1. 核对暂存清单，只包含源码、公开文档和虚构测试。
2. 确认数据库、登录状态、历史诊断、备份、日志和真实截图均被排除。
3. 执行发布检查和相关测试，从干净克隆重新安装和构建。
4. 使用 GitHub 隐私邮箱提交，不在提交信息中写真实聊天或本机路径。
5. 发布源码标签和 Release，注明实验功能及已知限制。

自动扫描只覆盖已知规则，不保证发现所有敏感信息；新增截图与外部资料需人工审阅。第三方真实验收应使用授权的非敏感测试账户，不作为普通 CI 前提。

`public-summary.test.ts` 与真实 Harness 的模拟模型集成测试覆盖：跨成员并发去重、仅公开字段、增量与重启缓存、群/模型隔离、源记录修改失效、失败不重复调用、预算恢复、取消和摘要超时。公共摘要费用使用独立工具身份；托管网站测试验证摘要模型仍受站长开放名单约束。浏览器测试覆盖官方目录选择器、摘要超时和默认模板继承。上述验证均不调用真实付费模型。

浏览器朗读和单次 @ 唤醒回归：`tests/speech.test.ts` 验证正文过滤、分块顺序、暂停/恢复、跳过、取消和失败释放；`tests/free-chat.test.ts` 覆盖朗读租约、在途发送等待、暂停时的单次唤醒、待命隔离、预算、重复 @ 和停止。`tests/browser/speech-ui.test.ts` 使用模拟 Web Speech API 验证选定消息起读、新消息续播、设置保存和移动布局；`tests/browser/standby-ui.test.ts` 验证待命成员选择及暂停后的单次回复。浏览器流程测试不验证扬声器实际音质，也不调用任何远程语音或付费模型。
