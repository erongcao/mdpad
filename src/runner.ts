import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./main";

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
    renderResult(r, out);
  } catch (err) {
    out.innerHTML = '<div class="code-output-status err">' + escapeText(String(err)) + "</div>";
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderResult(r: RunResult, out: HTMLElement) {
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
  out.innerHTML = parts.join("");
}

export function attachRunButtons(previewEl: HTMLElement) {
  previewEl.querySelectorAll("pre").forEach((pre) => {
    const code = pre.querySelector("code");
    if (!code) return;
    const lang = langOf(code);
    if (!lang) return;
    if (pre.querySelector(".code-run-btn")) return;
    const btn = document.createElement("button");
    btn.className = "code-run-btn";
    btn.textContent = "▶ 运行";
    btn.title = "在本地运行这段代码";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      void runBlock(lang, code.textContent ?? "", pre as HTMLElement);
    });
    (pre as HTMLElement).style.position = "relative";
    pre.appendChild(btn);
  });
}

export function initRunner() {
  if (!inTauri) return;
  void invoke<RunnerInfo[]>("code_runners_check").then((r) => { runners = r; });
}
