import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { undo, redo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { view, inTauri, newFile, openFile, openPath, writeCurrent, saveAs, setMode } from "./main";
import { doExport, doPrint } from "./export";
import { openSettings } from "./ai";
import { runFormat } from "./format";
import { toggleChat } from "./chat";
import { runTable } from "./tables";
import { toggleFocus } from "./focus";
import { copyForWeChat } from "./wechat";
import { toggleCompletion } from "./complete";
import { checkForUpdates } from "./updater";

async function dispatch(id: string) {
  if (id.startsWith("recent:")) {
    const n = id.slice(7);
    if (n === "none") return;
    if (n === "clear") {
      await invoke("clear_recent_files");
      return;
    }
    const list = await invoke<string[]>("get_recent_files");
    const path = list[Number(n)];
    if (path) await openPath(path);
    return;
  }
  if (id.startsWith("tbl_")) {
    runTable(id);
    return;
  }
  if (id.startsWith("fmt_")) {
    runFormat(id);
    return;
  }
  switch (id) {
    case "new": return newFile();
    case "open": return void openFile();
    case "save": return void writeCurrent();
    case "save_as": return void saveAs();
    case "export_docx": return doExport("docx");
    case "export_html": return doExport("html");
    case "print": return doPrint();
    case "settings": return openSettings();
    case "check_update": return void checkForUpdates(true);
    case "view_editor": return setMode("editor");
    case "view_split": return setMode("split");
    case "view_preview": return setMode("preview");
    case "chat_toggle": return toggleChat();
    case "view_focus": return toggleFocus();
    case "view_completion": return toggleCompletion();
    case "export_wechat": return void copyForWeChat();
    case "undo": undo(view); return void view.focus();
    case "redo": redo(view); return void view.focus();
    case "find":
    case "replace": openSearchPanel(view); return void view.focus();
    case "open_log": return void invoke("open_log");
    case "help_repo": return void openUrl("https://github.com/erongcao/mdpad");
    case "help_issue": return void openUrl("https://github.com/erongcao/mdpad/issues/new");
  }
}

export function initMenu() {
  if (!inTauri) return;
  void listen<string>("menu-event", (e) => void dispatch(e.payload));
}
