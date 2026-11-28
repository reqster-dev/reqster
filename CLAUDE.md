# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Proje Amacı

**Reqster** — tamamen yerel çalışan, hafif ve veri gizliliği odaklı bir Postman alternatifi.
Nihai hedef: telemetrisiz/hesapsız/bulutsuz, tek SQLite dosyasında yaşayan, Postman
koleksiyonlarını içe aktarabilen ve sonunda Tauri ile paketlenecek bir masaüstü API istemcisi.

**Ad değişikliği (1.0.0-rc.20):** eski adı **Reqly**'ydi (başka projelerle çakıştı). Bilerek ESKİ adla kalanlar:
`reqly-wordmark.svg` (yeni wordmark çizilene kadar). Eski site adresi `reqly.talhacigdem.tr` 2026-11-24'te bilerek kapatıldı: rc.19 ve öncesi güncelleme göremez, elle yeni sürüm kurar (updater'daki ölü yedek satır 1.1.0'dan sonra kaldırıldı). Uygulama kimliği 1.1.1'den sonra `tr.talhacigdem.reqly` → `dev.reqster.desktop` oldu: kimliğe yalnızca WebView önbelleğinin klasörü (Windows `%LOCALAPPDATA%\<kimlik>`, macOS `~/Library/WebKit|Caches|HTTPStorages/<kimlik>`) ve NSIS kaldırıcısının "uygulama verisini sil" yolları bağlıdır; updater platforma göre eşleşir, kurulum kaydı ürün adınadır. Kabuk eski kimliğin önbelleğini açılışta siler (`src-tauri/src/old_identifier.rs`; eski kimlik adlı VERİ klasörüne dokunmaz). Geri uyum: `REQLY_*` ortam değişkenleri
`server/src/envCompat.ts` (+ başlatıcıdaki eşi) ile `REQSTER_*`'a kopyalanır; `reqly.db` açılışta `reqster.db`'ye taşınır
(`db/connection.ts`); `reqly-bundle` paketleri içe alınır (`shared` `isBundleFormat`); Windows kurulumu eski "Reqly" kaydını
sessizce kaldırır, veri kalır (`src-tauri/windows/installer-hooks.nsh`). macOS'ta updater paketi yerinde değiştirdiği için `Reqly.app` adı kalıyordu: kabuk açılışta eski adlı paketten çalıştığını görürse onu `Reqster.app` yapıp `open -n` ile yeni yoldan yeniden açar (`src-tauri/src/bundle_name.rs`; App Translocation'da, hedef varsa ya da yazma izni yoksa yalnızca loglar). Kısaltma ve script API'si `rq.*` değişmedi.

Mimari kararların gerekçeleriyle tam dökümü **TASARIM.md**'dedir; bu dosya onun operasyonel özetidir.
Tasarım değişikliği gerektiren bir iş yapılırken TASARIM.md de güncellenmelidir.
Proje dili Türkçedir: UI metinleri, hata mesajları, commit/doküman dili Türkçe; kod tanımlayıcıları İngilizce.

## Komutlar

```bash
npm install
npm run dev              # backend (127.0.0.1:7357) + UI (127.0.0.1:5173) birlikte
npm run dev:server       # yalnızca backend (tsx watch — dosya değişince otomatik yeniden başlar)
npm run dev:app          # yalnızca Vite dev sunucusu (HMR)
npm run typecheck        # tüm workspace'lerde tsc --noEmit
npm run build            # shared → server → app sırasıyla derleme doğrulaması
npm run build -w @reqster/app   # tek paket için (aynı kalıp diğer paketlerde de geçerli)
npm run start             # tek port (7357): app'i build eder + server'ı statik dosyaları da sunacak şekilde başlatır
```

- **Masaüstü paketi (Tauri 2, `src-tauri/`)**: v1.0 kabuğu Tauri'dir. Pencere (WebView2 / WebKitGTK)
  Node sunucusunu **sidecar** olarak başlatır ve `http://127.0.0.1:<port>/` adresini yükler; frontend
  değişmez, Tauri IPC kullanılmaz (`capabilities/default.json` boş). Sözleşme: kabuk sidecar'a
  `REQSTER_SIDECAR=1`, `REQSTER_PORT=0` (dinamik port), `REQSTER_RESOURCES_DIR` (`resource_dir()/resources`),
  `REQSTER_DATA_DIR` (`lib.rs` `user_data_dir()` = `data_dir()/Reqster`: Windows `%APPDATA%\Reqster`, macOS
  `~/Library/Application Support/Reqster`, Linux `~/.local/share/Reqster`; rc.26 ve öncesi kimlik adlı klasördeydi, 1.0.0 öncesi
  olduğu için veri taşınmadı) verir; sunucu `listen`
  sonrası stdout'a `REQSTER_READY http://127.0.0.1:<port>/` yazar, kabuk bunu görünce pencereyi
  yönlendirir (`src-tauri/src/lib.rs`); 30 sn içinde gelmez ya da süreç çökerse hata diyaloğu + çıkış.
  READY'den sonra stdout'taki `REQSTER_PICK_FILE <id>` satırı dosya seçme diyaloğu isteğidir (bkz. "Dosya seçici").
  Pencere kapanınca sidecar öldürülür; kabuk çökerse sidecar stdin kapanışını görüp kendini kapatır.
  **Ana pencere** `tauri.conf.json`'da `create: false`; `setup`'ta `WebviewWindowBuilder::from_config` + `on_download` ile kurulur.
  **Dışa aktarma "Farklı kaydet"** (`src-tauri/src/download.rs`): frontend dosyayı yine `<a download>` blob'u olarak verir;
  kabuk indirmeyi geçici dizine alır (olay UI iş parçacığında senkron, içinde modal diyalog WebView2'de yeniden girişim riski),
  bitince asenkron kaydet diyaloğu (varsayılan İndirilenler, önerilen ad) açar, dosyayı taşır ve sayfaya `webview.eval` ile
  `reqster:file-saved` / `reqster:file-save-failed` DOM olayı yollar (IPC değil); iptal sessiz. Sunucu sidecar modunda `index.html`'e
  `data-shell="desktop"` basar → `lib/download.ts` `isDesktopShell()`: düğme "Kaydet…", bildirim kabuktan; tarayıcıda "indirildi" bildirimi.
  **Kabuk logu**: her `crate::rlog!` satırı stderr'e ve `<veri klasörü>/logs/shell.log`'a (Windows
  `%APPDATA%\Reqster\logs\shell.log`, 1 MB'ta `shell.1.log`'a döner) yazılır; panik kancası da oraya
  yazar (`src-tauri/src/logging.rs`). Windows'ta GUI'nin stderr'i görünmediği için kapanma teşhisinde ilk bakılacak yer.
  Tuzak: `reqwest` eklenti yüzünden `rustls-no-provider` ile derlenir; kabukta reqwest istemcisi kurmadan
  önce `rustls::crypto::ring::default_provider().install_default()` çağrılmalı, yoksa rustls paniği `panic=abort` ile
  süreci sessizce öldürür (rc.9 Windows). Linux'ta kabuk `xvfb-run` ile koşturulup `shell.log` okunarak yeniden üretildi.
  Sidecar adı `reqster-server` (Tauri, crate adı `reqster` ile aynı sidecar adını reddeder); script worker
  `windowsHide: true` ile açılır ki GUI'den gizli başlatılan konsol süreci yeni pencere açmasın.
  **Uygulama içi güncelleme** (`src-tauri/src/update.rs`, `tauri-plugin-updater`): READY'de pencere hemen
  uygulamaya geçmez; açılış ekranı (`src-tauri/ui/index.html`, durum satırı `window.__reqsterStatus`, kabuk `webview.eval`
  ile yazar) "Güncellemeler denetleniyor" gösterirken görev `GET /api/settings` (`network.verify_tls`) ve
  `GET /api/internal/proxy-url` (aktif proxy, yoksa doğrudan) okur, `https://reqster.dev/updates/latest.json`'u
  (erişilemezse önceki adres `reqster.talhacigdem.tr`'yi dener; o adres de `reqster.dev`'e yönlenir, 1.1.0 ve öncesi yalnızca onu bilir) denetler. En fazla
  `STARTUP_CHECK_BUDGET` (5 sn) beklenir; dolunca uygulama açılır, denetim arka planda biter. Güncelleme yoksa açılış
  ekranı kabuk başladığından beri en az `MIN_SPLASH` (1,2 sn) görünür ve son anda "Güncel" yazar (bir an görünüp kaybolmasın). Yeni sürümde diyalog açılış
  ekranındayken "Şimdi kur / Sonra"; seçilmeden uygulama açılmaz. **Zorunlu güncelleme:** manifestin üst düzeyindeki
  `minimumVersion`'ın altındaki kurulumda diyalog "Şimdi kur / Çık" (Çık → uygulama kapanır; kurulum başarısızsa
  kilitlemez, açılır). Manifeste `minimumVersion`'ı site yayını yazar (`npm run release rc --zorunlu` → sürüm commit'inde
  `Zorunlu-Guncelleme: evet` → `release.yml` Release notuna `<!-- reqster:minimum-version -->` → işaretli en yüksek sürüm).
  Açıkken 24 saatte bir denetlenir; o turda bulunan zorunlu güncelleme yalnızca sorulur, zorunluluk sonraki açılışta
  uygulanır ("Sonra" aynı sürümü oturum boyunca susturur). Denetim kapatılamaz (`update.auto_check` rc.24'te kaldırıldı;
  eski DB değeri yok sayılır). Windows'ta NSIS `/S /UPDATE /R` (`installMode: quiet`, kurulum penceresi yok; rc.24'ten önce passive ilerleme penceresi açılıyordu, mod kurulu sürümün config'inden okunduğu için ilk sessiz güncelleme rc.24 → sonrası) ile kurulur ve uygulama kendini
  yeniden açar; sidecar `on_before_exit`'te öldürülür (kilitli `reqster-server.exe`); macOS'ta `.app`
  değiştirilip `app.restart()`. `network.verify_tls=false` ise updater da sertifika doğrulamaz (paketi
  minisign imzası korur). Yükleyici türü URL uzantısından değil içerikten (PE/MSI sihirli baytı) anlaşılır;
  dosya `.bin` gibi nötr adla sunulabilir. Manifest: `{version, notes, pub_date(RFC3339), platforms:
  {"windows-x86_64": {url, signature}, "darwin-aarch64": …, "darwin-x86_64": …}}`; imza `.sig` dosyasının
  içeriğidir. `bundle.createUpdaterArtifacts: true` → CI'da `TAURI_SIGNING_PRIVATE_KEY` (+`_PASSWORD`)
  verildiğinde `setup.exe.sig` / `.app.tar.gz` + `.sig` üretilir; `plugins.updater.pubkey` eşleşen açık
  anahtardır. Çalışma zamanı davranışı yalnızca gerçek Windows/macOS cihazda doğrulanır.
