use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取失败：{e}"))
}

fn next_id() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn parent_dir(path: &Path) -> &Path {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    }
}

/// 先写入同目录临时文件并 fsync，再改名。崩溃不会把目标文件截成半截。
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = parent_dir(path);
    if parent != Path::new(".") && !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), next_id()));
    let write_result = (|| -> Result<(), String> {
        let mut file = File::create(&tmp).map_err(|e| format!("写入失败：{e}"))?;
        file.write_all(bytes).map_err(|e| format!("写入失败：{e}"))?;
        file.sync_all().map_err(|e| format!("写入失败：{e}"))?;
        Ok(())
    })();
    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("保存失败：{err}"));
    }
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    atomic_write(Path::new(&path), contents.as_bytes())
}


/* ---------------- 崩溃恢复快照（写真实文件，比 WebKit localStorage 可靠） ---------------- */

fn autosave_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("mdpad")
        .join("autosave.json")
}

#[tauri::command]
fn autosave_write(contents: String) -> Result<(), String> {
    atomic_write(&autosave_path(), contents.as_bytes()).map_err(|e| format!("快照{e}"))
}

#[tauri::command]
fn autosave_read() -> Option<String> {
    fs::read_to_string(autosave_path()).ok()
}

#[tauri::command]
fn autosave_clear() -> Result<(), String> {
    let p = autosave_path();
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("快照删除失败：{e}"))?;
    }
    Ok(())
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

fn normalize_base_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// 只允许 http/https。密钥只发给已经写入配置的那个地址，避免页面把钥匙串密钥转到别的主机。
fn validate_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim();
    let url = reqwest::Url::parse(trimmed).map_err(|_| "服务地址无效".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("服务地址只允许 http 或 https".into()),
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("服务地址无效".into());
    }
    Ok(normalize_base_url(trimmed))
}

/// 设置页「拉取模型」时眼前的地址还没点保存。只在内存里放行这一次，不写配置文件。
static ALLOWED_URLS: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
fn ai_allow_base_url(provider: String, base_url: String) -> Result<(), String> {
    let base_url = validate_base_url(&base_url)?;
    ALLOWED_URLS.lock().unwrap().insert(provider, base_url);
    Ok(())
}

fn api_key_for_saved_url(provider: &str, base_url: &str) -> String {
    let wanted = normalize_base_url(base_url);
    let cfg = ai_get_config();
    let saved = cfg
        .providers
        .get(provider)
        .map(|p| normalize_base_url(&p.base_url))
        .filter(|s| !s.is_empty());
    let allowed = ALLOWED_URLS.lock().unwrap().get(provider).cloned();
    if saved.as_deref() != Some(wanted.as_str()) && allowed.as_deref() != Some(wanted.as_str()) {
        log_line(&format!("未把钥匙串密钥发给未保存的地址 provider={provider}"));
        return String::new();
    }
    keychain_get(provider)
}

#[tauri::command]
async fn ai_list_models(base_url: String, provider: String) -> Result<Vec<String>, String> {
    let base_url = validate_base_url(&base_url)?;
    let api_key = api_key_for_saved_url(&provider, &base_url);
    let url = format!("{base_url}/models");
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
    let base_url = validate_base_url(&base_url)?;
    let cancel = Arc::new(AtomicBool::new(false));
    CANCELS.lock().unwrap().insert(id.clone(), cancel.clone());
    let api_key = api_key_for_saved_url(&provider, &base_url);
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
    let mut pending = Vec::new();
    let mut finished = false;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            emit(app, serde_json::json!({"id": id, "kind": "done", "cancelled": true}));
            return Ok(());
        }
        let chunk = chunk.map_err(|e| format!("读取流失败：{e}"))?;
        append_utf8(&mut buf, &mut pending, &chunk);
        if drain_sse(app, id, &mut buf) {
            finished = true;
            break;
        }
    }
    if !finished {
        if !pending.is_empty() {
            buf.push('\u{FFFD}');
            pending.clear();
        }
        if !buf.is_empty() {
            buf.push('\n');
            let _ = drain_sse(app, id, &mut buf);
        }
    }

    emit(app, serde_json::json!({"id": id, "kind": "done"}));
    Ok(())
}

