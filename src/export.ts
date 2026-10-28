import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { view, inTauri, getCurrentPath, renderPreview } from "./main";

interface PandocStatus {
  available: boolean;
  version: string;
  path: string;
}

function el<T extends HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

function docBaseName(): string {
  const p = getCurrentPath();
  const name = p ? p.split("/").pop() || "" : "";
  return name.replace(/\.(md|markdown|mdown|txt)$/i, "") || "未命名";
}

function docDir(): string | null {
  const p = getCurrentPath();
  if (!p || !p.includes("/")) return null;
  return p.slice(0, p.lastIndexOf("/"));
}

function showStatus(text: string, ms = 4000) {
  const meta = el("#meta");
  const old = meta.textContent;
  meta.textContent = text;
  window.setTimeout(() => {
    if (meta.textContent === text) meta.textContent = old;
  }, ms);
}

async function checkPandoc(): Promise<boolean> {
  try {
    const status = await invoke<PandocStatus>("pandoc_check");
    if (!status.available) {
      alert("未检测到 pandoc。\n\n请先安装：brew install pandoc\n装好后重启 mdpad 即可。");
      return false;
    }
    return true;
  } catch (err) {
    alert(String(err));
    return false;
  }
}

export async function doExport(format: "docx" | "html") {
  if (!inTauri) {
    alert("导出功能需要在桌面应用里运行。");
    return;
  }
  if (!(await checkPandoc())) return;

  const picked = await save({
    defaultPath: docBaseName() + "." + format,
    filters: [
      format === "docx"
        ? { name: "Word 文档", extensions: ["docx"] }
        : { name: "HTML 文档", extensions: ["html"] },
    ],
  });
  if (!picked) return;

  showStatus("导出中…", 60000);
  try {
    const path = await invoke<string>("pandoc_export", {
      source: view.state.doc.toString(),
      format,
      outputPath: picked,
      docDir: docDir(),
    });
    showStatus("已导出：" + path.split("/").pop());
  } catch (err) {
    showStatus("导出失败", 4000);
    alert(String(err));
  }
}

export function doPrint() {
  renderPreview();
  window.setTimeout(() => window.print(), 50);
}
