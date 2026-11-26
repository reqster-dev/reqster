/**
 * Sunucudan kullanıcıya giden metinlerin tr/en sözlüğü.
 *
 * Anahtar → `{ tr, en }`; `{name}` biçimindeki yer tutucular `params` ile doldurulur. Türkçe
 * metinler önceki sabit metinlerle birebir aynıdır; İngilizce karşılıklar kısa ve tekniktir.
 * Loglar (console.*) bu sözlükten geçmez, Türkçe kalır: kullanıcıya görünmezler.
 *
 * `sandbox.*` anahtarları isolate içinde (prelude/pm-compat) kullanılır; prelude bu alt kümeyi
 * JSON olarak gömer ve `__meta.language`'a göre seçer (bkz. `scripting/prelude.ts`).
 * `validation.*` anahtarları `shared/validation` zod şemalarında mesaj olarak yazılır ve
 * `api/helpers.ts` içindeki `parseBody` tarafından çevrilir (shared paketi dil bilmez).
 */
export type Lang = 'tr' | 'en';

export const DEFAULT_LANG: Lang = 'tr';

export function isLang(value: unknown): value is Lang {
  return value === 'tr' || value === 'en';
}

type Entry = { tr: string; en: string };

const MESSAGES = {
  // ---- API hata gövdeleri ----
  'error.notFound': { tr: 'Bulunamadı', en: 'Not found' },
  // ---- Yerel kapı bekçisi (security/localGuard.ts) ----
  'security.hostRejected': {
    tr: 'Bu adresten gelen istekler kabul edilmiyor (Host başlığı izinli değil)',
    en: 'Requests for this host are not accepted (Host header not allowed)',
  },
  'security.originRejected': {
    tr: 'Başka bir siteden gelen istek reddedildi',
    en: 'Request from another site was rejected',
  },
  'security.unauthorized': {
    tr: 'Oturum doğrulanamadı. Reqster\'yi uygulama penceresinden ya da başlatıcının açtığı adresten açın.',
    en: 'Session could not be verified. Open Reqster from its app window or the address opened by the launcher.',
  },
  'duplicate.suffix': { tr: 'kopya', en: 'copy' },
  'error.collectionNotFound': { tr: 'Koleksiyon bulunamadı', en: 'Collection not found' },
  'error.folderNotFound': { tr: 'Klasör bulunamadı', en: 'Folder not found' },
  'error.requestNotFound': { tr: 'İstek bulunamadı', en: 'Request not found' },
  'error.environmentNotFound': { tr: 'Ortam bulunamadı', en: 'Environment not found' },
  'error.variableNotFound': { tr: 'Değişken bulunamadı', en: 'Variable not found' },
  'error.historyNotFound': { tr: 'Geçmiş kaydı bulunamadı', en: 'History entry not found' },
  'error.proxyNotFound': { tr: 'Proxy bulunamadı', en: 'Proxy not found' },
  'error.ownerIdRequired': { tr: 'ownerId gerekli', en: 'ownerId is required' },

  // ---- zod doğrulama (shared şemaları bu anahtarları mesaj olarak taşır) ----
  'validation.failed': { tr: 'Doğrulama hatası', en: 'Validation error' },
  'validation.urlRequired': { tr: 'URL boş olamaz', en: 'URL must not be empty' },
  'validation.curlRequired': { tr: 'cURL komutu boş olamaz', en: 'cURL command must not be empty' },
  'validation.nameRequired': { tr: 'Ad boş olamaz', en: 'Name must not be empty' },
  'validation.proxyUrlInvalid': { tr: 'Proxy adresi geçerli bir URL olmalı', en: 'Proxy address must be a valid URL' },
  'validation.proxyUrlScheme': {
    tr: 'Proxy adresi http:// ya da https:// ile başlamalı',
    en: 'Proxy address must start with http:// or https://',
  },
  'validation.postmanApiKeyRequired': { tr: 'Postman API anahtarı boş olamaz', en: 'Postman API key must not be empty' },

  // ---- yürütme (engine/executor.ts, engine/scriptRunner.ts) ----
  'execute.formFileUnreadable': {
    tr: 'form-data dosya alanı "{key}" okunamadı ({path}): {error}',
    en: 'form-data file field "{key}" could not be read ({path}): {error}',
  },
  'execute.formFileFromScript': {
    tr: 'form-data dosya alanı "{key}" isteğin kendisinde yok ya da yolu değişmiş; script\'ler dosya alanı ekleyemez veya yolunu değiştiremez.',
    en: 'form-data file field "{key}" is not part of the request as saved, or its path was changed; scripts cannot add file fields or change their paths.',
  },
  'execute.invalidUrl': { tr: 'Geçersiz URL: {url}', en: 'Invalid URL: {url}' },
  'execute.staleConnection': {
    tr: 'Açık tutulan bağlantı sunucu tarafından kapatılmıştı ({error}); {method} isteği yan etkisi olabileceği için otomatik yinelenmedi. Tekrar gönderin.',
    en: 'The kept-alive connection had been closed by the server ({error}); the {method} request was not retried automatically because it may have side effects. Send it again.',
  },
  'shell.pickUnavailable': {
    tr: 'Dosya seçici yalnızca masaüstü uygulamasında çalışır; dosya yolunu elle yazın.',
    en: 'The file picker only works in the desktop app; type the file path instead.',
  },
  'response.fileGone': {
    tr: 'Bu yanıtın dosyası artık yok (geçici dosyalar yeni yanıtlarla ve uygulama kapanınca silinir). İsteği yeniden gönderin.',
    en: 'The file for this response is gone (temporary files are removed by newer responses and when the app closes). Send the request again.',
  },
  'execute.cancelled': { tr: 'İstek iptal edildi.', en: 'Request cancelled.' },
  'execute.preRequestError': { tr: 'Pre-request script hatası — {error}', en: 'Pre-request script error — {error}' },
  'execute.sourceRequest': { tr: 'İstek', en: 'Request' },
  'execute.sourceFolder': { tr: 'Klasör: {name}', en: 'Folder: {name}' },
  'execute.sourceCollection': { tr: 'Koleksiyon: {name}', en: 'Collection: {name}' },
  'execute.sourceCollectionUnnamed': { tr: 'Koleksiyon', en: 'Collection' },
  'execute.mutationNoEnvironment': {
    tr: '{{{key}}} {scope} kapsamına yazılamadı: aktif bir ortam yok',
    en: '{{{key}}} could not be written to the {scope} scope: no active environment',
  },
  'execute.mutationNoCollection': {
    tr: '{{{key}}} {scope} kapsamına yazılamadı: koleksiyon bağlamı yok',
    en: '{{{key}}} could not be written to the {scope} scope: no collection context',
  },

  // ---- proxy (engine/dispatcher.ts) ----
  'proxy.authFailed': { tr: 'Proxy kimlik doğrulaması başarısız ({host})', en: 'Proxy authentication failed ({host})' },
  'proxy.tunnelFailed': {
    tr: 'Proxy ({host}) hedefe tünel açamadı: proxy {status} döndü',
    en: 'Proxy ({host}) could not open a tunnel to the target: proxy returned {status}',
  },
  'proxy.connectFailed': { tr: "Proxy'ye bağlanılamadı ({host}): {code}", en: 'Could not connect to proxy ({host}): {code}' },

  // ---- rq.sendRequest host tarafı (engine/scriptHttp.ts) ----
  'sendRequest.invalidUrl': { tr: 'rq.sendRequest: geçersiz URL: {url}', en: 'rq.sendRequest: invalid URL: {url}' },
  'sendRequest.schemeUnsupported': {
    tr: 'rq.sendRequest: yalnızca http/https desteklenir: {protocol}',
    en: 'rq.sendRequest: only http/https is supported: {protocol}',
  },
  'sendRequest.runEnded': {
    tr: 'rq.sendRequest: script sona erdi, bekleyen istek iptal edildi',
    en: 'rq.sendRequest: script ended, pending request cancelled',
  },
  'sendRequest.timeout': { tr: 'rq.sendRequest: zaman aşımı ({ms} ms): {host}', en: 'rq.sendRequest: timeout ({ms} ms): {host}' },
  'sendRequest.connectionRefused': { tr: 'rq.sendRequest: bağlantı reddedildi: {host}', en: 'rq.sendRequest: connection refused: {host}' },
  'sendRequest.dnsFailed': {
    tr: 'rq.sendRequest: sunucu adı çözülemedi: {host}',
    en: 'rq.sendRequest: could not resolve host name: {host}',
  },
  'sendRequest.networkError': { tr: 'rq.sendRequest: ağ hatası ({host}): {detail}', en: 'rq.sendRequest: network error ({host}): {detail}' },

  // ---- script worker (scripting/host.ts, worker-entry.ts, sandbox.ts; dil IPC ile iner) ----
  'script.workerExitedOnStart': {
    tr: 'Script worker beklenmedik şekilde kapandı (kod: {code})',
    en: 'Script worker exited unexpectedly (code: {code})',
  },
  'script.workerUnresponsive': {
    tr: 'Script worker yanıt vermedi (host güvenlik zaman aşımı)',
    en: 'Script worker did not respond (host safety timeout)',
  },
  'script.workerExited': { tr: 'Script worker çalışırken kapandı (kod: {code})', en: 'Script worker exited while running (code: {code})' },
  'script.pendingCallCancelled': {
    tr: 'Script sona erdi; bekleyen rq.sendRequest çağrısı iptal edildi',
    en: 'Script ended; pending rq.sendRequest call cancelled',
  },
  'script.sendRequestLimit': {
    tr: 'rq.sendRequest: script başına en fazla {max} istek gönderilebilir',
    en: 'rq.sendRequest: at most {max} requests may be sent per script',
  },
  'script.sendRequestDeadline': {
    tr: 'rq.sendRequest: script zaman aşımına ulaşıldı, istek gönderilmedi',
    en: 'rq.sendRequest: script timeout reached, request not sent',
  },
  'script.wallClockTimeout': {
    tr: 'Script zaman aşımı: toplam süre {ms} ms sınırını aştı (rq.sendRequest beklemeleri dahil); o ana kadarki log/değişken yazımları kurtarılamadı',
    en: 'Script timeout: total time exceeded the {ms} ms limit (including rq.sendRequest waits); logs/variable writes up to that point could not be recovered',
  },
  'script.unresolvedPromise': {
    tr: 'Script, hiç çözülmeyen bir Promise bekliyordu; ana gövde bitmeden sonlandırıldı.',
    en: 'Script was awaiting a Promise that never resolved; it ended before the main body completed.',
  },
  'script.bridgeParseFailed': { tr: 'rq.sendRequest: istek serileştirilemedi', en: 'rq.sendRequest: request could not be serialized' },
  'script.bridgeInvalidShape': { tr: 'rq.sendRequest: geçersiz istek yapısı', en: 'rq.sendRequest: invalid request structure' },
  'script.consoleTruncated': {
    tr: '(konsol çıktısı boyut limitini aştı; kalan kayıtlar kesildi)',
    en: '(console output exceeded the size limit; remaining entries were dropped)',
  },

  // ---- isolate içi (prelude.ts / pm-compat.ts; `__meta.language` ile seçilir) ----
  'sandbox.setTimeoutNotFunction': {
    tr: 'setTimeout: ilk parametre bir fonksiyon olmali',
    en: 'setTimeout: first argument must be a function',
  },
  'sandbox.setTimeoutQueueFull': {
    tr: 'setTimeout: kuyruk siniri asildi (en fazla {max} bekleyen zamanlayici)',
    en: 'setTimeout: queue limit exceeded (at most {max} pending timers)',
  },
  'sandbox.setIntervalUnsupported': {
    tr: 'setInterval desteklenmiyor: script sandbox icinde gercek zamanlayici yok (setTimeout kuyruga alinir).',
    en: 'setInterval is not supported: the script sandbox has no real timers (setTimeout is queued).',
  },
  'sandbox.headerItemShape': {
    tr: 'rq.sendRequest: baslik ogesi { key, value } biciminde olmali',
    en: 'rq.sendRequest: header item must be of the form { key, value }',
  },
  'sandbox.headerShape': {
    tr: 'rq.sendRequest: header bir nesne ya da [{ key, value }] dizisi olmali',
    en: 'rq.sendRequest: header must be an object or a [{ key, value }] array',
  },
  'sandbox.requestShape': {
    tr: 'rq.sendRequest: istek bir URL metni ya da { url, method, header, body } nesnesi olmali',
    en: 'rq.sendRequest: request must be a URL string or a { url, method, header, body } object',
  },
  'sandbox.urlScheme': {
    tr: 'rq.sendRequest: URL http:// ya da https:// ile baslamali: {url}',
    en: 'rq.sendRequest: URL must start with http:// or https://: {url}',
  },
  'sandbox.bodyModeUnsupported': {
    tr: 'rq.sendRequest: body.mode "{mode}" desteklenmiyor (raw ya da urlencoded kullanin)',
    en: 'rq.sendRequest: body.mode "{mode}" is not supported (use raw or urlencoded)',
  },
  'sandbox.bodyShape': {
    tr: 'rq.sendRequest: body string ya da { mode, raw | urlencoded } olmali',
    en: 'rq.sendRequest: body must be a string or { mode, raw | urlencoded }',
  },
  'sandbox.bodyTruncated': {
    tr: 'rq.sendRequest: yanıt gövdesi {mb} MB sınırında kırpıldı (res.truncated=true)',
    en: 'rq.sendRequest: response body truncated at the {mb} MB limit (res.truncated=true)',
  },
  'sandbox.jsonTruncated': {
    tr: 'rq.sendRequest: yanit govdesi boyut sinirinda kirpildi, JSON olarak ayristirilamaz',
    en: 'rq.sendRequest: response body was truncated at the size limit and cannot be parsed as JSON',
  },
  'sandbox.callbackShape': {
    tr: 'rq.sendRequest: ikinci parametre bir callback fonksiyonu olmali',
    en: 'rq.sendRequest: second argument must be a callback function',
  },
  'sandbox.noBridge': {
    tr: 'rq.sendRequest bu calistirmada kullanilamaz (kopru yok)',
    en: 'rq.sendRequest is not available in this run (no bridge)',
  },
  'sandbox.sendRequestFailed': {
    tr: 'rq.sendRequest basarisiz ({url}): {message} — callback err ile cagrildi, res tanimsiz',
    en: 'rq.sendRequest failed ({url}): {message} — callback invoked with err, res is undefined',
  },
  'sandbox.sendRequestLimit': {
    tr: 'rq.sendRequest: script basina en fazla {max} istek gonderilebilir ({n}. cagri reddedildi)',
    en: 'rq.sendRequest: at most {max} requests may be sent per script (call #{n} rejected)',
  },
  'sandbox.expectType': { tr: 'beklenen tip: {expected}, gelen: {actual} ({value})', en: 'expected type: {expected}, got: {actual} ({value})' },
  'sandbox.expectLength': { tr: 'beklenen uzunluk: {expected}, gelen: {actual}', en: 'expected length: {expected}, got: {actual}' },
  'sandbox.expectExist': { tr: 'beklenen: tanimli bir deger, gelen: {actual}', en: 'expected: a defined value, got: {actual}' },
  'sandbox.expectValue': { tr: 'beklenen: {expected}, gelen: {actual}', en: 'expected: {expected}, got: {actual}' },
  'sandbox.expectTruthy': { tr: 'beklenen: truthy bir deger, gelen: {actual}', en: 'expected: a truthy value, got: {actual}' },
  'sandbox.expectEmpty': { tr: 'beklenen: bos, gelen: {actual}', en: 'expected: empty, got: {actual}' },
  'sandbox.expectOneOfArray': { tr: 'oneOf bir dizi bekler', en: 'oneOf expects an array' },
  'sandbox.expectOneOf': { tr: 'beklenen: {list} icinden biri, gelen: {actual}', en: 'expected: one of {list}, got: {actual}' },
  'sandbox.expectMatch': { tr: 'beklenen: {pattern} ile eslesme, gelen: {actual}', en: 'expected: a match for {pattern}, got: {actual}' },
  'sandbox.expectLeast': { tr: 'beklenen: en az {expected}, gelen: {actual}', en: 'expected: at least {expected}, got: {actual}' },
  'sandbox.expectMost': { tr: 'beklenen: en fazla {expected}, gelen: {actual}', en: 'expected: at most {expected}, got: {actual}' },
  'sandbox.expectWithin': { tr: 'beklenen: {lo}..{hi} arasi, gelen: {actual}', en: 'expected: within {lo}..{hi}, got: {actual}' },
  'sandbox.expectDeepEqual': { tr: 'beklenen (deep): {expected}, gelen: {actual}', en: 'expected (deep): {expected}, got: {actual}' },
  'sandbox.expectInclude': { tr: 'beklenen: {actual} icinde {expected}', en: 'expected: {actual} to include {expected}' },
  'sandbox.expectProperty': { tr: 'beklenen: "{name}" ozelligine sahip nesne', en: 'expected: an object with property "{name}"' },
  'sandbox.expectAbove': { tr: "beklenen: {expected}'den buyuk, gelen: {actual}", en: 'expected: greater than {expected}, got: {actual}' },
  'sandbox.expectBelow': { tr: "beklenen: {expected}'den kucuk, gelen: {actual}", en: 'expected: less than {expected}, got: {actual}' },
  'sandbox.pmUnsupported': {
    tr: '{path} desteklenmiyor. Bu Reqster script API alt kumesinde yok; rq.* kullanin.',
    en: '{path} is not supported. It is not part of the Reqster script API subset; use rq.*.',
  },
  'sandbox.pmHeadersReadOnly': {
    tr: 'pm.request.headers.{op} post-response fazinda kullanilamaz: istek gonderildi, pm.request salt-okunur',
    en: 'pm.request.headers.{op} cannot be used in the post-response phase: the request was sent, pm.request is read-only',
  },
  'sandbox.pmUpsertShape': { tr: 'pm.request.headers.upsert({ key, value }) bekler', en: 'pm.request.headers.upsert expects { key, value }' },
  'sandbox.pmStatusCode': { tr: 'beklenen durum kodu: {expected}, gelen: {actual}', en: 'expected status code: {expected}, got: {actual}' },
  'sandbox.pmStatusText': { tr: 'beklenen durum: {expected}, gelen: {actual}', en: 'expected status: {expected}, got: {actual}' },
  'sandbox.pmHeaderPresent': { tr: 'beklenen: "{name}" basligi mevcut', en: 'expected: header "{name}" to be present' },
  'sandbox.pmHeaderEquals': { tr: 'beklenen: "{name}" = {expected}, gelen: {actual}', en: 'expected: "{name}" = {expected}, got: {actual}' },
  'sandbox.pmBodyNonEmpty': { tr: 'beklenen: bos olmayan govde', en: 'expected: a non-empty body' },
  'sandbox.pmBodyMatch': { tr: 'beklenen: govde {pattern} ile eslesir', en: 'expected: body to match {pattern}' },
  'sandbox.pmBodyEquals': { tr: 'beklenen govde: {expected}', en: 'expected body: {expected}' },
  'sandbox.pmJsonBody': { tr: 'beklenen: JSON govde', en: 'expected: a JSON body' },
  'sandbox.pmStatusRange': { tr: 'beklenen: {range}, gelen: {actual}', en: 'expected: {range}, got: {actual}' },

  // ---- Postman dosya import'u (importers/postman-v2.ts) ----
  'import.invalidCollection': {
    tr: 'Geçersiz Postman koleksiyonu: info.name veya item[] eksik',
    en: 'Invalid Postman collection: info.name or item[] missing',
  },
  'import.invalidEnvironment': {
    tr: 'Geçersiz Postman environment dosyası: name veya values[] eksik',
    en: 'Invalid Postman environment file: name or values[] missing',
  },
  'import.invalidGlobals': { tr: 'Geçersiz Postman global değişkenleri: values[] eksik', en: 'Invalid Postman globals: values[] missing' },
  'import.schemaUnknown': {
    tr: 'Şema tanınamadı ({schema}); v2.1 varsayılarak devam edildi',
    en: 'Schema not recognized ({schema}); continued assuming v2.1',
  },
  'import.schemaUnspecified': { tr: 'belirtilmemiş', en: 'unspecified' },
  'import.unsupportedScriptCall': {
    tr: '"{item}": desteklenmeyen script çağrısı: {call}',
    en: '"{item}": unsupported script call: {call}',
  },
  'import.unsupportedAuth': { tr: 'desteklenmeyen auth tipi: {type}', en: 'unsupported auth type: {type}' },
  'import.unsupportedMethod': { tr: 'desteklenmeyen HTTP metodu: {method}', en: 'unsupported HTTP method: {method}' },
  'import.unknownItem': { tr: 'ne klasör ne istek: tanınmayan öğe', en: 'neither folder nor request: unrecognized item' },
  'import.formDataFileSkipped': {
    tr: 'form-data dosya alanı "{key}" aktarılmadı; dosyayı yeniden seçin',
    en: 'form-data file field "{key}" was not imported; re-select the file',
  },
  'import.fileBodySkipped': { tr: 'dosya body aktarılmadı; dosyayı yeniden seçin', en: 'file body was not imported; re-select the file' },
  'import.graphqlDowngraded': { tr: '"{item}": graphql body raw JSON\'a indirgendi', en: '"{item}": graphql body downgraded to raw JSON' },
  'import.unknownBodyMode': { tr: '"{item}": bilinmeyen body modu "{mode}" atlandı', en: '"{item}": unknown body mode "{mode}" skipped' },

  // ---- Reqster paylaşım paketi (importers/bundle.ts) ----
  'import.invalidBundle': {
    tr: 'Geçersiz Reqster paketi: format "reqster-bundle" ve version 1 bekleniyor',
    en: 'Invalid Reqster bundle: expected format "reqster-bundle" and version 1',
  },
  'import.bundleFailed': {
    tr: 'Paket içe aktarılamadı, hiçbir şey yazılmadı: {reason}',
    en: 'Bundle could not be imported, nothing was written: {reason}',
  },
  'import.bundleSecretsEmpty': {
    tr: '{count} secret değişken boş değerle geldi (paket secret içermiyor), değerleri elle girin: {names}',
    en: '{count} secret variable(s) arrived with empty values (bundle excludes secrets), enter them manually: {names}',
  },

  // ---- cURL dönüşümü (importers/curl.ts, exporters/curl.ts) ----
  'curl.notCurl': { tr: 'Metin bir cURL komutu değil ("curl" ile başlamalı)', en: 'Text is not a cURL command (must start with "curl")' },
  'curl.noUrl': { tr: 'cURL komutunda URL bulunamadı', en: 'No URL found in the cURL command' },
  'curl.unterminatedQuote': { tr: 'cURL komutunda kapanmamış tırnak var', en: 'The cURL command has an unterminated quote' },
  'curl.trailingIgnored': { tr: 'Komutun devamı yok sayıldı: {text}', en: 'Rest of the command was ignored: {text}' },
  'curl.unknownOption': { tr: 'Tanınmayan seçenek yok sayıldı: {flag}', en: 'Unknown option ignored: {flag}' },
  'curl.optionIgnored': { tr: '{flag} isteğe aktarılmadı (Reqster ayarlarından yönetilir ya da karşılığı yok)', en: '{flag} was not imported (managed in Reqster settings or has no equivalent)' },
  'curl.missingValue': { tr: '{flag} seçeneğinin değeri eksik', en: 'Option {flag} is missing its value' },
  'curl.fileArgSkipped': { tr: '{flag} {value}: dosyadan okuma aktarılmadı, içeriği elle girin', en: '{flag} {value}: reading from a file was not imported, enter the content manually' },
  'curl.formFileSkipped': { tr: 'form-data dosya alanı "{key}" aktarılmadı; dosya alanı henüz desteklenmiyor', en: 'form-data file field "{key}" was not imported; file fields are not supported yet' },
  'curl.badHeader': { tr: 'Geçersiz başlık yok sayıldı: {value}', en: 'Invalid header ignored: {value}' },
  'curl.badForm': { tr: 'Geçersiz form alanı yok sayıldı: {value}', en: 'Invalid form field ignored: {value}' },
  'curl.userNoPassword': { tr: '--user parolasız verildi; parola boş bırakıldı', en: '--user was given without a password; password left empty' },
  'curl.cookieFileSkipped': { tr: '-b {value}: çerez dosyası aktarılmadı', en: '-b {value}: cookie file was not imported' },
  'curl.insecure': {
    tr: '-k/--insecure aktarılmadı; TLS doğrulamasını Ayarlar > Ağ bölümünden kapatabilirsiniz',
    en: '-k/--insecure was not imported; TLS verification can be turned off in Settings > Network',
  },
  'curl.unsupportedAuth': { tr: '{flag} kimlik doğrulaması desteklenmiyor, aktarılmadı', en: '{flag} authentication is not supported and was not imported' },
  'curl.multipleUrls': { tr: 'Komutta birden çok URL var; yalnızca ilki alındı: {url}', en: 'The command has several URLs; only the first was used: {url}' },
  'curl.dataAndForm': { tr: '-d ile -F birlikte verilmiş; yalnızca form alanları alındı', en: '-d and -F were both given; only the form fields were used' },
  'curl.unsupportedMethod': { tr: 'Desteklenmeyen HTTP metodu: {method}', en: 'Unsupported HTTP method: {method}' },
  'curl.bodyOnGet': { tr: '{method} isteğinde gövde var; Reqster {method} isteğinde gövde göndermez', en: 'The {method} request has a body; Reqster does not send a body with {method}' },
  'curl.exportScriptsNotRun': {
    tr: 'Pre-request script\'ler çalıştırılmadı; komut script\'lerin yapacağı değişiklikleri içermez',
    en: 'Pre-request scripts were not run; the command does not include changes they would make',
  },
  'curl.exportSecretsIncluded': { tr: 'Komut secret değişken değerleri içeriyor', en: 'The command contains secret variable values' },

  // ---- Postman API'den çekme (importers/postman-api.ts) ----
  'postmanApi.authError': { tr: 'Postman API anahtarı geçersiz ya da yetkisiz', en: 'Postman API key is invalid or unauthorized' },
  'postmanApi.rateLimited': {
    tr: 'Postman API istek sınırı aşıldı, biraz sonra yeniden deneyin',
    en: 'Postman API rate limit exceeded, try again shortly',
  },
  'postmanApi.statusError': { tr: 'Postman API {status} döndü', en: 'Postman API returned {status}' },
  'postmanApi.statusErrorDetail': { tr: 'Postman API {status} döndü: {detail}', en: 'Postman API returned {status}: {detail}' },
  'postmanApi.invalidJson': { tr: 'Postman API geçersiz yanıt döndü (JSON değil)', en: 'Postman API returned an invalid response (not JSON)' },
  'postmanApi.timeout': { tr: 'Postman API yanıt vermedi ({ms} ms zaman aşımı)', en: 'Postman API did not respond ({ms} ms timeout)' },
  'postmanApi.connectFailed': { tr: "Postman API'ye bağlanılamadı ({code})", en: 'Could not connect to Postman API ({code})' },
  'postmanApi.connectFailedNoCode': { tr: "Postman API'ye bağlanılamadı", en: 'Could not connect to Postman API' },
  'postmanApi.labelCollection': { tr: 'koleksiyon: {name}', en: 'collection: {name}' },
  'postmanApi.labelEnvironment': { tr: 'ortam: {name}', en: 'environment: {name}' },
  'postmanApi.labelGlobals': { tr: 'global değişkenler: {id}', en: 'global variables: {id}' },
  'postmanApi.duplicateGlobal': {
    tr: 'Global "{key}" birden fazla workspace\'te tanımlı; {label} değeri kazandı',
    en: 'Global "{key}" is defined in more than one workspace; the value from {label} won',
  },
} satisfies Record<string, Entry>;

export type MessageKey = keyof typeof MESSAGES;

export type MessageParams = Record<string, string | number | undefined>;

export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MESSAGES, value);
}

/** `{name}` yer tutucularını doldurur; verilmeyen yer tutucu olduğu gibi kalır */
function fill(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(lang: Lang, key: MessageKey, params?: MessageParams): string {
  const entry: Entry = MESSAGES[key];
  // Dil IPC ile de gelir (worker); bozuk/eksik değerde Türkçe'ye düş, patlama
  return fill(entry[lang] ?? entry[DEFAULT_LANG], params);
}

/** Isolate'a gömülmek üzere yalnızca `sandbox.*` anahtarlarının iki dilli alt kümesi */
export function sandboxMessages(): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const [key, entry] of Object.entries(MESSAGES)) {
    if (key.startsWith('sandbox.')) out[key.slice('sandbox.'.length)] = entry;
  }
  return out;
}
