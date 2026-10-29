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

type ActionKey = "expand" | "summarize" | "polish";

const ACTIONS: Record<ActionKey, { label: string; prompt: (t: string) => string }> = {
  expand: {
    label: "扩写",
    prompt: (t) =>
      `请扩写下面这段文字。要求：保持原有的观点、语气和文体不变，将内容扩充到原来的两到三倍，补充细节、例证与过渡，使其更充实丰满。直接输出扩写后的正文，不要加任何解释、说明或前后缀。\n\n原文：\n${t}`,
  },
  summarize: {
    label: "总结",
    prompt: (t) =>
      `请总结下面的内容，用三到五句话概括要点，语言精炼准确。直接输出总结本身，不要加任何解释、说明或前后缀。\n\n内容：\n${t}`,
  },
  polish: {
    label: "润色",
    prompt: (t) =>
      `请润色下面这段文字：修正错别字与语病，让表达更流畅、准确，保持原意与文体不变。直接输出润色后的正文，不要加任何解释、说明或前后缀。\n\n原文：\n${t}`,
  },
};

interface Preset {
  label: string;
  baseUrl: string;
  keyHint: string;
  models: string[];
  modelHint?: string;
}

const PRESETS: Record<string, Preset> = {
  ollama: {
    label: "Ollama（本地）",
    baseUrl: "http://localhost:11434/v1",
    keyHint: "本地服务可留空",
    models: [],
  },
  lmstudio: {
    label: "LM Studio（本地）",
    baseUrl: "http://localhost:1234/v1",
    keyHint: "本地服务可留空",
    models: [],
  },
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyHint: "platform.deepseek.com 申请",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  zhipu: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyHint: "open.bigmodel.cn 申请",
    models: ["glm-4.6", "glm-4.5", "glm-4-air", "glm-4-flash"],
  },
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    keyHint: "platform.minimaxi.com 申请",
    models: ["MiniMax-M2", "abab6.5s-chat"],
  },
  kimi: {
    label: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    keyHint: "platform.moonshot.cn 申请",
    models: ["kimi-k2-0711-preview", "moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
  },
  dashscope: {
    label: "通义千问（百炼）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyHint: "bailian.console.aliyun.com 申请",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
  },
  volcengine: {
    label: "豆包（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyHint: "console.volcengine.com 申请",
    models: [],
    modelHint: "模型一栏填接入点 ID（ep- 开头）",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyHint: "platform.openai.com 申请",
    models: ["gpt-4o", "gpt-4o-mini"],
  },
  custom: {
    label: "自定义 OpenAI 兼容端点",
    baseUrl: "",
    keyHint: "",
    models: [],
  },
};

interface CodeFixTarget {
  lang: string;
  codeText: string;
  occurrence: number;
}

interface Job {
  id: string;
  action: string;
  mode: "selection" | "code";
  from: number;
  to: number;
  result: string;
  reasoning: string;
  running: boolean;
  codeFix?: CodeFixTarget;
}

let job: Job | null = null;
let unlisten: (() => void) | null = null;
let settingsConfig: AiConfig | null = null;

function el<T extends HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

async function getConfig(): Promise<AiConfig> {
  const fallback: AiConfig = {
    active: "ollama",
    providers: {
      ollama: { base_url: PRESETS.ollama.baseUrl, api_key: "", model: "" },
    },
  };
  if (!inTauri) return fallback;
  try {
    return await invoke<AiConfig>("ai_get_config");
  } catch {
    return fallback;
  }
}

/* ---------------- 事件流 ---------------- */

async function ensureListener() {
  if (unlisten || !inTauri) return;
  unlisten = await listen<AiEvent>("ai-event", (e) => {
    const payload = e.payload;
    if (!job || payload.id !== job.id) return;
    if (payload.kind === "chunk" && payload.text) {
      job.result += payload.text;
      renderOutput();
    } else if (payload.kind === "reasoning" && payload.text) {
      job.reasoning += payload.text;
      renderOutput();
    } else if (payload.kind === "done") {
      job.running = false;
      el("#ai-stop").hidden = true;
      setStatus(payload.cancelled ? "已停止" : "完成");
    }
  });
}

function renderOutput() {
  if (!job) return;
  const out = el("#ai-output");
  const reasoningHtml = job.reasoning
    ? `<div class="ai-reasoning">${md.render(job.reasoning)}</div>`
    : "";
  out.innerHTML = reasoningHtml + md.render(job.result || "");
  out.scrollTop = out.scrollHeight;
}

