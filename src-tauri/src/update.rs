//! Uygulama içi güncelleme.
//!
//! Frontend Tauri IPC kullanmadığı için akışın tamamı burada, Rust tarafındadır. Sidecar `REQSTER_READY`
//! olduktan sonra pencere hemen uygulamaya geçmez: açılış ekranında (`ui/index.html`) "Güncellemeler
//! denetleniyor" yazılır ve `plugins.updater.endpoints`'teki `latest.json` en fazla
//! [`STARTUP_CHECK_BUDGET`] kadar beklenir. Güncelleme varsa diyalog açılış ekranındayken sorulur ve
//! seçim yapılmadan uygulama açılmaz: "Şimdi kur" / "Sonra". Kurulu sürüm manifestteki `minimumVersion`'ın
//! altındaysa güncelleme **zorunludur**: diyalog yalnızca "Şimdi kur" / "Çık" sunar. Süre dolarsa (ağ yok,
//! proxy yavaş) uygulama açılır, denetim arka planda biter ve bulursa normal diyalogla sorar. Uygulama açık
//! kaldığı sürece denetim günde bir yinelenir; o turlarda bulunan zorunlu güncelleme de yalnızca sorulur,
//! zorunluluk bir sonraki açılışta uygulanır (çalışan oturum bozulmasın). Denetim kapatılamaz.
//!
//! Hiçbir denetim hatası uygulamayı engellemez: loga düşer ve uygulama açılır.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{kill_sidecar, rlog, Sidecar, MAIN_WINDOW};

/// Açılış ekranında güncelleme denetimine tanınan süre; dolunca uygulama açılır, denetim arka planda biter.
const STARTUP_CHECK_BUDGET: Duration = Duration::from_secs(5);
/// Güncelleme yoksa açılış ekranı kabuk başladığından beri en az bu kadar görünür; denetim çok hızlı bittiğinde
/// ekran bir an görünüp kaybolmasın (son anda durum satırı "Güncel" yazar). Güncelleme varsa beklenmez.
const MIN_SPLASH: Duration = Duration::from_millis(1200);

/// Kabuğun başladığı an (`mark_start`, setup'ta); açılış ekranının en az süresi buna göre hesaplanır.
static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

pub(crate) fn mark_start() {
    let _ = STARTED.set(std::time::Instant::now());
}

/// En az süreden geriye kalan bekleme (geçtiyse sıfır).
fn splash_remaining(elapsed: Duration) -> Duration {
    MIN_SPLASH.saturating_sub(elapsed)
}
/// Uygulama açık kaldığı sürece denetim bu aralıkla yinelenir.
const RECHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Sidecar'a yerel HTTP istekleri için zaman aşımı.
const LOCAL_HTTP_TIMEOUT: Duration = Duration::from_secs(5);
/// Manifest ve paket indirme için zaman aşımı (yavaş kurumsal proxy'ler için geniş).
const UPDATER_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Diyalogda gösterilen sürüm notlarının en fazla uzunluğu (karakter).
const NOTES_MAX_CHARS: usize = 300;
const WINDOW_TITLE: &str = "Reqster";

/// `network.verify_tls` ayarı (`GET /api/settings`, düz anahtarlar); eksik/bozuksa doğrulama açık.
fn verify_tls_from_settings(value: &serde_json::Value) -> bool {
    value["network.verify_tls"].as_bool().unwrap_or(true)
}

/// Manifestin (`latest.json`) üst düzeyindeki `minimumVersion`: kurulu sürüm bunun altındaysa güncelleme
/// zorunludur. Alan yoksa ya da sürümler semver değilse zorunlu değildir.
fn is_required(current_version: &str, manifest: &serde_json::Value) -> bool {
    let Some(minimum) = manifest["minimumVersion"].as_str() else { return false };
    match (semver::Version::parse(current_version), semver::Version::parse(minimum)) {
        (Ok(current), Ok(minimum)) => current < minimum,
        _ => false,
    }
}

/// Açılış ekranındaki durum satırını değiştirir (`ui/index.html` → `window.__reqsterStatus`). Pencere uygulamaya
/// geçtiyse işlev tanımsızdır ve çağrı hiçbir şey yapmaz.
fn splash_status(app: &AppHandle, text: &str) {
    splash_eval(app, text, false);
}

/// Son durum (ör. "Güncel"): nokta animasyonu durur.
fn splash_done(app: &AppHandle, text: &str) {
    splash_eval(app, text, true);
}

fn splash_eval(app: &AppHandle, text: &str, done: bool) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let arg = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
        let _ = window.eval(format!("window.__reqsterStatus && window.__reqsterStatus({arg}, {done})"));
    }
}

