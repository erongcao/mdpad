import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import MarkdownIt from "markdown-it";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { initAi } from "./ai";
import { initMenu } from "./menu";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

const WELCOME = `# 欢迎使用 mdpad

这是一个用 **Tauri 2 + CodeMirror 6** 写的 macOS Markdown 编辑器。
整个 App 大约 10 MB，内存占用不到 Electron 方案的三分之一。

## 快捷键

- \`⌘O\` 打开文件
- \`⌘S\` 保存，\`⇧⌘S\` 另存为
- \`⌘F\` 查找
- 也可以直接把 \`.md\` 文件拖进窗口

## 它支持什么

| 能力 | 状态 |
| --- | --- |
| 实时预览 | ✅ |
| 语法高亮 | ✅ |
| 大文件（10 MB）流畅编辑 | ✅ |
| 多光标 / 代码折叠 | ✅ CodeMirror 原生 |

> 编辑区是 CodeMirror 6，增量解析，打字不会有延迟。

\`\`\`ts
const stack = "Tauri 2 + Rust + TypeScript";
console.log(\`built with \${stack}\`);
\`\`\`

- [x] 打开 / 保存
- [x] 三栏模式切换
- [ ] 导出 PDF
`;

/* ---------------- 主题 ---------------- */

const lightHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.55em", fontWeight: "700", color: "#1c1c1e" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700", color: "#1c1c1e" },
  { tag: tags.heading3, fontSize: "1.14em", fontWeight: "650", color: "#1c1c1e" },
  { tag: tags.heading4, fontSize: "1.04em", fontWeight: "650", color: "#1c1c1e" },
  { tag: tags.strong, fontWeight: "700", color: "#1c1c1e" },
  { tag: tags.emphasis, fontStyle: "italic", color: "#4b4740" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "#9a948a" },
  { tag: tags.link, color: "#0a6fd1" },
  { tag: tags.url, color: "#0a6fd1", textDecoration: "underline" },
  { tag: tags.monospace, color: "#b3410f", background: "rgba(0,0,0,0.05)" },
  { tag: tags.quote, color: "#8a8479", fontStyle: "italic" },
  { tag: tags.list, color: "#0a84ff" },
  { tag: tags.meta, color: "#a9a296" },
  { tag: tags.processingInstruction, color: "#a9a296" },
  { tag: tags.contentSeparator, color: "#a9a296" },
]);

const darkHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.55em", fontWeight: "700", color: "#f2f0eb" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700", color: "#f2f0eb" },
  { tag: tags.heading3, fontSize: "1.14em", fontWeight: "650", color: "#f2f0eb" },
  { tag: tags.heading4, fontSize: "1.04em", fontWeight: "650", color: "#f2f0eb" },
  { tag: tags.strong, fontWeight: "700", color: "#f2f0eb" },
  { tag: tags.emphasis, fontStyle: "italic", color: "#d6d2ca" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: "#7d7a73" },
  { tag: tags.link, color: "#70b6ff" },
  { tag: tags.url, color: "#70b6ff", textDecoration: "underline" },
  { tag: tags.monospace, color: "#f0a06a", background: "rgba(255,255,255,0.07)" },
  { tag: tags.quote, color: "#9d9890", fontStyle: "italic" },
  { tag: tags.list, color: "#4aa3ff" },
  { tag: tags.meta, color: "#6f6b64" },
  { tag: tags.processingInstruction, color: "#6f6b64" },
  { tag: tags.contentSeparator, color: "#6f6b64" },
]);

const highlightCompartment = new Compartment();
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/* ---------------- 状态 ---------------- */

export const inTauri = "__TAURI_INTERNALS__" in window;
const win = inTauri ? getCurrentWindow() : null;
let currentPath: string | null = null;
let dirty = false;
let mode: "editor" | "split" | "preview" = "split";
let previewTimer: number | undefined;

const editorHost = document.querySelector<HTMLElement>("#editor")!;
const previewEl = document.querySelector<HTMLElement>("#preview")!;
const workspace = document.querySelector<HTMLElement>("#workspace")!;
const metaEl = document.querySelector<HTMLElement>("#meta")!;

export const view = new EditorView({
  parent: editorHost,
  state: EditorState.create({
    doc: WELCOME,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      rectangularSelection(),
      crosshairCursor(),
      EditorView.lineWrapping,
      EditorState.allowMultipleSelections.of(true),
      placeholder("开始写点什么…"),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown(),
      highlightCompartment.of(syntaxHighlighting(darkQuery.matches ? darkHighlight : lightHighlight)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          dirty = true;
          updateTitle();
          schedulePreview();
        }
        if (u.docChanged || u.selectionSet) updateMeta();
      }),
    ],
  }),
});