/* ---------------- 抽屉 ---------------- */

function setStatus(text: string) {
  el("#ai-drawer-status").textContent = text;
}

function openDrawer(title: string) {
  el("#ai-drawer-title").textContent = title;
  el<HTMLElement>("#ai-drawer").hidden = false;
}

function closeDrawer() {
  if (job?.running) void invoke("ai_cancel", { id: job.id });
  job = null;
  el<HTMLElement>("#ai-drawer").hidden = true;
}

interface AiTaskOpts {
  title: string;
  user: string;
  system?: string;
  mode: "selection" | "code";
  from?: number;
  to?: number;
  codeFix?: CodeFixTarget;
}

export async function runAiTask(opts: AiTaskOpts) {
  if (!inTauri) {
    alert("AI 功能需要在桌面应用里运行。");
    return;
  }
  const config = await getConfig();
  const provider = config.providers[config.active];
  if (!provider || !provider.base_url || !provider.model) {
    openSettings();
    setSettingsStatus("先补全当前服务商的接口地址和模型");
    return;
  }
  const presetLabel = PRESETS[config.active]?.label ?? config.active;

  job = {
    id: `job-${Date.now()}`,
    action: opts.title,
    mode: opts.mode,
    from: opts.from ?? 0,
    to: opts.to ?? 0,
    result: "",
    reasoning: "",
    running: true,
    codeFix: opts.codeFix,
  };

  openDrawer(`${opts.title} · ${presetLabel} · ${provider.model}`);
  el("#ai-output").innerHTML = "";
  el("#ai-stop").hidden = false;
  // 按任务类型调整底部按钮
  const replaceBtn = el<HTMLButtonElement>("#ai-replace");
  const insertBtn = el<HTMLButtonElement>("#ai-insert-after");
  if (opts.mode === "code") {
    insertBtn.hidden = true;
    replaceBtn.hidden = !opts.codeFix;
    replaceBtn.textContent = "替换代码块";
  } else {
    insertBtn.hidden = false;
    replaceBtn.hidden = false;
    replaceBtn.textContent = "替换选区";
  }
  setStatus("连接中…");
  await ensureListener();

  try {
    await invoke("ai_chat_stream", {
      id: job.id,
      baseUrl: provider.base_url,
      provider: config.active,
      model: provider.model,
      messages: [
        { role: "system", content: opts.system ?? "你是一位严谨的中文写作助手。" },
        { role: "user", content: opts.user },
      ],
    });
  } catch (err) {
    if (job) job.running = false;
    el("#ai-stop").hidden = true;
    setStatus(`出错：${String(err)}`);
    void invoke("log_frontend", { msg: "runAiTask 出错: " + String(err) });
  }
}

async function startAction(action: ActionKey) {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  const text = view.state.doc.sliceString(sel.from, sel.to);
  hideBar();
  await runAiTask({
    title: ACTIONS[action].label,
    user: ACTIONS[action].prompt(text),
    mode: "selection",
    from: sel.from,
    to: sel.to,
  });
}

/* ---------------- 浮动条 ---------------- */

const bar = () => el<HTMLElement>("#ai-bar");
let barTimer: number | undefined;

function hideBar() {
  bar().hidden = true;
}

function maybeShowBar() {
  window.clearTimeout(barTimer);
  barTimer = window.setTimeout(() => {
    const sel = view.state.selection.main;
    if (sel.empty || !view.hasFocus) {
      hideBar();
      return;
    }
    const coords = view.coordsAtPos(sel.head);
    if (!coords) return hideBar();
    const b = bar();
    b.hidden = false;
    const left = Math.min(Math.max(8, coords.left), window.innerWidth - b.offsetWidth - 8);
    const top = Math.max(52, coords.top - 42);
    b.style.left = `${left}px`;
    b.style.top = `${top}px`;
  }, 160);
}

/* ---------------- 设置面板 ---------------- */

function currentPresetKey(): string {
  return el<HTMLSelectElement>("#ai-preset").value;
}

