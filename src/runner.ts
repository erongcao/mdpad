import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { view, inTauri } from "./main";
import { extractFencedCode, findFenceByOccurrence } from "./ai";

interface RunnerInfo { lang: string; available: boolean; path: string }

interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  images: string[];
}

interface AiEvt { id: string; kind: string; text?: string }

const SUPPORTED = ["python", "python3", "r", "rscript", "julia"];

let runners: RunnerInfo[] | null = null;

const INSTALL_HINT: Record<string, string> = {
  python: "brew install python3",
  r: "从 r-project.org 安装 R",
  julia: "brew install julia 或 julialang.org 下载",
};

function langOf(code: Element): string | null {
  for (const cls of code.classList) {
    if (cls.startsWith("language-")) {
      const lang = cls.slice(9).toLowerCase();
      if (SUPPORTED.includes(lang)) return lang;
    }
  }
  return null;
}

function runnerFor(lang: string): RunnerInfo | null {
  if (!runners) return null;
  const key = lang === "python3" ? "python" : lang === "rscript" ? "r" : lang;
  return runners.find((r) => r.lang === key) ?? null;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 输出区（没有则建，挂在 pre 后面）
function outBox(pre: HTMLElement): HTMLElement {
  let out = pre.nextElementSibling as HTMLElement | null;
  if (!out || !out.classList.contains("code-output")) {
    out = document.createElement("div");
    out.className = "code-output";
    pre.after(out);
  }
  return out;
}

// 预览中第几个「语言+内容相同」的代码块（定位源码用）
function occurrenceOf(pre: HTMLElement, lang: string, text: string): number {
  const all = [...document.querySelectorAll("#preview pre")];
  let n = 0;
  for (const p of all) {
    const c = p.querySelector("code");
    if (!c) continue;
    if (langOf(c) === lang && (c.textContent ?? "") === text) {
      if (p === pre) return n;
      n++;
    }
  }
  return 0;
}

/* ---------------- 运行 / 检查 ---------------- */

async function runBlock(lang: string, code: string, pre: HTMLElement) {
  const runner = runnerFor(lang);
  const out = outBox(pre);
  if (runner && !runner.available) {
    out.textContent = "未检测到 " + lang + " 解释器。安装：" + (INSTALL_HINT[lang === "rscript" ? "r" : lang === "python3" ? "python" : lang] ?? "");
    return;
  }
  out.innerHTML = '<div class="code-output-status">运行中…</div>';
  try {
    const r = await invoke<RunResult>("run_code", { lang, code });
    renderResult(r, out, lang, code, pre);
  } catch (err) {
    out.innerHTML = '<div class="code-output-status err">' + escapeText(String(err)) + "</div>";
  }
}

async function checkBlock(lang: string, code: string, pre: HTMLElement) {
  const out = outBox(pre);
  out.innerHTML = '<div class="code-output-status">检查中…</div>';
  try {
    const r = await invoke<{ ok: boolean; message: string }>("run_check", { lang, code });
    out.innerHTML = '<div class="code-output-status' + (r.ok ? "" : " err") + '">' +
      (r.ok ? "✓ " : "✗ ") + escapeText(r.message) + "</div>";
  } catch (err) {
    out.innerHTML = '<div class="code-output-status err">' + escapeText(String(err)) + "</div>";
  }
}

function renderResult(r: RunResult, out: HTMLElement, lang: string, code: string, pre: HTMLElement) {
  const parts: string[] = [];
  if (r.stdout) parts.push('<pre class="code-stdout">' + escapeText(r.stdout) + "</pre>");
  if (r.stderr) parts.push('<pre class="code-stderr">' + escapeText(r.stderr) + "</pre>");
  for (const img of r.images) {
    parts.push('<img class="code-run-img" src="' + img + '" />');
  }
  const status = r.timed_out
    ? "超时终止"
    : r.exit_code === 0
      ? "完成 · " + (r.duration_ms / 1000).toFixed(1) + "s"
      : "退出码 " + r.exit_code + " · " + (r.duration_ms / 1000).toFixed(1) + "s";
  parts.push('<div class="code-output-status' + (r.exit_code === 0 && !r.timed_out ? "" : " err") + '">' + status + "</div>");
  if (r.exit_code !== 0) {
    parts.push('<button class="code-fix-btn">🔧 让 AI 修复这个错误</button>');
  }
  out.innerHTML = parts.join("");
  out.querySelector(".code-fix-btn")?.addEventListener("click", () => {
    aiFixInline(lang, code, r.stderr, pre);
  });
}

/* ---------------- 内联 AI（解释/修复，不开抽屉） ---------------- */

interface AiCfg { active: string; providers: Record<string, { base_url: string; model: string }> }

async function streamInline(
  id: string,
  system: string,
  user: string,
  onChunk: (acc: string) => void,
  onDone: (acc: string) => void,
  onError: (msg: string) => void,
) {
  let acc = "";
  const un = await listen<AiEvt>("ai-event", (e) => {
    const p = e.payload;
    if (p.id !== id) return;
    if (p.kind === "chunk" && p.text) { acc += p.text; onChunk(acc); }
    if (p.kind === "done") { un(); onDone(acc); }
  });
  const cfg = await invoke<AiCfg>("ai_get_config");
  const provider = cfg.providers[cfg.active];
  if (!provider?.base_url || !provider.model) {
    un();
    onError("请先在设置（⌘,）里配置 AI 服务商");
    return;
  }
  try {
    await invoke("ai_chat_stream", {
      id,
      provider: cfg.active,
      baseUrl: provider.base_url,
      model: provider.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
  } catch (err) {
    un();
    onError(String(err));
  }
}

function aiBox(pre: HTMLElement): HTMLElement {
  const out = outBox(pre);
  let box = out.querySelector(".code-ai-inline") as HTMLElement | null;
  if (!box) {
    box = document.createElement("div");
    box.className = "code-ai-inline";
    out.appendChild(box);
  }
  return box;
}

function aiExplainInline(lang: string, code: string, pre: HTMLElement) {
  const box = aiBox(pre);
  box.innerHTML = '<div class="code-output-status">AI 讲解中…</div>';
  void streamInline(
    "inline-" + Date.now(),
    "你是一位编程老师，用中文讲解代码，清楚简洁，面向非计算机专业的读者。直接输出讲解，不要客套。",
    "请讲解下面这段 " + lang + " 代码：\n\n```" + lang + "\n" + code + "\n```",
    (acc) => { box.innerHTML = '<div class="code-ai-text">' + escapeText(acc) + "</div>"; },
    (acc) => {
      box.innerHTML = '<div class="code-ai-text">' + escapeText(acc) + '</div><button class="code-inline-btn">关闭</button>';
      box.querySelector(".code-inline-btn")?.addEventListener("click", () => box.remove());
    },
    (msg) => { box.innerHTML = '<div class="code-output-status err">' + escapeText(msg) + "</div>"; },
  );
}

function aiFixInline(lang: string, code: string, stderr: string, pre: HTMLElement) {
  const box = aiBox(pre);
  const occ = occurrenceOf(pre, lang, code);
  box.innerHTML = '<div class="code-output-status">AI 修复中…</div>';
  void streamInline(
    "inline-" + Date.now(),
    "你是资深程序员。直接输出修正后的完整代码，放在一个代码块里，代码块之前最多一句话。",
    "下面这段 " + lang + " 代码运行报错。\n\n代码：\n```" + lang + "\n" + code + "\n```\n\n报错：\n```\n" + stderr + "\n```",
    (acc) => {
      const fixed = extractFencedCode(acc);
      box.innerHTML = fixed
        ? '<pre class="code-ai-text mono">' + escapeText(fixed) + "</pre>"
        : '<div class="code-ai-text">' + escapeText(acc) + "</div>";
    },
    (acc) => {
      const fixed = extractFencedCode(acc);
      if (!fixed) {
        box.innerHTML = '<div class="code-ai-text">' + escapeText(acc) + "</div>";
        return;
      }
      box.innerHTML = '<pre class="code-ai-text mono">' + escapeText(fixed) + '</pre>' +
        '<div class="code-inline-actions"><button class="code-inline-btn primary">替换代码块</button><button class="code-inline-btn">丢弃</button></div>';
      const btns = box.querySelectorAll(".code-inline-btn");
      btns[0]?.addEventListener("click", () => {
        const pos = findFenceByOccurrence(code, occ);
        if (!pos) {
          box.innerHTML = '<div class="code-output-status err">原文档里找不到对应代码块（可能被改过）</div>';
          return;
        }
        view.dispatch({ changes: { from: pos.from, to: pos.to, insert: fixed + "\n" } });
        view.focus();
        box.innerHTML = '<div class="code-output-status">已替换，可以点 ▶ 再跑一次</div>';
      });
      btns[1]?.addEventListener("click", () => box.remove());
    },
    (msg) => { box.innerHTML = '<div class="code-output-status err">' + escapeText(msg) + "</div>"; },
  );
}

/* ---------------- 按钮组与入口 ---------------- */

export function attachRunButtons(previewEl: HTMLElement) {
  previewEl.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const lang = langOf(code);
    if (!lang) return;
    if (pre.querySelector(".code-actions")) return;
    const text = code.textContent ?? "";
    const group = document.createElement("div");
    group.className = "code-actions";
    const mkBtn = (label: string, title: string, fn: () => void) => {
      const b = document.createElement("button");
      b.className = "code-action-btn";
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", (e) => { e.preventDefault(); fn(); });
      return b;
    };
    group.appendChild(mkBtn("▶ 运行", "在本地运行这段代码", () => void runBlock(lang, text, pre as HTMLElement)));
    group.appendChild(mkBtn("检查", "只检查语法，不执行", () => void checkBlock(lang, text, pre as HTMLElement)));
    group.appendChild(mkBtn("✨ 解释", "让 AI 讲解这段代码", () => aiExplainInline(lang, text, pre as HTMLElement)));
    (pre as HTMLElement).style.position = "relative";
    pre.appendChild(group);
  });
}

export function initRunner() {
  if (!inTauri) return;
  void invoke<RunnerInfo[]>("code_runners_check").then((r) => { runners = r; });
}

