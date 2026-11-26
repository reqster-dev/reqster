# Reqster — Mimari Tasarım Dokümanı (TASARIM.md)

> Tamamen yerel çalışan, hafif ve veri gizliliği odaklı bir Postman alternatifi.
> Bu doküman fonksiyonel kod içermez; yalnızca mimari kuralları, veri şemasını ve best-practice'leri tanımlar.
>
> **Ad:** *Reqster = request + tester*; 1.0.0-rc.20'ye kadar adı **Reqly**'ydi. Ad değişikliği kullanıcı verisini ve
> alışkanlıklarını kırmaz: uygulama kimliği (`tr.talhacigdem.reqly`) ve dolayısıyla güncelleme zinciri aynı kalır (veri klasörü
> 1.0.0-rc.27'de taşınmadan `%APPDATA%\Reqster` oldu; 1.0.0 öncesi olduğu için eski klasördeki veri aktarılmaz), eski veritabanı dosyası, `REQLY_*` ortam değişkenleri ve `reqly-bundle` paketleri tanınır, script API'si
> (`rq.*`, `pm.*`) değişmez.

---

## 1. Temel İlkeler

1. **Local-first / Offline-first:** Hiçbir veri dışarı çıkmaz. Telemetri, hesap, senkronizasyon, bulut yok. Tüm veri tek bir SQLite dosyasında kullanıcının diskinde durur.
2. **Hafiflik:** Minimum bağımlılık, tek süreçlik yerel backend, paketlenmiş tek çalıştırılabilir hedefi.
3. **Modülerlik:** Her yetenek (koleksiyon, ortam, script, import) bağımsız bir modül; modüller arası iletişim tanımlı arayüzler üzerinden.
4. **Güvenlik varsayılanı:** Kullanıcı scriptleri asla ana süreçte çalışmaz; her zaman izole, yetkisiz ve zaman sınırlı bir sandbox içinde koşar.

---

## 2. Teknoloji Kararları ve Gerekçeleri

| Katman | Seçim | Gerekçe |
|---|---|---|
| Frontend | React + Vite + TypeScript | Hızlı geliştirme, tip güvenliği, hafif build |
| Backend | Node.js + Fastify (yerel HTTP sunucu, sadece `127.0.0.1`) | Hafif, tek runtime (script sandbox ile aynı dil), Electron'a göre çok daha düşük ayak izi |
| Veritabanı | SQLite (`better-sqlite3`, WAL modu) | Senkron ve hızlı, tek dosya, sıfır kurulum |
| İstek motoru | Backend tarafında native HTTP istemcisi (`undici`) | **Kritik:** Tarayıcı CORS/çerez kısıtlarına takılmamak için HTTP istekleri her zaman backend'den atılır, frontend asla doğrudan hedef API'ye gitmez |
| Script sandbox | Ayrı worker süreci + `isolated-vm` | Bkz. Bölüm 5 |
| Masaüstü paketleme (opsiyonel faz) | Tauri (webview kabuğu) | Electron'a göre ~10x küçük binary; backend sidecar olarak gömülür |

**Mimari akış:**

```
┌─────────────┐   HTTP (127.0.0.1)   ┌──────────────────┐   undici    ┌────────────┐
│  React UI   │ ───────────────────► │  Fastify Backend │ ──────────► │  Hedef API │
│  (tarayıcı/ │ ◄─────────────────── │  + SQLite        │ ◄────────── │            │
│   webview)  │      WebSocket*      │  + Script Worker │             └────────────┘
└─────────────┘                      └──────────────────┘
* WebSocket: uzun süren istekler, script logları ve iptal sinyali için
```

---

## 3. Klasör Yapısı

Monorepo (npm workspaces), üç paket: `app` (UI), `server` (backend), `shared` (ortak tipler).

```
reqster/
├── package.json                  # workspace kökü
├── TASARIM.md
├── packages/
│   ├── shared/                   # UI ve server'ın ortak kullandığı saf tipler
│   │   └── src/
│   │       ├── types/            # Request, Collection, Environment, HistoryEntry...
│   │       ├── constants/        # HTTP metodları, auth tipleri, limitler
│   │       └── validation/       # Şema doğrulama tanımları (zod şemaları)
│   │
│   ├── server/                   # Yerel backend
│   │   └── src/
│   │       ├── index.ts          # Giriş noktası: sunucuyu 127.0.0.1'e bağlar
│   │       ├── api/              # HTTP route katmanı (ince, sadece giriş/çıkış)
│   │       │   ├── collections.routes.ts
│   │       │   ├── requests.routes.ts
│   │       │   ├── environments.routes.ts
│   │       │   ├── history.routes.ts
│   │       │   └── import.routes.ts
│   │       ├── core/             # Alan mantığı (route'lardan bağımsız)
│   │       │   ├── collections/
│   │       │   ├── environments/
│   │       │   ├── history/
│   │       │   └── variables/    # Değişken çözümleme motoru ({{var}} interpolasyonu)
│   │       ├── engine/           # HTTP istek yürütme hattı
│   │       │   ├── executor.ts   # İstek yaşam döngüsü orkestrasyonu
│   │       │   ├── interpolate.ts
│   │       │   └── cookie-jar.ts
│   │       ├── scripting/        # Sandbox altyapısı (Bölüm 5)
│   │       │   ├── host.ts       # Worker yaşam döngüsü yönetimi
│   │       │   ├── worker.ts     # İzole süreçte çalışan taraf
│   │       │   └── bridge.ts     # pm-benzeri API'nin mesajlaşma köprüsü
│   │       ├── importers/        # Format dönüştürücüler (Bölüm 6)
│   │       │   ├── postman-v2.ts
│   │       │   └── (curl.ts, openapi.ts — gelecek)
│   │       └── db/
│   │           ├── connection.ts # Tek bağlantı, WAL, foreign_keys=ON
│   │           ├── migrations/   # Numaralı SQL migration dosyaları
│   │           │   └── 0001_init.sql
│   │           └── repositories/ # Tablolara erişim (SQL yalnızca burada yaşar)
│   │
│   └── app/                      # React UI
│       └── src/
│           ├── main.tsx
│           ├── api/              # Backend istemcisi (tek yerden fetch)
│           ├── stores/           # UI durumu (zustand önerilir)
│           ├── features/         # Özellik-bazlı dikey dilimler
│           │   ├── request-builder/   # URL, method, header, body editörleri
│           │   ├── response-viewer/   # Body/header/timing görüntüleme
│           │   ├── collections/       # Sol panel ağacı
│           │   ├── environments/      # Ortam & değişken yönetimi
│           │   ├── history/
│           │   ├── scripting/         # Script editörü + konsol çıktısı
│           │   └── import-export/
│           └── components/       # Özellikten bağımsız ortak UI parçaları
│
└── data/                         # Çalışma zamanı (git'e girmez)
    └── reqster.db                  # Tek SQLite dosyası (kullanıcı dizininde tutulur)
```

**Kurallar:**
- `shared` hiçbir pakete bağımlı olamaz; `app` ve `server` yalnızca `shared`'a bağımlı olabilir.
- SQL sorguları yalnızca `db/repositories/` içinde yazılır; `core/` katmanı repository arayüzleriyle konuşur.
- `api/` route dosyaları iş mantığı içermez; doğrulama + `core` çağrısı + yanıt şekillendirme ile sınırlıdır.
- Veritabanı dosyası üretimde işletim sisteminin kullanıcı veri dizinine yazılır (`%APPDATA%/reqster/`, `~/.local/share/reqster/`), proje dizinine değil.

---

## 4. Veri Tabanı Şeması (SQLite)

**Genel kararlar:**
- ID'ler: `TEXT` tipinde UUIDv7 (zaman sıralı → index dostu, import/export'ta çakışmasız).
- Tarihler: `INTEGER` epoch milisaniye (`created_at`, `updated_at`).
- Yarı yapısal veri (header listesi, query param listesi) `TEXT` kolonlarında JSON olarak tutulur — bunlar her zaman bütün halinde okunup yazılır, üzerinde SQL ile sorgu yapılmaz; bu yüzden ayrı tabloya normalize etmek gereksiz karmaşıklıktır.
- `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON` zorunludur.
- Şema versiyonu `schema_migrations` tablosuyla izlenir; her değişiklik numaralı migration dosyasıdır.

