# Yomi GPT Image MCP — DSH 插件

可通过 DSH「插件 → 添加插件」安装的标准配置 bundle，使用官方 `@deepseek-ai/dsh-mcp-client` 启动随包 Python 服务，无需自写 Host/Client 入口。

## 安装

环境要求：DSH NEXT 2.0.20-next / DSH 0.2.1-rc.3 或兼容版本；Node 22+（DSH 自带）；PATH 中的 **Python 3.9+**。仅用标准库，无 pip 依赖、无安装脚本。Windows 请准备 `python3`，或启动 DSH 前设置 `YOMI_PYTHON` 为解释器路径。

打开 **插件 → 添加插件**，输入：

```text
github:LLM-ASTR/work-contect-gpt2.5
```

安装启用后按提示完整重启 DSH。正式部署建议用 `github:LLM-ASTR/work-contect-gpt2.5#<commit>` 固定提交。也可通过官方 CLI：

```sh
dsh plugin --profile <profile> install github:LLM-ASTR/work-contect-gpt2.5
```

仓库根目录包含 npm manifest 和 `dsh.bundle.patch`，无需构建，不另装官方 MCP client。保留普通工具型聊天模型，不把图片模型选作主聊天模型。

## 工作区与密钥

默认工作区是用户主目录下 `dshwork`（`~/dshwork`），**不是自动获取当前会话目录**。MCP 是 profile 级共享进程，不跟随会话切换目录。参考图须先复制到配置的工作区。

密钥位置：`<工作区>/.secrets/yomi-image-key`；输出目录：`<工作区>/generated-images`。没有密钥也能启动及调用 `status`，但不能生成图片。从仓库本地副本在终端执行：

```sh
python3 setup_key.py
```

隐藏输入密钥，不在聊天或 GitHub 中发送。脚本只在本机保存权限 600 的文件，目录 700，不调用 API。曾暴露的旧密钥应先撤销。POSIX 权限检查主要面向 macOS/Linux；Windows 使用者需另确保凭据 ACL 不向其他用户开放。

自定义目录时，初始化脚本和 DSH 启动环境须一致设置 `YOMI_WORKSPACE`，或在 DSH MCP 配置中设置 `env.YOMI_WORKSPACE` 为绝对路径。macOS 从 Dock 启动不一定继承终端环境；修改后完整重启 DSH。不要把密钥本身写进配置。

```sh
YOMI_WORKSPACE="$HOME/Pictures/image-work" python3 setup_key.py
```

## 工具

- `mcp__yomi_image__status`：本地状态，不联网、不显示密钥。
- `mcp__yomi_image__generate_image`：文生图，JSON POST `/v1/images/generations`。
- `mcp__yomi_image__edit_image`：图生图／编辑，multipart POST `/v1/images/edits`，1–4 张参考图及可选 PNG 蒙版。

API 固定为 `https://api.yomiapi.com/v1`。提示词与指定图片会发给第三方服务。只在用户要求时调用，每次请求一张，不自动重试。连接关闭或超时后仍可能计费，先核实中转记录，不可直接重发。

## 模型与尺寸规则

- 未声明分辨率或声明 1K：`gpt-image-2.5`。
- 明确声明 2K／4K：`gpt-image-2.5-sunburst`。
- 指定目标像素 `size: WIDTHxHEIGHT` 且最长边 **>2048**：Sunburst；等于 2048 仍为普通 2.5（例如 1536×2048）。
- **任何比例只控制长宽比，不推断像素尺寸、不升级模型。** 只说 3:4、16:9、正方形等时，调用方不得主动添加高分辨率 `size`。
- 显式 `model` 覆盖自动路由；不应在用户未要求时强行选择 Sunburst。
- 质量不升级模型。`xhigh/max` 仅支持 Sunburst，普通模型使用这些质量会在联网前报错。

2048 是用户更正后确认的 Yomi 普通模型边长限制，不宣称这是 OpenAI 通用上限。文本路由只做 2K/4K 字面识别，不能可靠理解否定或矛盾要求；请传清晰的最终提示词，必要时显式指定模型。

尺寸采用 [OpenAI 官方 OpenAPI](https://github.com/openai/openai-openapi/blob/master/openapi.yaml) 的 GPT Image 兼容约定：宽高为 16 的倍数、比例 1:3 至 3:1、最大 3840×2160（可交换竖向），高于 2560×1440 为实验性，实际以中转限制为准。质量可选 `auto/low/medium/high/xhigh/max`。未给尺寸时由上游选择像素尺寸，插件不保证输出严格是 1K。

示例：“使用参考图生成 Zippo 产品展示图，名称蛇女刀魂，比例 3:4，只出一版。”应使用普通 2.5，省略 size。参考图原有像素尺寸不参与选模型。

## Sunburst 一次性确认（1.2.0）

所有 Sunburst 请求，包括显式 model 强选，在联网前暂停。工具返回本机终端命令；用户需亲自在交互终端查看完整参数并输入 `APPROVE`，然后让聊天模型原样提交一次。批准绑定工具名及完整参数，10 分钟过期，发送前即消耗，失败不自动重试。不批准时不发送 API 请求。

聊天模型不得自行运行确认命令，也不能把修改后的提示词当作用户原始分辨率意图。确认文件存在工作区 `.secrets/image-approvals`，含提示词和路径，不含 API 密钥，请勿分享。此机制没有接入 DSH GUI 审批弹窗，且**不是针对拥有任意 shell/文件权限智能体的系统安全边界**。请勿让智能体代为写确认文件。普通 2.5 请求无需额外确认。

工具成功返回时会注明实际请求的模型与请求尺寸，避免仅凭生成文件像素尺寸猜测模型。

## 安全与限制

- 参考图检查真实路径，只允许配置的工作区内文件；支持 PNG/JPEG/WebP，单图不超过 40 MiB。
- API 不跟随重定向，图片下载只接受公网 HTTPS 且不转发密钥。DNS 检查不替代网络隔离，不构成完整 DNS rebinding 防护。
- 不显示上游错误正文或凭据，不自动重试。蒙版透明区域和尺寸匹配由上游校验。
- 图片块投影依赖聊天模型支持；即使投影失败，仍按工具返回的明确路径交付，不能猜测目录最新图片就是本次结果。
- 仓库不含凭据、个人参考图、生成图片或 DSH profile。不要提交这些数据。

## 测试

```sh
python3 -m unittest discover -s . -v
```

测试包括 MCP stdio 初始化／工具发现、模拟生成与编辑、图片保存、模型路由、尺寸及基础安全检查，**不调用付费 API**。安装兼容性应通过隔离 profile 分别验证本地包及固定 GitHub 提交。CLI 与 GUI 添加入口使用同一插件管理器；CLI 测试不等于已人工点击验证 GUI。Windows 尚未端到端验证。

同路径本地包可能被包管理器缓存；更新请用官方插件管理器移除再安装，完整重启 DSH。不修改应用安装包。