/* ---------------- 渲染 ---------------- */

export function renderPreview() {
  previewEl.innerHTML = md.render(view.state.doc.toString());
}

function schedulePreview() {
  if (mode === "editor") return;
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(renderPreview, 120);
}

function updateMeta() {
  const text = view.state.doc.toString();
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const latin = text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const chars = text.length;
  const minutes = Math.max(1, Math.round((cjk + latin * 1.6) / 350));
  metaEl.textContent = `${chars.toLocaleString()} 字符 · ${(cjk + latin).toLocaleString()} 字 · 约 ${minutes} 分钟`;
}

function fileName(p: string | null) {
  if (!p) return "未命名";
  return p.split("/").pop() || p;
}

function updateTitle() {
  const name = fileName(currentPath);
  const title = `${dirty ? "• " : ""}${name} — mdpad`;
  if (win) win.setTitle(title).catch(() => {});
  else document.title = title;
}

export function setMode(next: typeof mode) {
  mode = next;
  workspace.dataset.mode = next;
  document.querySelectorAll<HTMLButtonElement>("#view-modes button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === next);
  });
  if (next !== "editor") renderPreview();
  view.requestMeasure();
}

/* ---------------- 文件操作 ---------------- */

function setDoc(text: string, path: string | null) {
  currentPath = path;
  dirty = false;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 },
    scrollIntoView: true,
  });
  dirty = false;
  updateTitle();
  renderPreview();
  updateMeta();
}

export async function openPath(path: string) {
  if (dirty && !confirm("当前文档还没保存，继续打开会丢失修改。继续？")) return;
  try {
    const text = await invoke<string>("read_text_file", { path });
    setDoc(text, path);
    void invoke("add_recent_file", { path });
  } catch (err) {
    alert(String(err));
  }
}

export async function openFile() {
  if (!inTauri) return alert("文件操作需要在桌面应用里运行。");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "txt"] }],
  });
  if (typeof picked !== "string") return;
  await openPath(picked);
}

export function newFile() {
  if (dirty && !confirm("当前文档还没保存，新建会丢失修改。继续？")) return;
  setDoc("", null);
}

export async function saveAs(): Promise<boolean> {
  if (!inTauri) {
    alert("文件操作需要在桌面应用里运行。");
    return false;
  }
  const picked = await save({
    defaultPath: currentPath ?? "未命名.md",
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  if (!picked) return false;
  currentPath = picked;
  return writeCurrent();
}

export async function writeCurrent(): Promise<boolean> {
  if (!currentPath) return saveAs();
  try {
    await invoke("write_text_file", {
      path: currentPath,
      contents: view.state.doc.toString(),
    });
    dirty = false;
    updateTitle();
    void invoke("add_recent_file", { path: currentPath });
    return true;
  } catch (err) {
    alert(String(err));
    return false;
  }
}

/* ---------------- 事件 ---------------- */

document.querySelectorAll<HTMLButtonElement>("#view-modes button").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode as typeof mode));
});

if (win) {
  win.onCloseRequested(async (event) => {
    if (dirty && !confirm("还有未保存的修改，确定关闭？")) {
      event.preventDefault();
    }
  });
}

if (inTauri) {
  void getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type !== "drop") return;
    const path = event.payload.paths.find((p) => /\.(md|markdown|mdown|txt)$/i.test(p));
    if (!path) return;
    if (dirty && !confirm("当前文档还没保存，继续会丢失修改。继续？")) return;
    try {
      const text = await invoke<string>("read_text_file", { path });
      setDoc(text, path);
    } catch (err) {
      alert(String(err));
    }
  });
}

darkQuery.addEventListener("change", (e) => {
  view.dispatch({
    effects: highlightCompartment.reconfigure(
      syntaxHighlighting(e.matches ? darkHighlight : lightHighlight),
    ),
  });
});

// 分隔条拖动
const divider = document.querySelector<HTMLElement>("#divider")!;
const previewPane = document.querySelector<HTMLElement>(".preview-pane")!;
let dragging = false;

divider.addEventListener("mousedown", (e) => {
  dragging = true;
  e.preventDefault();
  document.body.style.cursor = "col-resize";
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const total = workspace.clientWidth;
  const ratio = Math.min(0.85, Math.max(0.15, e.clientX / total));
  previewPane.style.flex = `1 1 ${(1 - ratio) * 100}%`;
  view.requestMeasure();
});

window.addEventListener("mouseup", () => {
  dragging = false;
  document.body.style.cursor = "";
});

export function getCurrentPath(): string | null {
  return currentPath;
}

/* ---------------- 启动 ---------------- */

setMode("split");
updateMeta();
updateTitle();
initAi();
initMenu();