### 4.1 Koleksiyonlar ve İstekler

```sql
CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE collections (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    description   TEXT,
    -- Koleksiyon seviyesi script'ler (tüm alt isteklerden önce/sonra koşar)
    pre_request_script   TEXT,
    post_response_script TEXT,
    -- Koleksiyon seviyesi auth (alt istekler 'inherit' ile devralır)
    auth_json     TEXT,              -- {"type":"bearer","config":{...}} | NULL
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Klasörler: koleksiyon içi hiyerarşi (self-referencing ağaç)
CREATE TABLE folders (
    id             TEXT PRIMARY KEY,
    collection_id  TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    parent_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = kök seviye
    name           TEXT NOT NULL,
    description    TEXT,
    pre_request_script   TEXT,
    post_response_script TEXT,
    auth_json      TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE TABLE requests (
    id             TEXT PRIMARY KEY,
    collection_id  TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    folder_id      TEXT REFERENCES folders(id) ON DELETE CASCADE,  -- NULL = koleksiyon kökü
    name           TEXT NOT NULL,
    description    TEXT,
    method         TEXT NOT NULL,           -- GET, POST, ...
    url            TEXT NOT NULL,           -- ham hali, {{degisken}} içerebilir
    headers_json   TEXT NOT NULL DEFAULT '[]',  -- [{"key","value","enabled"}]
    params_json    TEXT NOT NULL DEFAULT '[]',  -- query paramları, aynı yapı
    body_json      TEXT,                    -- {"mode":"raw|form-data|urlencoded|file","content":...}
    auth_json      TEXT,                    -- NULL = üstten devral (inherit)
    pre_request_script   TEXT,
    post_response_script TEXT,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_folders_collection ON folders(collection_id, parent_id, sort_order);
CREATE INDEX idx_requests_tree      ON requests(collection_id, folder_id, sort_order);
```

### 4.2 Ortamlar ve Değişkenler

Değişkenler üç kapsamda (scope) yaşar ve çözümleme önceliği şudur:
**yerel (script çalışma anı) → ortam (aktif environment) → koleksiyon → global**

```sql
CREATE TABLE environments (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 0,   -- workspace başına en fazla 1 aktif
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Tek tablo, scope ayrımı owner kolonlarıyla: tam olarak biri dolu olmalı
-- (global scope için workspace_id dolu olur)
CREATE TABLE variables (
    id              TEXT PRIMARY KEY,
    environment_id  TEXT REFERENCES environments(id) ON DELETE CASCADE,
    collection_id   TEXT REFERENCES collections(id)  ON DELETE CASCADE,
    workspace_id    TEXT REFERENCES workspaces(id)   ON DELETE CASCADE, -- global scope
    key             TEXT NOT NULL,
    value           TEXT,
    is_secret       INTEGER NOT NULL DEFAULT 0,  -- UI'da maskele, export'a dahil etme
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    CHECK (
        (environment_id IS NOT NULL) + (collection_id IS NOT NULL) + (workspace_id IS NOT NULL) = 1
    )
);

-- Aynı kapsam içinde aynı anahtar bir kez
CREATE UNIQUE INDEX uq_var_env  ON variables(environment_id, key) WHERE environment_id IS NOT NULL;
CREATE UNIQUE INDEX uq_var_coll ON variables(collection_id,  key) WHERE collection_id  IS NOT NULL;
CREATE UNIQUE INDEX uq_var_ws   ON variables(workspace_id,   key) WHERE workspace_id   IS NOT NULL;
```

**Gizlilik notu:** `is_secret=1` olan değerler; history kayıtlarında, export dosyalarında ve script konsol loglarında `«masked»` olarak yazılır. İleri faz: bu değerleri işletim sistemi keychain'inde tutup tabloda yalnızca referans saklamak.

### 4.3 İstek Geçmişi (History)

History **snapshot** mantığıyla çalışır: isteğin gönderildiği andaki *çözümlenmiş* hali saklanır (değişkenler yerine konmuş), çünkü kaynak request sonradan değişebilir ya da silinebilir.

```sql
CREATE TABLE history (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    request_id     TEXT,               -- kaynak istek; FK DEĞİL, istek silinse de geçmiş kalır
    executed_at    INTEGER NOT NULL,
    duration_ms    INTEGER,
    -- İstek snapshot'ı (değişkenler çözülmüş, secret'lar maskelenmiş)
    method         TEXT NOT NULL,
    url            TEXT NOT NULL,
    request_headers_json TEXT,
    request_body   TEXT,               -- boyut limiti aşılırsa NULL + truncated=1
    -- Yanıt snapshot'ı
    status_code    INTEGER,            -- NULL = ağ hatası / iptal
    response_headers_json TEXT,
    response_body  BLOB,               -- binary yanıtlar için BLOB
    response_size  INTEGER,
    truncated      INTEGER NOT NULL DEFAULT 0,
    error          TEXT,               -- ağ hatası mesajı
    timings_json   TEXT                -- süre dökümü (ExecuteTimings, 0003); eski kayıtlarda NULL
);

CREATE INDEX idx_history_time ON history(workspace_id, executed_at DESC);
```

**Saklama politikası:** Gövdeler için üst limit (varsayılan 1 MB; üstü kırpılır ve `truncated=1` işaretlenir). Bu sınır arayüze dönen gövde için de geçerlidir; yanıtın **tam gövdesi** history'ye değil, "Yanıtı kaydet" için veri klasöründeki geçici dosyaya akar (`engine/responseStore.ts`: en çok 200 MB/yanıt, son 10 yanıt / 500 MB, açılışta temizlenir; `GET /api/responses/:id/file`). İkili yanıt (zip, resim, PDF) metne çevrilmez, history'ye yalnızca `<tür: N B>` notu düşer: metne çevirmek içeriği geri dönüşsüz bozar ve history'yi şişirirdi. Geçici dosyalar maskelenmez (yanıtın aslıdır), bu yüzden kalıcı tutulmaz. Otomatik temizlik: workspace başına son N kayıt (varsayılan 1000) veya X gün — kullanıcı ayarı. Temizlik uygulama açılışında ve periyodik olarak koşar.

