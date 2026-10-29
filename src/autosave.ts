import { view, setDoc, markDirty, getCurrentPath, isDirty } from "./main";

/**
 * 崩溃/意外退出保护：
 * - 文档每次变动后 1.5s 落一份快照到 localStorage
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
  timer = window.setTimeout(snapshotNow, 1500);
}

function snapshotNow(): void {
  // 只在有未保存修改时保留快照；刚打开/刚保存的文档不产生恢复横幅
  if (!isDirty()) {
    clearAutosave();
    return;
  }
  const snap: Snapshot = {
    path: getCurrentPath(),
    content: view.state.doc.toString(),
    ts: Date.now(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch {
    // 配额满（超大文档）就放弃本次快照，不影响编辑
  }
}

export function clearAutosave(): void {
  window.clearTimeout(timer);
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Snapshot;
    if (typeof s.content !== "string") return null;
    return s;
  } catch {
    return null;
  }
}

export function initAutosaveRecovery(): void {
  const snap = loadSnapshot();
  if (!snap) return;
  showBanner(snap);
}

function showBanner(snap: Snapshot): void {
  const name = snap.path ? (snap.path.split("/").pop() ?? snap.path) : "未命名";
  const time = new Date(snap.ts).toLocaleString();

  const bar = document.createElement("div");
  bar.id = "autosave-banner";

  const label = document.createElement("span");
  label.textContent = `检测到上次未保存的修改：${name}（${time}）`;

  const restore = document.createElement("button");
  restore.textContent = "恢复";
  restore.className = "primary";
  restore.addEventListener("click", () => {
    setDoc(snap.content, snap.path);
    markDirty();
    snapshotNow();
    bar.remove();
  });

  const discard = document.createElement("button");
  discard.textContent = "丢弃";
  discard.addEventListener("click", () => {
    clearAutosave();
    bar.remove();
  });

  bar.append(label, restore, discard);
  const workspace = document.querySelector("#workspace");
  document.body.insertBefore(bar, workspace);
}
