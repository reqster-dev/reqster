import { getCACertificates } from 'node:tls';

let cached: string[] | undefined;

/**
 * TLS doğrulamasında güvenilen kök sertifikalar: Node'un varsayılanı (gömülü Mozilla listesi +
 * `NODE_EXTRA_CA_CERTS`) ve **işletim sisteminin deposu** (Windows sertifika deposu, macOS anahtar zinciri,
 * Linux'ta OpenSSL dizinleri / `SSL_CERT_FILE`). Node kendi başına yalnızca gömülü listeye bakar; kurum
 * ağında TLS'i yeniden imzalayan proxy'nin ya da iç CA'nın kökü işletim sistemine kurulu olduğu halde
 * istek "self signed certificate in certificate chain" ile düşüyor, kullanıcı doğrulamayı kapatmak zorunda
 * kalıyordu. Tarayıcılar ve curl (Windows/macOS) da sistem deposunu kullanır.
 *
 * Depo ilk HTTPS dispatcher'ı kurulurken bir kez okunur (senkron ve Windows'ta yavaş olabilir; açılışı
 * geciktirmesin) ve süreç boyu önbellekte kalır: işletim sistemine yeni kurulan bir CA için uygulama
 * yeniden başlatılır. Okuma başarısız olursa Node'un varsayılanına düşülür.
 */
export function trustedCas(): string[] {
  if (cached) return cached;
  const defaults = getCACertificates('default');
  let system: string[] = [];
  try {
    system = getCACertificates('system');
  } catch (err) {
    console.warn('Sistem sertifika deposu okunamadı; yalnızca gömülü kök sertifikalar kullanılacak:', err);
  }
  cached = [...new Set([...defaults, ...system])];
  return cached;
}