### 4.4 Yardımcı Tablolar

```sql
CREATE TABLE settings (
    key    TEXT PRIMARY KEY,   -- 'history.max_entries', 'network.timeout_ms', ...
    value  TEXT NOT NULL       -- JSON
);

CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  INTEGER NOT NULL
);
```

**Proxy profilleri (`0002_proxies.sql`, 2026-11-13):** `proxies(id, name, url, username, password, bypass_json, is_active,
created_at, updated_at)` + `is_active=1` için kısmi unique index (en fazla bir aktif; hiçbiri aktif değilse istekler
doğrudan gider). Uygulama geneli, workspace'e bağlı değil. Parola API'ye asla dönmez (`ProxyProfile.hasPassword`);
yalnızca `engine/dispatcher.ts` okur. Ana istek, script içi `rq.sendRequest` ve Postman API çekimi tek
`createDispatcherFor(url, ayarlar)` noktasından geçer: aktif proxy varsa ve hedef atlama listesinde değilse undici
`ProxyAgent` (http hedefler düz proxy isteği, https hedefler CONNECT; kurumsal proxy'lerin yalnızca 443'e tünel açması
yaygın), aksi halde `Agent`. Atlama listesi: tam ad, `.sonek`, `*`; loopback her zaman doğrudan. Bilinen sınır:
yönlendirme hedefi ilk dispatcher kararını paylaşır. Parola DB'de düz metindir (değişken secret'larıyla aynı durum;
OS keychain Faz 3).

**Bağlantı yeniden kullanımı (2026-11-16):** `network.reuse_connections` (varsayılan açık) iken ana istek ve
`rq.sendRequest` süreç boyu paylaşılan bir doğrudan + bir proxy dispatcher'ı kullanır (keep-alive; sunucu `Keep-Alive`
bildirmezse boşta 30 sn). Havuz anahtarı TLS doğrulaması + yönlendirme sınırı + aktif proxy (adres ve kimlik bilgisi,
SHA-256 özeti); biri değişince eski havuz kapatılır — `verify_tls=false` ile açılmış soket doğrulama açıkken kullanılmaz.
Zaman aşımı istek başına uygulanır. Havuzdan gelen bağlantı yanıtsız kapanırsa (`UND_ERR_SOCKET`/`ECONNRESET`/`EPIPE`)
idempotent istek bir kez yeni bağlantıyla yinelenir (`timings.retried`); POST/PATCH yinelenmez, açıklayıcı hata döner.
Bedeli: ilk/sonraki istek süreleri farklı (döküm "mevcut bağlantı" notu verir), DNS/hosts değişikliği açık bağlantıya
yansımaz, yük dengeleyici arkasında hep aynı arka uca gidilebilir — bunlar için ayar kapatılır. Postman API çekimi kendi
dispatcher'ını açıp kapatır.

UI tercihleri (`ui.theme`, `ui.sidebar_width`, `ui.request_pane_ratio`) de `settings` tablosundadır: Tauri kabuğu
sidecar'ı her açılışta farklı porttan yüklediği için tarayıcı depolaması origin'le birlikte sıfırlanır; kalıcı kaynak
sunucudur, sunucu `index.html`'i kayıtlı temayla basar.


### 4.5 Dosya Tabanlı Koleksiyon Depolama (Git ile çalışma)

> **Durum: tasarım onaylandı (paket A, 2026-11-16); uygulama B–F paketlerinde.** Uygulanınca §1/1 ("tek SQLite dosyası") ve §4.1–4.2 bu bölüme göre
> güncellenir. Kararlar (2026-11-16): YAML, istek başına bir dosya; mevcut koleksiyonlar tek seferlik geçişle dosyaya
> taşınır, DB modu kalmaz.

