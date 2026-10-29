import { EditorSelection, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { view, inTauri } from "./main";

/* ---------------- 幽灵文本状态 ---------------- */

interface Ghost { pos: number; text: string }

const setGhost = StateEffect.define<Ghost | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.textContent = this.text.split("\n")[0];
    return span;
  }
}

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (v): DecorationSet => {
      if (!v) return Decoration.none;
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(v.text), side: 1 }).range(v.pos),
      ]);
    }),
});

function clearGhost() {
  if (view.state.field(ghostField)) {
    view.dispatch({ effects: setGhost.of(null) });
  }
}

const ghostKeymap = Prec.highest(
  keymap.of([
    {
      key: "Tab",
      run: () => {
        const g = view.state.field(ghostField);
        if (!g) return false;
        view.dispatch({
          changes: { from: g.pos, insert: g.text },
          selection: EditorSelection.cursor(g.pos + g.text.length),
          effects: setGhost.of(null),
        });
        return true;
      },
    },
    {
      key: "Escape",
      run: () => {
        if (!view.state.field(ghostField)) return false;
        clearGhost();
        return true;
      },
    },
  ]),
);

/* ---------------- 代码围栏上下文 ---------------- */

function fenceContext(pos: number): { lang: string; code: string } | null {
  const doc = view.state.doc;
  const ln = doc.lineAt(pos).number;
  let fenceStart = -1;
  let lang = "";
  for (let n = ln; n >= 1; n--) {
    const t = doc.line(n).text.trim();
    if (t.startsWith("```")) {
      const m = t.match(/^```(\w*)/);
      if (m && n < ln) { fenceStart = n; lang = m[1]; }
      break;
    }
  }
  if (fenceStart < 1 || !lang) return null;
  for (let n = fenceStart + 1; n < ln; n++) {
    if (doc.line(n).text.trim().startsWith("```")) return null; // 已闭合，不在代码里
  }
  const code = view.state.sliceDoc(doc.line(fenceStart + 1).from, pos);
  if (code.trim().length < 8) return null;
  return { lang, code: code.slice(-2500) };
}

/* ---------------- 补全请求 ---------------- */

let enabled = window.localStorage.getItem("mdpad-completion") !== "0";
let timer: number | undefined;
let activeId: string | null = null;
let acc = "";
let unlisten: (() => void) | null = null;

interface AiConfig { active: string; providers: Record<string, { base_url: string; model: string }> }

async function ensureListener() {
  if (unlisten || !inTauri) return;
  unlisten = await listen<{ id: string; kind: string; text?: string }>("ai-event", (e) => {
    const p = e.payload;
    if (!activeId || p.id !== activeId) return;
    if (p.kind === "chunk" && p.text) {
      acc += p.text;
      // 流式更新幽灵文本（去掉可能的代码块标记）
      const cleaned = acc.replace(/^```\w*\n?/, "").trimEnd();
      if (cleaned) view.dispatch({ effects: setGhost.of({ pos: view.state.selection.main.head, text: cleaned }) });
    } else if (p.kind === "done") {
      activeId = null;
    }
  });
}

async function requestCompletion() {
  if (!inTauri) return;
  const sel = view.state.selection.main;
  if (!sel.empty) return;
  const ctx = fenceContext(sel.head);
  if (!ctx) return;
  const cfg = await invoke<AiConfig>("ai_get_config");
  const provider = cfg.providers[cfg.active];
  if (!provider?.base_url || !provider.model) return;

  if (activeId) void invoke("ai_cancel", { id: activeId });
  activeId = "comp-" + Date.now();
  acc = "";
  await ensureListener();
  try {
    await invoke("ai_chat_stream", {
      id: activeId,
      provider: cfg.active,
      baseUrl: provider.base_url,
      model: provider.model,
      messages: [
        { role: "system", content: "你是代码补全引擎。只输出续写的代码本身，不要解释、不要代码块标记、不要重复已有内容。续写控制在三行以内。" },
        { role: "user", content: "语言：" + ctx.lang + "\n补全以下代码（光标在末尾）：\n" + ctx.code },
      ],
    });
  } catch {
    activeId = null;
  }
}

/* ---------------- 触发与开关 ---------------- */

const completionListener = EditorView.updateListener.of((u) => {
  if (!enabled || !u.docChanged) return;
  clearGhost();
  if (activeId) { void invoke("ai_cancel", { id: activeId }); activeId = null; }
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void requestCompletion(), 900);
});

export const completionExtension = [ghostField, ghostKeymap, completionListener];

export function toggleCompletion() {
  enabled = !enabled;
  window.localStorage.setItem("mdpad-completion", enabled ? "1" : "0");
  if (!enabled) {
    clearGhost();
    if (activeId) { void invoke("ai_cancel", { id: activeId }); activeId = null; }
  }
  view.focus();
}
