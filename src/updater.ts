import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { inTauri } from "./main";

/**
 * 检查更新。manual=true 时（菜单触发）无论结果都给出反馈；
 * manual=false 时（启动自动检查）只在发现新版本时打扰用户。
 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!inTauri) return;
  try {
    const update = await check();
    if (!update) {
      if (manual) alert("当前已是最新版本。");
      return;
    }
    const notes = (update.body ?? "").trim();
    const msg =
      "发现新版本 v" + update.version + "（当前 v" + update.currentVersion + "）" +
      (notes ? "\n\n" + notes : "") +
      "\n\n现在下载并安装？完成后会自动重启。";
    if (!confirm(msg)) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    // 自动检查时静默失败（离线、仓库不可达都正常）
    if (manual) alert("检查更新失败：" + String(err));
  }
}

/** 启动后延迟自动检查一次 */
export function scheduleAutoUpdateCheck(): void {
  if (!inTauri) return;
  window.setTimeout(() => void checkForUpdates(false), 5000);
}
