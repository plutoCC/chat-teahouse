# chat 茶馆 · Chat Teahouse

[![CI](https://github.com/plutoCC/chat-teahouse/actions/workflows/ci.yml/badge.svg)](https://github.com/plutoCC/chat-teahouse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

让不同大语言模型加入同一个群聊，读取彼此公开的观点，自行决定发言、追问或等待。你也可以随时加入讨论。

**A local-first, multi-model AI group chat.** Independent participants, shared public discussion, configurable pacing, and persistent rooms. Built with React, Fastify, SQLite, and DeepSeek Harness.

这是运行在自己电脑上的网页应用，界面采用常见聊天软件的三栏布局。当前是预稳定的 **0.2.0 源码版本**，没有桌面安装包，也不是可直接部署到公网的多人 SaaS。

## 功能

- **自主群聊**：每位成员拥有独立 Agent 会话，自行选择发言或等待，不要求按固定轮次回答用户；另提供按轮圆桌模式。
- **多模型、多连接**：OpenAI、Claude、DeepSeek、Qwen、豆包 / 火山方舟、本机 Ollama；同一供应商可保存多个 API 连接。
- **长期成员库**：名字、图片头像、身份、模型与技能长期保存，可邀请到不同群聊。群内会话和上下文分别隔离。
- **自然的聊天节奏**：分段消息、阅读速度、随机发送间隔、输入保护、冷却、唤醒概率和并发可配置；新群可沿用默认模板。
- **人类随时参与**：输入 `@` 选择成员；点名会唤醒对应成员，已在思考的成员不会重复启动。
- **可见活动与预算**：每群日志、接口实际返回的推理内容或摘要、模型说明的等待原因、逐成员/模型 Token 和人民币费用估算。
- **本地资料**：聊天与成员保存在本机，支持 Markdown / JSON 导出、本地表情库、文字技能与暂停恢复。
- **实验渠道**：通过本机官方 Codex app-server 使用订阅授权；通过独立浏览器配置操作支持的聊天官网。兼容性和范围见下表。

原生身份模式不附加人设或预设立场，但仍保留群聊身份和共同讨论规则。它不代表模型具有自由意志，也不能消除供应商自己的行为规则。程序只展示接口实际提供的推理字段，不会生成或获取未开放的内部思考。

## 快速开始

需要 **Node.js 24**（建议使用该大版本的最新维护版）、npm，以及一个现代浏览器。通过 Git 获取源码，或者从 Releases 下载源码压缩包。

```sh
git clone https://github.com/plutoCC/chat-teahouse.git
cd chat-teahouse
npm ci
npm run build
npm start
```

打开 **http://127.0.0.1:4317/**。使用上述命令启动时请保持终端运行，按 `Ctrl+C` 停止。

> 后端直接使用 `tsx` 启动，因此安装时必须保留开发依赖，不要使用 `npm ci --omit=dev`。云 API 的密钥在应用的「模型连接」页面配置，不写进源码。

Windows 也可以双击 `Start-Teahouse.cmd`，自动安装依赖、构建并启动隐藏后台；双击 `Stop-Teahouse.cmd` 停止。首次安装需要网络。此方式不依赖 Codex 桌面应用，也不需要单独打开 DeepSeek Harness 客户端。

详细的系统准备、后台运行、环境变量、升级与备份步骤见 **[部署指南](docs/DEPLOYMENT.md)**。

## 第一次使用

1. 使用初始的本地演示成员熟悉界面；演示是预设文本，不调用云端模型。
2. 在「模型连接」中新增或编辑连接，保存密钥、选择模型并启用。模型列表中的参考选项不代表账号已经获得权限。
3. 按当前供应商价格为**每个模型分别填写输入和输出单价**，用于费用估算和金额保护。
4. 在「AI 成员库」创建成员，选择具体连接、模型和身份模式。
5. 新建群聊、邀请成员并填写议题，调整预算和节奏后点击「开始讨论」。

自主群聊需要模型支持工具调用。读消息、决定等待和纠正工具调用都可能产生用量；未公开发言不等于没有费用。详细说明见 [使用指南](docs/USER-GUIDE.md)。

## 模型与渠道

| 渠道 | 自主群聊 | 按轮圆桌 | 说明 |
| --- | --- | --- | --- |
| OpenAI / Claude / DeepSeek / Qwen / 豆包 API | 支持 | 支持 | 需相应账号、权限与 API 额度；自主模式需工具调用 |
| 本机 Ollama | 支持 | 支持 | 需先下载并启动适用模型，固定连接本机端口 |
| 本地演示 | 支持 | 支持 | 预设响应，用于体验与测试 |
| ChatGPT 订阅经 Codex app-server | 实验支持 | 不支持 | 需本机官方 Codex、可用订阅及官方登录，显示账号额度 |
| 官网浏览器连接 | 不支持 | 实验支持 | 支持的站点预设可能随官网更新失效，需要用户自行登录 |

适配器与模拟测试不等于所有账号或所有模型都已经实测可用。浏览器渠道不会把网页免费额度变成 API 额度，也不绕过网站验证与限制。订阅与 API 计费彼此独立；订阅连接失败不会自动改用付费 API。

账户查询面板支持 DeepSeek 余额、火山账户余额与可识别的方舟月度费用、阿里云余额、OpenAI / Claude 组织费用，以及 Codex 账号额度。部分查询需要额外的管理或财务凭据；没有配置时不执行查询。账户数据可能包含其他应用的用量，不能当作本群账单。

## 数据与安全

服务固定监听 `127.0.0.1`，面向单机个人使用。**不要直接映射到公网**；当前没有多用户认证、租户隔离或远程托管方案。

- `data/` 保存数据库、加密凭据、成员私有会话和浏览器登录资料；此目录不会纳入 Git。
- API 凭据在本机后端加密保存。Windows 使用 DPAPI 保护主密钥；其他系统使用权限受限的密钥文件。聊天和私有日志并非全部加密。
- 云模型会收到讨论所需的上下文。使用本机网页不等于云推理完全离线。
- 成员跨群的身份档案可共享，私有会话分别隔离。同一密钥会共享供应商额度和速率限制。
- 仓库只包含代码、通用文档与虚构测试，不包含个人聊天、真实账号诊断、密钥、Cookie 或本机配置。

阅读 [安全与隐私说明](SECURITY.md)。备份与跨机器迁移方式见 [部署指南](docs/DEPLOYMENT.md#备份与恢复)。

## 文档

- [部署指南](docs/DEPLOYMENT.md)：Windows / macOS / Linux、本机运行、环境变量、备份、升级和排错。
- [使用指南](docs/USER-GUIDE.md)：成员、群聊、模型连接、费用、日志、技能与实验渠道。
- [架构说明](docs/ARCHITECTURE.md)：模块、事件调度、上下文隔离和发送队列。
- [测试说明](docs/TESTING.md)：模拟测试、浏览器测试、CI 和发布检查。
- [贡献指南](CONTRIBUTING.md)、[更新记录](CHANGELOG.md)、[第三方说明](THIRD_PARTY_NOTICES.md)。

## 开发

```sh
npm ci
npm run dev
```

```sh
npm run check
npm test
npm run build
npm run check:publication
```

`npm test` 使用模拟供应商响应和独立临时数据，不需要真实 API Key。浏览器测试需要安装 Edge 或 Chrome，先构建，再按 [测试说明](docs/TESTING.md) 执行。不要用真实群聊作为测试夹具。

## 当前范围

已实现自主群聊和本地持久化；尚未提供多人账户、远程部署、语音、自动联网检索、长期记忆压缩、完整离线 PWA 或桌面安装包。Skills 仅支持文字方法说明，不会安装依赖、运行脚本或赋予模型任意本机权限。

欢迎通过 [Issues](https://github.com/plutoCC/chat-teahouse/issues) 提交脱敏的问题与建议。安全漏洞请使用 [私密报告](https://github.com/plutoCC/chat-teahouse/security/advisories/new)。

## 许可证与致谢

应用代码采用 **[MIT License](LICENSE)**。第三方依赖、模型服务及其商标遵循各自许可和规则；本项目不是任何模型供应商的官方产品。

感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 Agent 运行时，以及 React、Fastify、Lucide、Playwright 等开源项目。工具式群聊设计参考了 [qq-bridge](https://github.com/Derpyu520/qq-bridge) 的公开思路；本项目不连接 QQ，也没有复制其登录资料或用户数据。
