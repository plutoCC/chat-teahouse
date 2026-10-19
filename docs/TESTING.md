# 测试与发布检查

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