/// 网络块可能把一个汉字拆开。未完成的 UTF-8 字节留到下一块，不再各自 lossy 解码。
fn append_utf8(text: &mut String, pending: &mut Vec<u8>, chunk: &[u8]) {
    pending.extend_from_slice(chunk);
    while !pending.is_empty() {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                text.push_str(s);
                pending.clear();
                break;
            }
            Err(err) => {
                let valid = err.valid_up_to();
                if valid > 0 {
                    text.push_str(std::str::from_utf8(&pending[..valid]).unwrap());
                    pending.drain(..valid);
                    continue;
                }
                match err.error_len() {
                    None => break,
                    Some(len) => {
                        text.push('\u{FFFD}');
                        pending.drain(..len.min(pending.len()));
                    }
                }
            }
        }
    }
}

struct SseDelta {
    done: bool,
    content: String,
    reasoning: String,
}

fn parse_sse_data(data: &str) -> SseDelta {
    if data == "[DONE]" {
        return SseDelta {
            done: true,
            content: String::new(),
            reasoning: String::new(),
        };
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return SseDelta {
            done: false,
            content: String::new(),
            reasoning: String::new(),
        };
    };
    let delta = &value["choices"][0]["delta"];
    let content = delta["content"].as_str().unwrap_or("").to_string();
    let reasoning = delta["reasoning"]
        .as_str()
        .or_else(|| delta["reasoning_content"].as_str())
        .unwrap_or("")
        .to_string();
    SseDelta {
        done: false,
        content,
        reasoning,
    }
}

fn drain_sse(app: &AppHandle, id: &str, buf: &mut String) -> bool {
    while let Some(pos) = buf.find('\n') {
        let line: String = buf[..pos].trim().to_string();
        buf.drain(..=pos);
        if line.is_empty() || !line.starts_with("data:") {
            continue;
        }
        let delta = parse_sse_data(line[5..].trim());
        if delta.done {
            return true;
        }
        if !delta.content.is_empty() {
            emit(
                app,
                serde_json::json!({"id": id, "kind": "chunk", "text": delta.content}),
            );
        }
        if !delta.reasoning.is_empty() {
            emit(
                app,
                serde_json::json!({"id": id, "kind": "reasoning", "text": delta.reasoning}),
            );
        }
    }
    false
}



/* ---------------- 钥匙串（走 security CLI，读写同一条路径，无授权弹窗） ---------------- */

const KEYCHAIN_SERVICE: &str = "com.yirongcao.mdpad";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

fn keychain_account(provider: &str) -> String {
    format!("ai-api-key-{provider}")
}

fn keychain_get(provider: &str) -> String {
    // Security 框架读写，密钥不出现在进程参数里
    match security_framework::passwords::get_generic_password(
        KEYCHAIN_SERVICE,
        &keychain_account(provider),
    ) {
        Ok(bytes) => String::from_utf8_lossy(&bytes)
            .trim_end_matches(['\r', '\n'])
            .to_string(),
        Err(err) => {
            if err.code() != ERR_SEC_ITEM_NOT_FOUND {
                log_line(&format!("keychain 读取失败 provider={provider}: {err}"));
            }
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
    match security_framework::passwords::set_generic_password(
        KEYCHAIN_SERVICE,
        &keychain_account(&provider),
        trimmed.as_bytes(),
    ) {
        Ok(()) => {
            log_line(&format!(
                "set_api_key: provider={provider} key_len={} ok",
                trimmed.len()
            ));
            Ok(())
        }
        Err(err) => {
            log_line(&format!("set_api_key: provider={provider} 失败: {err}"));
            Err(format!("写入钥匙串失败：{err}"))
        }
    }
}

#[tauri::command]
fn ai_delete_api_key(provider: String) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(
        KEYCHAIN_SERVICE,
        &keychain_account(&provider),
    ) {
        Ok(()) => {
            log_line(&format!("delete_api_key: provider={provider} ok"));
            Ok(())
        }
        Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(err) => Err(format!("删除钥匙串失败：{err}")),
    }
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

    // 源文写进独立临时目录，让 pandoc 读真实文件（图片相对路径才有着落）
    let scratch = TempDir::new("export")?;
    let tmp = scratch.path().join("source.md");
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
    drop(scratch);

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let snippet: String = stderr.chars().take(300).collect();
        log_line(&format!("pandoc 导出失败: format={format} err={snippet}"));
        return Err(format!("pandoc 导出失败：{snippet}"));
    }
    log_line(&format!("pandoc 导出成功: format={format} -> {output_path}"));
    Ok(output_path)
}




