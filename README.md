# Zotero Math Patch

Zotero Math Patch 是面向 Zotero 7+ 笔记的公式修复插件。它提供两个完全手动触发的命令：

**当前版本：v0.3.3 · [下载 XPI](https://github.com/DragonGong/zotero-math-patch/releases/latest/download/zotero-math-patch.xpi) · [更新记录](CHANGELOG.md)**

| 命令 | 处理方式 | 适合场景 |
| --- | --- | --- |
| `Render Markdown Math` | 只使用本地规则，不联网 | 已有 `$...$`、`$$...$$`、方括号公式等明确格式 |
| `Process Math with AI` | 调用用户配置的 OpenAI Compatible 服务 | 公式分隔符丢失、LaTeX 被拆段、Unicode/富文本公式损坏等混乱内容 |

两个命令都支持当前打开的笔记、笔记标签页、单独笔记窗口，以及文献库中选中的单个笔记条目。插件不会监听粘贴事件，不会后台上传笔记，也不会自动批量处理文献库。

## 工作方式

规则模式沿用原有转换器，输出 Zotero 可识别的节点：

```html
<span class="math">$d_i$</span>
<pre class="math">$$TTCP_i = \frac{d_i}{v_i}$$</pre>
```

AI 模式不会把整篇 HTML 交给模型，也不会接受模型返回的整篇 HTML。插件先在本地解析笔记，只发送带稳定编号的普通文本块，例如：

```json
[
  { "id": "block-1", "tag": "p", "text": "其中 (d_i) 表示距离。" },
  { "id": "block-2", "tag": "p", "text": "[" },
  { "id": "block-3", "tag": "p", "text": "TTCP_i = d_i / v_i" },
  { "id": "block-4", "tag": "p", "text": "]" }
]
```

模型只能返回公式操作：

```json
{
  "operations": [
    {
      "type": "inline",
      "blockId": "block-1",
      "source": "(d_i)",
      "occurrence": 1,
      "latex": "d_i"
    },
    {
      "type": "block",
      "blockIds": ["block-2", "block-3", "block-4"],
      "source": "[\nTTCP_i = d_i / v_i\n]",
      "latex": "TTCP_i = \\frac{d_i}{v_i}"
    }
  ]
}
```

行内操作的 `occurrence` 是 `source` 在指定 `blockId` 内从 1 开始的出现序号，不跨段落累计。如果模型误把前面段落里的相同公式也计入，但当前块内只有一个精确命中，插件会安全归一为 `1`。如果模型抄错相邻块编号，但 `source` 在本批请求中只有一个完全一致且可编辑的匹配，插件会将操作安全重定位到真实块；存在多个候选、候选位于批次外或无法精确匹配时仍会拒绝写回。

初次返回仍然必须通过严格原文校验。若某一项失败且能够定位到具体 operation，插件最多发起两次受限修正请求，只让模型重新推理这一项，其他候选操作保持不动。修正块级公式时，模型只确认连续的 `blockIds` 和 LaTeX；本地直接从这些真实 DOM 块生成 canonical `source`，不再要求模型第二次逐字转录长公式。修正结果仍需重新通过块范围、受保护内容、重叠和 LaTeX 安全校验，失败时不会写回。

是否属于公式完全由模型判断。本地不会因为来源只是 `0`、`2026`、`TTC`、`x` 或数字向量而拒绝操作，也不会使用数学语义启发式重新判断模型结果。

所有操作仍会在本地检查 JSON 结构、块编号、原文精确匹配、出现次数、重叠范围、受保护内容和 LaTeX 安全性，包括未转义大括号必须成对闭合。LaTeX 中的 `<`、`>` 数学比较符会被保留；本地只拒绝能够明确识别的标签、属性、注释、声明和危险命令。模型只能替换其操作中精确定位的来源范围，不能新增、删除或改写其他正文。只有全部操作通过验证后，插件才会在克隆 DOM 上使用 `textContent` 创建固定的公式节点，并一次性保存笔记。失败、取消、返回冲突、LaTeX 括号不完整或处理期间笔记被再次编辑时，不会写回结果。

## 下载与安装

推荐从 GitHub Releases 下载已经构建好的插件：

**[下载最新版 zotero-math-patch.xpi](https://github.com/DragonGong/zotero-math-patch/releases/latest/download/zotero-math-patch.xpi)**

1. 在 Zotero 中打开 `工具` -> `插件`。
2. 点击插件管理器右上角的齿轮。
3. 选择 `Install Add-on From File...`。
4. 选择下载的 `zotero-math-patch.xpi`。
5. 按 Zotero 提示重启。

覆盖安装新版本会保留 Math Patch 设置和本机凭据存储中的 API Key。插件通过仓库中的 `updates.json` 检查后续版本，也可以随时从 Releases 手动升级。

兼容范围为 Zotero 7.0 至 9.0.x；v0.3.0 已在 Windows 上的 Zotero 9.0.5 中完成实际安装和功能测试。

### 从源码构建

```sh
npm install
npm test
npm run build
```

构建产物：

```text
builds/zotero-math-patch.xpi
```

## 配置 AI

1. 打开 Zotero 设置。Windows/Linux 通常是 `编辑` -> `设置`，macOS 是 `Zotero` -> `设置`。
2. 在左侧选择独立的 `Math Patch` 栏目。
3. 接口类型选择 `OpenAI Compatible`。
4. 填写接口地址、API Key、模型名称和超时时间。
5. 点击 `Test Connection`。测试只发送一个最小 JSON 请求，不发送笔记内容。

设置修改后自动生效，没有额外的保存按钮。API Key 使用 Firefox/Zotero 环境的本地凭据存储，密码框不会明文显示；API Key 不写入仓库、插件普通首选项或日志。本地 vLLM 等不要求鉴权的服务可以留空 API Key。

常用配置示例：

| 服务 | 接口地址 | 模型名称 | API Key |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash` | 必填 |
| DeepSeek 旧兼容名 | `https://api.deepseek.com` | `deepseek-chat` | 必填 |
| 本地 vLLM | `http://localhost:8000/v1` | vLLM 启动时加载的模型名 | 通常可留空 |
| 其他兼容服务 | 服务商提供的 Base URL，通常以 `/v1` 结尾 | 服务商模型 ID | 按服务要求 |

DeepSeek 官方已声明 `deepseek-chat` 将于 2026-07-24 停用；新配置建议使用当前模型名。可查看 [DeepSeek API 文档](https://api-docs.deepseek.com/) 和 [vLLM OpenAI Compatible Server 文档](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) 获取最新参数。

对官方 `api.deepseek.com` 的 `deepseek-v4-flash` 和 `deepseek-v4-pro`，插件会关闭思考模式。公式修复是受严格 JSON 协议约束的提取任务，关闭思考模式可以减少延迟，并避免思考内容占用输出额度。

插件会自动在 Base URL 后追加 `/chat/completions`，因此不要把完整的 `/chat/completions` 路径填进接口地址。

## AI 设置

- `Request timeout (ms)`：每个模型请求的超时。默认 `120000`（120 秒）；云端模型建议使用 `120000` 到 `180000`。连接测试只发送极短请求，测试成功不代表整篇笔记也能在很短的超时内完成。
- `Show a preview before modifying the note`：默认开启，应用前显示行内/块级数量、每项原文和恢复后的 LaTeX。
- `Default processing range`：整篇笔记、当前选中内容、优先选中内容否则整篇。
- `Maximum characters per request`：长笔记按块级节点分批，不会从文本中间硬截断。云端接口建议从 `8000` 到 `12000` 开始；请求仍然超时时可以继续调低。
- `Maximum output tokens`：传给兼容接口的 `max_tokens`。
- `System prompt`：可编辑；`Restore Default Prompt` 可恢复内置安全提示词。
- `Keep a local diagnostic log...`：默认开启。每次操作生成独立 JSONL 文件；可以关闭，也可以选择、打开或恢复默认日志目录。

长笔记分批时会尽量携带相邻文本块作为上下文。不同批次的完全相同操作会去重；针对同一原文的不同结果或重叠修改会终止整个写回。

## 七日追溯日志

v0.3.0 默认对插件启动、关闭、本地规则转换、AI 处理和 `Test Connection` 生成本机诊断日志。每次操作对应一个 UTF-8 JSONL 文件，每行是带时间、运行 ID、顺序号、功能名和事件数据的 JSON 记录。

默认目录是 Zotero Profile 下的：

```text
zotero-math-patch/logs
```

设置页会显示完整的有效路径。也可以用 `Choose Directory` 改为自定义目录，例如本仓库的 `D:\dragongong\ws\zotero-math-patch\logs`；仓库已忽略根目录 `/logs/`，避免日志被提交。`Open Directory` 会直接打开当前有效目录，`Use Default` 恢复 Profile 目录。

插件会在启动、每次运行和目录变化时清理所有已知目录中修改时间超过精确 168 小时的 `math-patch-*.jsonl`，按最旧文件优先删除，不会删除其他文件或仍在写入的日志。自定义目录不可写时会回退到默认目录并提示；两个目录都不可写时，公式处理仍会继续，但结果中会附带日志失败警告。

日志用于复盘模型是否返回了缺失括号的 LaTeX，或响应是否因 `finish_reason: "length"` 被截断。AI 日志包括完整原始笔记 HTML、安全文本块、分批信息、实际请求体、完整响应对象、usage、解析与验证、预览决定、最终 HTML 和保存/回滚结果；本地规则日志包括转换前后完整 HTML。`Test Connection` 只记录最小测试请求，不包含笔记正文。

**这些日志是不加密的本机明文文件，可能包含完整笔记正文和模型响应。** API Key、`Authorization`、Bearer token 和常见认证字段会在写盘前递归脱敏，但日志中的正文仍可能包含隐私信息。无需追溯时，可以在 `Math Patch` 设置中关闭日志；关闭后不会为新操作创建日志文件，已有插件日志仍按七日规则清理。

## 使用方法

### 本地规则

1. 打开或选中一个可编辑的 Zotero 笔记。
2. 主窗口使用 `工具` -> `Render Markdown Math`；单独笔记窗口使用 `编辑` -> `Render Markdown Math`。
3. 插件显示转换的块级和行内公式数量。

规则模式继续支持：

```markdown
这是 $R_{name}$ 的定义。

$$R_{format} = 1$$

[
TTCP_i = \frac{d_i}{v_i}
]

其中 (d_i) 是车 (i) 到冲突点的距离，比较 (\Delta TTCP)。
```

普通括号文字如 `(Better Notes)`、`(2026)` 不会被规则模式误转；已有 `.math`、`code`、`pre`、`script` 和 `style` 内容会被跳过。

### 大模型处理

1. 先在 `Math Patch` 设置中完成配置和连接测试。
2. 打开或选中一个可编辑笔记。
3. 主窗口使用 `工具` -> `Process Math with AI`；单独笔记窗口使用 `编辑` -> `Process Math with AI`。
4. 等待模型识别并返回操作。
5. 检查预览，点击 `Apply` 或 `Cancel`。
6. 成功后提示行内公式数、块级公式数和使用的模型。

本地不再以“不像公式”为理由拦截模型选择，因此建议保持预览开启，特别留意普通数字、年份和缩写是否被误判。请求有超时限制，同一笔记处理期间两个命令都会暂时禁用。插件停用时会取消仍在进行的请求。

### 请求错误排查

- `The model request timed out after ...`：当前批次没有在设置的时间内完成。提高 `Request timeout`，或降低 `Maximum characters per request` 后重试。
- `The model JSON response was truncated ...`：服务返回了 `finish_reason: "length"`，即使响应仍是合法 JSON 也不会继续应用；提高 `Maximum output tokens` 后重试。
- `The model returned an empty JSON response` 或 `The model did not return valid JSON`：服务已经响应，但没有遵守 JSON 协议。可以先重试连接测试；持续出现时检查模型是否支持 `response_format: {"type":"json_object"}`。
- 需要判断是模型输出错误还是传输截断时：在 `Math Patch` 设置中点击 `Open Directory`，打开本次 `process-math-with-ai` 日志，查看 `provider_response` 的完整响应和 `finishReason`。不要把包含敏感笔记正文的日志公开上传。

上述错误都发生在保存之前，原笔记不会被修改。

### 插件问题排查

- 菜单中没有 `Render Markdown Math` 或 `Process Math with AI`：确认插件已启用且版本为 v0.3.3，然后重启 Zotero。
- AI 预览窗口为空白：v0.2.4 已改为通过 Zotero 注册的 `chrome://` 页面打开预览；覆盖安装后必须重启 Zotero，避免旧窗口代码仍留在内存中。
- 安装时提示不兼容：确认 Zotero 版本处于 7.0 至 9.0.x，并确认选择的是 `.xpi` 文件而不是源码压缩包。
- `Test Connection` 成功但处理笔记超时：连接测试只发送极短请求；把 `Request timeout` 调到 `120000` 或更高，并适当降低单次请求字符数。

## 数据与隐私

AI 模式会发送普通文本块及其 `id`、`tag` 和 `text`。为帮助识别跨段公式，长笔记批次可能包含少量相邻普通文本上下文。若初次操作未通过本地校验，插件还会向同一模型服务发送该批安全文本块、候选公式操作和脱敏后的校验错误，最多进行两次单项修正；不会为修正请求发送整篇 HTML。

以下内容不会作为可修改文本发送：

- 已有 `.math` 公式节点；
- `code`、`pre`、`script`、`style`；
- 图片；
- 链接文本和链接地址；
- Zotero 引用、附件、批注等特殊节点。

这些位置在发送给模型的相邻文本中只表示为受保护占位符。插件不会执行模型返回的 HTML 或脚本。

默认开启的本机七日追溯日志与网络发送范围不同：为了定位问题，它会记录完整笔记 HTML、实际模型请求和完整响应。日志不上传到项目作者或其他后台服务，只写入用户选择的本机目录；API Key 和已知认证字段在写盘前脱敏。日志内容、位置、保留和关闭方式见上方“七日追溯日志”。

**使用第三方模型时，待处理笔记文本会发送到用户配置的第三方接口，数据处理和隐私规则由对应服务商决定。**

只有手动执行 `Process Math with AI` 才会发起请求。`Render Markdown Math` 始终完全在本地运行。

## 开发与测试

```sh
npm install
npm test
npm run build
```

测试使用 mock HTTP，不调用真实或付费模型接口。测试覆盖规则模式回归、安全文本块提取、行内/块级应用、出现次数定位、格式保持、预览窗口及确认/取消操作、非法协议、重叠冲突、批次合并、超时、取消、网络/API 错误脱敏、原子工作流，以及 JSONL 顺序、七日清理、目录回退、完整追溯和凭据脱敏。

Windows 下检查 XPI 内容：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead("builds/zotero-math-patch.xpi")
$zip.Entries | Select-Object FullName
$zip.Dispose()
```

XPI 内部路径必须使用 `chrome/content/...` 正斜杠格式。

## 主要文件

```text
bootstrap.js                       Zotero 启动和脚本加载
prefs.js                           Zotero 7 默认首选项
chrome/content/converter.js        原规则转换器
chrome/content/math-renderer.js    菜单、笔记定位、保存和刷新
chrome/content/settings.js         设置默认值和统一读取
chrome/content/credentials.js      本地 API Key 凭据存储
chrome/content/logger.js           JSONL 追溯、脱敏、目录回退和七日清理
chrome/content/ai-provider.js      OpenAI Compatible Provider
chrome/content/ai-core.js          安全提取、验证、DOM 应用、分批合并
chrome/content/ai-workflow.js      原子 AI 处理流程
chrome/content/preferences.*       Math Patch 设置面板
chrome/content/preview.*           修改预览窗口
test/                              规则、核心、Provider 和工作流测试
scripts/build-xpi.js               跨平台 XPI 构建
```

## 当前限制

- 当前版本完整实现整篇笔记处理。Zotero 编辑器选区尚未可靠映射到安全 DOM 块；选择“当前选中内容”会明确提示暂不支持，“优先选中内容”当前回退到整篇笔记。
- 第一版只实现 OpenAI Compatible Chat Completions，不支持 Anthropic/Gemini 原生协议。
- 兼容服务需要接受 `temperature: 0`、`max_tokens` 和 `response_format: {"type":"json_object"}`。部分旧服务若不支持 JSON mode，连接测试会失败。
- 单个文本块若本身超过单次请求字符上限，插件会停止并提示提高上限，不会把段落从中间截断。
- 公式识别质量取决于所选模型；本地严格验证可以阻止越界写回，但不判断来源是否真是公式，也不能保证模型恢复出的数学含义一定正确，因此默认开启预览。
- 诊断日志不加密且会包含完整正文；七日清理依赖插件有机会启动或运行，长期不启动 Zotero 时，过期文件会在下一次启动后清理。
- 插件只创建 Zotero 公式节点，本身不实现 KaTeX 或 MathJax 渲染器。

## 发布

发布记录和可安装 XPI 位于 [GitHub Releases](https://github.com/DragonGong/zotero-math-patch/releases)。每个发布资产都附带 SHA-256 校验值；版本变化见 [CHANGELOG.md](CHANGELOG.md)。