function setSettingsStatus(text: string) {
  el("#ai-settings-status").textContent = text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fillModelList(models: string[]) {
  el<HTMLDataListElement>("#ai-model-list").innerHTML = models
    .map((m) => `<option value="${escapeHtml(m)}"></option>`)
    .join("");
  const sel = el<HTMLSelectElement>("#ai-model-select");
  if (models.length) {
    const current = el<HTMLInputElement>("#ai-model").value;
    sel.innerHTML =
      `<option value="">选择模型…</option>` +
      models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    sel.hidden = false;
    if (models.includes(current)) sel.value = current;
  } else {
    sel.hidden = true;
    sel.innerHTML = "";
  }
}

function loadProviderFields(key: string) {
  const preset = PRESETS[key];
  const saved = settingsConfig?.providers[key];
  el<HTMLInputElement>("#ai-base-url").value = saved?.base_url || preset?.baseUrl || "";
  el<HTMLInputElement>("#ai-api-key").value = ""; // 永不回显，只写不读
  if (inTauri) {
    void invoke<boolean>("ai_has_api_key", { provider: key }).then((has) => {
      el("#ai-key-hint").textContent = has
        ? "已保存在 macOS 钥匙串，输入新值可更换"
        : preset?.keyHint ?? "";
      el<HTMLElement>("#ai-key-clear").hidden = !has;
    });
  }
  el<HTMLInputElement>("#ai-model").value = saved?.model || preset?.models[0] || "";
  el("#ai-key-hint").textContent = preset?.keyHint ?? "";
  el("#ai-model-hint").textContent = saved?.model ? "" : preset?.modelHint ?? "";
  fillModelList(preset?.models ?? []);
  const isActive = settingsConfig?.active === key;
  el("#ai-active-hint").textContent = isActive ? "当前使用" : "";
}

export function openSettings() {
  void (async () => {
    el<HTMLElement>("#ai-settings-overlay").hidden = false;
    setSettingsStatus("");
    settingsConfig = await getConfig();
    const key = PRESETS[settingsConfig.active] ? settingsConfig.active : "ollama";
    el<HTMLSelectElement>("#ai-preset").value = key;
    loadProviderFields(key);
  })();
}

function closeSettings() {
  el<HTMLElement>("#ai-settings-overlay").hidden = true;
}

async function fetchModels() {
  const baseUrl = el<HTMLInputElement>("#ai-base-url").value.trim();
  if (!baseUrl) {
    setSettingsStatus("先填接口地址");
    return;
  }
  const keyInField = el<HTMLInputElement>("#ai-api-key").value;
  setSettingsStatus("拉取中…");
  try {
    // 输入框里有新 key：先写进钥匙串，保证「拉取」用的就是眼前这串
    if (keyInField) {
      await invoke("ai_set_api_key", { provider: currentPresetKey(), key: keyInField });
      el<HTMLElement>("#ai-key-clear").hidden = false;
      el("#ai-key-hint").textContent = "已保存在 macOS 钥匙串，输入新值可更换";
    }
    const models = await invoke<string[]>("ai_list_models", { baseUrl, provider: currentPresetKey() });
    fillModelList(models);
    setSettingsStatus(models.length ? `找到 ${models.length} 个模型` : "列表为空，请手填模型名");
  } catch (err) {
    const msg = String(err);
    if (inTauri) void invoke("log_frontend", { msg: "fetchModels 出错: " + msg });
    if (msg.includes("401")) {
      setSettingsStatus("401 未授权：请确认 API Key 已填入上方输入框，且与所选服务商匹配");
    } else {
      setSettingsStatus(`${msg}（可手填模型名）`);
    }
  }
}

async function saveSettings() {
  if (!settingsConfig) settingsConfig = await getConfig();
  const key = currentPresetKey();
  settingsConfig.providers[key] = {
    base_url: el<HTMLInputElement>("#ai-base-url").value.trim(),
    api_key: "",
    model: el<HTMLInputElement>("#ai-model").value.trim(),
  };
  settingsConfig.active = key;
  const newKey = el<HTMLInputElement>("#ai-api-key").value;
  try {
    await invoke("ai_set_config", { config: settingsConfig });
    if (newKey) await invoke("ai_set_api_key", { provider: key, key: newKey });
    closeSettings();
  } catch (err) {
    setSettingsStatus(String(err));
  }
}

/* ---------------- 入口 ---------------- */

export function initAi() {
  document.querySelectorAll<HTMLButtonElement>("#ai-bar button").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // 别让编辑器失焦、选区塌掉
      void startAction(btn.dataset.action as ActionKey);
    });
  });

  view.dom.addEventListener("mouseup", maybeShowBar);
  view.dom.addEventListener("keyup", maybeShowBar);
  view.dom.addEventListener("blur", () => window.setTimeout(hideBar, 200));
  window.addEventListener("mousedown", (e) => {
    if (!bar().hidden && !bar().contains(e.target as Node) && !view.dom.contains(e.target as Node)) {
      hideBar();
    }
  });
  window.addEventListener("resize", hideBar);

  el("#ai-close").addEventListener("click", closeDrawer);
  el("#ai-stop").addEventListener("click", () => {
    if (job) void invoke("ai_cancel", { id: job.id });
  });
  el("#ai-copy").addEventListener("click", () => {
    if (job?.result) void navigator.clipboard.writeText(job.result);
  });
  el("#ai-replace").addEventListener("click", () => {
    if (!job?.result) return;
    if (job.mode === "code") {
      if (replaceCodeBlock(job)) closeDrawer();
      return;
    }
    view.dispatch({ changes: { from: job.from, to: job.to, insert: job.result } });
    view.focus();
    closeDrawer();
  });
  el("#ai-insert-after").addEventListener("click", () => {
    if (!job?.result) return;
    view.dispatch({ changes: { from: job.to, insert: `\n\n${job.result}` } });
    view.focus();
    closeDrawer();
  });

  el("#btn-ai-settings").addEventListener("click", openSettings);
  el("#ai-settings-cancel").addEventListener("click", closeSettings);
  el("#ai-settings-save").addEventListener("click", () => void saveSettings());
  el("#ai-fetch-models").addEventListener("click", () => void fetchModels());
  el("#ai-view-log").addEventListener("click", () => { if (inTauri) void invoke("open_log"); });
  el<HTMLElement>("#ai-settings-overlay").addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });
  el<HTMLSelectElement>("#ai-preset").addEventListener("change", () => {
    loadProviderFields(currentPresetKey());
    setSettingsStatus("");
  });
  el("#ai-key-toggle").addEventListener("click", () => {
    const input = el<HTMLInputElement>("#ai-api-key");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    el("#ai-key-toggle").textContent = showing ? "显示" : "隐藏";
  });
  el("#ai-key-clear").addEventListener("click", () => {
    const key = currentPresetKey();
    void invoke("ai_delete_api_key", { provider: key }).then(() => {
      el<HTMLInputElement>("#ai-api-key").value = "";
      el<HTMLElement>("#ai-key-clear").hidden = true;
      el("#ai-key-hint").textContent = PRESETS[key]?.keyHint ?? "";
    });
  });
  el<HTMLSelectElement>("#ai-model-select").addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) el<HTMLInputElement>("#ai-model").value = v;
  });
}

