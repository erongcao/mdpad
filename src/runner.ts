import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./main";
import { runAiTask } from "./ai";

interface RunnerInfo {
  lang: string;
  available: boolean;
  path: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out: boolean;
  images: string[];
}

const SUPPORTED = ["python", "python3", "r", "rscript", "julia"];

let runners: RunnerInfo[] | null = null;

const INSTALL_HINT: Record<string, string> = {
  python: "brew install python3",
  r: "从 r-project.org 安装 R",
  julia: "brew install --cask julia 或 julialang.org 下载",
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

async function runBlock(lang: string, code: string, pre: HTMLElement) {
  const runner = runnerFor(lang);
  let out = pre.nextElementSibling as HTMLElement | null;
  if (!out || !out.classList.contains("code-output")) {
    out = document.createElement("div");
    out.className = "code-output";
    pre.after(out);
  }
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

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  const fixBtn = out.querySelector(".code-fix-btn");
  if (fixBtn) {
    fixBtn.addEventListener("click", () => {
      void runAiTask({
        title: "修复代码",
        mode: "code",
        system: "你是一位资深程序员。用户会给你一段出错的代码和报错信息。请直接输出修正后的完整代码，放在一个代码块里，代码块之前最多一句话说明改了什么。",
        user: "下面这段 " + lang + " 代码运行报错了。\n\n代码：\n```" + lang + "\n" + code + "\n```\n\n报错：\n```\n" + r.stderr + "\n```",
        codeFix: { lang, codeText: code, occurrence: occurrenceOf(pre, lang, code) },
      });
    });
  }
}

// 预览中第几个「语言+内容相同」的代码块（AI 修复时定位源码用）
function occurrenceOf(pre: HTMLElement, lang: string, text: string): number {
  const all = [...document.querySelectorAll("#preview pre")];
  let n = 0;
  for (const p of all) {
    const c = p.querySelector("code");
    if (!c) continue;
    const l = langOf(c);
    if (l === lang && (c.textContent ?? "") === text) {
      if (p === pre) return n;
      n++;
    }
  }
  return 0;
}

async function checkBlock(lang: string, code: string, pre: HTMLElement) {
  let out = pre.nextElementSibling as HTMLElement | null;
  if (!out || !out.classList.contains("code-output")) {
    out = document.createElement("div");
    out.className = "code-output";
    pre.after(out);
  }
  out.innerHTML = '<div class="code-output-status">检查中…</div>';
  try {
    const r = await invoke<{ ok: boolean; message: string }>("run_check", { lang, code });
    out.innerHTML = '<div class="code-output-status' + (r.ok ? "" : " err") + '">' +
      (r.ok ? "✓ " : "✗ ") + escapeText(r.message) + "</div>";
  } catch (err) {
    out.innerHTML = '<div class="code-output-status err">' + escapeText(String(err)) + "</div>";
  }
}

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
    group.appendChild(mkBtn("✨ 解释", "让 AI 讲解这段代码", () =>
      void runAiTask({
        title: "解释代码",
        mode: "code",
        system: "你是一位编程老师，用中文讲解代码，清楚简洁，面向非计算机专业的读者。",
        user: "请讲解下面这段 " + lang + " 代码在做什么、怎么做的。\n\n```" + lang + "\n" + text + "\n```",
      })));
    (pre as HTMLElement).style.position = "relative";
    pre.appendChild(group);
  });
}

export function initRunner() {
  if (!inTauri) return;
  void invoke<RunnerInfo[]>("code_runners_check").then((r) => { runners = r; });
}
