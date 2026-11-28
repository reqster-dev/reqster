//! Reqster masaüstü kabuğu.
//!
//! Kabuk, Node tabanlı sunucuyu (`binaries/reqster-server-<triple>`) Tauri sidecar'ı olarak başlatır,
//! stdout'ta `REQSTER_READY <url>` satırını bekler, ana pencereyi o adrese yönlendirir ve uygulama
//! kapanırken sidecar'ı öldürür. Frontend ile Tauri IPC üzerinden konuşulmaz; pencere yalnızca
//! sidecar'ın sunduğu harici URL'yi yükler. Sözleşme: scratchpad `tauri-protokol.md` §1–3.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod bundle_name;
mod download;
mod logging;
mod old_identifier;
mod picker;
mod update;

/// Sidecar'ın hazır olduğunu bildiren stdout satırının öneki (sözleşme §2).
const READY_PREFIX: &str = "REQSTER_READY ";
/// READY satırı bu süre içinde gelmezse başlatma başarısız sayılır.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
/// Hata diyaloğunda gösterilecek son stderr satırı sayısı.
const STDERR_TAIL_LINES: usize = 20;
pub(crate) const MAIN_WINDOW: &str = "main";

/// Hata diyaloğu süreç boyunca en fazla bir kez gösterilir.
static FAILURE_REPORTED: AtomicBool = AtomicBool::new(false);

/// Çalışan sidecar süreci. `CommandChild` düşürülürse stdin pipe'ı kapanır ve sunucu kendini
/// kapatır (sözleşme §3); bu yüzden süreç uygulama boyunca state içinde tutulur.
pub(crate) struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    /// Kabuk kendi isteğiyle kapanıyor (ya da güncelleme için öldürüldü); sonrasında gelen
    /// `Terminated` bir çökme değildir.
    pub(crate) closing: AtomicBool,
}

/// Sidecar olay döngüsünün paylaşılan durumu (okuyucu görevi + zaman aşımı iş parçacığı).
struct Watch {
    ready: AtomicBool,
    stderr_tail: Mutex<VecDeque<String>>,
}

impl Watch {
    fn push_stderr(&self, line: String) {
        let mut tail = self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
        if tail.len() == STDERR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }

    fn stderr_text(&self) -> String {
        let tail = self.stderr_tail.lock().unwrap_or_else(|e| e.into_inner());
        tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(picker::LocalServer::default())
        .manage(Sidecar {
            child: Mutex::new(None),
            closing: AtomicBool::new(false),
        })
        .setup(|app| {
            update::mark_start(); // açılış ekranının en az görünme süresi buradan sayılır
            let handle = app.handle().clone();
            // Kabuk logu: stderr + <veri klasörü>/logs/shell.log (Windows'ta tek teşhis kaynağı)
            match user_data_dir(&handle) {
                Ok(dir) => logging::init(dir.join("logs"), app.package_info().version.to_string().as_str()),
                Err(err) => crate::rlog!("[reqster] veri klasörü çözülemedi, dosya logu yok: {err}"),
            }

            // macOS: eski `Reqly.app` paketi `Reqster.app` olur ve uygulama yeni yoldan yeniden açılır
            if bundle_name::adopt_new_bundle_name() {
                std::process::exit(0);
            }

            old_identifier::remove_stale_cache(app.handle());

            // Ana pencere config'te `create: false`; indirme olayını yakalamak için (dışa aktarmada
            // "Farklı kaydet") builder ile burada kurulur
            let window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == MAIN_WINDOW)
                .cloned()
                .ok_or("tauri.conf.json'da ana pencere tanımı yok")?;
            WebviewWindowBuilder::from_config(&handle, &window_config)?
                .on_download(download::handle)
                .build()?;

            // Yalnızca debug derlemede: geliştirici `npm run dev` + `cargo run` ile çalışıyorsa
            // sidecar başlatmadan doğrudan verilen adrese git.
            #[cfg(debug_assertions)]
            if let Ok(dev_url) = std::env::var("REQSTER_DEV_URL") {
                crate::rlog!("[reqster] REQSTER_DEV_URL verildi, sidecar başlatılmıyor: {dev_url}");
                navigate_main(&handle, &dev_url)?;
                return Ok(());
            }

            if let Err(err) = start_sidecar(&handle) {
                report_failure(&handle, &format!("Sidecar başlatılamadı: {err}"), "");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Ana pencere kapatılırken sidecar'ı hemen öldür (çıkış olayını beklemeden).
            if window.label() == MAIN_WINDOW && matches!(event, WindowEvent::CloseRequested { .. }) {
                kill_sidecar(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("Reqster kabuğu oluşturulamadı")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                kill_sidecar(app);
            }
        });
}

/// Kullanıcı verisinin (veritabanı, loglar) klasörü: Windows `%APPDATA%\Reqster`, macOS
/// `~/Library/Application Support/Reqster`, Linux `~/.local/share/Reqster`. Uygulama kimliğinden
/// (`app_data_dir`) bilerek bağımsızdır; kimlik değişse de veri yerinde kalır.
fn user_data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().data_dir()?.join("Reqster"))
}

