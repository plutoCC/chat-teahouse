# 第三方依赖与致谢

应用代码采用根目录的 MIT 许可证。下表根据本次锁定安装的直接依赖包元数据生成；第三方依赖不因此被重新许可。完整传递依赖及完整性信息见 `package-lock.json`，各依赖的许可证全文随 npm 包提供。

本源码仓库不附带 `node_modules`、浏览器、Codex 客户端或模型权重。自行制作包含依赖代码的安装包、前端构建产物或二次发行版时，需同时保留依赖的适用版权与许可声明；本清单不替代那些声明。

| 依赖 | 锁定版本 | 许可证 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | 4.0.5 | MIT |
| `@deepseek-ai/dsh-agent` | 0.2.1-rc.2 | MIT |
| `@deepseek-ai/dsh-agent-loop` | 0.2.1-rc.2 | MIT |
| `@deepseek-ai/dsh-llm` | 0.2.1-rc.2 | MIT |
| `@deepseek-ai/dsh-session` | 0.2.1-rc.2 | MIT |
| `@deepseek-ai/dsh-session-persistence` | 0.2.1-rc.2 | MIT |
| `@deepseek-ai/dsh-session-persistence-jsonl` | 0.2.1-rc.2 | MIT |
| `@deepseek-ai/dsh-session-projection` | 0.2.1-rc.2 | MIT |
| `@deepseek-ai/dsh-system-prompt` | 0.2.1-rc.2 | MIT |
| `@deepseek-ai/dsh-tools` | 0.2.1-rc.2 | MIT |
| `@fastify/static` | 10.1.6 | MIT |
| `@types/node` | 24.19.2 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `@vitejs/plugin-react` | 5.2.0 | MIT |
| `fastify` | 5.12.7 | MIT |
| `lucide-react` | 0.468.0 | ISC |
| `playwright-core` | 1.64.1 | Apache-2.0 |
| `react` | 19.3.0 | MIT |
| `react-dom` | 19.3.0 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `remark-gfm` | 4.0.1 | MIT |
| `sharp` | 0.35.5 | Apache-2.0 |
| `tsx` | 4.23.15 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 7.3.7 | MIT |
| `zod` | 4.6.7 | MIT |

Sharp 的图像处理原生依赖可能适用单独许可（包括 libvips）；请查阅实际分发包附带的许可证。Lucide 图标保留其原始版权及 ISC 声明。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为成员提供 Agent、工具和会话运行时。工具式主动群聊思路参考 [qq-bridge](https://github.com/Derpyu520/qq-bridge)；应用未集成 QQ 登录或其用户数据，也未复制 MaiBot / AstrBot 的实现代码。

模型、浏览器和操作系统服务的名称仅用于标识兼容渠道，不表示获得相应公司的背书。第三方服务使用规则和额度不受本项目 MIT 许可证改变。
