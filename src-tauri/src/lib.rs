use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取失败：{e}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    fs::write(&path, contents).map_err(|e| format!("保存失败：{e}"))
}

/* ---------------- AI ---------------- */

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct ProviderConfig {
    base_url: String,
    api_key: String,
    model: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct AiConfig {
    active: String,
    providers: HashMap<String, ProviderConfig>,
}

impl Default for AiConfig {
    fn default() -> Self {
        let mut providers = HashMap::new();
        providers.insert(
            "ollama".into(),
            ProviderConfig {
                base_url: "http://localhost:11434/v1".into(),
                api_key: String::new(),
                model: "qwen3.8:27b-mlx".into(),
            },
        );
        Self {
            active: "ollama".into(),
            providers,
        }
    }
}

fn ai_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("mdpad")
        .join("ai-config.json")
}

#[tauri::command]
fn ai_get_config() -> AiConfig {
    let Ok(text) = fs::read_to_string(ai_config_path()) else {
        return AiConfig::default();
    };
    let mut cfg = if let Ok(cfg) = serde_json::from_str::<AiConfig>(&text) {
        cfg
    } else {
        // 旧版单配置自动迁移到 ollama 名下
        #[derive(Deserialize)]
        struct OldConfig {
            base_url: String,
            api_key: String,
            model: String,
        }
        if let Ok(old) = serde_json::from_str::<OldConfig>(&text) {
            let mut cfg = AiConfig::default();
            cfg.providers.insert(
                "ollama".into(),
                ProviderConfig {
                    base_url: old.base_url,
                    api_key: old.api_key,
                    model: old.model,
                },
            );
            cfg
        } else {
            return AiConfig::default();
        }
    };
    // 明文 key 迁移进钥匙串，配置文件中不再保存
    let mut migrated = false;
    for (name, provider) in cfg.providers.iter_mut() {
        if !provider.api_key.is_empty() {
            if ai_set_api_key(name.clone(), provider.api_key.clone()).is_ok() {
                provider.api_key.clear();
                migrated = true;
            }
        }
    }
    if migrated {
        let _ = ai_set_config(cfg.clone());
    }
    cfg
}

#[tauri::command]
fn ai_set_config(mut config: AiConfig) -> Result<(), String> {
    for p in config.providers.values_mut() {
        p.api_key.clear(); // key 永不落盘，只走钥匙串
    }
    let path = ai_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("保存配置失败：{e}"))
}

#[tauri::command]
async fn ai_list_models(base_url: String, provider: String) -> Result<Vec<String>, String> {
    let api_key = keychain_get(&provider);
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    log_line(&format!(
        "list_models 请求: provider={provider} url={url} key_len={}",
        api_key.len()
    ));
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            log_line(&format!("list_models 连接失败: {e}"));
            return Err(format!("连接失败：{e}"));
        }
    };
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        log_line(&format!("list_models 失败: HTTP {status} body={snippet}"));
        return Err(format!("HTTP {status}：{snippet}"));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let models: Vec<String> = json["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    log_line(&format!("list_models 成功: {} 个模型", models.len()));
    Ok(models)
}

#[derive(Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

