import { invoke } from "@tauri-apps/api/core";
import { getCurrentPath, inTauri, view } from "./main";

/**
 * 预览里的本地图片按当前文稿目录读取，转成 data URI。
 * 粘贴或拖入的图片写到文稿旁边，并插入 Markdown。
 */

let imageGen = 0;

function markdownTarget(rel: string): string {
  return /[\s()]/.test(rel) ? `<${rel}>` : rel;
}

function requireSavedDoc(): string | null {
  const doc = getCurrentPath();
  if (!doc) {
    alert("先把文稿保存下来，图片才能放到它旁边。");
    return null;
  }
  return doc;
}

export function insertImageMarkdowns(rels: string[]): void {
  if (!rels.length) return;
  const sel = view.state.selection.main;
  const before = sel.from > 0 ? view.state.doc.sliceString(sel.from - 1, sel.from) : "\n";
  const lead = before === "\n" ? "" : "\n";
  const snippet = lead + rels.map((rel) => `![](${markdownTarget(rel)})`).join("\n") + "\n";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: snippet },
    selection: { anchor: sel.from + snippet.length },
  });
  view.focus();
}

function markMissing(img: HTMLImageElement, text: string, title: string) {
  const span = document.createElement("span");
  span.className = "remote-img";
  span.title = title;
  span.textContent = text || title;
  img.replaceWith(span);
}

export async function hydrateLocalImages(root: HTMLElement): Promise<void> {
  const gen = ++imageGen;
  const imgs = [...root.querySelectorAll<HTMLImageElement>("img")].filter((img) => {
    const src = img.getAttribute("src") ?? "";
    return src !== "" && !src.startsWith("data:");
  });
  if (!imgs.length) return;
  const docPath = getCurrentPath();
  if (!docPath) {
    for (const img of imgs) {
      markMissing(img, img.getAttribute("src") ?? "", "先保存文稿，才能显示旁边的图片");
    }
    return;
  }
  if (!inTauri) return;
  const srcs = imgs.map((img) => img.getAttribute("src") ?? "");
  let urls: string[] = [];
  try {
    urls = await invoke<string[]>("load_local_images", { docPath, srcs });
  } catch {
    return;
  }
  if (gen !== imageGen) return;
  imgs.forEach((img, i) => {
    if (!img.isConnected) return;
    const url = urls[i] ?? "";
    if (url.startsWith("data:")) img.src = url;
    else markMissing(img, srcs[i] ?? "", "图片无法显示");
  });
}

function extForMime(mime: string): string | null {
  switch (mime.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return null;
  }
}

function extFromName(name: string): string | null {
  const match = /\.(png|jpe?g|gif|webp|svg)$/i.exec(name);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function pasteImages(files: File[]): Promise<void> {
  const docPath = requireSavedDoc();
  if (!docPath) return;
  const rels: string[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const ext = extForMime(file.type) ?? extFromName(file.name);
    if (!ext) {
      errors.push("不支持的图片格式");
      continue;
    }
    try {
      const data = await fileToBase64(file);
      rels.push(await invoke<string>("save_image_beside_doc", { docPath, data, ext }));
    } catch (err) {
      errors.push(String(err));
    }
  }
  if (rels.length) insertImageMarkdowns(rels);
  if (errors.length) alert(errors[0]);
}

export function initImageInput(): void {
  if (!inTauri) return;
  view.dom.addEventListener(
    "paste",
    (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      void pasteImages(files);
    },
    true,
  );
}

export async function importDroppedImages(paths: string[]): Promise<void> {
  if (!inTauri || !paths.length) return;
  const docPath = requireSavedDoc();
  if (!docPath) return;
  const rels: string[] = [];
  const errors: string[] = [];
  for (const sourcePath of paths) {
    try {
      rels.push(await invoke<string>("import_image_file", { docPath, sourcePath }));
    } catch (err) {
      errors.push(String(err));
    }
  }
  if (rels.length) insertImageMarkdowns(rels);
  if (errors.length) alert(errors[0]);
}
