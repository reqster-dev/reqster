//! Kabuk logu: her satır stderr'e VE `<veri klasörü>/logs/shell.log` dosyasına yazılır.
//! Windows'ta GUI uygulamasının stderr'i görünmez; kullanıcı çökme/kapanma teşhisi için bu dosyayı
//! gönderir. Panik kancası da buraya yazar: `panic = "abort"` profilinde süreç hemen öldüğü için
//! Olay Görüntüleyicisi'nde iz kalmayabiliyor, dosyada kalır. Dosya 1 MB'ı aşınca `shell.1.log` olarak
//! döndürülür (tek yedek). Bağımlılık yok; zaman damgası süreç başlangıcından geçen saniye.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

static STARTED: OnceLock<Instant> = OnceLock::new();
static FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();
const MAX_BYTES: u64 = 1024 * 1024;

/// Log dizinini açar; başarısız olursa yalnızca stderr kalır (uygulama bundan etkilenmez).
pub(crate) fn init(dir: PathBuf, app_version: &str) {
    STARTED.get_or_init(Instant::now);
    let path = dir.join("shell.log");
    let file = (|| -> std::io::Result<File> {
        fs::create_dir_all(&dir)?;
        if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
            let _ = fs::rename(&path, dir.join("shell.1.log"));
        }
        OpenOptions::new().create(true).append(true).open(&path)
    })();
    match file {
        Ok(f) => {
            let _ = FILE.set(Mutex::new(Some(f)));
            write(&format!(
                "[reqster] ---- başlangıç: Reqster {app_version}, {} {} ----",
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            write(&format!("[reqster] log dosyası: {}", path.display()));
        }
        Err(err) => eprintln!("[reqster] log dosyası açılamadı ({}): {err}", path.display()),
    }
    // Panik → dosyaya yaz; abort profilinde bu satır çökmenin tek izi olabilir.
    std::panic::set_hook(Box::new(|info| {
        write(&format!("[reqster] PANİK: {info}"));
    }));
}

/// Tek satır: stderr + (açıksa) dosya. Dosya yazımı hiçbir zaman hata fırlatmaz.
pub(crate) fn write(line: &str) {
    eprintln!("{line}");
    if let Some(lock) = FILE.get() {
        if let Ok(mut guard) = lock.lock() {
            if let Some(file) = guard.as_mut() {
                let t = STARTED.get().map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0);
                let _ = writeln!(file, "[+{t:08.3}s] {line}");
            }
        }
    }
}

/// `eprintln!` yerine: biçimlendirir, stderr'e ve log dosyasına yazar.
#[macro_export]
macro_rules! rlog {
    ($($arg:tt)*) => {
        $crate::logging::write(&format!($($arg)*))
    };
}
