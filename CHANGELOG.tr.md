# Değişiklik günlüğü

Reqster'daki kayda değer değişiklikler. Biçim [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/), sürümler
[anlamsal sürümleme](https://semver.org/lang/tr/): yeni özellik küçük sürümü, düzeltme ve bağımlılık güncellemesi yama
sürümünü artırır. English: [CHANGELOG.md](CHANGELOG.md). Her sürümün bu dosyadaki bölümü uygulamanın güncelleme
penceresinde de gösterilir (ilk 300 karakter); en önemli madde başa yazılır.

## [Unreleased]

### Düzeltildi
- Uygulama adına gelen ekler okunuşa göre düzeltildi ("Reqster'ı").

## [1.1.1] - 2026-11-28

### Değişti
- Site, indirmeler ve güncelleme denetimi **reqster.dev** adresine taşındı. Eski adres oraya yönlenir; kurulu sürümler güncellenmeye devam eder.

## [1.1.0] - 2026-11-26

### Eklendi
- Yanıtı kaydet: zip gibi ikili ve büyük yanıtlar dahil, gövdenin tamamı isteği yeniden göndermeden dosyaya kaydedilir.
- İkili yanıtta bozuk metin yerine tür, boyut ve dosya adını gösteren kart.
- Masaüstünde form-data dosya alanı için "Dosya seç" düğmesi.

### Değişti
- İkili yanıtın gövdesi geçmişe yazılmaz; yerine türünü ve boyutunu belirten kısa bir not düşülür. Post-response script'leri ikili yanıtta boş gövde görür.

## [1.0.2] - 2026-11-25

### Eklendi
- TLS doğrulaması artık işletim sisteminin sertifika deposuna da güvenir (Windows sertifika deposu, macOS anahtar zinciri, Linux'ta OpenSSL dizinleri). Bilgisayara kurulu kurum CA'sı, doğrulama kapatılmadan çalışır. Yeni bir CA kurduktan sonra uygulamayı yeniden başlatın.

## [1.0.1] - 2026-11-25

### Güvenlik
- `npm audit`'in bildirdiği tüm açıkları (17, biri kritik) kapatan bağımlılık güncellemeleri: zod 4, @fastify/static 10, adm-zip 0.6, undici 7.30.2, vite 6.4.6, fastify 5.12.8 ve diğerleri.
- Zorunlu güncellemedir: 1.0.1'den eski masaüstü kurulumları güncellenmeden açılmaz.

## [1.0.0] - 2026-11-24

İlk kararlı sürüm.