/// READY adresini (`http://127.0.0.1:<port>/?reqster_token=<t>`) taban adres + oturum token'ına ayırır.
/// Token yalnızca yerel API çağrılarında `X-Reqster-Token` başlığıyla kullanılır, loglanmaz.
pub(crate) fn split_ready_url(ready: &str) -> Option<(String, Option<String>)> {
    let url = Url::parse(ready).ok()?;
    let token = url
        .query_pairs()
        .find(|(k, _)| k == "reqster_token")
        .map(|(_, v)| v.into_owned());
    let mut base = url;
    base.set_query(None);
    base.set_fragment(None);
    Some((base.to_string(), token))
}

/// READY sonrası çağrılır. Açılış denetimini yapar, sonra `open_app` ile pencereyi uygulamaya geçirir (tam bir kez)
/// ve günlük denetimleri sürdürür. Zorunlu güncelleme reddedilirse uygulama kapanır, `open_app` çağrılmaz.
pub(crate) fn startup(
    app: AppHandle,
    server_url: String,
    token: Option<String>,
    open_app: Box<dyn FnOnce() + Send + 'static>,
) {
    // reqwest bu projede `rustls-no-provider` ile derlenir (updater eklentisinin seçimi) ve eklenti kripto
    // sağlayıcıyı ancak kendi `check()` çağrısında kurar. Bizim yerel HTTP istemcimiz ondan önce kurulduğu
    // için rustls "no CryptoProvider" paniği atıyor, `panic = "abort"` süreci sessizce öldürüyordu
    // (rc.9 Windows'ta açılıp kapanıyordu; Linux'ta aynı abort yeniden üretildi). Sağlayıcı burada kurulur.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    tauri::async_runtime::spawn(async move {
        // "Sonra" denen sürüm; aynı sürüm için bu oturumda tekrar sorulmaz.
        let mut declined: Option<String> = None;

        rlog!("[reqster] güncelleme: açılış denetimi (en fazla {} sn)", STARTUP_CHECK_BUDGET.as_secs());
        splash_status(&app, "Güncellemeler denetleniyor");
        let mut pending = {
            let (app, server_url, token) = (app.clone(), server_url.clone(), token.clone());
            tauri::async_runtime::spawn(async move { find_update(&app, &server_url, token.as_deref()).await })
        };
        match tokio::time::timeout(STARTUP_CHECK_BUDGET, &mut pending).await {
            Ok(found) => {
                if let Some(update) = found.ok().flatten() {
                    if is_required(&update.current_version, &update.raw_json) {
                        rlog!("[reqster] güncelleme: {} zorunlu (minimumVersion)", update.version);
                        if !ask_required(&app, &update).await {
                            rlog!("[reqster] güncelleme: zorunlu güncelleme reddedildi, uygulama kapanıyor");
                            app.exit(0);
                            return;
                        }
                        install(&app, update).await;
                        // buraya ancak kurulum başarısızsa gelinir: kullanıcı kilitli kalmasın, uygulama açılır
                    } else if ask_install(&app, &update, false).await {
                        install(&app, update).await;
                    } else {
                        declined = Some(update.version.clone());
                    }
                } else {
                    splash_done(&app, "Güncel");
                    let elapsed = STARTED.get().map_or(MIN_SPLASH, |t| t.elapsed());
                    tokio::time::sleep(splash_remaining(elapsed)).await;
                }
                open_app();
            }
            Err(_) => {
                rlog!("[reqster] güncelleme: açılış süresi doldu, uygulama açılıyor; denetim arka planda sürüyor");
                open_app();
                if let Some(update) = pending.await.ok().flatten() {
                    offer(&app, update, &mut declined).await;
                }
            }
        }

        loop {
            tokio::time::sleep(RECHECK_INTERVAL).await;
            if let Some(update) = find_update(&app, &server_url, token.as_deref()).await {
                offer(&app, update, &mut declined).await;
            }
        }
    });
}

/// Uygulama açıkken bulunan güncellemeyi sorar. Zorunlu olsa da çalışan oturum kilitlenmez; zorunluluk bir sonraki
/// açılışta açılış ekranında uygulanır.
async fn offer(app: &AppHandle, update: Update, declined: &mut Option<String>) {
    if !should_prompt(declined.as_deref(), &update.version) {
        rlog!("[reqster] güncelleme: {} bu oturumda ertelendi, tekrar sorulmuyor", update.version);
        return;
    }
    let required = is_required(&update.current_version, &update.raw_json);
    if ask_install(app, &update, required).await {
        install(app, update).await;
    } else {
        *declined = Some(update.version.clone());
    }
}

