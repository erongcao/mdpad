# mdpad

一个 macOS 上的 Markdown 写作工具：CodeMirror 6 编辑器 + AI 辅助写作 + pandoc 导出，原生外壳只有约 6 MB。

## 功能

### 编辑

- CodeMirror 6 内核，增量解析，大文件流畅编辑
- 源码 / 分栏 / 预览三种视图（⌘1 / ⌘2 / ⌘3），实时渲染（markdown-it）
- 原生 macOS 菜单栏：新建 ⌘N、打开 ⌘O、打开最近、保存 ⌘S、另存为 ⇧⌘S、关闭窗口 ⌘W
- 拖拽打开 .md 文件，查找 ⌘F、替换 ⌥⌘F
- 字数统计（中文字符 + 西文单词分别计），深浅色跟随系统

### 格式菜单（对照 Bear）

原生「格式」菜单，全部 toggle 语义（再按一次还原）：

- 标题 1-3（⌃⌘1/2/3）、引用块、代码块（⌥⌘C）、分隔线
- 加粗 ⌘B、斜体 ⌘I、删除线 ⇧⌘X、行内代码 ⇧⌘C
- 无序 / 有序 / 任务列表（⇧⌘7/8/9）
- 链接 ⌘K、图片、表格模板、自动编号脚注

### AI 辅助写作

选中一段文字，浮出小条即可操作：

- 扩写：保持原意扩充到两三倍
- 总结：三到五句话概括要点
- 润色：修正语病、让表达更流畅

结果流式显示在底部抽屉，确认后可选「替换选区」或「插入到选区后」——AI 不会直接改动你的原文。支持推理模型的思考过程展示（qwen、DeepSeek-R1 等）。

### AI 对话面板

视图菜单 ▸ AI 对话（⌘J）打开右侧常驻面板：

- 多轮对话，流式输出，随时可停止
- 「附带选区 / 附带全文」开关控制发给模型的上下文（默认只发选区，发什么看得见）
- 每条回答可一键「插入到光标处」或复制
- 与选区动作共用同一份服务商配置

支持的服务商（一套 OpenAI 兼容协议全覆盖）：

| 类型 | 服务商 |
| --- | --- |
| 本地 | Ollama、LM Studio |
| 云端 | DeepSeek、智谱 GLM、MiniMax、Kimi（月之暗面）、通义千问（百炼）、豆包（火山方舟）、OpenAI |
| 其他 | 任何 OpenAI 兼容端点（自定义） |

### AI 代码补全

在代码块里输入时，停顿约 1 秒会自动出现灰色补全建议（Tab 接受，Esc 忽略）。视图菜单可开关。只发生在代码块内，正文写作不打扰。

### 写作体验

- 专注模式（视图 ▸ 专注模式，⇧⌘F）：只高亮当前段落，其余变淡
- 滚动同步：分栏模式下预览跟随编辑区，按源码行号对齐

### 可执行代码块

预览里的 python / r / julia 代码块右上角有「▶ 运行」：本地解释器执行，输出显示在代码块下方，生成的图片（png/jpg/svg）自动嵌入显示。超时上限 120 秒。解释器缺失时按钮会给出安装提示。

「检查」按钮只验证语法不执行（Julia 需 Meta.parseall，多行代码兼容）；「✨ 解释」让 AI 讲解代码；运行报错后输出区出现「让 AI 修复这个错误」，AI 给出修正版后可一键替换原文档中的代码块。

### 导出（文件菜单）

- Word (.docx)：pandoc 转换，数学公式转 Word 原生 OMML 格式（可继续编辑），表格为真 Word 表格
- HTML：单文件导出，样式内联、图片内嵌，发哪儿都能看
- PDF：⌘P 系统打印，打印视图只含正文
- 公众号：文件 ▸ 导出 ▸ 复制为公众号格式，带排版样式复制到剪贴板，粘贴进公众号编辑器原样保留

### 隐私

- 文档完全本地，AI 请求只发你选中的那一段文字
- API Key 保存在 macOS 钥匙串，不落任何明文文件
- 配置存于 ~/Library/Application Support/mdpad/ai-config.json（只含地址和模型名）

## 安装

从 Releases 下载 mdpad_aarch64.dmg，拖进「应用程序」。

未签名的应用首次打开会被 Gatekeeper 拦：

- 提示「无法验证开发者」：右键 → 打开
- 提示「已损坏」（应用经过 AirDrop/微信等传输后被加了隔离标记）：终端执行 `xattr -cr /Applications/mdpad.app` 后打开

## 使用

### 配置 AI

工具栏右侧「AI」按钮打开设置：

1. 选服务商（本地 Ollama 默认已填好，云端需要填 API Key）
2. 点「拉取模型列表」拿到真实模型清单，下拉选择；也可以手填
3. 「保存并使用」——每个服务商的配置分开保存，切换不用重输

云端 API Key 申请入口：设置面板里每个服务商名下有提示。

### 配置导出

docx / html 导出依赖 pandoc：「brew install pandoc」。程序会自动在常见位置查找（/opt/homebrew/bin、/usr/local/bin），找不到时导出按钮会给出安装提示。

## 从源码构建

需要 Rust 工具链和 Node.js：

```bash
npm install
npm run tauri dev    # 开发模式（热更新）
npm run tauri build  # 打包 release，产物在 src-tauri/target/release/bundle/
```

## 技术栈

- 外壳：Tauri 2（Rust + WKWebView），不用 Electron，无 Node、无 Chromium 运行时
- 编辑器：CodeMirror 6
- 渲染：markdown-it
- AI：reqwest 直连 OpenAI 兼容端点，SSE 流式解析（Rust 侧，前端只收事件）
- 密钥：keyring crate → macOS Keychain

## 致谢

AI 写作台的产品形态参考了 MDEditor（github.com/Ldxs001/maby_tool）与其衍生项目墨匠 MDWright（github.com/zhjx19/MDWright）——仅借鉴思路，本项目代码为独立实现。

## License

GNU AGPL-3.0-or-later。你可以自由使用、修改、再分发；修改后再分发（包括以网络服务形式提供）必须以相同协议开源。