/// Sidecar'ı sözleşme §1'deki ortam değişkenleriyle başlatır ve olay döngüsünü kurar.
fn start_sidecar(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let resources_dir = app.path().resource_dir()?.join("resources");
    let data_dir = user_data_dir(app)?;
    std::fs::create_dir_all(&data_dir)?;

    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert(
        "REQSTER_RESOURCES_DIR".into(),
        resources_dir.to_string_lossy().into_owned(),
    );
    envs.insert("REQSTER_DATA_DIR".into(), data_dir.to_string_lossy().into_owned());
    envs.insert("REQSTER_PORT".into(), "0".into());
    envs.insert("REQSTER_SIDECAR".into(), "1".into());

    // tauri-plugin-shell stdin'i her zaman pipe olarak açar; CommandChild yaşadığı sürece açık kalır.
    // Süreç grubu (POSIX) / job object (Windows): kill() sunucuyla birlikte onun açtığı script
    // worker'ını da öldürür, yetim kalmaz. kill_on_drop güvenlik ağıdır (state beklenmedik düşerse).
    let (rx, child) = app
        .shell()
        .sidecar("reqster-server")?
        .envs(envs)
        .set_process_group(true)
        .kill_on_drop(true)
        .spawn()?;

    let sidecar = app.state::<Sidecar>();
    *sidecar.child.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

    watch_sidecar(app.clone(), rx);
    Ok(())
}