/// Tek bir denetim: yerel ayarları ve aktif proxy'yi sidecar'dan okur, manifesti denetler. Her hata loglanır,
/// `None` döner.
async fn find_update(app: &AppHandle, server_url: &str, token: Option<&str>) -> Option<Update> {
    rlog!("[reqster] güncelleme: denetim başlıyor");
    let local = match reqwest::Client::builder()
        .no_proxy() // 127.0.0.1 isteği ortamdaki/sistemdeki proxy'ye asla gitmesin
        .timeout(LOCAL_HTTP_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            rlog!("[reqster] güncelleme: yerel HTTP istemcisi kurulamadı: {err}");
            return None;
        }
    };

    let verify_tls = match get_json(&local, &format!("{server_url}api/settings"), token).await {
        Ok(value) => {
            rlog!("[reqster] güncelleme: ayarlar okundu");
            verify_tls_from_settings(&value)
        }
        Err(err) => {
            rlog!("[reqster] güncelleme: ayarlar okunamadı ({err}), varsayılanla devam");
            true
        }
    };

    // Aktif proxy (kimlik bilgisi dahil); uç yoksa / hata verirse proxy'siz devam.
    let proxy = match get_json(&local, &format!("{server_url}api/internal/proxy-url"), token).await {
        Ok(value) => value["url"]
            .as_str()
            .and_then(|raw| match Url::parse(raw) {
                Ok(url) => Some(url),
                Err(err) => {
                    rlog!("[reqster] güncelleme: proxy adresi çözülemedi ({err}), proxy'siz devam");
                    None
                }
            }),
        Err(err) => {
            rlog!("[reqster] güncelleme: proxy bilgisi alınamadı ({err}), proxy'siz devam");
            None
        }
    };

    rlog!("[reqster] güncelleme: manifest denetleniyor (proxy: {})", if proxy.is_some() { "var" } else { "yok" });
    match check(app, proxy, verify_tls).await {
        Ok(Some(update)) => {
            rlog!(
                "[reqster] güncelleme: {} → {} bulundu ({})",
                update.current_version, update.version, update.download_url
            );
            Some(update)
        }
        Ok(None) => {
            rlog!("[reqster] güncelleme: yeni sürüm yok");
            None
        }
        Err(err) => {
            rlog!("[reqster] güncelleme: denetim başarısız: {err}");
            None
        }
    }
}

async fn get_json(client: &reqwest::Client, url: &str, token: Option<&str>) -> reqwest::Result<serde_json::Value> {
    let mut request = client.get(url);
    if let Some(token) = token {
        request = request.header("X-Reqster-Token", token);
    }
    request
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await
}

/// Updater'ı kurup manifesti denetler. `verify_tls=false` ayarı (kurumsal TLS araya girme
/// sertifikaları için) updater istemcisine de yansıtılır; paketin bütünlüğünü TLS değil minisign
/// imzası korur.
async fn check(
    app: &AppHandle,
    proxy: Option<Url>,
    verify_tls: bool,
) -> tauri_plugin_updater::Result<Option<Update>> {
    let mut builder = app.updater_builder().timeout(UPDATER_TIMEOUT);
    if let Some(proxy) = proxy {
        rlog!(
            "[reqster] güncelleme: proxy kullanılıyor: {}://{}",
            proxy.scheme(),
            proxy.host_str().unwrap_or("?")
        );
        builder = builder.proxy(proxy);
    }
    if !verify_tls {
        rlog!("[reqster] güncelleme: network.verify_tls kapalı, sertifika doğrulaması yapılmıyor");
        builder = builder.configure_client(|client| client.danger_accept_invalid_certs(true));
    }
    // Windows'ta kurulum `std::process::exit(0)` ile biter; o anda sidecar hâlâ yaşıyorsa
    // `reqster-server.exe` kilitli kalır ve NSIS dosyayı değiştiremez. Varsayılan kanca
    // (`cleanup_before_exit`) sidecar'ı bilmez, bu yüzden ikisini birlikte çağırıyoruz.
    let exit_handle = app.clone();
    builder = builder.on_before_exit(move || {
        kill_sidecar(&exit_handle);
        exit_handle.cleanup_before_exit();
    });
    builder.build()?.check().await
}

/// "Sonra" denen sürüm için yeniden sorulmaz; başka bir sürüm çıkarsa yine sorulur.
fn should_prompt(declined: Option<&str>, version: &str) -> bool {
    declined != Some(version)
}