- **Sidecar üretimi (`launcher/package.mjs`)**: resmî Node ikilisi + Node SEA ile gömülü başlatıcı
  (`launcher/reqster-launcher.js`) ve `resources/` (esbuild ile tek dosyaya bundle'lanmış
  `server.cjs`/`worker.cjs`, vite çıktısı, migration'lar, hedef platformun ön-derlenmiş
  `better-sqlite3`/`isolated-vm` ikilileri). `--sidecar-dir src-tauri --no-archive` ile çıktı
  `src-tauri/binaries/reqster-server-<rust-triple>[.exe]` + `src-tauri/resources/` olur (git dışı);
  `--sidecar-dir`siz çalıştırınca eski taşınabilir arşiv üretilir (Linux `tar.gz` headless/Docker ve
  sunucu kullanımı için kalır; eski Windows launcher zip'i dağıtılmaz — Windows'un taşınabilir zip'i Tauri
  yükünden `deploy/win-portable.sh` ile üretilir, aşağıda). Linux üzerinde Windows paketi üretilir,
  derleyici gerekmez. Node sürümü `.nvmrc`'de sabittir ve blob/ABI eşleşmesi için betik bunu zorlar.
  macOS hedefleri (`--target darwin-arm64|darwin-x64`, triple `aarch64-apple-darwin`/`x86_64-apple-darwin`)
  yalnızca macOS'ta üretilir (Node SEA belgesi: `codesign --remove-signature` → postject `--macho-segment-name NODE_SEA`
  → ad-hoc `codesign --sign -`); Linux'ta istenirse betik dosya üretmeden durur, `--plan` yan etkisiz olarak URL/triple/
  ön-derleme durumunu yazdırır. isolated-vm'in darwin-x64 ön-derlemesi npm paketinde yoktur: CI onu kaynaktan derleyip
  kök `node_modules/isolated-vm/prebuilds/darwin-x64/isolated-vm.abi<ABI>.node` olarak koyar, betik oradan kopyalar.
  Paketlenmiş modda sunucu yolları `REQSTER_RESOURCES_DIR` üzerinden çözer (`server/src/paths.ts`);
  script worker, `process.execPath`'in SEA'da her zaman gömülü script'i çalıştırması nedeniyle `fork`
  yerine `REQSTER_WORKER_MODE=1` ile aynı exe'nin ikinci kopyası olarak açılır (`scripting/host.ts`).
- **Derleme ortamı**: Node sürümü `.nvmrc`'de sabittir (paketleme bunu zorlar). Node işleri gerekirse
  `docker run --rm -u 1000:1000 -e HOME=/tmp/h -v "$PWD":/w -w /w node:24-bookworm ...`; Tauri işleri
  builder imajında (`deploy/tauri-builder.Dockerfile`: Rust stable +
  Node 24.22.2 + NSIS 3.11 (kaynaktan; bookworm'un 3.08'i Tauri şablonuyla uyumsuz) + cargo-xwin ile
  Windows SDK önbelleği + webkit2gtk + xvfb). Windows kurulum dosyası Linux'ta çapraz derlenir:
  `npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc` → `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Reqster_<ver>_x64-setup.exe`.
  Linux: `npx tauri build --bundles deb`; pencere `xvfb-run` + `import -window root` ile ekran görüntüsü alınarak doğrulanır.
  İmaj yalnızca yerel derleme içindir (`docker build -f deploy/tauri-builder.Dockerfile -t reqster-tauri-builder deploy/`).
  Üçüncü taraf lisansları: `THIRD_PARTY_NOTICES.md`, `node launcher/third-party-notices.mjs --cargo` ile builder
  imajında yeniden üretilir (bağımlılık eklenince/güncellenince; elle düzenlenmez).
- **CI (GitHub Actions, `.github/workflows/`)**: `ci.yml` — `main` push ve PR → typecheck + Linux paketi + duman testi
  (`launcher/smoke.mjs`: taşınabilir mod + sidecar sözleşmesi: dinamik port, READY satırı, stdin kapanınca çıkış, kapı
  bekçisi); PR'larda ayrıca her commit'te `Signed-off-by` (DCO, CONTRIBUTING.md) denetimi. Secret kullanmaz.
  `release.yml` — `v1.2.3` etiketi → `linux` (tar.gz, duman testinden geçen dosyanın kendisi), `windows`
  (`windows-latest`'te yerli derleme: frontend `npm run build` ile önce derlenir çünkü package.mjs `npm`'i kabuksuz
  çağırır ve Windows'ta `npm.cmd` çözülmez → `--skip-app-build`; NSIS kurulumu, aynı kurulumun zip'i (`_x64-setup.zip`, .exe indirmesi engelli ağlar için; içinde yalnızca exe) + `deploy/win-portable.sh` ile taşınabilir
  zip, zip yoksa 7-Zip), `macos` (`macos-latest` Apple Silicon: aarch64 yerli, x64 çapraz; isolated-vm x64 ön-derlemesi
  orada node-gyp ile üretilir) ve hepsi bitince `release` işi GitHub Release'i oluşturur (`gh release`, önsürümde
  `--prerelease`; yeniden koşturmada `upload --clobber`). Etiket sürümü `package.json` ile eşleşmezse `meta` düşer.
  Elle tetikleme → yalnızca artifact. Secret: `TAURI_SIGNING_PRIVATE_KEY` (updater imzası; yoksa `.sig` üretilmez).
  Paketler henüz kod imzasız (SmartScreen / Gatekeeper uyarır).
  **Değişiklik günlüğü:** `CHANGELOG.md` (İngilizce) + `CHANGELOG.tr.md` (Türkçe), Keep a Changelog biçimi. Kullanıcının
  göreceği her değişiklik, onu getiren commit'te iki dosyanın `## [Unreleased]` bölümüne yazılır (Added/Changed/Fixed/Security ↔
  Eklendi/Değişti/Düzeltildi/Güvenlik). `deploy/changelog.sh`: `cut` (surum.sh çağırır; kararlı sürümde Unreleased'i sürüm
  başlığına taşır, boşsa sürüm çıkmaz; rc dokunmaz), `notes` (release.yml çağırır; Release notunun başına "What's new" + işaretli
  Türkçe blok koyar). Türkçe blok site üzerinden updater manifestinin `notes`'una, oradan güncelleme penceresine gider (ilk 300
  karakter, düz metin): en önemli madde başa, kısa yazılır. Yayınlanmış bir sürümün günlüğü düzeltilip main'e push edilince `release-notes.yml` o Release'in notunu eşitler
  (`changelog.sh merge`; "## Downloads" altı aynen kalır); güncelleme penceresindeki not için site yayını elle yenilenir. Sürümleme: görünür yeni özellik → minor, yalnızca düzeltme/bağımlılık → patch.
  Sürüm çıkarma tek komuttur: `npm run release rc|patch|minor|major|X.Y.Z` (`deploy/surum.sh`): dört
  manifest + package-lock yükselir, `Sürüm X` commit'i ve `vX` etiketi atılır, main + etiket push edilir
  (temiz ağaç ve `main` zorunlu; `--no-push` ile yalnızca yerel; `npm version` bilerek kullanılmaz, bkz. betik).
