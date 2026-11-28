//! Uygulama kimliği 1.1.1'den sonra `tr.talhacigdem.reqly` yerine `dev.reqster.desktop` oldu. WebView
//! önbelleğini kimliğe göre adlandırılan klasörde tutar; eski kimliğin klasörleri artık kullanılmaz ve
//! açılışta silinir. Kullanıcı verisi (`user_data_dir`) kimlikten bağımsızdır ve bundan etkilenmez.
//!
//! Yalnızca önbellek konumlarına dokunulur. 1.0.0-rc.26 ve öncesinin veritabanı eski kimlik adlı VERİ
//! klasöründeydi (`%APPDATA%`, `~/Library/Application Support`); o klasör silinmez. Linux'ta yerel veri ve
//! veri klasörü aynı yer olduğu için orada hiçbir şey silinmez.

use std::path::PathBuf;

use tauri::AppHandle;
#[cfg(any(windows, target_os = "macos"))]
use tauri::Manager;

#[cfg(any(windows, target_os = "macos"))]
const OLD_IDENTIFIER: &str = "tr.talhacigdem.reqly";

/// Eski kimliğin WebView önbellek klasörleri (yoksa boş liste).
fn stale_dirs(app: &AppHandle) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        // %LOCALAPPDATA%\<kimlik>: WebView2 kullanıcı verisi (EBWebView)
        app.path().local_data_dir().map(|d| vec![d.join(OLD_IDENTIFIER)]).unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        app.path()
            .home_dir()
            .map(|home| {
                let library = home.join("Library");
                vec![
                    library.join("WebKit").join(OLD_IDENTIFIER),
                    library.join("Caches").join(OLD_IDENTIFIER),
                    library.join("HTTPStorages").join(OLD_IDENTIFIER),
                    library.join("Saved Application State").join(format!("{OLD_IDENTIFIER}.savedState")),
                ]
            })
            .unwrap_or_default()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Vec::new()
    }
}

/// Eski kimliğin önbellek klasörlerini arka planda siler; hata yalnızca loglanır.
pub(crate) fn remove_stale_cache(app: &AppHandle) {
    let dirs: Vec<PathBuf> = stale_dirs(app).into_iter().filter(|d| d.is_dir()).collect();
    if dirs.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        for dir in dirs {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => crate::rlog!("eski kimliğin önbelleği silindi: {}", dir.display()),
                Err(err) => crate::rlog!("eski kimliğin önbelleği silinemedi ({}): {err}", dir.display()),
            }
        }
    });
}