/* ---------------- 代码块运行 ---------------- */

#[derive(Serialize, Clone)]
struct RunnerInfo {
    lang: String,
    available: bool,
    path: String,
}

fn find_interpreter(lang: &str) -> Option<String> {
    let candidates: Vec<String> = match lang {
        "python" | "python3" => vec![
            "/opt/homebrew/bin/python3".into(),
            "/usr/local/bin/python3".into(),
            "/usr/bin/python3".into(),
        ],
        "r" | "rscript" => vec![
            "/usr/local/bin/Rscript".into(),
            "/opt/homebrew/bin/Rscript".into(),
            "/Library/Frameworks/R.framework/Resources/bin/Rscript".into(),
        ],
        "julia" => {
            let mut v = vec![
                "/opt/homebrew/bin/julia".into(),
                "/usr/local/bin/julia".into(),
            ];
            // /Applications/Julia-x.y.app 形式
            if let Ok(entries) = fs::read_dir("/Applications") {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with("Julia") && name.ends_with(".app") {
                        v.push(format!(
                            "/Applications/{}/Contents/Resources/julia/bin/julia",
                            name
                        ));
                    }
                }
            }
            v
        }
        _ => return None,
    };
    candidates.into_iter().find(|p| Path::new(p).exists())
}

#[tauri::command]
fn code_runners_check() -> Vec<RunnerInfo> {
    ["python", "r", "julia"]
        .iter()
        .map(|lang| match find_interpreter(lang) {
            Some(p) => RunnerInfo {
                lang: lang.to_string(),
                available: true,
                path: p,
            },
            None => RunnerInfo {
                lang: lang.to_string(),
                available: false,
                path: String::new(),
            },
        })
        .collect()
}