/// Sidecar çıktısını izler: READY satırında pencereyi yönlendirir, stderr'i geçirir,
/// erken sonlanma ya da zaman aşımında hata diyaloğu gösterip uygulamayı kapatır.
fn watch_sidecar(app: AppHandle, mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
    let watch = Arc::new(Watch {
        ready: AtomicBool::new(false),
        stderr_tail: Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)),
    });

    // Zaman aşımı: tokio'ya ayrı bağımlılık eklemek yerine basit bir iş parçacığı.
    {
        let app = app.clone();
        let watch = Arc::clone(&watch);
        thread::spawn(move || {
            thread::sleep(READY_TIMEOUT);
            if !watch.ready.load(Ordering::SeqCst) {
                report_failure(
                    &app,
                    &format!(
                        "Sunucu {} saniye içinde hazır sinyali vermedi.",
                        READY_TIMEOUT.as_secs()
                    ),
                    &watch.stderr_text(),
                );
            }
        });
    }

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end_matches(['\r', '\n']);
                    if let Some(url) = line.strip_prefix(READY_PREFIX) {
                        let url = url.trim();
                        // Adres oturum token'ını taşır: loga/diyaloğa yalnızca taban adres yazılır.
                        let (base, token) = update::split_ready_url(url).unwrap_or_else(|| (url.to_owned(), None));
                        crate::rlog!(
                            "[reqster] sunucu hazır: {base} (oturum token'ı: {})",
                            if token.is_some() { "var" } else { "yok" }
                        );
                        watch.ready.store(true, Ordering::SeqCst);
                        app.state::<picker::LocalServer>().set(base.clone(), token.clone());
                        // Pencere açılış ekranında kalır: önce güncelleme denetlenir (en fazla birkaç sn), sonra
                        // `open_app` uygulamaya geçirir (bkz. update.rs). Zorunlu güncelleme reddedilirse hiç geçmez.
                        let open_app = {
                            let (app, watch, url, base) = (app.clone(), Arc::clone(&watch), url.to_owned(), base.clone());
                            Box::new(move || {
                                crate::rlog!("[reqster] açılış ekranı kapanıyor, uygulama yükleniyor");
                                if let Err(err) = navigate_main(&app, &url) {
                                    report_failure(
                                        &app,
                                        &format!("Pencere sunucu adresine yönlendirilemedi ({base}): {err}"),
                                        &watch.stderr_text(),
                                    );
                                }
                            })
                        };
                        update::startup(app.clone(), base, token, open_app);
                    } else if let Some(id) = line.strip_prefix(picker::PICK_FILE_PREFIX) {
                        picker::pick_file(&app, id.trim().to_owned());
                    } else if !line.is_empty() {
                        crate::rlog!("[sidecar] {line}");
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end_matches(['\r', '\n']);
                    crate::rlog!("[sidecar] {line}");
                    watch.push_stderr(line.to_owned());
                }
                CommandEvent::Error(message) => {
                    crate::rlog!("[sidecar] hata: {message}");
                    watch.push_stderr(message);
                }
                CommandEvent::Terminated(payload) => {
                    if app.state::<Sidecar>().closing.load(Ordering::SeqCst) {
                        break; // kabuk kapanıyor, beklenen sonlanma
                    }
                    let reason = if watch.ready.load(Ordering::SeqCst) {
                        "Sunucu süreci beklenmedik biçimde sonlandı."
                    } else {
                        "Sunucu süreci hazır olmadan sonlandı."
                    };
                    let detail = match (payload.code, payload.signal) {
                        (Some(code), _) => format!("{reason} (çıkış kodu {code})"),
                        (None, Some(signal)) => format!("{reason} (sinyal {signal})"),
                        (None, None) => reason.to_owned(),
                    };
                    report_failure(&app, &detail, &watch.stderr_text());
                    break;
                }
                _ => {}
            }
        }
    });
}

/// Ana pencereyi verilen adrese yönlendirir.
fn navigate_main(app: &AppHandle, url: &str) -> tauri::Result<()> {
    let parsed = Url::parse(url).map_err(tauri::Error::InvalidUrl)?;
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| tauri::Error::WebviewNotFound)?;
    window.navigate(parsed)
}

/// Hata diyaloğunu bir kez gösterir; kullanıcı kapatınca uygulama 1 koduyla çıkar.
fn report_failure(app: &AppHandle, reason: &str, stderr_tail: &str) {
    let closing = app
        .try_state::<Sidecar>()
        .is_some_and(|s| s.closing.load(Ordering::SeqCst));
    if closing || FAILURE_REPORTED.swap(true, Ordering::SeqCst) {
        return; // kabuk zaten kapanıyor ya da diyalog gösterildi (zaman aşımı + çökme çakışabilir)
    }

    crate::rlog!("[reqster] HATA: {reason}");
    let mut message = format!("Reqster sunucusu başlatılamadı.\n\n{reason}");
    if !stderr_tail.is_empty() {
        message.push_str("\n\nSunucu çıktısı (son satırlar):\n");
        message.push_str(stderr_tail);
    }

    let exit_handle = app.clone();
    app.dialog()
        .message(message)
        .title("Reqster")
        .kind(MessageDialogKind::Error)
        .show(move |_| exit_handle.exit(1));
}

/// Sidecar'ı öldürür; yetim bırakmaz. Birden çok kez çağrılabilir (idempotent).
pub(crate) fn kill_sidecar(app: &AppHandle) {
    let Some(sidecar) = app.try_state::<Sidecar>() else {
        return;
    };
    sidecar.closing.store(true, Ordering::SeqCst);
    let child = sidecar.child.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(child) = child {
        if let Err(err) = child.kill() {
            crate::rlog!("[reqster] sidecar öldürülemedi: {err}");
        }
    }
}
