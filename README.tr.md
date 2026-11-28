# Reqster

Tamamen yerel çalışan, hafif ve veri gizliliği odaklı bir API istemcisi (Postman alternatifi).
Hesap yok, bulut yok, telemetri yok: koleksiyonlarınız, ortamlarınız ve geçmişiniz makinenizde kalır.

*Reqster = request + tester.* Eski adı **Reqly**: mevcut kurulumlar yerinde güncellenir, `.reqly.json` paketleri içe
alınmaya ve `REQLY_*` ortam değişkenleri çalışmaya devam eder.

[English](README.md) · [İndir](https://reqster.dev/download/latest/) · [Tasarım notları](TASARIM.md)

## Özellikler

- Params, header, raw / urlencoded / form-data gövde; klasör ve koleksiyondan devralınan Bearer / Basic / API key auth
- Koleksiyon → klasör → istek ağacı, sekmeler, kaydedilmemiş geçici istekler, çoğaltma, yeniden adlandırma
- Ortam / koleksiyon / global değişkenler, `{{degisken}}` vurgusu ve yerinde düzenleme; secret değerler geçmişte
  maskelenir, istenmedikçe dışa aktarılmaz
- İzole sandbox'ta (ayrı süreçte `isolated-vm`, zaman ve bellek sınırlı, ağ/dosya erişimsiz) pre-request ve
  post-response script'leri; `pm.*` uyumluluk katmanı ve `pm.sendRequest`
- Postman koleksiyon / ortam içe aktarma (dosyadan ya da doğrudan Postman API'sinden), Postman v2.1 dışa aktarma,
  `.reqster.json` paylaşım paketi, cURL içe/dışa aktarma (bash ve Windows cmd)
- Güne göre gruplanmış geçmiş, süre dökümü (DNS / TCP / TLS / TTFB / indirme)
- Atlama listeli proxy profilleri, TLS doğrulama anahtarı, bağlantı yeniden kullanımı
- Türkçe ve İngilizce arayüz, koyu ve açık tema
- Tauri 2 ile masaüstü uygulaması (Windows, macOS), uygulama içi güncelleme; taşınabilir Windows zip'i ve
  sunucuda kullanım için Linux paketi

## Kurulum

Son sürümü [indirme sayfasından](https://reqster.dev/download/latest/) ya da
[GitHub Releases](https://github.com/reqster-dev/reqster/releases)'tan indirin.

| Platform | Dosya | Not |
|---|---|---|
| Windows | `Reqster_<sürüm>_x64-setup.exe` | Kullanıcı hesabına kurulur, yönetici hakkı gerekmez; Edge WebView2 yoksa indirir |
| Windows (kurulum, zip içinde) | `Reqster_<sürüm>_x64-setup.zip` | Ağınız `.exe` indirmeyi engelliyorsa: aynı kurulum dosyası zip içinde |
| Windows (taşınabilir) | `Reqster_<sürüm>_x64-portable.zip` | Kurulum yok: açıp `Reqster\reqster.exe`'yi çalıştırın (Windows 10/11'deki gibi WebView2 kurulu olmalı) |
| macOS | `Reqster_<sürüm>_aarch64.dmg` / `Reqster_<sürüm>_x64.dmg` | Apple Silicon / Intel. Paketler henüz notarize değil: ilk açılışta Sistem Ayarları → Gizlilik ve Güvenlik → "Yine de Aç" |
| Linux | `Reqster-<sürüm>-linux-x64.tar.gz` | Sunucuyu çalıştırır; tarayıcıda `http://127.0.0.1:7357` |

Veri tek bir SQLite dosyasındadır: Windows'ta `%APPDATA%\Reqster\reqster.db`, macOS'ta
`~/Library/Application Support/Reqster/reqster.db`, diğer durumlarda `data/reqster.db` (ya da
`REQSTER_DATA_DIR`). Masaüstü uygulaması açılışta ve günde bir kez güncelleme denetler; tek dış çağrısı budur, yalnızca sürüm
bilgisi okunur ve başka veri gönderilmez.

## Geliştirme

Gereksinimler: Node.js (tam sürüm [`.nvmrc`](.nvmrc)'de sabit); masaüstü kabuğu için Rust stable.

```bash
npm install
npm run dev          # backend (127.0.0.1:7357) + arayüz (127.0.0.1:5173)
npm run typecheck    # tüm workspace'ler
npm run package:linux && npm run smoke   # Linux paketini üretip uçtan uca duman testini koşar
```

`http://127.0.0.1:5173` adresini açın. Monorepo üç paketten oluşur: `packages/shared` (tipler ve zod şemaları —
API sözleşmesi), `packages/server` (Fastify + better-sqlite3 + undici; script sandbox'ı) ve `packages/app` (React +
Vite + zustand). `src-tauri/`'deki masaüstü kabuğu sunucuyu sidecar olarak başlatır (`launcher/package.mjs` onu Node
SEA ile üretir) ve yerel adresini yükler. Mimari kararlar [TASARIM.md](TASARIM.md)'dedir.

Masaüstü paketleri:

```bash
npm run sidecar:win && npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc   # Windows, Linux'tan çapraz derleme
npm run portable:win                                                                       # aynı yükten taşınabilir zip
```

`deploy/tauri-builder.Dockerfile` Rust, NSIS ve cargo-xwin içeren Linux derleme imajıdır. Tüm platformların sürüm
paketlerini GitHub Actions üretir ([`.github/workflows`](.github/workflows)).

## Sunucuda çalıştırma

Linux paketi headless çalışabilir (bkz. [`deploy/Dockerfile`](deploy/Dockerfile)): `REQSTER_HOST=0.0.0.0` verin ve dış
adı `REQSTER_ALLOWED_HOSTS`'a ekleyin. **Önüne kimlik doğrulayan bir ters vekil koyun.** Reqster kendi girişi olmayan bir
HTTP istemcisi ve script çalıştırıcısıdır; ona erişebilen herkes onu ağınıza açılan bir proxy gibi kullanabilir.

## Katkı

Katkılarınızı bekliyoruz — lütfen [CONTRIBUTING.md](CONTRIBUTING.md)'yi okuyun. Commit'ler imzalanmalıdır
([DCO](https://developercertificate.org/), `git commit -s`). Güvenlik açıkları için [SECURITY.md](SECURITY.md).
Proje [Contributor Covenant](CODE_OF_CONDUCT.md) davranış kurallarını izler.

## Lisans

[Apache License 2.0](LICENSE). Telif ve üçüncü taraf bildirimleri: [NOTICE](NOTICE),
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