#[derive(Serialize)]
struct RunResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    duration_ms: u128,
    timed_out: bool,
    images: Vec<String>, // base64 data URI
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join(format!(
            "mdpad-{prefix}-{}-{}",
            std::process::id(),
            next_id()
        ));
        fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
        Ok(Self(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const MAX_CAPTURE: usize = 256 * 1024;

struct Captured {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    duration_ms: u128,
}

fn push_capped(kept: &mut Vec<u8>, truncated: &mut bool, data: &[u8], cap: usize) {
    if kept.len() >= cap {
        *truncated = true;
        return;
    }
    let room = cap - kept.len();
    if data.len() > room {
        kept.extend_from_slice(&data[..room]);
        *truncated = true;
    } else {
        kept.extend_from_slice(data);
    }
}

fn decode_captured(bytes: &[u8], truncated: bool) -> String {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if truncated {
        text.push_str("\n…（输出过长，已截断）");
    }
    text
}

async fn drain_rest(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    kept: &mut Vec<u8>,
    truncated: &mut bool,
) {
    let mut buf = [0u8; 8192];
    loop {
        match tokio::io::AsyncReadExt::read(&mut reader, &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => push_capped(kept, truncated, &buf[..n], MAX_CAPTURE),
        }
    }
}

/// 超时后先发 SIGKILL 并等待进程退出，再让调用方删临时目录。
async fn run_captured(
    program: &str,
    args: &[String],
    dir: &Path,
    timeout: std::time::Duration,
) -> Result<Captured, String> {
    let started = std::time::Instant::now();
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("运行失败：{e}"))?;
    let mut stdout = child.stdout.take().ok_or("无法读取标准输出")?;
    let mut stderr = child.stderr.take().ok_or("无法读取标准错误")?;
    let deadline = tokio::time::Instant::now() + timeout;
    let mut out_kept = Vec::new();
    let mut err_kept = Vec::new();
    let mut out_trunc = false;
    let mut err_trunc = false;
    let mut out_buf = [0u8; 8192];
    let mut err_buf = [0u8; 8192];
    let mut out_done = false;
    let mut err_done = false;

    let status = loop {
        tokio::select! {
            biased;
            res = child.wait() => {
                break res.map_err(|e| format!("运行失败：{e}"))?;
            }
            n = tokio::io::AsyncReadExt::read(&mut stdout, &mut out_buf), if !out_done => {
                match n {
                    Ok(0) | Err(_) => out_done = true,
                    Ok(n) => push_capped(&mut out_kept, &mut out_trunc, &out_buf[..n], MAX_CAPTURE),
                }
            }
            n = tokio::io::AsyncReadExt::read(&mut stderr, &mut err_buf), if !err_done => {
                match n {
                    Ok(0) | Err(_) => err_done = true,
                    Ok(n) => push_capped(&mut err_kept, &mut err_trunc, &err_buf[..n], MAX_CAPTURE),
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
                return Ok(Captured {
                    stdout: String::new(),
                    stderr: format!("运行超时（{} 秒上限），进程已终止", timeout.as_secs()),
                    exit_code: -1,
                    timed_out: true,
                    duration_ms: started.elapsed().as_millis(),
                });
            }
        }
    };

    if !out_done {
        drain_rest(stdout, &mut out_kept, &mut out_trunc).await;
    }
    if !err_done {
        drain_rest(stderr, &mut err_kept, &mut err_trunc).await;
    }

    Ok(Captured {
        stdout: decode_captured(&out_kept, out_trunc),
        stderr: decode_captured(&err_kept, err_trunc),
        exit_code: status.code().unwrap_or(-1),
        timed_out: false,
        duration_ms: started.elapsed().as_millis(),
    })
}

fn image_mime(name: &str) -> Option<&'static str> {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".svg") {
        Some("image/svg+xml")
    } else if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower.ends_with(".gif") {
        Some("image/gif")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else {
        None
    }
}

const MAX_LOCAL_IMAGE: usize = 15 * 1024 * 1024;

fn from_hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 远程地址返回 None。相对路径、绝对路径和 file:// 留给文稿目录解析。
fn local_image_src(src: &str) -> Option<String> {
    let src = src.trim();
    if src.is_empty() || src.starts_with("data:") || src.starts_with('#') {
        return None;
    }
    let mut decoded = percent_decode(src);
    if decoded.contains('\0') {
        return None;
    }
    if let Some(rest) = decoded.strip_prefix("file://") {
        decoded = if let Some(path) = rest.strip_prefix("localhost") {
            format!("/{}", path.trim_start_matches('/'))
        } else {
            rest.to_string()
        };
    }
    let lower = decoded.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || decoded.starts_with("//") {
        return None;
    }
    if decoded.contains("://") {
        return None;
    }
    Some(decoded)
}

fn resolve_local_image(doc_path: &Path, src: &str) -> Option<PathBuf> {
    let decoded = local_image_src(src)?;
    let raw = Path::new(&decoded);
    let path = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        let parent = doc_path.parent()?;
        if parent.as_os_str().is_empty() {
            return None;
        }
        parent.join(raw)
    };
    let name = path.file_name()?.to_string_lossy();
    image_mime(&name)?;
    Some(path)
}