static CANCELS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
fn ai_cancel(id: String) {
    if let Some(flag) = CANCELS.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

fn emit(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit("ai-event", payload);
}

#[tauri::command]
async fn ai_chat_stream(
    app: AppHandle,
    id: String,
    base_url: String,
    provider: String,
    model: String,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    CANCELS.lock().unwrap().insert(id.clone(), cancel.clone());
    let api_key = keychain_get(&provider);
    log_line(&format!(
        "chat 请求: provider={provider} model={model} key_len={} base={base_url}",
        api_key.len()
    ));

    let result = run_stream(&app, &id, &base_url, &api_key, &model, messages, &cancel).await;

    match &result {
        Ok(()) => log_line("chat 完成"),
        Err(e) => log_line(&format!("chat 失败: {e}")),
    }
    CANCELS.lock().unwrap().remove(&id);
    result
}

async fn run_stream(
    app: &AppHandle,
    id: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    let client = reqwest::Client::new();
    let mut req = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("HTTP {status}：{snippet}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut finished = false;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            emit(app, serde_json::json!({"id": id, "kind": "done", "cancelled": true}));
            return Ok(());
        }
        let chunk = chunk.map_err(|e| format!("读取流失败：{e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buf.find('\n') {
            let line: String = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let data = line[5..].trim();
            if data == "[DONE]" {
                finished = true;
                break;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            let delta = &v["choices"][0]["delta"];
            if let Some(text) = delta["content"].as_str() {
                if !text.is_empty() {
                    emit(app, serde_json::json!({"id": id, "kind": "chunk", "text": text}));
                }
            }
            if let Some(reasoning) = delta["reasoning"]
                .as_str()
                .or_else(|| delta["reasoning_content"].as_str())
            {
                if !reasoning.is_empty() {
                    emit(app, serde_json::json!({"id": id, "kind": "reasoning", "text": reasoning}));
                }
            }
        }
        if finished {
            break;
        }
    }

    emit(app, serde_json::json!({"id": id, "kind": "done"}));
    Ok(())
}



/* ---------------- 钥匙串（走 security CLI，读写同一条路径，无授权弹窗） ---------------- */

const KEYCHAIN_SERVICE: &str = "com.yirongcao.mdpad";

fn keychain_account(provider: &str) -> String {
    format!("ai-api-key-{provider}")
}

fn keychain_get(provider: &str) -> String {
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &keychain_account(provider),
            "-w",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_string(),
        Ok(o) => {
            log_line(&format!(
                "keychain 读取失败 provider={provider}: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            ));
            String::new()
        }
        Err(e) => {
            log_line(&format!("security CLI 调用失败: {e}"));
            String::new()
        }
    }
}

#[tauri::command]
fn ai_has_api_key(provider: String) -> bool {
    !keychain_get(&provider).is_empty()
}

#[tauri::command]
fn ai_set_api_key(provider: String, key: String) -> Result<(), String> {
    let trimmed = key.trim().to_string();
    let out = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &keychain_account(&provider),
            "-w",
            &trimmed,
        ])
        .output()
        .map_err(|e| format!("调用 security 失败：{e}"))?;
    if out.status.success() {
        log_line(&format!(
            "set_api_key: provider={provider} key_len={} ok",
            trimmed.len()
        ));
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        log_line(&format!("set_api_key: provider={provider} 失败: {err}"));
        Err(format!("写入钥匙串失败：{err}"))
    }
}

#[tauri::command]
fn ai_delete_api_key(provider: String) -> Result<(), String> {
    let out = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            &keychain_account(&provider),
        ])
        .output()
        .map_err(|e| format!("调用 security 失败：{e}"))?;
    if out.status.success() {
        log_line(&format!("delete_api_key: provider={provider} ok"));
    }
    Ok(())
}

/* ---------------- Pandoc 导出 ---------------- */

#[derive(Serialize)]
struct PandocStatus {
    available: bool,
    version: String,
    path: String,
}

/// 图形界面启动的 .app PATH 里没有 /opt/homebrew/bin，要主动找常见位置
fn find_pandoc() -> Option<String> {
    for p in ["/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc"] {
        if Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    if let Ok(out) = std::process::Command::new("which").arg("pandoc").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() && Path::new(&p).exists() {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
fn pandoc_check() -> PandocStatus {
    let Some(path) = find_pandoc() else {
        return PandocStatus {
            available: false,
            version: String::new(),
            path: String::new(),
        };
    };
    let version = std::process::Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .map(String::from)
        })
        .unwrap_or_default();
    PandocStatus {
        available: true,
        version,
        path,
    }
}

#[tauri::command]
fn pandoc_export(
    source: String,
    format: String,
    output_path: String,
    doc_dir: Option<String>,
) -> Result<String, String> {
    let pandoc = find_pandoc().ok_or("未找到 pandoc，请先安装：brew install pandoc")?;

    // 源文写进临时文件，让 pandoc 读真实文件（图片相对路径才有着落）
    let tmp = std::env::temp_dir().join(format!("mdpad-export-{}.md", std::process::id()));
    fs::write(&tmp, &source).map_err(|e| format!("写临时文件失败：{e}"))?;

    let mut cmd = std::process::Command::new(&pandoc);
    cmd.arg(tmp.as_os_str())
        .arg("-f")
        .arg("markdown")
        .arg("-t")
        .arg(&format)
        .arg("-o")
        .arg(&output_path);

    if format == "html" {
        // 单文件成品：样式内联、图片转 data URI
        cmd.arg("--standalone").arg("--embed-resources");
        let title = Path::new(&output_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "document".into());
        cmd.arg("--metadata").arg(format!("title={title}"));
    }
    if let Some(dir) = &doc_dir {
        if Path::new(dir).exists() {
            cmd.current_dir(dir);
            cmd.arg(format!("--resource-path={dir}"));
        }
    }

    let out = cmd.output().map_err(|e| format!("启动 pandoc 失败：{e}"))?;
    let _ = fs::remove_file(&tmp);

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let snippet: String = stderr.chars().take(300).collect();
        log_line(&format!("pandoc 导出失败: format={format} err={snippet}"));
        return Err(format!("pandoc 导出失败：{snippet}"));
    }
    log_line(&format!("pandoc 导出成功: format={format} -> {output_path}"));
    Ok(output_path)
}



