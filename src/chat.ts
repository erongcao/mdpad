import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import MarkdownIt from "markdown-it";
import { view, inTauri } from "./main";

const md = new MarkdownIt({ html: false, linkify: true });

interface ProviderConfig {
  base_url: string;
  api_key: string;
  model: string;
}

interface AiConfig {
  active: string;
  providers: Record<string, ProviderConfig>;
}

interface AiEvent {
  id: string;
  kind: "chunk" | "reasoning" | "done";
  text?: string;
  cancelled?: boolean;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string; // 发给 API 的完整内容（含上下文）
  display?: string; // 界面展示的文本（用户消息不含上下文）
  reasoning?: string;
}

let messages: ChatMsg[] = [];
let streaming = false;
let streamId = "";
let unlisten: (() => void) | null = null;
let ctxSel = true;
let ctxDoc = false;

function el<T extends HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

const panel = () => el<HTMLElement>("#chat-panel");

export function toggleChat(force?: boolean) {
  const show = force ?? panel().hidden;
  panel().hidden = !show;
  el<HTMLElement>("#chat-divider").hidden = !show;
  if (show) {
    updateTitle();
    el<HTMLTextAreaElement>("#chat-input").focus();
  }
}

async function updateTitle() {
  if (!inTauri) return;
  try {
    const cfg = await invoke<AiConfig>("ai_get_config");
    const p = cfg.providers[cfg.active];
    el("#chat-title").textContent = "AI 对话 · " + (p?.model || "未配置");
  } catch {
    el("#chat-title").textContent = "AI 对话";
  }
}

/* ---------------- 渲染 ---------------- */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderAll() {
  const box = el("#chat-messages");
  if (!messages.length) {
    box.innerHTML = '<div class="chat-empty">选中文字后可以直接问，比如「这段写得通顺吗」</div>';
    return;
  }
  box.innerHTML = messages
    .map((m, i) => {
      if (m.role === "user") {
        return '<div class="chat-msg user"><div class="bubble">' + escapeHtml(m.display ?? m.content) + "</div></div>";
      }
      const reasoning = m.reasoning
        ? '<div class="chat-reasoning">' + md.render(m.reasoning) + "</div>"
        : "";
      const body = m.content ? md.render(m.content) : '<span class="chat-typing">思考中…</span>';
      const actions =
        m.content && !streaming
          ? '<div class="chat-msg-actions"><button data-insert="' + i + '">插入到光标处</button><button data-copy="' + i + '">复制</button></div>'
          : "";
      return '<div class="chat-msg assistant"><div class="bubble markdown-body">' + reasoning + body + "</div>" + actions + "</div>";
    })
    .join("");
  box.scrollTop = box.scrollHeight;
}

/* ---------------- 事件流 ---------------- */

async function ensureListener() {
  if (unlisten || !inTauri) return;
  unlisten = await listen<AiEvent>("ai-event", (e) => {
    const p = e.payload;
    if (!streaming || p.id !== streamId) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    if (p.kind === "chunk" && p.text) {
      last.content += p.text;
      renderAll();
    } else if (p.kind === "reasoning" && p.text) {
      last.reasoning = (last.reasoning ?? "") + p.text;
      renderAll();
    } else if (p.kind === "done") {
      streaming = false;
      el("#chat-stop").hidden = true;
      el<HTMLButtonElement>("#chat-send").disabled = false;
      renderAll();
    }
  });
}

/* ---------------- 发送 ---------------- */

async function send() {
  if (!inTauri) {
    alert("AI 功能需要在桌面应用里运行。");
    return;
  }
  const input = el<HTMLTextAreaElement>("#chat-input");
  const text = input.value.trim();
  if (!text || streaming) return;

  let apiContent = text;
  const sel = view.state.selection.main;
  if (ctxDoc) {
    const doc = view.state.doc.toString();
    const capped = doc.length > 20000 ? doc.slice(0, 20000) + "\n…（文档过长已截断）" : doc;
    apiContent = "<文档全文>\n" + capped + "\n</文档全文>\n\n" + text;
  } else if (ctxSel && !sel.empty) {
    apiContent = "<选中文本>\n" + view.state.doc.sliceString(sel.from, sel.to) + "\n</选中文本>\n\n" + text;
  }

  const cfg = await invoke<AiConfig>("ai_get_config");
  const provider = cfg.providers[cfg.active];
  if (!provider || !provider.base_url || !provider.model) {
    alert("请先在设置（⌘,）里配置 AI 服务商。");
    return;
  }

  input.value = "";
  messages.push({ role: "user", content: apiContent, display: text });
  messages.push({ role: "assistant", content: "" });
  streaming = true;
  streamId = "chat-" + Date.now();
  el("#chat-stop").hidden = false;
  el<HTMLButtonElement>("#chat-send").disabled = true;
  renderAll();
  await ensureListener();

  const apiMessages = [
    {
      role: "system",
      content: "你是一位中文写作助手，正在协助用户修改一篇 Markdown 文档。回答简洁直接，需要输出文稿时使用 Markdown。",
    },
    ...messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    await invoke("ai_chat_stream", {
      id: streamId,
      provider: cfg.active,
      baseUrl: provider.base_url,
      model: provider.model,
      messages: apiMessages,
    });
  } catch (err) {
    streaming = false;
    el("#chat-stop").hidden = true;
    el<HTMLButtonElement>("#chat-send").disabled = false;
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant" && !last.content) {
      last.content = "出错：" + String(err);
    }
    renderAll();
  }
}

/* ---------------- 入口 ---------------- */

export function initChat() {
  el("#chat-close").addEventListener("click", () => toggleChat(false));
  el("#chat-clear").addEventListener("click", () => {
    if (streaming) void invoke("ai_cancel", { id: streamId });
    messages = [];
    streaming = false;
    renderAll();
  });
  el("#chat-send").addEventListener("click", () => void send());
  el("#chat-stop").addEventListener("click", () => void invoke("ai_cancel", { id: streamId }));

  el<HTMLTextAreaElement>("#chat-input").addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  });

  const selChip = el("#ctx-sel");
  const docChip = el("#ctx-doc");
  selChip.addEventListener("click", () => {
    ctxSel = !ctxSel;
    if (ctxSel) { ctxDoc = false; docChip.classList.remove("active"); }
    selChip.classList.toggle("active", ctxSel);
  });
  docChip.addEventListener("click", () => {
    ctxDoc = !ctxDoc;
    if (ctxDoc) { ctxSel = false; selChip.classList.remove("active"); }
    docChip.classList.toggle("active", ctxDoc);
  });

  // 消息气泡上的插入/复制按钮（事件代理）
  el("#chat-messages").addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    const insertIdx = btn.getAttribute("data-insert");
    const copyIdx = btn.getAttribute("data-copy");
    if (insertIdx !== null) {
      const m = messages[Number(insertIdx)];
      if (m?.content) {
        const pos = view.state.selection.main.head;
        view.dispatch({ changes: { from: pos, insert: "\n\n" + m.content } });
        view.focus();
      }
    } else if (copyIdx !== null) {
      const m = messages[Number(copyIdx)];
      if (m?.content) void navigator.clipboard.writeText(m.content);
    }
  });

  renderAll();
}