fn image_data_url(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    let mime = image_mime(&name)?;
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_LOCAL_IMAGE as u64 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() > MAX_LOCAL_IMAGE {
        return None;
    }
    use base64::Engine;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn doc_dir(doc_path: &str) -> Result<&Path, String> {
    Path::new(doc_path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "文稿还没有保存位置".to_string())
}

fn relative_inside(doc_dir: &Path, src: &Path) -> Option<String> {
    let dir = doc_dir.canonicalize().ok()?;
    let file = src.canonicalize().ok()?;
    let rel = file.strip_prefix(&dir).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    let text = rel.to_string_lossy().replace('\\', "/");
    if text == ".." || text.starts_with("../") {
        return None;
    }
    Some(text)
}

fn unique_image_name(dir: &Path, preferred: &str, ext: &str) -> String {
    let preferred = preferred.rsplit(['/', '\\']).next().unwrap_or(preferred);
    if !preferred.is_empty()
        && preferred != "."
        && preferred != ".."
        && image_mime(preferred).is_some()
        && !dir.join(preferred).exists()
    {
        return preferred.to_string();
    }
    for n in 1..10_000 {
        let name = format!("mdpad-image-{n}.{ext}");
        if !dir.join(&name).exists() {
            return name;
        }
    }
    format!("mdpad-image-{}.{ext}", next_id())
}

fn write_image_beside(dir: &Path, preferred: &str, ext: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("图片是空的".into());
    }
    if bytes.len() > MAX_LOCAL_IMAGE {
        return Err("图片超过 15 MB".into());
    }
    if image_mime(&format!("f.{ext}")).is_none() {
        return Err("不支持的图片格式".into());
    }
    let name = unique_image_name(dir, preferred, ext);
    atomic_write(&dir.join(&name), bytes)?;
    Ok(name)
}

/// 按文稿目录把本地图片读成 data URI。远程地址、缺失文件和过大的文件返回空字符串。
#[tauri::command]
fn load_local_images(doc_path: String, srcs: Vec<String>) -> Vec<String> {
    let doc = Path::new(&doc_path);
    srcs.into_iter()
        .map(|src| {
            resolve_local_image(doc, &src)
                .and_then(|path| image_data_url(&path))
                .unwrap_or_default()
        })
        .collect()
}

/// 把粘贴进来的图片写到文稿旁边，返回相对路径。
#[tauri::command]
fn save_image_beside_doc(doc_path: String, data: String, ext: String) -> Result<String, String> {
    let dir = doc_dir(&doc_path)?;
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "图片数据无法识别".to_string())?;
    write_image_beside(dir, "", &ext, &bytes)
}

/// 拖进来的图片：已经在文稿目录里就沿用相对路径，否则复制过去。
#[tauri::command]
fn import_image_file(doc_path: String, source_path: String) -> Result<String, String> {
    let dir = doc_dir(&doc_path)?;
    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err("找不到这张图片".into());
    }
    let ext = src
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if image_mime(&format!("f.{ext}")).is_none() {
        return Err("不是支持的图片格式".into());
    }
    if let Some(rel) = relative_inside(dir, src) {
        return Ok(rel);
    }
    let bytes = fs::read(src).map_err(|e| format!("读取图片失败：{e}"))?;
    let preferred = src
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    write_image_beside(dir, &preferred, &ext, &bytes)
}