/* ---------------- 日志 ---------------- */

fn log_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("mdpad")
        .join("mdpad.log")
}

fn log_line(msg: &str) {
    let p = log_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // 超过 1MB 就截断重来，日志不膨胀
    if let Ok(meta) = fs::metadata(&p) {
        if meta.len() > 1_000_000 {
            let _ = fs::remove_file(&p);
        }
    }
    let ts = jiff::Zoned::now().strftime("%Y-%m-%d %H:%M:%S").to_string();
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p) {
        use std::io::Write;
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

#[tauri::command]
fn log_frontend(msg: String) {
    log_line(&format!("前端: {msg}"));
}

#[tauri::command]
fn open_log() -> Result<(), String> {
    let p = log_path();
    if !p.exists() {
        fs::write(&p, "").map_err(|e| e.to_string())?;
    }
    tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| e.to_string())
}

/* ---------------- 最近文件 ---------------- */

fn recent_store_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("mdpad")
        .join("recent-files.json")
}

fn read_recent() -> Vec<String> {
    fs::read_to_string(recent_store_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_recent(list: &[String]) {
    let p = recent_store_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&p, serde_json::to_string_pretty(list).unwrap_or_default());
}

fn rebuild_recent_menu(app: &AppHandle) -> Result<(), String> {
    let Some(menu) = app.menu() else { return Ok(()) };
    let Some(tauri::menu::MenuItemKind::Submenu(sub)) = menu.get("recent-menu") else {
        return Ok(());
    };
    for item in sub.items().map_err(|e| e.to_string())? {
        sub.remove(&item).map_err(|e| e.to_string())?;
    }
    let list = read_recent();
    if list.is_empty() {
        let none = MenuItemBuilder::with_id("recent:none", "无最近文件")
            .enabled(false)
            .build(app)
            .map_err(|e| e.to_string())?;
        sub.append(&none).map_err(|e| e.to_string())?;
    } else {
        for (i, path) in list.iter().enumerate() {
            let name = path.rsplit('/').next().unwrap_or(path);
            let item = MenuItemBuilder::with_id(format!("recent:{i}"), name)
                .build(app)
                .map_err(|e| e.to_string())?;
            sub.append(&item).map_err(|e| e.to_string())?;
        }
        let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
        sub.append(&sep).map_err(|e| e.to_string())?;
        let clear = MenuItemBuilder::with_id("recent:clear", "清除列表")
            .build(app)
            .map_err(|e| e.to_string())?;
        sub.append(&clear).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_recent_files() -> Vec<String> {
    read_recent()
}

#[tauri::command]
fn add_recent_file(app: AppHandle, path: String) {
    let mut list = read_recent();
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(10);
    write_recent(&list);
    let _ = rebuild_recent_menu(&app);
}

#[tauri::command]
fn clear_recent_files(app: AppHandle) {
    write_recent(&[]);
    let _ = rebuild_recent_menu(&app);
}

/* ---------------- 菜单 ---------------- */

fn mi(
    handle: &AppHandle,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<Wry>> {
    let mut b = MenuItemBuilder::with_id(id, label);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(handle)
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "mdpad")
        .item(&PredefinedMenuItem::about(app, Some("关于 mdpad"), None)?)
        .separator()
        .item(&mi(app, "settings", "设置…", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&PredefinedMenuItem::services(app, Some("服务"))?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("隐藏 mdpad"))?)
        .item(&PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?)
        .item(&PredefinedMenuItem::show_all(app, Some("全部显示"))?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("退出 mdpad"))?)
        .build()?;

    let recent_sub = SubmenuBuilder::new(app, "打开最近")
        .id("recent-menu")
        .build()?;
    let export_sub = SubmenuBuilder::new(app, "导出")
        .item(&mi(app, "export_docx", "Word (.docx)", None)?)
        .item(&mi(app, "export_html", "HTML 网页", None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "文件")
        .item(&mi(app, "new", "新建", Some("CmdOrCtrl+N"))?)
        .item(&mi(app, "open", "打开…", Some("CmdOrCtrl+O"))?)
        .item(&recent_sub)
        .separator()
        .item(&mi(app, "save", "保存", Some("CmdOrCtrl+S"))?)
        .item(&mi(app, "save_as", "另存为…", Some("Shift+CmdOrCtrl+S"))?)
        .separator()
        .item(&export_sub)
        .item(&mi(app, "print", "打印 / 存为 PDF…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, Some("关闭窗口"))?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&mi(app, "undo", "撤销", Some("CmdOrCtrl+Z"))?)
        .item(&mi(app, "redo", "重做", Some("Shift+CmdOrCtrl+Z"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("拷贝"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("全选"))?)
        .separator()
        .item(&mi(app, "find", "查找…", Some("CmdOrCtrl+F"))?)
        .item(&mi(app, "replace", "替换…", Some("Alt+CmdOrCtrl+F"))?)
        .build()?;

    let format_menu = SubmenuBuilder::new(app, "格式")
        .item(&mi(app, "fmt_h1", "标题 1", Some("Ctrl+CmdOrCtrl+1"))?)
        .item(&mi(app, "fmt_h2", "标题 2", Some("Ctrl+CmdOrCtrl+2"))?)
        .item(&mi(app, "fmt_h3", "标题 3", Some("Ctrl+CmdOrCtrl+3"))?)
        .separator()
        .item(&mi(app, "fmt_bold", "加粗", Some("CmdOrCtrl+B"))?)
        .item(&mi(app, "fmt_italic", "斜体", Some("CmdOrCtrl+I"))?)
        .item(&mi(app, "fmt_strike", "删除线", Some("Shift+CmdOrCtrl+X"))?)
        .item(&mi(app, "fmt_code", "行内代码", Some("Shift+CmdOrCtrl+C"))?)
        .separator()
        .item(&mi(app, "fmt_quote", "引用块", Some("Shift+CmdOrCtrl+."))?)
        .item(&mi(app, "fmt_codeblock", "代码块", Some("Alt+CmdOrCtrl+C"))?)
        .item(&mi(app, "fmt_hr", "分隔线", None)?)
        .separator()
        .item(&mi(app, "fmt_link", "链接…", Some("CmdOrCtrl+K"))?)
        .item(&mi(app, "fmt_image", "图片", None)?)
        .separator()
        .item(&mi(app, "fmt_ul", "无序列表", Some("Shift+CmdOrCtrl+7"))?)
        .item(&mi(app, "fmt_ol", "有序列表", Some("Shift+CmdOrCtrl+8"))?)
        .item(&mi(app, "fmt_todo", "任务列表", Some("Shift+CmdOrCtrl+9"))?)
        .separator()
        .item(&mi(app, "fmt_table", "表格", None)?)
        .item(&mi(app, "fmt_footnote", "脚注", None)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(&mi(app, "view_editor", "源码", Some("CmdOrCtrl+1"))?)
        .item(&mi(app, "view_split", "分栏", Some("CmdOrCtrl+2"))?)
        .item(&mi(app, "view_preview", "预览", Some("CmdOrCtrl+3"))?)
        .separator()
        .item(&mi(app, "chat_toggle", "AI 对话", Some("CmdOrCtrl+J"))?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .item(&PredefinedMenuItem::minimize(app, Some("最小化"))?)
        .item(&PredefinedMenuItem::maximize(app, Some("缩放"))?)
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "帮助")
        .item(&mi(app, "help_repo", "GitHub 仓库", None)?)
        .item(&mi(app, "help_issue", "反馈问题…", None)?)
        .item(&mi(app, "open_log", "查看日志", None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &format_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let _ = app.emit("menu-event", event.id().as_ref());
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            build_menu(app.handle())?;
            rebuild_recent_menu(app.handle()).map_err(|e| e.to_string())?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            ai_get_config,
            ai_set_config,
            ai_list_models,
            ai_chat_stream,
            ai_cancel,
            ai_has_api_key,
            ai_set_api_key,
            ai_delete_api_key,
            pandoc_check,
            pandoc_export,
            get_recent_files,
            add_recent_file,
            clear_recent_files,
            open_log,
            log_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