/// İki düğmeli yerel diyalog. `true` = "Şimdi kur". `required` ise (uygulama açıkken bulunan zorunlu güncelleme)
/// mesaj bir sonraki açılışta kurulmasının zorunlu olacağını söyler.
async fn ask_install(app: &AppHandle, update: &Update, required: bool) -> bool {
    let mut message = update_message(&update.version, &update.current_version, update.body.as_deref());
    if required {
        message.push_str("\n\nBu güncelleme zorunludur: şimdi kurmazsanız Reqster bir sonraki açılışta kurulmadan açılmaz.");
    }
    let dialog = app
        .dialog()
        .message(message)
        .title("Reqster güncellemesi")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Şimdi kur".into(),
            "Sonra".into(),
        ));
    // blocking_show ana iş parçacığında çağrılamaz; async görevdeyiz ama tokio işçisini de
    // kilitlemeyelim.
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .unwrap_or(false)
}

/// Zorunlu güncelleme diyaloğu (açılış ekranında). `true` = "Şimdi kur", `false` = "Çık" (pencere kapatma dahil).
async fn ask_required(app: &AppHandle, update: &Update) -> bool {
    let mut message = update_message(&update.version, &update.current_version, update.body.as_deref());
    message.push_str("\n\nBu güncelleme zorunludur; kurulmadan Reqster kullanılamaz.");
    let dialog = app
        .dialog()
        .message(message)
        .title("Reqster güncellemesi (zorunlu)")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Şimdi kur".into(), "Çık".into()));
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .unwrap_or(false)
}

fn update_message(new_version: &str, current_version: &str, notes: Option<&str>) -> String {
    let mut message = format!("Reqster {new_version} hazır (şu an {current_version}).");
    if let Some(notes) = notes.map(str::trim).filter(|n| !n.is_empty()) {
        message.push_str("\n\n");
        message.push_str(&truncate_chars(notes, NOTES_MAX_CHARS));
    }
    message
}