#[tauri::command]
async fn run_code(lang: String, code: String) -> Result<RunResult, String> {
    let Some(interp) = find_interpreter(&lang) else {
        return Err(format!("未找到 {lang} 解释器"));
    };
    let dir = TempDir::new("run")?;
    let ext = match lang.as_str() {
        "python" | "python3" => "py",
        "r" | "rscript" => "R",
        "julia" => "jl",
        _ => "txt",
    };
    let script = dir.path().join(format!("script.{ext}"));
    fs::write(&script, &code).map_err(|e| format!("写脚本失败：{e}"))?;

    let captured = run_captured(
        &interp,
        &[script.to_string_lossy().to_string()],
        dir.path(),
        std::time::Duration::from_secs(120),
    )
    .await?;
    if captured.timed_out {
        log_line(&format!("run_code 超时: lang={lang}"));
        return Ok(RunResult {
            stdout: captured.stdout,
            stderr: captured.stderr,
            exit_code: -1,
            duration_ms: captured.duration_ms,
            timed_out: true,
            images: vec![],
        });
    }

    let mut images = Vec::new();
    if let Ok(entries) = fs::read_dir(dir.path()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with("script.") {
                continue;
            }
            let Some(mime) = image_mime(&name) else { continue };
            let Ok(bytes) = fs::read(entry.path()) else { continue };
            if bytes.len() > 5_000_000 {
                continue;
            }
            use base64::Engine;
            images.push(format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            ));
        }
    }

    log_line(&format!(
        "run_code: lang={lang} exit={} {}ms images={}",
        captured.exit_code,
        captured.duration_ms,
        images.len()
    ));
    Ok(RunResult {
        stdout: captured.stdout,
        stderr: captured.stderr,
        exit_code: captured.exit_code,
        duration_ms: captured.duration_ms,
        timed_out: false,
        images,
    })
}


#[derive(Serialize)]
struct CheckResult {
    ok: bool,
    message: String,
    duration_ms: u128,
}