/* ---------------- 代码块替换（AI 修复用） ---------------- */

export function extractFencedCode(text: string): string | null {
  const m = text.match(/```[\w+-]*\n([\s\S]*?)```/);
  return m ? m[1].replace(/\n$/, "") : null;
}

export function findFenceByOccurrence(codeText: string, occurrence: number): { from: number; to: number } | null {
  const doc = view.state.doc;
  const wanted = codeText.trim();
  let count = 0;
  let i = 1;
  while (i <= doc.lines) {
    const line = doc.line(i);
    if (line.text.trim().startsWith("```")) {
      let j = i + 1;
      while (j <= doc.lines && !doc.line(j).text.trim().startsWith("```")) j++;
      if (j > doc.lines) break;
      const from = doc.line(i + 1).from;
      const to = doc.line(j).from;
      const inner = view.state.sliceDoc(from, to).trim();
      if (inner === wanted) {
        if (count === occurrence) return { from, to };
        count++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return null;
}

function replaceCodeBlock(j: Job): boolean {
  const fix = j.codeFix;
  if (!fix) return false;
  const code = extractFencedCode(j.result);
  if (!code) {
    setStatus("AI 的回答里没有代码块，无法替换");
    return false;
  }
  const pos = findFenceByOccurrence(fix.codeText, fix.occurrence);
  if (!pos) {
    setStatus("原文档里找不到对应的代码块（可能被改过）");
    return false;
  }
  view.dispatch({ changes: { from: pos.from, to: pos.to, insert: code + "\n" } });
  view.focus();
  return true;
}
