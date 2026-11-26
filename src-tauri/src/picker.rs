//! form-data dosya alanı için yerel "dosya seç" diyaloğu.
//!
//! Sayfa Tauri IPC kullanmaz ve WebView seçilen dosyanın yolunu vermez. İstek sidecar üzerinden gelir:
//! sunucu stdout'a `REQSTER_PICK_FILE <id>` yazar (lib.rs yakalar), burada asenkron diyalog açılır ve sonuç
//! token'lı yerel API'ye (`POST /api/internal/picked-file`) bildirilir; iptalde `path: null`. İki kanal da
//! açılıştaki READY satırı ve updater'ın yerel çağrılarıyla aynıdır.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub(crate) const PICK_FILE_PREFIX: &str = "REQSTER_PICK_FILE ";
const LOCAL_HTTP_TIMEOUT: Duration = Duration::from_secs(5);

/// READY'de öğrenilen yerel sunucu adresi ve oturum token'ı (token loglanmaz)
#[derive(Default)]
pub(crate) struct LocalServer(Mutex<Option<(String, Option<String>)>>);

impl LocalServer {
    pub(crate) fn set(&self, base: String, token: Option<String>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((base, token));
    }

    fn get(&self) -> Option<(String, Option<String>)> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

pub(crate) fn pick_file(app: &AppHandle, id: String) {
    let Some((base, token)) = app.state::<LocalServer>().get() else {
        crate::rlog!("[reqster] dosya seçici: sunucu adresi henüz bilinmiyor, istek yok sayıldı");
        return;
    };
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) {
        dialog = dialog.set_parent(&window);
    }
    crate::rlog!("[reqster] dosya seçici açılıyor");
    dialog.pick_file(move |chosen| {
        let path = chosen.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned());
        crate::rlog!("[reqster] dosya seçici: {}", if path.is_some() { "dosya seçildi" } else { "iptal" });
        tauri::async_runtime::spawn(async move {
            if let Err(err) = report(&base, token.as_deref(), &id, path.as_deref()).await {
                crate::rlog!("[reqster] dosya seçici: sonuç sunucuya bildirilemedi: {err}");
            }
        });
    });
}

async fn report(base: &str, token: Option<&str>, id: &str, path: Option<&str>) -> reqwest::Result<()> {
    // Kripto sağlayıcı açılışta update::startup'ta kurulur (READY'den sonra buraya gelinir)
    let client = reqwest::Client::builder().no_proxy().timeout(LOCAL_HTTP_TIMEOUT).build()?;
    let mut request = client
        .post(format!("{base}api/internal/picked-file"))
        .json(&serde_json::json!({ "id": id, "path": path }));
    if let Some(token) = token {
        request = request.header("X-Reqster-Token", token);
    }
    request.send().await?.error_for_status()?;
    Ok(())
}