**Amaç.** Koleksiyonlar bir ekibin Git deposunda yaşayabilsin: PR ile istek eklensin, diff okunabilsin, `git pull`
sonrası uygulama değişikliği görsün. Kişisel ve makineye özgü durum (geçmiş, ayarlar, secret değerler, script'in o an
yazdığı token'lar) depoya **hiçbir zaman** girmez.

#### 4.5.1 Ne nerede durur

| Veri | Yer | Gerekçe |
|---|---|---|
| Koleksiyon, klasör, istek (URL, params, headers, body, auth şekli, script'ler, açıklama, sıra) | **Dosya** | Paylaşılan tanım |
| Koleksiyon değişkenleri: anahtar, paylaşılan değer, `secret`/`enabled` bayrağı | **Dosya** | Ekip aynı anahtarları görür |
| Ortamlar ve ortam değişkenleri (aynı kural) | **Dosya** | Paylaşılan tanım |
| Secret değişken **değerleri** | DB `local_values` | Depoya asla girmez (§8/5) |
| Değişkenlerin **yerel değeri** (script'in `rq.environment.set` ile yazdığı, kullanıcının "yalnızca bende" dediği) | DB `local_values` | Script her çalıştığında depo kirlenmesin |
| Global değişkenler | DB (`variables`, workspace scope) | Kişisel; Postman'de de workspace'e özgü |
| Aktif ortam | DB (`settings`: `workspace.active_environment`) | Kişisel tercih; dosyaya yazılırsa her seçim bir diff olur |
| History, ayarlar, proxy profilleri | DB (değişmez) | Kişisel / makineye özgü |

**Değişken çözümü:** `yerel değer ?? dosyadaki değer`. Secret değişkenin dosyada değeri yoktur, yalnız yerel değeri
vardır. Script yazmaları (`rq.environment.set/unset`, `rq.collectionVariables.set/unset`) **yerel değere** gider,
dosyaya dokunmaz (Postman'deki "current value" karşılığı); paylaşılan bir değişkeni `unset` etmek yerelde bir
"silindi" işareti bırakır. Değişkenler diyaloğunda düzenleme varsayılan olarak dosyaya
(paylaşılan değer) yazar; satırda "yerel değer var" işareti ve "Sıfırla" (yerel değeri sil) bulunur. Script'in
yeni oluşturduğu anahtar da yalnızca yereldir: dosyaya kullanıcı "Paylaş" diyene kadar girmez.

#### 4.5.2 Dizin düzeni

Bir **çalışma alanı dizini** vardır: varsayılan `<REQSTER_DATA_DIR>/workspace/`, ayarlardan (`storage.workspace_dir`)
herhangi bir klasöre — tipik olarak bir Git deposunun içine — taşınabilir. Uygulama Git komutu çalıştırmaz; depo
işlemleri kullanıcının kendi aracıyla yapılır (Faz 2'de salt-okur durum gösterimi düşünülebilir).

```
<çalışma alanı>/
  .gitignore                     # uygulamanın ürettiği şablon (yerel/ geçici dosyalar)
  environments/
    Geliştirme.env.yml
    Test.env.yml
  collections/
    Kullanıcı API/
      reqster.collection.yml       # koleksiyon ayarları + değişkenler; dizini koleksiyon yapan işaret
      Kullanıcı listesi.req.yml
      Yönetim/
        _folder.yml              # klasör ayarları (yoksa varsayılanlar)
        Kullanıcı sil.req.yml
```

- Klasör = alt dizin. `_folder.yml` alt çizgiyle başlar ki "folder" adlı bir istekle çakışmasın ve listede başta dursun.
- Dosya adı, öğe adından üretilir: Windows'ta yasak karakterler (`\ / : * ? " < > |`, kontrol karakterleri) `_` olur,
  sondaki nokta/boşluk atılır, ayrılmış adlar (`CON`, `NUL`, `COM1`…) `_` ön ekiyle kaçar, en fazla 120 karakter.
  Büyük/küçük harf duyarsız çakışmada (`Liste` / `liste`) ` (2)` eklenir. Türkçe karakterler korunur (UTF-8, NFC).
- Görünen ad dosyadaki `name` alanıdır, dosya adı değil: kaçış/kırpma görünen adı bozmaz. Ad değişince dosya
  yeniden adlandırılır (Git bunu "rename" olarak görür).

#### 4.5.3 Dosya biçimleri

Ortak kurallar: UTF-8, LF, dosya sonunda tek satır sonu; anahtarlar **sabit sırada**; boş/varsayılan alanlar yazılmaz
(`enabled: true`, boş liste, `description` yok…); çok satırlı metin (script, raw body, açıklama) `|` blok skaleriyle,
tek satırlık değer gerekiyorsa tırnaklı. Aynı model → aynı bayt (deterministik yazım), yoksa her kayıt sahte diff üretir.
`createdAt` UUIDv7 kimliğin zaman damgasından, `updatedAt` dosyanın mtime'ından türetilir; dosyaya tarih yazılmaz.

İstek (`*.req.yml`):

```yaml
id: 0193a1f2-7c4e-7b21-9d0a-3f1c2b4a5e6f
name: Kullanıcı listesi
seq: 3
method: GET
url: "{{baseUrl}}/users"
params:
  - key: page
    value: "1"
headers:
  - key: Accept
    value: application/json
  - key: X-Debug
    value: "1"
    enabled: false
auth:                     # alan yoksa = üstten devral; `type: none` = auth yok
  type: bearer
  token: "{{token}}"
body:
  mode: raw
  contentType: application/json
  raw: |
    {
      "aktif": true
    }
scripts:
  preRequest: |
    rq.environment.set('ts', String(Date.now()));
  postResponse: |
    rq.test('200', () => rq.expect(rq.response.status).to.equal(200));
description: |
  Sayfalı kullanıcı listesi.
```

- `auth` biçimleri: `{type: none}`, `{type: bearer, token}`, `{type: basic, username, password}`,
  `{type: apikey, key, value, in: header|query}` — iç modeldeki iç içe nesne (`bearer: {token}`) dosyada düzleştirilir.
  Auth alanlarında düz parola yazmak kullanıcının kararıdır; arayüz `{{değişken}}` + secret değişken önerir.
- `body.mode`: `none | raw | urlencoded | form-data`; urlencoded/form-data `items:` listesi (params ile aynı biçim).

Koleksiyon (`reqster.collection.yml`) — biçim sürümü yalnızca burada tutulur:

```yaml
reqster: 1                  # dosya biçimi sürümü; bilinmeyen büyük sürüm → salt-okur + uyarı
id: 0193a1f0-…
name: Kullanıcı API
auth: { type: bearer, token: "{{token}}" }
# scripts: istekteki gibi (preRequest / postResponse)
variables:
  - key: baseUrl
    value: https://api.example.com
  - key: token
    secret: true          # değer dosyaya yazılmaz; yerel değer DB'de
```

Klasör (`_folder.yml`): `id, name, seq, auth, scripts, description` (koleksiyonla aynı alanlar, `variables` yok).
Ortam (`environments/<ad>.env.yml`): `id, name, variables` (koleksiyon değişkenleriyle aynı biçim).

**Kimlik ve sıra.** Her dosyanın kalıcı `id`'si vardır; history, açık sekmeler ve yerel değerler buna bağlanır, dosya
taşınsa/yeniden adlandırılsa da kopmaz. Değişken kimliği `(sahip id, anahtar)` çiftinden türetilen kararlı bir
değerdir (API'deki `/variables/:id` sözleşmesi korunur). Kardeşler `seq`'e, eşitlikte ada göre sıralanır; yeniden
sıralama yalnızca yeri değişen kardeşlerin `seq`'ini yazar. İki dosyada aynı `id` görülürse (elle kopyalama, birleştirme)
yol sırasına göre ikincisine bellekte geçici kimlik verilir, uyarı gösterilir; dosya ancak kullanıcı onu kaydedince
yeni kimlikle yazılır (uygulama kendiliğinden depoyu kirletmez).

#### 4.5.4 Okuma, yazma, tutarlılık

- **Bellek indeksi:** açılışta çalışma alanı taranır, tüm dosyalar ayrıştırılıp bellekte ağaç + `id → yol` haritası
  kurulur (birkaç bin dosya < 1 sn). SQL'deki `collections/folders/requests` tabloları kaldırılır; repository
  fonksiyonlarının imzaları korunur, arkalarında dosya deposu çalışır (paket B) — route'lar, engine, UI değişmez.
- **Bozuk dosya** (YAML hatası, şema dışı alan) koleksiyonu düşürmez: öğe "hatalı" olarak ağaçta görünür, hata
  mesajı ve satırı ile; düzeltilene kadar çalıştırılamaz, uygulama o dosyanın üstüne yazmaz.
  Tanınmayan alanlar okunurken korunur ve yazarken geri yazılır (ileri sürüm uyumu, başka araçların eklediği alanlar).
- **Atomik yazım:** aynı dizinde geçici dosya + `rename` (Windows'ta antivirüs kilidi için kısa yeniden deneme).
  Çok dosyalı işlemler (import, çoğaltma, klasör silme, koleksiyon geçişi) bir **hazırlık dizininde** üretilip tek
  `rename` ile yerine konur; olmuyorsa yazılan dosyalar geri alınır. §8/2'deki "tek transaction" kuralının dosya
  karşılığı budur: yarıda kalmış koleksiyon bırakılmaz.
- **Dış değişiklik izleme:** çalışma alanı izlenir (`fs.watch` özyinelemeli; desteklemeyen platformda yoklama).
  Uygulamanın kendi yazdığı dosyalar içerik özetiyle tanınıp yok sayılır. Dış değişiklikte indeks yenilenir ve UI'a
  bildirilir (ağaç yenilenir; açık sekmede kaydedilmemiş değişiklik varsa "dosya diskte değişti: yeniden yükle /
  benimkini koru" sorulur). Git'in çakışma işaretli dosyası (`<<<<<<<`) bozuk dosya muamelesi görür.
- **Silme:** dosya/dizin kalıcı silinir (arayüzdeki onay diyaloğu korunur; depodaysa Git geçmişi geri getirir).

#### 4.5.5 Tek seferlik geçiş (paket C)

Yeni migration, açılışta `collections/folders/requests` ve koleksiyon/ortam değişkenlerini çalışma alanına yazar:
paylaşılan değerler dosyaya, secret değerler `local_values`'a, aktif ortam `settings`'e. Önce `reqster.db` yedeklenir
(`reqster.pre-files.db`), dosyalar hazırlık dizininde üretilip yerine konur, sonra tablolar boşaltılır. Geçiş raporu
(kaç koleksiyon/istek, ad çakışmasıyla yeniden adlandırılanlar) ilk açılışta gösterilir. Geçiş başarısızsa DB'ye
dokunulmaz, uygulama eski tablolarla değil hata ekranıyla açılır (yedekten dönüş talimatıyla).

#### 4.5.6 Import / export / paylaşım paketi

Postman ve `.reqster.json` içe aktarımı aynı iç modeli üretip dosya deposuna yazar (§8/6 değişmez). Export değişmez.
Dosya tabanlı koleksiyon zaten paylaşılabilir olduğu için `.reqster.json` paketi Git kullanmayan ekipler için kalır.

#### 4.5.7 Bağımlılık

YAML için `yaml` (eemeli/yaml): bağımlılıksız, belge düzeyinde biçim kontrolü (blok skaler, tırnak, anahtar sırası)
verir; deterministik yazım için gerekli. Dosya izleme Node yerleşik `fs.watch` ile; yetmezse `chokidar` ayrıca tartışılır.

#### 4.5.8 Kararlar (paket A onayı, 2026-11-16)

1. **Tek çalışma alanı dizini.** Başka depolardaki koleksiyon dizinlerini "bağlama" sonraki bir iştir.
2. Değişkenler penceresinde düzenleme varsayılan olarak **paylaşılan değere** (dosyaya) yazar; "yalnızca bende"
   ile yerel değer girilir. Script yazmaları ve secret değerler her durumda yalnızca yereldir.
3. Ortamlar **çalışma alanı düzeyinde** kalır (`environments/`), bugünkü çözümleme modeli değişmez.

---

## 5. Script Altyapısı Mimarisi (Pre-request / Post-response)

### 5.1 Tehdit Modeli ve Temel Kural

Kullanıcı scriptleri güvenilmez koddur (import edilmiş bir koleksiyondan gelebilir). **Ana kural:** script'ler asla backend'in ana sürecinde ve asla `eval`/`new Function`/`node:vm` ile çalıştırılmaz (`node:vm` güvenlik sınırı değildir). Bunun yerine:

```
Backend ana süreci
   │  (yapılandırılmış mesaj: script + girdi bağlamı)
   ▼
Script Worker (ayrı child process — worker_threads DEĞİL: bir isolate segfault'u
                thread'i değil tüm process'i öldürür, bu yüzden gerçek OS-seviyesi izolasyon
                yalnızca ayrı process ile sağlanır)
   └── isolated-vm isolate'ı           ← V8 seviyesinde bellek/CPU sınırlı gerçek izolasyon
         • Ağ erişimi YOK
         • Dosya sistemi erişimi YOK
         • require/import YOK
         • process, os, Buffer YOK
         • Yalnızca köprüyle sunulan sınırlı API var
```

**Uygulanan sınırlar:**

| Sınır | Değer (varsayılan) | Aşılırsa |
|---|---|---|
| Duvar saati zaman aşımı | 5 sn | Isolate öldürülür, istek "script timeout" hatasıyla işaretlenir |
| Bellek | 64 MB isolate limiti | Isolate öldürülür |
| Konsol çıktısı | 256 KB / çalıştırma | Sonrası atılır |
| Değişken yazma | yalnızca izin verilen scope'lar | Sessizce reddedilmez; hata döner |

Worker süreci çökerse ana süreç etkilenmez; worker havuzu (1 adet, lazy) yeniden başlatılır.

### 5.2 Script API Yüzeyi (pm-benzeri, `rq` namespace)

Sandbox içine yalnızca şu yüzey enjekte edilir; doğrudan referans asla paylaşılmaz — yalnızca
`copy:true` ile serileştirilmiş yapılandırılmış veri isolate sınırını geçer:

> **Uygulama notu (Faz 2'de doğrulandı):** İlk tasarımda her `get`/`set` çağrısının host'a ayrı
> bir IPC mesajı olarak gitmesi öngörülmüştü. Pratikte bu gereksiz: isolate'in global state'i,
> script çalışması hata/timeout ile bitse bile host tarafından hâlâ okunabiliyor (spike ile
> doğrulandı). Bu yüzden `get`/`set`/`unset` çağrıları isolate-local bir kopya üzerinde senkron
> çalışır; script'in ürettiği TÜM değişken mutasyonları, konsol logları ve test sonuçları,
> çalışma bittiğinde (başarı ya da hata fark etmeksizin) **tek seferde** host'a `copy:true` ile
> geri okunur. Sonuç aynı ilke (isolate'ten asla canlı referans sızmaz), daha az köprü çağrısıyla.
>
> **Tek istisna — `rq.sendRequest` köprüsü (2026-11-12):** script içinden HTTP isteği, isolate'ın
> dışına çıkmak zorundadır. Bunun için isolate'a tek bir `ivm.Reference` (host fonksiyonu) verilir ve
> `applySyncPromise` ile çağrılır: isolate yanıt gelene kadar bloklanır, worker'ın event loop'u
> serbest kalır (`script.run` async). Worker da ağa çıkmaz; isteği IPC ile host'a iletir, host undici
> ile yapar (ana istekle aynı `network.*` ayarları), yanıt isolate'a JSON string olarak döner.
> Isolate'tan host'a yine canlı referans geçmez; referans prelude kapanışında saklanır, kullanıcı
> koduna görünmez. Sınırlar: script başına 10 çağrı, yanıt gövdesi 1 MB, çağrı zaman aşımı =
> min(`network.timeout_ms`, kalan script süresi). Bu istekler history'ye yazılmaz ve loglanmaz.
> Dikkat: `script.run` zaman aşımı yalnızca JS yürütme süresini sayar, senkron bekleme sayılmaz;
> bekleme bütçesi worker'da deadline'a göre kesilir, son çare deadline + 1,5 sn'de `isolate.dispose()`.

```
rq.request            → salt-okunur istek anlık görüntüsü (pre-request'te mutasyona izinli alanlar: headers, params, body, url)
rq.response           → salt-okunur yanıt (yalnızca post-response'ta): status, headers, body, json(), durationMs
rq.variables.get(k)   → çözümleme önceliğine göre okur
rq.variables.replaceIn(s) → metindeki {{var}} ifadelerini o anki duruma göre çözer (script'in kendi set'leri dahil)
rq.environment.set(k,v) / .get(k) / .unset(k) / .name (seçili ortamın adı; ortam yoksa undefined)
rq.collectionVariables.set(k,v) / .get(k) / .unset(k)
rq.globals.set(k,v) / .get(k)
rq.sendRequest(req, cb?) → script içinden HTTP isteği (host üzerinden; yukarıdaki köprü notu). req: URL string ya da
                        { url, method='GET', header (nesne | [{key,value}]), body: string | {mode:'raw',raw} | {mode:'urlencoded',urlencoded} };
                        cb(err, res) — res: code, status, headers.get(), json(), text(), responseTime, truncated. Promise de döner (await edilebilir).
rq.info               → eventName ('prerequest'|'test'), requestName, requestId
rq.test(ad, fn)       → basit assertion toplayıcı (post-response)
rq.expect(...)        → chai-benzeri assertion yardımcıları (equal/eql/include/a/an/exist/true/false/null/undefined/length/oneOf/match/least/most/above/below, not, deep)
console.log/warn/error → tamponlanır, çalışma bitince UI konsoluna aktarılır
setTimeout(fn, ms)    → gerçek zamanlayıcı yok: fn kuyruğa alınır, ana gövde bitince kayıt sırasıyla (gecikme yok sayılır) çalışır; setInterval yok
btoa(s) / atob(s)     → tarayıcı/Postman ile aynı Base64 yardımcıları (saf JS, Latin1 sınırı; Basic auth üretimi için)
```

**Kanonik senaryo — yanıttan token alıp koleksiyon değişkenine yazmak:** Post-response script `rq.response.json()` ile gövdeyi okur, `rq.collectionVariables.set('token', ...)` çağırır (isolate-local kopyaya senkron yazar). Script çalışması bitince bu mutasyon, ana sürece toplu sonucun bir parçası olarak döner; ana süreç scope doğrulaması yapıp `variables` tablosuna yazar. Bir sonraki isteğin `{{token}}` interpolasyonu bu değeri görür. Script'in kendisi DB'ye, dosyaya ya da ağa hiçbir zaman dokunmaz.

### 5.3 Yürütme Hattı (Request Lifecycle)

```
1. İstek tetiklenir (UI → backend)
2. Script zinciri çözülür: koleksiyon → klasör(ler) → istek sırasıyla pre-request script'ler
3. Her pre-request script sandbox'ta koşar; istekte yaptığı mutasyonlar ve değişken
   yazmaları toplanır (değişken yazmaları hemen kalıcılaşır)
4. Değişken interpolasyonu: {{var}} ifadeleri öncelik sırasına göre çözülür
   (çözülemeyen değişken → kullanıcıya uyarı, istek yine de gönderilebilir)
5. HTTP isteği undici ile atılır (timeout, redirect ve boyut limitleri settings'ten)
6. Post-response script zinciri koşar: istek → klasör(ler) → koleksiyon (ters sıra)
7. Test sonuçları + konsol logları UI'a, snapshot history tablosuna yazılır
```

Koleksiyon ve klasör düzeyindeki auth/script/değişkenler UI'da ağaçtaki ⚙ "Ayarlar" diyaloğundan
düzenlenir; backend bunları `PATCH /api/collections/:id` ve `/api/folders/:id` ile kısmi günceller.

**Sıralı çalıştırma (collection runner, ileri faz)** aynı hattı döngüye alır; `rq.execution.setNextRequest()` benzeri akış kontrolü bu mimariye eklenebilir, çekirdek tasarımı değiştirmez.

---

### 5.4 Paketlenmiş Modda Worker

Dağıtım paketinde (`launcher/package.mjs`) sunucu ve worker ayrı esbuild bundle'larıdır ve
`process.execPath`, Node SEA ile üretilen `Reqster.exe`'dir. SEA ikilisi kendisine verilen script
yolunu değil her zaman gömülü başlatıcıyı çalıştırdığı için `fork(worker-entry)` kullanılamaz;
host, aynı exe'yi `REQSTER_WORKER_MODE=1` ortam değişkeni ve `ipc` kanalıyla `spawn` eder,
başlatıcı bu değişkeni görünce `resources/worker.cjs`'yi yükler. Tehdit modeli değişmez:
worker yine ayrı bir süreçtir, DB/ağ/dosya erişimi yoktur, çökmesi sunucuyu etkilemez.

## 6. Postman Import Stratejisi (Collection v2 / v2.1)

### 6.1 Genel Yaklaşım

- Import bir **dönüştürme hattıdır**: `JSON parse → şema tespiti → normalize (iç ara model) → SQLite'a transactional yazım`.
- v2.0 ile v2.1 arasındaki temel fark `url` alanıdır (v2.0'da düz string olabilir, v2.1'de yapılandırılmış nesne). Normalizasyon katmanı ikisini de aynı ara modele indirger; sürüm `info.schema` URL'sinden tespit edilir.
- Tüm import tek bir SQLite transaction'ında yapılır: yarıda hata olursa hiçbir şey yazılmaz, kullanıcıya hata raporu döner.
- Tüm ID'ler yeniden üretilir (Postman `_postman_id` değerine güvenilmez); orijinal id'ler gerekirse ileride izlenebilirlik için `description` yerine ayrı bir meta alanında tutulabilir.

### 6.2 Alan Eşleme Tablosu

| Postman v2.x | Reqster şeması | Not |
|---|---|---|
| `info.name`, `info.description` | `collections.name/description` | |
| `item[]` (içinde `item[]` olan) | `folders` satırı | Özyinelemeli: iç içe klasörler `parent_id` zinciriyle kurulur |
| `item[]` (içinde `request` olan) | `requests` satırı | Dizideki sıra → `sort_order` |
| `request.method` | `requests.method` | |
| `request.url` (string \| nesne) | `requests.url` + `params_json` | Nesne formunda `raw` esas alınır; `query[]` → `params_json`, `variable[]` (path değişkenleri) `:id` sözdiziminde korunur |
| `request.header[]` | `headers_json` | `disabled` → `enabled:false` |
| `request.body.mode` (`raw`, `urlencoded`, `formdata`, `file`, `graphql`) | `body_json` | `graphql` → raw+JSON'a indirgenir; `file` yolları güvenlik gereği içe alınmaz, kullanıcıya "yeniden seç" uyarısı |
| `request.auth` / `item.auth` | `auth_json` | Desteklenen tipler: `bearer`, `basic`, `apikey`, `noauth`; diğerleri (awsv4, oauth1...) atlanır ve raporlanır. `auth` yoksa → NULL (inherit) |
| `event[]` → `prerequest.script.exec` | `pre_request_script` | Satır dizisi `\n` ile birleştirilir |
| `event[]` → `test.script.exec` | `post_response_script` | |
| `variable[]` (koleksiyon kökü) | `variables` (collection scope) | |
| Postman Environment export dosyası (`values[]`) | `environments` + `variables` (environment scope) | Ayrı import akışı; `type:"secret"` → `is_secret=1` |

### 6.3 Script Uyumluluğu

Postman scriptleri `pm.*` API'sini kullanır; bizim API `rq.*`. Strateji **çeviri değil, uyumluluk katmanıdır**: sandbox'a, `rq.*`'ya delege eden ince bir `pm` alias nesnesi (`pm.environment.set` → `rq.environment.set` vb. yalnızca desteklenen alt küme) enjekte edilir. Desteklenmeyen bir `pm.*` çağrısı — alt nesneler dahil (`pm.environment.foo`) — çalışma zamanında açık bir "desteklenmiyor" hatası üretir; yalnızca tanıtıcı erişimler (Symbol, `then`, `toJSON`) undefined döner ki `JSON.stringify`/`await` patlamasın — sessiz yanlış davranıştan iyidir. Desteklenen alt küme: değişken scope'ları (+ `pm.environment.name`, `pm.variables.replaceIn`), `pm.request` (headers get/has/add/upsert/remove, url, method), `pm.response` (json/text/code/status/responseTime/headers, `to.have.status/header/body`, `to.be.ok/...`, `not`), `pm.test`/`pm.expect`, `pm.sendRequest`, `pm.info`. Import sırasında script gövdesi ayrıca statik olarak taranır ve desteklenmeyen çağrılar import raporunda önceden listelenir.

### 6.4 Import Raporu

Her import sonunda kullanıcıya özet dönülür:

- Aktarılan: X koleksiyon, Y klasör, Z istek, N değişken
- Atlananlar ve nedenleri (desteklenmeyen auth tipi, dosya body'si, desteklenmeyen `pm.*` çağrıları)
- Uyarılar (çözülemeyen değişken referansları vb.)

**Postman API'den çekme (2026-11-13):** Dosya içe aktarımının yanında ikinci giriş kapısı `importers/postman-api.ts`'tir:
kullanıcının Postman API anahtarı (`X-Api-Key`) yalnızca isteğin gövdesinde yaşar (saklanmaz, loglanmaz, hata mesajına
girmez). Envanter `GET /workspaces` → `GET /workspaces/{id}` ile workspace'e göre gruplanır; seçilen koleksiyonlar
`GET /collections/{uid}` ile v2.1 olarak çekilip **aynı** dönüştürme hattına verilir (ayrı bir eşleme yoktur), ortamlar
`GET /environments/{uid}`, workspace global'leri `GET /workspaces/{id}/global-variables` → Reqster global'leri (`secret`
tipi `is_secret`, `enabled` korunur; aynı anahtar birden fazla workspace'te → sonuncu kazanır, uyarı). Her öğe kendi
transaction'ında; tek öğe hatası diğerlerini durdurmaz ve `failed[]`'e düşer; anahtar reddi (401/403) bütün işlemi keser.
429'da bir kez beklenip yeniden denenir. Çağrılar aktif proxy ve ağ ayarlarından geçer.

**Export (simetri kuralı) — uygulandı (2026-11-13):** Kendi verimiz Postman v2.1 formatında geri export edilir
(`exporters/postman-v2.ts`); bu, kullanıcının verisine rehin kalmamasını (data portability) garanti eder ve import
eşlemesinin kayıpsızlığının sınanma yoludur: import → export → import → export döngüsünde iki export (üretilen id'ler
dışında) birebir eşit olmalıdır. Biçim: §6.2 tablosunun tersi — `info.schema` v2.1.0, klasörler iç içe `item[]`
(`sort_order` sırası; aynı ebeveyn altında klasör ve istekler tek dizide), `url` hem yapılandırılmış (`protocol/host/
port/path/query`, `{{var}}` parçaları olduğu gibi) hem `raw` (yalnızca etkin query; URL'e elle yazılmış `?a=1` de
`query[]`'ye taşınır), `header[]`/`query[]`/`urlencoded[]` yalnızca kapalıyken `disabled: true`, raw body
`options.raw.language` içerik tipinden (json/xml/html/javascript/text), form-data yalnızca `type: "text"`, auth
`null` (devral) → alan yok, `none` → `noauth`, script'ler `event[]` (`exec` satır dizisi). Postman'ın tanımadığı hiçbir
alan üretilmez; Reqster'ye özgü meta gerekmedi. **Secret kuralı:** varsayılan dışa aktarımda secret değişkenler
anahtarı ve `type: "secret"` ile ama **boş değerle** çıkar; değer yalnızca kullanıcı açıkça isterse (`secrets=1`,
`includeSecrets=true`) yazılır. İçe alan taraf `type: "secret"`i `is_secret=1` yapar ve boş gelen secret'ları raporda
adlarıyla uyarır. **Paylaşım paketi (`.reqster.json`, `ReqsterBundle`):** birden çok koleksiyon (v2.1 belgeleri olduğu
gibi) + ortamlar (Postman environment) + global'ler (`values[]`) tek dosyada; `format: "reqster-bundle"`, `version: 1`,
`exportedAt`, `app`, `secretsIncluded`. İçe aktarım (`importers/bundle.ts`) parçaları mevcut Postman importer'ına verir
(ayrı eşleme yok) ve hepsini **tek transaction**'da yazar: bir parça bozuksa hiçbir şey yazılmaz (§6.1 atomiklik,
iç transaction'lar savepoint). Paket biçimi dışa dönük sözleşmedir; alan ekleme geriye dönük uyumlu, kıran değişiklik
`version` artırır.

---

## 7. Genişletilebilirlik ve Yol Haritası Notları

- **Faz 1 (MVP):** Tek workspace, request builder + response viewer, koleksiyon ağacı, environment/variable, history, Postman import.
- **Faz 2:** Script sandbox (Bölüm 5), test assertion'ları, koleksiyon runner.
- **Faz 3:** Tauri paketleme, cURL/OpenAPI import, cookie yönetimi UI'ı, secret'ların OS keychain'e taşınması.
  Sürümleme kararı (2026-11-10): 0.x sürümleri Node SEA tabanlı bağımsız paket + tarayıcı "app modu"
  ile çıkar (`launcher/`); **v1.0.0 Tauri ile** çıkar, bu paket o zaman sidecar üretimine dönüşür.
  **Uygulandı (2026-11-11):** `src-tauri/` Tauri 2 kabuğu. Mimari: kabuk, Node sunucusunu sidecar olarak
  (`REQSTER_SIDECAR=1 REQSTER_PORT=0`) başlatır, sunucunun stdout'a yazdığı `REQSTER_READY <url>` satırını
  bekler ve pencereyi o adrese yönlendirir; frontend aynı porttan sunulduğu için CORS yoktur ve Tauri
  IPC'ye gerek kalmaz (izin listesi boş). Kapanışta sidecar öldürülür; kabuk çökerse sidecar stdin'in
  kapandığını görüp kendini kapatır. Windows paketi (NSIS) Linux CI runner'ında `cargo-xwin` ile çapraz
  derlenir (`deploy/tauri-builder.Dockerfile`); MSI (WiX) Windows gerektirdiği için üretilmez.
  Dinamik port, §8/2'deki oturum token'ının yerini tutmaz; o 2026-11-16'da eklendi (aşağıda §8/2).
- Yeni import formatları `importers/` altına yeni bir dosya olarak eklenir; hepsi aynı iç ara modeli üretir.
- WebSocket/gRPC/GraphQL istek tipleri `requests.body_json.mode` ve `engine/` içinde yeni bir executor ile eklenebilir; şema değişikliği gerektirmez.

---

## 8. Best-Practice Özeti (Uygulama Kuralları)

1. HTTP istekleri her zaman backend'den atılır (CORS ve gizlilik nedeniyle) — UI asla hedef API'ye doğrudan gitmez.
2. Backend yalnızca `127.0.0.1`'e bind edilir; her istekte rastgele üretilmiş yerel bir oturum token'ı doğrulanır (aynı makinedeki başka süreçlerin/sitelerin API'yi kullanmasını engeller — DNS rebinding/CSRF koruması).
   **Uygulandı (2026-11-16, `server/src/security/localGuard.ts`)** — üç katman:
   (a) **Host denetimi** asıl DNS rebinding korumasıdır: saldırgan alan adı 127.0.0.1'e çözülse de tarayıcı
   `Host: saldırgan.alan` yollar → 421. İzinli adlar loopback + `REQSTER_ALLOWED_HOSTS`. Token tek başına yetmezdi:
   rebinding'le aynı origin olan sayfa token'ı taşıyan HTML'i de okuyabilirdi.
   (b) **Origin denetimi** (POST/PUT/PATCH/DELETE): başka bir yerel sitenin (ör. `localhost:8080`) form/fetch ile
   durum değiştirmesini keser; SameSite çerezi port ayırmadığı için tek başına yetmez.
   (c) **Oturum token'ı**: paketlenmiş başlatıcı 32 baytlık rastgele token üretir (`REQSTER_SESSION_TOKEN`) ve her
   `/api` isteği onu `X-Reqster-Token` başlığında ya da `reqster_session_<port>` çerezinde (aynı makinede iki örnek
   çakışmasın diye portlu) taşımalıdır. Sayfa ve statik dosyalar token istemez: veri taşımayan, herkese açık uygulama
   kodudur. Adres `?reqster_token=` ile açılır; arayüz token'ı adresten alıp sekmenin sessionStorage'ına yazar, adresten
   siler ve API'ye başlıkla yollar. Sunucu o ilk istekte `HttpOnly; SameSite=Lax` yedek çerezi de kurar (tarayıcıda elle
   açılan yeni sekmeler için). Bu, paylaşılan makinedeki (Citrix/RDS) başka kullanıcıların ve başka yerel sitelerin API'yi
   kullanmasını engeller; token'ı yalnızca aynı origin'deki sayfa okuyabilir, o da Host denetimiyle korunur.
   *Neden çereze dayanmıyor (rc.22):* ilk tasarımda sayfa da çerez istiyor, token'lı adres `SameSite=Strict` çerezle
   302 yönlendiriliyordu. macOS WKWebView kabuğun açtığı ilk gezinmede bu çerezi göndermediği için pencere her açılışta
   401 gösterdi (rc.20/21). Çerezsiz bir tarayıcıda (Set-Cookie'yi silen aracıyla) eski akış 401, yenisi çalışır. Geliştirme modunda token yoktur; Access arkasındaki
   Docker imajı (`deploy/Dockerfile`) `REQSTER_AUTH=off` ile token'ı kapatır, Host denetimi açık kalır.
3. Kullanıcı scriptleri yalnızca izole worker + `isolated-vm` içinde, zaman/bellek sınırlı ve ağ/dosya erişimsiz koşar.
4. SQL yalnızca repository katmanında; her yazma işlemi transaction içinde; şema değişiklikleri yalnızca migration ile.
5. Secret değişkenler UI'da maskelenir, history ve export'a asla düz metin yazılmaz.
6. History bir snapshot'tır; kaynak isteğe FK ile bağlanmaz, boyut ve adet limitleriyle otomatik budanır.
7. Import işlemleri atomiktir (tek transaction) ve her zaman kullanıcıya rapor üretir.
8. `shared` paketindeki tipler tek doğruluk kaynağıdır; UI ve server aynı doğrulama şemalarını kullanır.
9. **TLS doğrulaması** varsayılan olarak açıktır ve ayar globaldir (`settings` tablosunda
   `network.verify_tls`, `GET/PATCH /api/settings`). Açıkken Node'un gömülü Mozilla listesine ek olarak
   **işletim sisteminin sertifika deposuna** da güvenilir (`engine/trustStore.ts`, `tls.getCACertificates('system')`;
   ilk HTTPS bağlantısında bir kez okunur, süreç boyu önbellekte kalır): kurum ağında TLS'i yeniden imzalayan
   proxy'nin ya da iç CA'nın kökü işletim sistemine kuruluysa doğrulama açıkken çalışır, tarayıcı ve curl ile
   aynı davranış. Kapatıldığında (depoda olmayan self-signed sunucular için) undici `Agent` `rejectUnauthorized=false` ile açılır ve her yanıt
   `tlsVerified=false` taşır; UI bunu uyarı olarak gösterir. Bu bir geçici çözümdür: araya giren
   saldırgan fark edilmez. Kalıcı çözüm, kök sertifikayı işletim sistemine kurmak (ya da `NODE_EXTRA_CA_CERTS` ortam
   değişkeniyle Node'a tanıtmak) ve doğrulamayı açık tutmaktır. Kabuğun updater'ı (Rust) bu listeyi kullanmaz. History şeması bu bayrağı saklamaz.
10. **Güncelleme denetimi** uygulamanın tek dış çağrısıdır; yalnızca masaüstü kabuğu yapar, sürüm bilgisi dışında
    veri göndermez, kurmadan önce sorar. **Kapatılamaz** (rc.24): `update.auto_check` ayarı kaldırıldı, çünkü
    kullanıcıların güncelleme alabilmesi ve zorunlu güncellemenin (manifestte `minimumVersion`) uygulanabilmesi
    tercihe bırakılmadı (bakımcı kararı, 2026-11-21). Denetim açılış ekranında en fazla 5 sn bekletir; ağ yoksa
    uygulama açılır (yerel çalışma asla engellenmez, zorunluluk ancak sunucuya ulaşılınca uygulanır). Kabuk
    DB'ye erişmediği için aktif proxy'nin kimlik bilgisi dahil URL'ini `GET /api/internal/proxy-url`
    ucundan alır (yalnızca kabuk içindir; kullanıcıya açık proxy API'si parolayı asla döndürmez).
11. **Dil (tr/en)**: UI her isteğe `X-Reqster-Lang` yazar; sunucu kullanıcıya görünen tüm metinleri (`{error}`, zod ayrıntıları,
    yürütme/script/import mesajları) `server/src/i18n/messages.ts` sözlüğünden bu dilde üretir, başlık yoksa Türkçe; shared
    zod şemaları mesaj yerine anahtar taşır, isolate'a dil `__meta.language` ile girer. Kodda sabit kullanıcı metni yazılmaz.
