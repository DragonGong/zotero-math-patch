# Zotero Math Patch

Zotero Math Patch 是面向 Zotero 7+ 笔记的公式修复插件。它提供两个完全手动触发的命令：

**当前版本：v0.2.4 · [下载 XPI](https://github.com/DragonGong/zotero-math-patch/releases/latest/download/zotero-math-patch.xpi) · [更新记录](CHANGELOG.md)**

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

所有操作会在本地检查 JSON 结构、块编号、原文、出现次数、重叠范围、LaTeX 安全性和普通文字保护。只有全部操作通过验证后，插件才会在克隆 DOM 上使用 `textContent` 创建固定的公式节点，并一次性保存笔记。失败、取消、返回冲突或处理期间笔记被再次编辑时，不会写回结果。

## 下载与安装

推荐从 GitHub Releases 下载已经构建好的插件：

**[下载最新版 zotero-math-patch.xpi](https://github.com/DragonGong/zotero-math-patch/releases/latest/download/zotero-math-patch.xpi)**

1. 在 Zotero 中打开 `工具` -> `插件`。
2. 点击插件管理器右上角的齿轮。
3. 选择 `Install Add-on From File...`。
4. 选择下载的 `zotero-math-patch.xpi`。
5. 按 Zotero 提示重启。

覆盖安装新版本会保留 Math Patch 设置和本机凭据存储中的 API Key。插件通过仓库中的 `updates.json` 检查后续版本，也可以随时从 Releases 手动升级。

兼容范围为 Zotero 7.0 至 9.0.x；v0.2.4 已在 Windows 上的 Zotero 9.0.5 中完成实际安装和功能测试。

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

长笔记分批时会尽量携带相邻文本块作为上下文。不同批次的完全相同操作会去重；针对同一原文的不同结果或重叠修改会终止整个写回。

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

请求有超时限制，同一笔记处理期间两个命令都会暂时禁用。插件停用时会取消仍在进行的请求。

### 请求错误排查

- `The model request timed out after ...`：当前批次没有在设置的时间内完成。提高 `Request timeout`，或降低 `Maximum characters per request` 后重试。
- `The model JSON response was truncated ...`：提高 `Maximum output tokens`。
- `The model returned an empty JSON response` 或 `The model did not return valid JSON`：服务已经响应，但没有遵守 JSON 协议。可以先重试连接测试；持续出现时检查模型是否支持 `response_format: {"type":"json_object"}`。

上述错误都发生在保存之前，原笔记不会被修改。

### 插件问题排查

- 菜单中没有 `Render Markdown Math` 或 `Process Math with AI`：确认插件已启用且版本为 v0.2.4，然后重启 Zotero。
- AI 预览窗口为空白：v0.2.4 已改为通过 Zotero 注册的 `chrome://` 页面打开预览；覆盖安装后必须重启 Zotero，避免旧窗口代码仍留在内存中。
- 安装时提示不兼容：确认 Zotero 版本处于 7.0 至 9.0.x，并确认选择的是 `.xpi` 文件而不是源码压缩包。
- `Test Connection` 成功但处理笔记超时：连接测试只发送极短请求；把 `Request timeout` 调到 `120000` 或更高，并适当降低单次请求字符数。

## 数据与隐私

AI 模式会发送普通文本块及其 `id`、`tag` 和 `text`。为帮助识别跨段公式，长笔记批次可能包含少量相邻普通文本上下文。

以下内容不会作为可修改文本发送：

- 已有 `.math` 公式节点；
- `code`、`pre`、`script`、`style`；
- 图片；
- 链接文本和链接地址；
- Zotero 引用、附件、批注等特殊节点。

这些位置在相邻文本中只表示为受保护占位符。插件不记录完整请求体、完整响应体或笔记正文，也不会执行模型返回的 HTML 或脚本。

**使用第三方模型时，待处理笔记文本会发送到用户配置的第三方接口，数据处理和隐私规则由对应服务商决定。**

只有手动执行 `Process Math with AI` 才会发起请求。`Render Markdown Math` 始终完全在本地运行。

## 开发与测试

```sh
npm install
npm test
npm run build
```

测试使用 mock HTTP，不调用真实或付费模型接口。测试覆盖规则模式回归、安全文本块提取、行内/块级应用、出现次数定位、格式保持、预览窗口及确认/取消操作、非法协议、重叠冲突、批次合并、超时、取消、网络/API 错误脱敏和原子工作流。

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
- 公式识别质量取决于所选模型；本地严格验证可以阻止越界写回，但不能保证模型恢复出的数学含义一定正确，因此默认开启预览。
- 插件只创建 Zotero 公式节点，本身不实现 KaTeX 或 MathJax 渲染器。

## 发布

发布记录和可安装 XPI 位于 [GitHub Releases](https://github.com/DragonGong/zotero-math-patch/releases)。每个发布资产都附带 SHA-256 校验值；版本变化见 [CHANGELOG.md](CHANGELOG.md)。
