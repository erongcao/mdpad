import { invoke } from "@tauri-apps/api/core";
import { view, setDoc, markDirty, getCurrentPath, isDirty, inTauri } from "./main";

/**
 * 崩溃/意外退出保护：
 * - 文档每次变动后 1.5s 落一份快照
 * - Tauri 内走 Rust 原子写文件（kill -9 也不丢）；浏览器 dev 环境退到 localStorage
 * - 保存成功或用户明确放弃修改时清除快照
 * - 下次启动发现快照 → 顶部横幅询问恢复/丢弃
 */

const KEY = "mdpad.autosave.v1";
let timer: number | undefined;

interface Snapshot {
  path: string | null;
  content: string;
  ts: number;
}

export function scheduleAutosave(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void snapshotNow(), 1500);
}

async function snapshotNow(): Promise<void> {
  // 只在有未保存修改时保留快照；刚打开/刚保存的文档不产生恢复横幅
  if (!isDirty()) {
    await clearAutosave();
    return;
  }
  const snap: Snapshot = {
    path: getCurrentPath(),
    content: view.state.doc.toString(),
    ts: Date.now(),
  };
  const raw = JSON.stringify(snap);
  if (inTauri) {
    try {
      await invoke("autosave_write", { contents: raw });
    } catch {
      // 写失败不打扰编辑
    }
  } else {
    try {
      localStorage.setItem(KEY, raw);
    } catch {
      // 配额满就放弃本次快照
    }
  }
}

export async function clearAutosave(): Promise<void> {
  window.clearTimeout(timer);
  if (inTauri) {
    try {
      await invoke("autosave_clear");
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

async function loadSnapshot(): Promise<Snapshot | null> {
  let raw: string | null = null;
  if (inTauri) {
    try {
      raw = await invoke<string | null>("autosave_read");
    } catch {
      raw = null;
    }
  }
  if (!raw) {
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      raw = null;
    }
  }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Snapshot;
    if (typeof s.content !== "string") return null;
    return s;
  } catch {
    return null;
  }
}

export async function initAutosaveRecovery(): Promise<void> {
  const snap = await loadSnapshot();
  if (!snap) return;
  showBanner(snap);
}

function showBanner(snap: Snapshot): void {
  const name = snap.path ? (snap.path.split("/").pop() ?? snap.path) : "未命名";
  const time = new Date(snap.ts).toLocaleString();

  const bar = document.createElement("div");
  bar.id = "autosave-banner";

  const label = document.createElement("span");
  label.textContent = "检测到上次未保存的修改：" + name + "（" + time + "）";

  const restore = document.createElement("button");
  restore.textContent = "恢复";
  restore.className = "primary";
  restore.addEventListener("click", () => {
    setDoc(snap.content, snap.path);
    markDirty();
    void snapshotNow();
    bar.remove();
  });

  const discard = document.createElement("button");
  discard.textContent = "丢弃";
  discard.addEventListener("click", () => {
    void clearAutosave();
    bar.remove();
  });

  bar.append(label, restore, discard);
  const workspace = document.querySelector("#workspace");
  document.body.insertBefore(bar, workspace);
}