/// 语法检查（不执行代码）
#[tauri::command]
async fn run_check(lang: String, code: String) -> Result<CheckResult, String> {
    let Some(interp) = find_interpreter(&lang) else {
        return Err(format!("未找到 {lang} 解释器"));
    };
    let dir = TempDir::new("check")?;
    let script_path = |name: &str| dir.path().join(name);
    let quote = |path: &Path| path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    let args: Vec<String> = match lang.as_str() {
        "python" | "python3" => {
            let file = script_path("check.py");
            fs::write(&file, &code).map_err(|e| e.to_string())?;
            vec!["-m".into(), "py_compile".into(), file.to_string_lossy().to_string()]
        }
        "r" | "rscript" => {
            let file = script_path("check.R");
            fs::write(&file, &code).map_err(|e| e.to_string())?;
            vec!["-e".into(), format!("invisible(parse(file=\"{}\"))", quote(&file))]
        }
        "julia" => {
            let file = script_path("check.jl");
            fs::write(&file, &code).map_err(|e| e.to_string())?;
            vec![
                "-e".into(),
                format!("Meta.parseall(read(\"{}\", String)); println(\"OK\")", quote(&file)),
            ]
        }
        _ => return Err("不支持的语言".into()),
    };

    let captured = run_captured(&interp, &args, dir.path(), std::time::Duration::from_secs(30)).await?;
    let ok = !captured.timed_out && captured.exit_code == 0;
    let message = if captured.timed_out {
        captured.stderr
    } else if ok {
        "语法检查通过".to_string()
    } else {
        let raw = if captured.stderr.trim().is_empty() {
            captured.stdout
        } else {
            captured.stderr
        };
        let mut cleaned = raw
            .replace(&dir.path().to_string_lossy().to_string(), "代码")
            .replace("check.py", "代码")
            .replace("check.R", "代码")
            .replace("check.jl", "代码")
            .trim()
            .to_string();
        if let Some(pos) = cleaned.find(" : \n") {
            cleaned = cleaned[pos + 5..].trim().to_string();
        }
        if let Some(stripped) = cleaned.strip_prefix("Error in parse") {
            cleaned = stripped
                .trim_start_matches(['(', ')', ' '])
                .trim_start_matches("file")
                .to_string();
        }
        cleaned.chars().take(400).collect()
    };
    log_line(&format!(
        "run_check: lang={lang} ok={ok} msg={}",
        message.chars().take(120).collect::<String>()
    ));
    Ok(CheckResult {
        ok,
        message,
        duration_ms: captured.duration_ms,
    })
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


/* ---------------- 文件关联打开 ---------------- */

static PENDING_OPEN: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

#[tauri::command]
fn take_pending_open() -> Vec<String> {
    std::mem::take(&mut *PENDING_OPEN.lock().unwrap())
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
        .item(&mi(app, "check_update", "检查更新…", None)?)
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
        .separator()
        .item(&mi(app, "export_wechat", "复制为公众号格式", None)?)
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

    let table_sub = SubmenuBuilder::new(app, "表格")
        .item(&mi(app, "tbl_insert", "插入表格…", Some("Shift+CmdOrCtrl+T"))?)
        .separator()
        .item(&mi(app, "tbl_row_above", "上方插入行", None)?)
        .item(&mi(app, "tbl_row_below", "下方插入行", None)?)
        .item(&mi(app, "tbl_col_left", "左侧插入列", None)?)
        .item(&mi(app, "tbl_col_right", "右侧插入列", None)?)
        .separator()
        .item(&mi(app, "tbl_row_del", "删除当前行", None)?)
        .item(&mi(app, "tbl_col_del", "删除当前列", None)?)
        .separator()
        .item(&mi(app, "tbl_align_left", "本列左对齐", None)?)
        .item(&mi(app, "tbl_align_center", "本列居中", None)?)
        .item(&mi(app, "tbl_align_right", "本列右对齐", None)?)
        .separator()
        .item(&mi(app, "tbl_format", "格式化表格", None)?)
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
        .item(&table_sub)
        .item(&mi(app, "fmt_footnote", "脚注", None)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "视图")
        .item(&mi(app, "view_editor", "源码", Some("CmdOrCtrl+1"))?)
        .item(&mi(app, "view_split", "分栏", Some("CmdOrCtrl+2"))?)
        .item(&mi(app, "view_preview", "预览", Some("CmdOrCtrl+3"))?)
        .separator()
        .item(&mi(app, "chat_toggle", "AI 对话", Some("CmdOrCtrl+J"))?)
        .item(&mi(app, "view_focus", "专注模式", Some("Shift+CmdOrCtrl+F"))?)
        .item(&mi(app, "view_completion", "AI 代码补全", None)?)
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
    let app = tauri::Builder::default()
        .setup(|app| {
            build_menu(app.handle())?;
            rebuild_recent_menu(app.handle()).map_err(|e| e.to_string())?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file,
            ai_get_config,
            ai_set_config,
            ai_list_models,
            ai_allow_base_url,
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
            code_runners_check,
            run_code,
            run_check,
            load_local_images,
            save_image_beside_doc,
            import_image_file,
            take_pending_open,
            autosave_write,
            autosave_read,
            autosave_clear,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // macOS 双击/拖放到 Dock 图标打开文件
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let p = path.to_string_lossy().to_string();
                    PENDING_OPEN.lock().unwrap().push(p.clone());
                    let _ = app.emit("file-opened", p);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn utf8_survives_a_split_han_character() {
        let bytes = "你".as_bytes();
        assert_eq!(bytes, &[0xE4, 0xBD, 0xA0]);
        let mut text = String::new();
        let mut pending = Vec::new();
        append_utf8(&mut text, &mut pending, &bytes[..1]);
        assert_eq!(text, "");
        append_utf8(&mut text, &mut pending, &bytes[1..2]);
        assert_eq!(text, "");
        append_utf8(&mut text, &mut pending, &bytes[2..]);
        assert_eq!(text, "你");
        assert!(pending.is_empty());
    }

    #[test]
    fn utf8_replaces_an_invalid_byte() {
        let mut text = String::new();
        let mut pending = Vec::new();
        append_utf8(&mut text, &mut pending, &[0xFF, b'A']);
        assert_eq!(text, "\u{FFFD}A");
        assert!(pending.is_empty());
    }

    #[test]
    fn sse_delta_keeps_content() {
        let delta = parse_sse_data(r#"{"choices":[{"delta":{"content":"你好","reasoning_content":"想"}}]}"#);
        assert!(!delta.done);
        assert_eq!(delta.content, "你好");
        assert_eq!(delta.reasoning, "想");
        assert!(parse_sse_data("[DONE]").done);
    }

    #[test]
    fn image_mime_distinguishes_jpeg() {
        assert_eq!(image_mime("plot.jpg"), Some("image/jpeg"));
        assert_eq!(image_mime("plot.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime("plot.png"), Some("image/png"));
        assert_eq!(image_mime("plot.svg"), Some("image/svg+xml"));
        assert_eq!(image_mime("plot.GIF"), Some("image/gif"));
        assert_eq!(image_mime("dir/plot.webp"), Some("image/webp"));
        assert_eq!(image_mime("notes.txt"), None);
    }

    #[test]
    fn base_url_rejects_non_http() {
        assert!(validate_base_url("file:///etc/passwd").is_err());
        assert!(validate_base_url("http://").is_err());
        assert_eq!(
            validate_base_url("http://localhost:11434/v1/").unwrap(),
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn atomic_write_replaces_the_whole_file() {
        let dir = TempDir::new("test-write").unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, "old").unwrap();
        atomic_write(&path, b"new content").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new content");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn local_image_reads_a_file_beside_the_document() {
        let dir = TempDir::new("img").unwrap();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "").unwrap();
        fs::write(dir.path().join("my plot.png"), b"png-bytes").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub").join("a.gif"), b"GIF").unwrap();
        let got = load_local_images(
            doc.to_string_lossy().into(),
            vec![
                "my%20plot.png".into(),
                "sub/a.gif".into(),
                "https://example.com/a.png".into(),
                "missing.png".into(),
                "notes.txt".into(),
            ],
        );
        assert!(got[0].starts_with("data:image/png;base64,"));
        assert!(got[1].starts_with("data:image/gif;base64,"));
        assert_eq!(&got[2..], &["", "", ""]);
    }

    #[test]
    fn import_keeps_or_copies_an_image_beside_the_document() {
        let dir = TempDir::new("img").unwrap();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "").unwrap();
        let beside = dir.path().join("plot.png");
        fs::write(&beside, b"png").unwrap();
        let kept = import_image_file(doc.to_string_lossy().into(), beside.to_string_lossy().into()).unwrap();
        assert_eq!(kept, "plot.png");

        let outside = TempDir::new("img-out").unwrap();
        let src = outside.path().join("shot.png");
        fs::write(&src, b"shot").unwrap();
        let copied = import_image_file(doc.to_string_lossy().into(), src.to_string_lossy().into()).unwrap();
        assert_eq!(copied, "shot.png");
        assert_eq!(fs::read(dir.path().join("shot.png")).unwrap(), b"shot");

        let pasted = save_image_beside_doc(
            doc.to_string_lossy().into(),
            base64::engine::general_purpose::STANDARD.encode(b"paste"),
            "png".into(),
        )
        .unwrap();
        assert_eq!(pasted, "mdpad-image-1.png");
        assert_eq!(fs::read(dir.path().join(&pasted)).unwrap(), b"paste");
    }

    #[test]
    fn capture_cap_marks_truncation() {
        let mut kept = Vec::new();
        let mut truncated = false;
        push_capped(&mut kept, &mut truncated, b"abcdef", 4);
        assert_eq!(kept, b"abcd");
        assert!(truncated);
    }

    #[tokio::test]
    async fn timeout_kills_the_child() {
        let started = std::time::Instant::now();
        let captured = run_captured(
            "/bin/sleep",
            &["30".into()],
            Path::new("."),
            std::time::Duration::from_millis(400),
        )
        .await
        .unwrap();
        assert!(captured.timed_out);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(3),
            "elapsed {:?}",
            started.elapsed()
        );
    }
}