- **Docker / public site**: `deploy/Dockerfile` Linux paketini headless imaja koyar (container'da
  `REQSTER_HOST=0.0.0.0`, `REQSTER_AUTH=off`, veri `/data`; önüne kimlik doğrulayan bir kapı gerekir, README). İndirme ve
  updater sitesi (`reqster.dev`; önceki `reqster.talhacigdem.tr` oraya yönlenir) bu depoda değildir; GitHub Release'lerinden beslenir: sürüm, dosya adları,
  imzalar, güncelleme notu ve `minimumVersion` son Release'teki `site-manifest.json`'dan okunur (`deploy/site-manifest.mjs`; `site-manifest.yml` release / release-notes
  iş akışları bitince, Release elle düzenlenince ve üretici değişince yeniden üretir). Site yalnızca GitHub'ın "latest" saydığı (kararlı) Release'i görür.
- Test altyapısı henüz yok. Doğrulama şu ana kadar `typecheck` + çalışan servera karşı curl ile
  uçtan uca API smoke testiyle yapılıyor (koleksiyon oluştur → değişken tanımla → execute → history kontrolü).
- Veri `data/reqster.db` dosyasında (gitignore'da); `REQSTER_DATA_DIR` ile taşınabilir.
  Temiz başlangıç için server kapalıyken bu dosyayı silmek yeterlidir (migration'lar açılışta koşar).

## Mimari (büyük resim)

npm workspaces monorepo, üç paket:

- **`packages/shared`** — saf tipler (`src/types`), sabitler ve zod şemaları (`src/validation`).
  Hiçbir pakete bağımlı olamaz; `app` ve `server` yalnızca buna bağımlıdır. API sözleşmesinin
  tek doğruluk kaynağı buradaki tiplerdir (`ExecuteInput`, `ExecuteResult`, `CollectionTree`, `ResolvedVariable`...).
- **`packages/server`** — Fastify (yalnızca `127.0.0.1:7357`) + better-sqlite3 (WAL) + undici.
  Katmanlar: `api/` (ince route'lar: zod doğrulama + core çağrısı) → `core/` (alan mantığı) →
  `db/repositories/` (SQL yalnızca burada). `engine/executor.ts` istek yaşam döngüsünü yürütür,
  `engine/scriptRunner.ts` script zincirini orkestre eder, `scripting/` izole sandbox'ı barındırır,
  `importers/postman-v2.ts` Postman dönüşümünü yapar, `exporters/postman-v2.ts` tersini (Postman v2.1 export +
  `.reqster.json` paylaşım paketi), `importers/bundle.ts` paketi tek transaction'da içe alır. Şema değişiklikleri yalnızca
  `db/migrations/NNNN_*.sql` dosyalarıyla yapılır (migrate.ts açılışta sıralı uygular).
- **`packages/app`** — React + Vite + zustand. `stores/appStore.ts` tek global store'dur ve
  **çoklu sekme** mimarisindedir: her `RequestTab` kendi taslağını, dirty durumunu, yanıtını ve
  executing bayrağını taşır; aktif sekme `selectActiveTab(s)` selector'ıyla okunur.
  UI, feature-bazlı dikey dilimlere bölünmüştür (`features/request-builder`, `collections`, ...).

### Kritik akış: bir isteğin yürütülmesi

UI hedef API'ye **asla doğrudan istek atmaz** (CORS + gizlilik sınırı). Akış:
UI → Vite proxy `/api` → Fastify `/api/execute` → `engine/executor.ts`:
istek/klasör/koleksiyon zinciri bir kez çözülür (`core/hierarchy.ts`, yapraktan köke) →
**pre-request script zinciri** (koleksiyon → klasör(ler, kökten yaprağa) → istek, `engine/scriptRunner.ts`;
bir script hata verirse zincir durur ve istek hiç gönderilmez) →
auth inheritance çözümü (istek → klasör zinciri → koleksiyon; `auth_json NULL` = devral) →
değişken interpolasyonu (`{{var}}`, öncelik: **ortam → koleksiyon → global**, `core/variables/resolve.ts`;
resolver script'lerden SONRA taze DB durumuna göre kurulur ki mutasyonlar interpolasyona yansısın) →
undici ile gönderim (`engine/dispatcher.ts` → `createDispatcherFor(url)`: aktif proxy varsa ve hedef atlama listesinde
değilse `ProxyAgent` (http düz, https CONNECT), yoksa `Agent`; `shared: true` çağrılar (ana istek, `rq.sendRequest`)
`network.reuse_connections` açıkken süreç boyu keep-alive havuzunu paylaşır, `release()` havuzu kapatmaz; redirect'ler `interceptors.redirect` ile, v7'de
`maxRedirections` opsiyonu yok; proxy'den gittiyse `ExecuteResult.viaProxy`) →
**post-response script zinciri** (istek → klasör(ler) → koleksiyon, ters sıra; hata olsa da yanıt atılmaz) →
history'ye **snapshot** yazımı (secret değerler `«masked»` ile maskelenir) → `ExecuteResult` döner
(scriptLogs/testResults dahil).

### Veri modeli özeti

- `collections → folders (parent_id ile ağaç) → requests`; header/param listeleri JSON kolonlarında
  (bütün okunup yazılır, SQL ile sorgulanmaz — normalize etme).
- `variables` tek tabloda üç scope: `environment_id` / `collection_id` / `workspace_id` kolonlarından
  tam olarak biri dolu (CHECK kısıtı + partial unique index'ler).
- `history` bilinçli olarak FK'sızdır (istek silinse de geçmiş kalır); gövde 1 MB'ta kırpılır,
  kayıt sayısı `history.max_entries` ayarına göre budanır.
- ID'ler UUIDv7 (`db/ids.ts`), tarihler epoch ms.

### UI'a özgü kalıplar

- **VariableInput** (`components/VariableInput.tsx`): input üzerine bindirilmiş overlay ile
  `{{var}}` vurgusu (tanımlı=yeşil, tanımsız=kırmızı) + hover'da düzenlenebilir tooltip.
  Çözümlenmiş değişkenleri `GET /api/variables/resolved?collectionId=` endpoint'inden alır ve
  modül seviyesinde önbellekler; önbellek anahtarının parçası store'daki `variablesVersion` sayacıdır.
  **Değişkenleri değiştiren her yeni akış `bumpVariablesVersion()` çağırmalıdır**, yoksa vurgular bayatlar.
- Sol panelden istek açma: aynı `requestId`'ye sahip sekme varsa odaklanır; aktif sekme hiç
  dokunulmamış boş taslaksa yeni istek onun yerine açılır. İstek silinince sekmesi kapanmaz,
  kayıt bağı koparılıp kayıtsız taslağa dönüşür.
- Response panelinde Console/Tests sekmeleri `ExecuteResult.scriptLogs`/`testResults`'ı gösterir;
  bunlar **DB'de kalıcı değildir** (history'de saklanmaz), yalnızca o anki çalıştırmanın yaşam
  süresi kadar UI state'inde durur.
- **CodeEditor** (`components/CodeEditor.tsx`, `components/LazyCodeEditor.tsx`): CodeMirror 6
  tabanlı, satır numarası + JSON/XML/JavaScript syntax highlighting + kod katlama sağlayan
  ortak editör. Raw body, pre/post-request script'ler ve (salt-okunur) response body hepsi bunu
  kullanır. Monaco yerine CodeMirror seçildi: TASARIM.md'nin "hafif" ilkesiyle daha uyumlu (worker
  kurulumu gerekmiyor, Vite ile sorunsuz bundle'lanıyor). CodeMirror + dil paketleri ana bundle'ı
  şişirmesin diye `LazyCodeEditor` üzerinden `React.lazy` ile ayrı bir chunk'a alınır — gerçek
  `CodeEditor`'ü doğrudan import ETMEYİN, her zaman `LazyCodeEditor`'den kullanın. `{{var}}`
  vurgulaması `VariableInput` ile aynı `useResolvedVariables` hook'unu (`lib/resolvedVariables.ts`)
  paylaşır; CodeMirror tarafında bir `StateField`+`StateEffect` üzerinden React state'i editöre
  aktarılır (`highlightVariables` prop'u `true` olan kullanımlarda). `lib/formatters.ts`daki
  `formatJson`/`formatXml` (bağımlılıksız, basit bir etiket-derinliği XML formatlayıcısı) "Beautify"
  butonu ve response body ön-formatlaması için kullanılır.
- **i18n (tr/en)**: UI metinleri `lib/i18n.ts` (bağımlılıksız) + sözlükler `locales/tr.ts` (anahtar kaynağı) ve
  `locales/en.ts` (`Record<MessageKey, string>`, eksik/fazla anahtar typecheck'te kırmızı). Bileşende
  `const t = useT(); t('settings.title')`, `{name}` yer tutucu `t('proxy.active', { name })`, çoğul `tn(count, '…_one', '…_other')`;
  bileşen dışı kodda (store, yardımcılar) `t()`/`tn()` doğrudan; hook kullanılamayan `dialog.custom` başlık/düğmelerinde `<T k="…"/>`.
  Yeni görünür metin (title/aria-label/placeholder dahil) **önce `tr.ts`'ye, sonra `en.ts`'ye** eklenir; bileşende sabit metin yazılmaz.
  Dil ayarı `ui.language` (`auto|tr|en`, sunucuda; tema gibi `localStorage['reqster.language']` yalnızca ilk boyama önbelleği, sunucu
  `index.html`'e `data-lang` basar). Tarih/sayı için `locale()` (`tr-TR`/`en-US`); her API isteği `X-Reqster-Lang: tr|en` başlığı taşır
  (`api/client.ts`). Uygulamanın tüm görünür metinleri sözlükten gelir (2026-11-13); yeni metin eklerken
  önce `tr.ts`, `en.ts` eksiği typecheck'te görünür. Kalan: site `/en/` sayfası.
- **Sunucu i18n (tr/en)**: sunucudan kullanıcıya giden her metin (`{error}` gövdeleri, zod 400 ayrıntıları, `ExecuteResult.error`,
  script log/test mesajları, import raporu) `server/src/i18n/messages.ts` sözlüğünden gelir (anahtar → `{ tr, en }`, `{name}` yer
  tutucu; Türkçe metinler birebir eski metinler). Dil `X-Reqster-Lang: tr|en` başlığından; yok/bozuksa `tr`. Fastify `onRequest`
  hook'u isteği `AsyncLocalStorage` bağlamına alır (`i18n/context.ts`), route dışı katmanlar imza değiştirmeden `msg(key, params)`
  çağırır. İki istisna: script worker ayrı süreçtir → dil `RunScriptRequest.language` ile IPC'den iner, worker/sandbox `t(lang, …)`
  kullanır, isolate'a `__meta.language` girer ve prelude `sandbox.*` alt kümesini iki dilli JSON tablo olarak gömüp `T(key, params)`
  ile seçer (pm-compat aynı fonksiyonu `__t`'den alır); host'taki IPC olay dinleyicileri (`scripting/host.ts`, `scriptRunner`'daki
  `onSendRequest`) bağlamı taşımadığı için dil orada açıkça yakalanır. zod şemaları (`shared/validation`) dil bilmez: özel mesajlar
  `validation.*` **anahtarı** olarak yazılır, `api/helpers.ts` `parseBody` çevirir; mesaj verilmeyen kurallarda zod'un İngilizce
  varsayılanı iki dilde de kalır. undici'nin ham hataları (`connect ECONNREFUSED …`, `Invalid URL protocol…`) çevrilmez. Loglar
  (`console.*`) Türkçe kalır. Yeni metin: anahtarı sözlüğe ekle, koddan `msg()`/`t()`/`T()` ile çağır; sabit metin yazma.
- **Tema**: renkler yalnızca `styles.css` başındaki token'lardan gelir (`--bg*`, `--text*`, `--accent*`,
  `--highlight-*`, `--hover`, `--focus-ring`, `--shadow`, `--mask`, semantik `--green/--red/...`); bileşende
  sabit renk yazılmaz. Koyu tema `:root`, açık tema `html[data-theme="light"]`. Tercihin kalıcı kaynağı sunucudaki
  `ui.theme` ayarıdır (`lib/theme.ts` → `lib/uiPrefs.ts`, `PATCH /api/settings`); `localStorage['reqster.theme']` yalnızca
  önbellektir çünkü Tauri her açılışta farklı port = farklı origin ile açar ve depolama boş başlar. Paketlenmiş/
  `start` modunda sunucu `index.html`'i `/` ve `/index.html` için `<html data-theme="…">` basarak verir (`Cache-Control:
  no-cache`); `index.html`'deki satır içi script bu değer varsa dokunmaz, yoksa localStorage → sistem → koyu. Bölme
  boyutları (`SplitPane`, `ui.sidebar_width`/`ui.request_pane_ratio`) aynı yolla saklanır. Palet: ana renk iki temada da
  tek renk kırmızı `#d00000` (WCAG eşiği: koyu zeminde 3,1:1, beyaz metinle 5,7:1; `#af0000` koyu temada okunmadığı için),
  hata kırmızısı accent'ten ayrışsın diye hafif turuncu, yeşil yalnızca başarı/GET için (önceki palet
  yeşildi). İkonlar
  `lucide-react`: emoji/unicode simge kullanılmaz, `lib/icons.ts`'teki `iconProps` (16px, stroke 2) ile
  tutarlı boyut; font yerel "Inter var" (`public/fonts/`, OFL), uzak font yok. Üst bardaki açılır menüler ortak
  `components/DropdownMenu.tsx` (klavye + aria) üzerinden.
  **Marka varlıkları**: kaynak SVG'ler `packages/app/src/assets/brand/` (`reqster-mark.svg`,
  `reqster-mark-bold.svg` = aynı path + ~%3 kontur, 16–24 px için; `reqly-wordmark.svg`; sitedeki kopyalar bunlarla birebir aynı tutulur),
  hepsi `fill="currentColor"` tek `evenodd` path, sabit renk yok — renk `--accent`'ten gelir. Üst bar
  `components/ReqsterMark.tsx` (path verisi bold SVG ile aynı; SVG değişirse bileşen de güncellenir). Favicon
  `public/favicon.svg` (kırmızı rx %22 kare + beyaz bold işaret); masaüstü ikonları ondan render edilen 1024 PNG ile
  builder container'ında `npx tauri icon <png> -o src-tauri/icons` — yalnızca `tauri.conf.json`'daki dosyalar +
  `icon.png` tutulur, üretilen Android/iOS/Square*/StoreLogo çıktıları silinir.

### Script sandbox mimarisi (`server/src/scripting/`)

Kullanıcı script'leri her zaman ayrı bir **child process** içinde, o process'in kendi
`isolated-vm` isolate'ında çalışır — worker_threads DEĞİL, çünkü bir native segfault
(isolate'ta gerçekten olabiliyor, spike sırasında bir kez gözlemlendi) thread'i değil
tüm process'i öldürür; child process bu riski ana sunucudan izole eder.

- **`protocol.ts`** — host↔worker IPC mesaj tipleri (`RunScriptRequest`/`RunScriptResponse`).
- **`prelude.ts`** / **`pm-compat.ts`** — isolate içinde çalışacak `rq.*` API'sini ve `pm.*`
  alias'ını üreten JS kaynak string'leri (TS içinde template olarak yazılır, isolate'a
  `compileScript` ile derlenir; **regex/kaçış karakterleri template içinde çift ters bölü ister**).
  `pm.*` ve tüm alt nesneleri (`pm.environment.*`, `pm.request.headers.*` …) Proxy ile sarılıdır:
  tanınmayan özellik açık "desteklenmiyor" hatası fırlatır; Symbol'ler ve `then`/`toJSON`/`inspect`
  gibi tanıtıcı erişimler undefined döner (`JSON.stringify(pm.environment)`, `await` patlamaz).
  `setTimeout(fn, ms)` gerçek zamanlayıcı değildir: fn kuyruğa alınır, ana gövde bittikten sonra
  kayıt sırasıyla ve gecikme yok sayılarak çalışır (en çok 100); `setInterval` hata verir.
- **`sandbox.ts`** — `runScriptInSandbox(input, bridge)`: isolate oluşturur, `__variables`/`__request`/
  `__response`/`__meta` verisini `copy:true` ile enjekte eder (asla canlı referans paylaşılmaz),
  prelude+pm-compat+kullanıcı script'ini birlikte çalıştırır. **Önemli tasarım kararı:**
  log/test/mutasyon toplama Reference tabanlı host köprüsü ile DEĞİL, isolate-local
  dizilere yazılıp çalışma bitince (hata/timeout olsa bile) `copy:true` ile toplu geri
  okunarak yapılır — isolate'in global state'i timeout sonrası bile okunabilir olduğu
  doğrulandı, bu da Reference bridge'i gereksiz kılıyor. Kullanıcı gövdesi bir **async
  fonksiyona** sarılır (top-level `await` ve `await pm.sendRequest(...)` çalışır; mikro görevlerin
  `script.run` bitmeden koştuğu doğrulandı), ardından `setTimeout` kuyruğu boşaltılır.
- **`rq.sendRequest` köprüsü — Reference kuralının tek istisnası.** Script içinden HTTP isteği için
  isolate'a tek bir `ivm.Reference` (`__sendRequest`, prelude kapanışına alınıp global'den silinir)
  verilir; isolate `applySyncPromise` ile bloklanır (worker'ın event loop'u serbesttir, `script.run`
  async). Worker ağa ÇIKMAZ: IPC ile host'a `{type:'sendRequest', callId, request, timeoutMs}` gönderir,
  host (`engine/scriptHttp.ts`, undici; dispatcher ayarları executor ile ortak `createDispatcher`)
  isteği yapar, `{type:'sendRequestResult'}` döner; yanıt isolate'a JSON string olarak girer. Worker
  bundle'ına undici girmez. `{{var}}` çözümü isolate içinde o anki değişken durumuna göre yapılır
  (`rq.variables.replaceIn`). Sınırlar: script başına 10 çağrı, gövde 1 MB'ta kırpılır
  (`res.truncated`), çağrı zaman aşımı = min(`network.timeout_ms`, kalan script süresi). Bu istekler
  history'ye yazılmaz, loglanmaz. **Zaman aşımı tuzağı (spike ile doğrulandı):** `script.run`'ın
  `timeout`'u yalnızca isolate'ın JS koştuğu süreyi sayar, `applySyncPromise` beklemesi sayılmaz;
  bu yüzden bekleme bütçesi worker'da deadline'a göre kesilir ve son çare olarak deadline+1.5 sn'de
  isolate `dispose` edilir (host güvenlik ağı 3 sn'den kısa; worker öldürülmez, loglar o durumda
  kurtarılamaz). Çalıştırma bitince bekleyen çağrılar host'ta `AbortSignal` ile iptal edilir.
- **`worker-entry.ts`** — child process giriş noktası. Geliştirmede `host.ts` tarafından
  `fork(path, { execArgv: ['--import', 'tsx/esm'] })` ile başlatılır; paketlenmiş modda
  (`isPackaged`) aynı exe `REQSTER_WORKER_MODE=1` ile `spawn` edilir ve başlatıcı
  `resources/worker.cjs`'yi yükler (bkz. "Paketleme"). IPC kanalı kopunca worker kendini kapatır.
- **`host.ts`** — `runScript(input, handlers)`: tek worker'ı lazy spawn eder, tüm çalıştırmaları
  sıraya alır (basit, düşük eşzamanlılıklı yerel araç için yeterli), çöken worker'ı bir sonraki
  çağrıda otomatik yeniden başlatır, host-side güvenlik timeout'u (script timeout + 3 sn) worker
  gerçekten asılırsa `kill()` eder. `handlers.onSendRequest` dış dünya kapısıdır; `scripting/`
  paketi `engine/`i import etmez, handler'ı `engine/scriptRunner.ts` verir.
- **`engine/scriptRunner.ts`** — zincir orkestrasyonu: her adımdan sonra değişken
  mutasyonlarını hemen DB'ye yazar (`applyMutations`) ve bir sonraki adım için taze
  snapshot alır (`buildVariableSnapshot`), böylece aynı zincirdeki bir script diğerinin
  yazdığı değeri okuyabilir.

**Bilinen bir güvenlik hatası burada bulunup düzeltildi:** `variables.ts` repository'sindeki
`upsertVariable`, `isSecret` parametresi verilmediğinde bayrağı sessizce `false`'a
sıfırlıyordu — script'in `rq.environment.set(key, value)` gibi value-only bir çağrısı,
zaten secret işaretli bir değişkenin maskeleme bayrağını kalıcı olarak kaldırabilirdi.
Artık `isSecret`/`enabled` verilmezse mevcut değer korunuyor.

## Uygulama Kuralları (TASARIM.md §8'in operasyonel hali)

1. Route dosyaları iş mantığı içermez; SQL yalnızca `db/repositories/` içinde yaşar.
2. Her çok-adımlı yazma işlemi (import gibi) tek SQLite transaction'ında, atomik olmalı.
3. Secret değişkenler (`is_secret=1`) history'ye, loglara ve export'a asla düz metin yazılmaz.
4. Kullanıcı scriptleri asla ana süreçte ve asla `node:vm`/`eval` ile çalıştırılmaz; yalnızca
   ayrı child process + `isolated-vm` (zaman/bellek sınırlı, ağ/dosya/require erişimsiz) —
   bkz. "Script sandbox mimarisi". Sandbox'a asla canlı bir referans geçirilmez, yalnızca
   `copy:true` ile yapılandırılmış veri.
5. Import her zaman kullanıcıya rapor üretir (`ImportReport`: aktarılan/atlanan/uyarılar);
   desteklenmeyen özellikler sessizce yutulmaz, raporlanır.
6. Yeni import formatları `importers/` altına ayrı dosya olarak eklenir ve aynı iç modeli üretir.

## Mevcut Durum (Temmuz 2026)

Tamamlananlar — Faz 1 + arayüz geliştirmeleri + Faz 2'nin script sandbox çekirdeği:

- İstek oluşturma/çalıştırma (params, headers, raw/urlencoded/form-data body, bearer/basic/apikey auth + inheritance)
- Koleksiyon → klasör → istek CRUD'u ve ağaç görünümü
- **Koleksiyon/klasör ayarları** (Postman'deki gibi, 2026-11-11): ağaçtaki ⚙ ile açılan diyalog
  (`features/collections/HierarchySettingsDialog.tsx`) — Genel (ad/açıklama), Auth, Scripts (pre/post),
  koleksiyonda ayrıca Değişkenler. Backend `PATCH /api/collections/:id` ve `/api/folders/:id`
  `hierarchyPatchSchema` ile kısmi güncelleme (`undefined` = dokunma, `null` = temizle); repository
  `updateCollection`/`updateFolder`. Alt istekler auth'u ve script zincirini buradan devralır.
- **Tauri masaüstü kabuğu** (2026-11-11): `src-tauri/` — pencere Node sidecar'ını başlatıp onun
  adresini yükler; Windows kurulum dosyası CI'da Linux'tan çapraz derlenir (ayrıntı: "Masaüstü paketi").
- Ortam / koleksiyon / global değişkenler, interpolasyon, secret maskeleme
- History (snapshot + budama), Postman v2/v2.1 koleksiyon ve environment import'u (atomik + raporlu)
- Sekmeli istek düzenleme, kayıtsız geçici istekler, `{{var}}` hover tooltip'i ile yerinde değişken düzenleme
- **Script sandbox** (`server/src/scripting/`): `isolated-vm` + ayrı child process, `rq.*` API'si
  (`environment`/`collectionVariables`/`globals`/`variables` get-set-unset, `variables.replaceIn`,
  `rq.request`, `rq.sendRequest`, `rq.info`,
  `rq.response`, `rq.test`/`rq.expect`, tarayıcı uyumlu `btoa`/`atob`), `pm.*` uyumluluk katmanı (desteklenmeyen çağrı açık hata
  verir), pre-request/post-response script zinciri (`engine/scriptRunner.ts`), UI'da Scripts
  düzenleme sekmesi + Console/Tests sonuç panelleri. Uçtan uca doğrulandı: timeout, bellek limiti,
  Node globals izolasyonu, pre-request hatasının isteği durdurması, post-response'ta `rq.request`'in
  salt-okunur (donmuş) olması, worker'ın OOM/timeout sonrası sağlıklı kalması.
- **Script içinden HTTP + Postman uyumluluğu genişlemesi** (2026-11-12): `rq.sendRequest`/`pm.sendRequest`
  (callback ve Promise biçimi, host üzerinden; bkz. sandbox bölümündeki köprü notu), `rq.environment.name`/`pm.environment.name`,
  `pm.variables.replaceIn`, `pm.request.headers.upsert/remove/has`, `pm.request.method`,
  `pm.response.to.have.status/header`, `pm.response.to.be.ok`, `pm.response.responseTime`,
  `pm.expect().to.be.a/an`, `.exist`, `.true/.false/.null/.undefined`, `.length/.lengthOf`, `.oneOf`,
  `.match`, `.at.least/.at.most`, `.deep.equal` (`not` ile), `pm.info.requestName/requestId/eventName`,
  kuyruklu `setTimeout`. `RunScriptRequest`'e `environmentName`/`requestName`/`requestId` eklendi.
- **CodeMirror 6 tabanlı kod editörü**: raw body, script'ler ve response body artık satır numarası,
  JSON/XML/JavaScript syntax highlighting, kod katlama ve `{{var}}` vurgulaması içeren ortak bir
  `CodeEditor` bileşenini kullanıyor; JSON/XML için "Beautify" butonu var (bkz. yukarıdaki
  "CodeEditor" notu).
- **Ayarlar API'si + TLS doğrulama anahtarı**: `GET/PATCH /api/settings` (`api/settings.routes.ts`,
  zod `settingsPatchSchema` `network.verify_tls` / `timeout_ms` (0 = sınırsız, hata ayıklama için; bağlantı kurma ayrıca undici connector varsayılanı 10 sn ile sınırlı) / `max_redirects` ile UI tercihleri `ui.theme`
  (`dark|light`), `ui.sidebar_width` (100–2000 px), `ui.request_pane_ratio` (0.05–0.95), `ui.language` (`auto|tr|en`,
  bkz. "i18n")'ı açar; bkz. "Tema");
  `network.reuse_connections` için bkz. "Bağlantı yeniden kullanımı".
  `network.verify_tls=false` iken executor undici `Agent`'ı `connect.rejectUnauthorized=false` ile
  açar ve `ExecuteResult.tlsVerified=false` döner (ResponseViewer'da "TLS doğrulaması kapalı" uyarısı;
  `features/settings/SettingsMenu.tsx`). Doğrulama açıkken gömülü Mozilla köklerine ek olarak **işletim sisteminin sertifika
  deposuna** da güvenilir (`engine/trustStore.ts` `trustedCas()`: `tls.getCACertificates('default' + 'system')`, ilk HTTPS
  dispatcher'ında bir kez okunur; `buildConnector`/`proxyTls`/`requestTls`'e `ca` olarak geçer), yani işletim sistemine kurulu
  kurum CA'sı kendiliğinden tanınır; `NODE_EXTRA_CA_CERTS` de çalışmaya devam eder. Linux'ta sistem deposu OpenSSL
  dizinleri / `SSL_CERT_FILE`'dır (yerel sınama böyle yapıldı); Windows deposu ve macOS anahtar zinciri gerçek cihazda doğrulanmadı.
  Ayarlar > Güncellemeler yalnızca yüklü sürümü ve denetimin ne okuduğunu gösterir (denetim kapatılamaz, bkz. "Uygulama içi
  güncelleme").
  Kabuğa özel `GET /api/internal/proxy-url` (`api/internal.routes.ts`, `core/proxyUrl.ts`) aktif proxy'yi
  kimlik bilgisi dahil `{ url: "http://u:p@host:port" }` (yoksa `{ url: null }`) olarak döner ki updater
  kurum proxy'sinden geçebilsin; kullanıcıya açık `GET /api/proxies` parolayı vermeye devam etmez.

- **Proxy profilleri** (2026-11-13): `proxies` tablosu (0002), `/api/proxies` CRUD + `PUT /api/proxies/active`
  (en fazla bir aktif; parola API'ye dönmez, `hasPassword`). Ana istek, `rq.sendRequest` ve Postman API çekimi aynı
  `createDispatcherFor` yolundan geçer; atlama listesi (`tam ad`, `.sonek`, `*`; loopback her zaman doğrudan), Türkçe proxy
  hataları (407, bağlanılamadı, tünel). UI: üst barda proxy menüsü + yönetim diyaloğu (`features/proxy/`), yanıtta
  "proxy: ad" rozeti. Bilinen sınır: yönlendirme hedefi ilk dispatcher kararını paylaşır.
- **Postman'dan çek** (2026-11-13): `importers/postman-api.ts` Postman API'den (`X-Api-Key`) workspace →
  koleksiyon/ortam envanteri (`POST /api/import/postman-api/inventory`) ve seçilenlerin toplu içe aktarımı
  (`POST /api/import/postman-api`; koleksiyonlar/ortamlar mevcut importer'a, workspace global'leri `importPostmanGlobals`'a).
  Anahtar saklanmaz/loglanmaz; 401 anahtar reddi işlemi keser, tek öğe hatası `failed[]`'e düşer, 429'da bir kez yeniden
  denenir. UI: İçe aktar ▾ → Postman'dan çek… (`features/import/`). Test için `REQSTER_POSTMAN_API_BASE`.
- **Dışa aktarma + paylaşım paketi** (2026-11-13): `exporters/postman-v2.ts` importer'ın simetriği —
  `exportCollection` Postman v2.1 (`info.schema` v2.1.0, iç içe `item`, yapılandırılmış `url` + `raw`, `header/query`
  `disabled`, `body` raw/urlencoded/formdata + `options.raw.language`, auth bearer/basic/apikey/noauth, `event[]`,
  `variable[]` `type: secret|default` + `disabled`), `exportEnvironment` (Postman environment, `_postman_variable_scope`),
  `exportGlobals`, `buildBundle` (`ReqsterBundle`: `format: reqster-bundle`, `version: 1`, `app: reqster/<sürüm>` —
  `paths.ts` `appVersion()`: `REQSTER_VERSION` → server `package.json` → `0.0.0`), `exportOptions`. Uçlar
  (`api/export.routes.ts`): `GET /api/export/options`, `GET /api/export/collections/:id?secrets=0|1`,
  `GET /api/export/environments/:id?secrets=`, `POST /api/export/bundle` (`bundleExportSchema`); hepsi
  `Content-Disposition: attachment` (ASCII `filename` + RFC 5987 `filename*`; `<ad>.collection.json`,
  `<ad>.environment.json` (içerik Postman biçiminde, ad nötr), `reqster-paket-<YYYY-MM-DD>.reqster.json`). **Secret kuralı:** `secrets=1` /
  `includeSecrets=true` değilse secret değişkenler anahtarı ve `type: "secret"` ile ama **boş değerle** gider.
  İçe: `POST /api/import/bundle` (`importers/bundle.ts`; `format`/`version` denetimi 400, tüm parçalar tek
  `db.transaction` — iç importer transaction'ları savepoint'e dönüşür, bir parça bozuksa hiçbir şey yazılmaz
  `import.bundleFailed`), `secretsIncluded=false` ise `import.bundleSecretsEmpty` uyarısı (adlar listelenir);
  `POST /api/import/postman` gövdesi `format: "reqster-bundle"` ise aynı yola yönlenir. Round-trip (import → export →
  import → export birebir) ve `postman-collection` SDK parse'ı uçtan uca doğrulandı. Reqster'a özgü ek alan üretilmez.
- **cURL kopyala / yapıştır** (2026-11-15): `importers/curl.ts` bash (`\\` devamı, `'…'`, `"…"`, `$'…'`) ve
  Windows cmd (`^` kaçışı/devamı + MSVCRT argüman kuralları; Chrome "Copy as cURL (cmd)") sözdizimini otomatik algılar;
  `Authorization` başlığı auth'a, query params'a taşınır; tanınmayan/aktarılamayan bayraklar `warnings`'e. `exporters/curl.ts`
  executor kurallarıyla (devralınan auth, etkin satırlar, GET/HEAD'de gövde yok) bash ya da cmd komutu üretir; `{{var}}`
  korunur ya da çözümlenir (secret uyarısı), pre-request script çalışmaz (uyarı). Uçlar `POST /api/import/curl` (DB'ye
  yazmaz), `POST /api/export/curl`. UI: URL kutusuna `curl …` yapıştırınca aktif sekme dolar; İçe aktar ▾ → cURL'den…
  (yeni sekme); url-row'da `Terminal` menüsü (`features/request-builder/CurlCopyMenu.tsx`, `lib/clipboard.ts`).
  cmd kaçışı Chrome'unkidir, ters bölüler yalnızca `"` öncesinde ikilenir (Chrome hepsini ikiler).
- **Süre dökümü** (2026-11-16): `ExecuteResult.timings` (`ExecuteTimings`: hazırlık, pre/post script, soket,
  DNS, TCP, TLS, proxy tüneli + hedef TLS, bekleme/TTFB, indirme, toplam; `null` = adım yok/ölçülemedi), history'de
  `timings_json` (0003). Ölçüm `engine/timing.ts` `TimingProbe`: yürütmeye özel dispatcher'ın connector'ı sarılır
  (`createDispatcherFor(…, { probe })`; doğrudan `buildConnector`, proxy'de `clientFactory`+`factory`), soket olayları
  `lookup`/`connect`/`secureConnect`; son adımın bitişi connector callback'idir (undici'nin dinleyicisi ilk bağlantıda
  ayrıştırıcı yüklediği için olay geç gelir). Yalnızca ilk soket izlenir, yönlendirmeler `waitMs` içinde (`redirects`).
  `durationMs` anlamı değişmedi (ağ). UI: süre yazısının üzerinde waterfall açılır pencere. Dispatcher paylaşıldığı için probe
connector'a değil isteğin `AsyncLocalStorage` bağlamına bağlanır (`withProbe`/`probedConnector`).
- **Yerel kapı bekçisi** (2026-11-16; TASARIM.md §8/2): `security/localGuard.ts` her istekte (dil hook'undan
  sonra) Host adını loopback (`127.0.0.1`/`localhost`/`[::1]`) + `REQSTER_ALLOWED_HOSTS` ile sınar (DNS rebinding → 421; Host
  yoksa geçer), durum değiştiren yöntemde yabancı `Origin`'i 403'ler, `REQSTER_SESSION_TOKEN` varsa `X-Reqster-Token` başlığı ya da
  `reqster_session_<port>` çerezi ister (401) — **yalnızca `/api`**; sayfa/statik dosyalar token istemez. Token'ı paketlenmiş başlatıcı
  üretir (`REQSTER_AUTH=off` hariç; `deploy/Dockerfile` kapatır, ad `REQSTER_ALLOWED_HOSTS` ile verilir); READY satırı ve taşınabilir
  modun açtığı adres `?reqster_token=` taşır. Arayüz token'ı `app/src/lib/session.ts`'de adresten alır (sessionStorage, adresten
  silinir; `bootstrap.ts` ilk yükler), `api/client.ts` ve `lib/download.ts` her isteğe `X-Reqster-Token` ekler; sunucu o ilk
  istekte yönlendirmeden yedek çerez (`SameSite=Lax`) kurar. Çereze dayanmama nedeni: macOS WKWebView ilk açılışta çerezi
  göndermediği için rc.20/21'de pencere 401 gösteriyordu (TASARIM.md §8/2). Kabuk token'ı READY adresinden ayırır (`update::split_ready_url`), updater'ın
  yerel çağrılarına başlık olarak ekler, loga yazmaz. Geliştirmede (`npm run dev`/`start`) token yok, Host/Origin denetimi açık.
  Sunucuya curl ile elle istek atarken paketli modda `-H "X-Reqster-Token: …"` gerekir. Duman testi kapıyı da sınar.
- **Bağlantı yeniden kullanımı** (2026-11-16): `network.reuse_connections` (varsayılan açık, Ayarlar > Ağ).
  `engine/dispatcher.ts` havuzu; anahtar = verify_tls + max_redirects + aktif proxy (kimlik dahil, özet) → değişince eski
  havuz kapanır. Zaman aşımı istek başına interceptor'la. `sendWithStaleRetry`: havuzdan gelen bağlantı yanıtsız
  kapanırsa idempotent istek bir kez yinelenir (`timings.retried`), POST/PATCH'te `execute.staleConnection` hatası.
  Ayrıntı ve bedeli TASARIM.md'de.
- **Çoğaltma** (2026-11-16): `core/duplicate.ts` + `POST /api/{requests|folders|collections|environments}/:id/duplicate`
  (201, tek transaction). Ad "Ad (kopya)", çakışırsa "(kopya 2)"…, ek `duplicate.suffix` ile istek dilinde; kopyanın kopyası kök
  adı kullanır. İstek/klasör kopyası aslının hemen altına (`reorderRequests`/`reorderFolders` kardeş `sort_order`'ını yeniden yazar);
  klasör/koleksiyon alt ağacı özyinelemeli; koleksiyon değişkenleri ve ortam değişkenleri secret değer + işaret + enabled ile
  kopyalanır; kopya ortam etkin yapılmaz. UI: ağaç satırında ve Ortamlar penceresinde `Copy` simgesi; istek kopyası yeni sekmede
  açılır, ortam kopyası seçilir. `api.post` gövdesizken `Content-Type` göndermez (Fastify boş JSON gövdeyi 400'ler).
- **GitHub issue'larından gelen arayüz işleri** (2026-11-20, rc.21): Body/Auth sekmelerinde içerik noktası (Body'de yalnızca
  gönderilecek içerik varsa); anahtar/değer listelerinde **toplu düzenleme** (`anahtar:değer`, devre dışı satır `//`, form-data
  dosya türü anahtardan korunur); sekmeler **sürükle-bırak** ile sıralanır (`moveTab`; masaüstünde `dragDropEnabled: false`, yoksa
  WebView2 HTML5 sürüklemeyi yutar); gönderim sürerken yanıt panelinde ilerleme çubuğu + canlı sayaç ve **İptal** (UI `fetch`'i
  `AbortController` ile keser, `execute.routes.ts` yanıt bağlantısı kapanınca executor'a `signal` geçirir, undici isteği
  iptal olur, history'ye `execute.cancelled`); raw türlerine `text/xml`.
- **form-data dosya alanı** (2026-11-20): `KeyValueItem.type: 'file'`, değer yerel dosya yolu; gönderimde diskten bellekle okunur
  (streaming yok), history'ye içerik değil `<ad: N B>` yazılır; Postman dışa aktarımı `type: file` + `src`, cURL `--form k=@yol`;
  Postman içe aktarımı dosya alanlarını hâlâ atlar (raporlar). **Güvenlik kuralı:** dosya alanı yalnızca kullanıcının gönderdiği
  istekte (`ExecuteInput.body`) aynı yolla varsa okunur; pre-request script'i `rq.request.body` ile dosya satırı ekleyemez ya da
  yolunu değiştiremez (`execute.formFileFromScript`), yol `{{değişken}}` ile çözülmez — aksi halde içe aktarılan bir koleksiyonun
  script'i diskteki dosyaları dışarı gönderebilirdi (koruma kapatılarak sızma gösterildi, açıkken reddedildi).
- **Yanıt kodlaması + XML güzelleştirme** (2026-11-23): `engine/bodyDecode.ts` `decodeBody` yanıt gövdesini BOM →
  `Content-Type` `charset` → içerikteki bildirim (XML bildirimi, HTML meta) → UTF-8 sırasıyla çözer; baytlar UTF-8'e
  uymuyorsa istek diline göre windows-1254 (tr) / windows-1252'ye düşer. Ana istek ve `rq.sendRequest` aynı yolu kullanır;
  UTF-8 dışıysa `ExecuteResult.charset` döner (yanıtta rozet). `formatXml` yalnızca metin içeren öğeyi tek satırda tutar
  ve metnine dokunmaz (Beautify gönderilen değere boşluk eklemez). Yanıt gövdesinde Düzenli / Ham görünüm seçici.
- **Masaüstünde tarayıcı davranışı bastırılır** (2026-11-24): `lib/desktopGuard.ts` yalnızca kabukta (`isDesktopShell()`)
  yenile (Ctrl+R/F5), geri/ileri (Alt+ok, fare yan düğmeleri), yazdır, sayfada bul (kod editörü dışında), kaynağı gör gibi
  WebView kısayollarını ve metin girdisi/editör dışındaki sağ tık menüsünü `preventDefault` eder; tarayıcı modunda dokunmaz.
  Sekme kısayolları kabukta Ctrl+T / Ctrl+W (Alt+T / Alt+W de çalışır), tarayıcıda yalnızca Alt (`lib/shortcuts.ts`;
  ipuçları `NEW_TAB_KEYS`/`CLOSE_TAB_KEYS`). Yeni bir tarayıcı kısayolu sızarsa `isBrowserShortcut`'a eklenir.
- **Üst bar sadeleştirmesi** (2026-11-13): "+ Yeni istek" kalktı (sekme + / kabukta Ctrl+T, tarayıcıda Alt+T), ortam seçici + Ortamlar
  tek menü (Ortam yok / ortamlar / Ortamlar… / Değişkenler…), Ayarlar yalnızca simge, İçe aktar menüsü (Dosyadan… /
  Postman'dan çek…).

- **Yanıtı kaydet + ikili yanıt** (2026-11-26): arayüze ve history'ye giden gövde hâlâ `history.max_body_bytes` (1 MB) ile kırpılıp
  metne çevrilir, ama her yanıtın **tam gövdesi** okunurken `<veri klasörü>/tmp/responses/<id>.bin`'e akıtılır
  (`engine/responseStore.ts` `ResponseFileWriter`: backpressure'lı, üst sınır 200 MB → aşılırsa `complete: false`; en çok 10 dosya /
  500 MB tutulur, eskiler yeni yanıtla, tümü açılışta silinir; kayıt bellekte). `ExecuteResult.bodyFile {id, fileName, sizeBytes,
  complete}` + `GET /api/responses/:id/file` (attachment; silinmişse 404 `response.fileGone`). Önerilen ad `suggestFileName`:
  `Content-Disposition` → adresin son parçası → `response`, uzantı yoksa içerik türünden. **İkili yanıt** (`bodyDecode.ts`
  `isBinaryBody`: içerik türü metin değilse baştaki 8 KB'ta NUL baytı) metne çevrilmez: `binary: true`, `body: ''`, post-response
  script'i boş gövde görür, history'ye `<application/zip: N B>` notu yazılır. Arayüz: yanıtta "Kaydet…" (masaüstünde mevcut
  Farklı kaydet akışı), ikili yanıtta bilgi kartı. Hata/iptal durumunda dosya bırakılmaz. Geçici dosyalar yanıtı olduğu gibi içerir
  (maskeleme yok); veri klasöründen çıkmaz.
- **Dosya seçici** (2026-11-26; `core/filePicker.ts`, `src-tauri/src/picker.rs`): form-data dosya satırında masaüstünde "Dosya seç".
  IPC yok, WebView yolu vermez; akış sidecar üzerinden: arayüz `POST /api/shell/pick-file` (yanıtı bekler, 10 dk zaman aşımı) →
  sunucu stdout'a `REQSTER_PICK_FILE <id>` → kabuk asenkron `pick_file` diyaloğu → `POST /api/internal/picked-file {id, path|null}`
  (token'lı; adres/token READY'de `picker::LocalServer` durumuna alınır) → arayüze `{path}`. Aynı anda tek diyalog; kabuk yokken
  501 (düğme yalnızca `isDesktopShell()`'de görünür). Duman testi sözleşmeyi kabuksuz sınar. Dosya güvenlik kuralı değişmedi.

Bilinen sınırlamalar: form-data dosya alanı yerel yolla çalışır (dosya seçici yalnızca masaüstünde, dosya her gönderimde diskten okunur, Postman içe aktarımında dosya yolları alınmaz);
script log/test sonuçları history'de kalıcı değil (yalnızca o çalıştırmanın UI state'i);
`isolated-vm@7` paketi Node ≥26 istiyor ama Node 24.15'te sorunsuz çalışıyor (bkz. `npm warn EBADENGINE`
uyarısı — zararsız, göz ardı edilebilir).

Depo: `https://github.com/reqster-dev/reqster` (CI, Release'ler, katkılar).

## Yol Haritası

### Faz 2 — Kalan işler: runner ve test altyapısı
- [ ] Collection runner: bir koleksiyonu/klasörü sırayla koşma, sonuç özeti (script sandbox'ı
      tek istek yürütmesi için değil, bir DİZİ istek için tekrar tekrar çağırması yeterli olmalı)
- [ ] Script log/test sonuçlarının history'ye kalıcı yazımı (istenirse; şu an yalnızca UI state'inde)
- [ ] Test altyapısının kurulması (vitest önerisi): önce importer, interpolasyon/çözümleme ve
      script sandbox (rq.*/pm.* davranışları) için birim testleri, import→export round-trip testi

### Faz 3 — Paketleme ve genişletme
- [x] Postman v2.1 **export** + `.reqster.json` paylaşım paketi (2026-11-13; round-trip doğrulandı)
- [x] **Tauri kabuğu** (2026-11-11): `src-tauri/`, sidecar sözleşmesi, Linux'ta çapraz derlenen
      Windows NSIS kurulum dosyası (bkz. "Masaüstü paketi"). Kalan: kod imzası,
      Linux deb/AppImage'ın Release'e eklenmesi, Windows'ta gerçek cihaz testi (kullanıcı).
- [x] cURL import/export (bash + Windows cmd; 2026-11-15)
- [ ] OpenAPI import
- [ ] Cookie yönetimi: `engine/cookie-jar.ts` + UI
- [ ] Secret değerlerin OS keychain'e taşınması (tabloda yalnızca referans)
- [x] form-data dosya alanı (2026-11-20; yerel yol, bellekte multipart; dosya seçici 2026-11-26, masaüstünde; kalan: streaming)

### Birikmiş küçük işler (fazdan bağımsız)
- [ ] Raw body editöründe `{{var}}` vurgusu (VariableInput overlay tekniğinin textarea'ya uyarlanması)
- [ ] İstek/klasör taşıma (drag-and-drop) ve `sort_order` güncelleme endpoint'i
- [x] History'de gün başlıklarıyla gruplama (2026-11-16: Bugün/Dün/tarih, yapışkan başlık + kayıt sayısı)
- [ ] History'de arama/filtreleme
- [ ] Çoklu workspace desteği (şema hazır, `getDefaultWorkspace()` tekil varsayıyor)
- [ ] GraphQL body modu için özel editör (import şu an raw JSON'a indirgiyor)