/// Karakter (bayt değil) sınırında kırpar; Türkçe harfleri ortadan bölmez.
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// İndirir (imza doğrulamalı), kurar ve yeniden başlatır. İlerleme pencere başlığına yazılır.
///
/// - Windows: `download_and_install` NSIS'i `/S /UPDATE /R` (installMode `quiet`: pencere yok, kurulum
///   kullanıcı hesabına olduğu için yönetici izni de istemez) ile açıp süreci sonlandırır, bu fonksiyon geri
///   dönmez; `/R` kurulum bitince uygulamayı yeniden açar. Mod kurulu sürümün config'inden okunur.
/// - macOS: .app yerine yenisi konur, ardından `app.restart()` (RunEvent::Exit → sidecar öldürülür).
async fn install(app: &AppHandle, update: Update) {
    let window = app.get_webview_window(MAIN_WINDOW);
    let set_title = |title: &str| {
        if let Some(window) = &window {
            let _ = window.set_title(title);
        }
    };

    set_title("Reqster — güncelleme indiriliyor");
    splash_status(app, "Güncelleme indiriliyor");
    let downloaded = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let last_percent = Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX));
    let progress_window = window.clone();
    let install_window = window.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                let done = downloaded.fetch_add(chunk, Ordering::Relaxed) + chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let percent = (done as u64 * 100 / total).min(100);
                    if last_percent.swap(percent, Ordering::Relaxed) != percent {
                        if let Some(window) = &progress_window {
                            let _ = window
                                .set_title(&format!("Reqster — güncelleme indiriliyor %{percent}"));
                            let _ = window.eval(format!(
                                "window.__reqsterStatus && window.__reqsterStatus('Güncelleme indiriliyor %{percent}')"
                            ));
                        }
                    }
                }
            },
            || {
                rlog!("[reqster] güncelleme: indirme tamamlandı, imza doğrulandı, kuruluyor");
                if let Some(window) = &install_window {
                    let _ = window.eval("window.__reqsterStatus && window.__reqsterStatus('Güncelleme kuruluyor')");
                }
            },
        )
        .await;

    match result {
        Ok(()) => {
            rlog!("[reqster] güncelleme: kuruldu, yeniden başlatılıyor");
            set_title(WINDOW_TITLE);
            // Ana iş parçacığında değiliz: request_exit → RunEvent::Exit → kill_sidecar → yeniden aç.
            app.restart();
        }
        Err(err) => {
            rlog!("[reqster] güncelleme: kurulum başarısız: {err}");
            set_title(WINDOW_TITLE);
            // Windows'ta on_before_exit koştuktan sonra (kurucu açılamadıysa) sidecar ölmüştür;
            // o durumda uygulama çalışmaya devam edemez, kullanıcıya söyle.
            let sidecar_gone = app
                .try_state::<Sidecar>()
                .is_some_and(|s| s.closing.load(Ordering::SeqCst));
            let tail = if sidecar_gone {
                "Yerel sunucu kapatıldı; lütfen Reqster'ı kapatıp yeniden açın."
            } else {
                "Uygulama çalışmaya devam ediyor."
            };
            app.dialog()
                .message(format!("Güncelleme kurulamadı: {err}\n\n{tail}"))
                .title("Reqster güncellemesi")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ready_url_split_into_base_and_token() {
        let (base, token) = super::split_ready_url("http://127.0.0.1:4100/?reqster_token=abc123").unwrap();
        assert_eq!(base, "http://127.0.0.1:4100/");
        assert_eq!(token.as_deref(), Some("abc123"));
        let (base, token) = super::split_ready_url("http://127.0.0.1:4100/").unwrap();
        assert_eq!(base, "http://127.0.0.1:4100/");
        assert_eq!(token, None);
    }

    use super::*;

    #[test]
    fn ertelenen_surum_tekrar_sorulmaz_farkli_surum_sorulur() {
        assert!(should_prompt(None, "1.0.0"));
        assert!(!should_prompt(Some("1.0.0"), "1.0.0"));
        assert!(should_prompt(Some("1.0.0"), "1.0.1"));
    }

    #[test]
    fn acilis_ekrani_en_az_sureyi_tamamlar() {
        assert_eq!(splash_remaining(Duration::from_millis(300)), Duration::from_millis(900));
        assert_eq!(splash_remaining(MIN_SPLASH), Duration::ZERO);
        assert_eq!(splash_remaining(Duration::from_secs(4)), Duration::ZERO); // yavaş açılışa ek bekleme yok
    }

    #[test]
    fn tls_ayari_eksikse_dogrulama_acik() {
        assert!(verify_tls_from_settings(&serde_json::json!({})));
        assert!(!verify_tls_from_settings(&serde_json::json!({ "network.verify_tls": false })));
        // eski sürümlerden kalan update.auto_check artık denetimi kapatmaz (yok sayılır)
        assert!(verify_tls_from_settings(&serde_json::json!({ "update.auto_check": false })));
    }

    #[test]
    fn asgari_surumun_altindaki_kurulum_zorunlu_gunceller() {
        let manifest = serde_json::json!({ "version": "1.0.0-rc.30", "minimumVersion": "1.0.0-rc.25" });
        assert!(is_required("1.0.0-rc.24", &manifest));
        assert!(is_required("1.0.0-rc.9", &manifest)); // sayısal karşılaştırma, sözlüksel değil
        assert!(!is_required("1.0.0-rc.25", &manifest)); // asgari sürümün kendisi zorunlu değil
        assert!(!is_required("1.0.0-rc.26", &manifest));
        assert!(!is_required("1.0.0-rc.24", &serde_json::json!({ "version": "1.0.0-rc.30" })));
        assert!(!is_required("1.0.0-rc.24", &serde_json::json!({ "minimumVersion": "bozuk" })));
        assert!(!is_required("1.0.0-rc.24", &serde_json::json!({ "minimumVersion": 25 })));
    }

    #[test]
    fn mesaj_notlari_karakter_sinirinda_kirpar() {
        let notes = "ğ".repeat(NOTES_MAX_CHARS + 50);
        let message = update_message("1.0.1", "1.0.0", Some(&notes));
        assert!(message.starts_with("Reqster 1.0.1 hazır (şu an 1.0.0)."));
        let shown = message.split("\n\n").nth(1).unwrap();
        assert_eq!(shown.chars().count(), NOTES_MAX_CHARS + 1); // + "…"
        assert!(shown.ends_with('…'));
        assert_eq!(
            update_message("1.0.1", "1.0.0", Some("  ")),
            "Reqster 1.0.1 hazır (şu an 1.0.0)."
        );
    }

    /// Updater'ın kuralı `release.version > current` (tauri-plugin-updater updater.rs);
    /// rc dizisinin bu kuralla ilerleyebildiğini belgeler.
    #[test]
    fn on_surum_siralamasi_updater_kuraliyla_uyumlu() {
        use semver::Version;
        let rc8 = Version::parse("1.0.0-rc.8").unwrap();
        assert!(Version::parse("1.0.0-rc.9").unwrap() > rc8);
        assert!(Version::parse("1.0.0-rc.10").unwrap() > rc8); // sayısal, sözlüksel değil
        assert!(Version::parse("1.0.0").unwrap() > rc8);
        assert!(!(Version::parse("1.0.0-rc.8").unwrap() > rc8)); // aynı sürüm → güncelleme yok
    }
}
