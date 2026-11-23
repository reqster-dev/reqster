export type CodeLanguage = 'json' | 'xml' | 'javascript' | 'text';

export function formatJson(text: string): string {
  return JSON.stringify(JSON.parse(text), null, 2);
}

/**
 * XML/HTML belirteçleri: yorum, CDATA, işlem yönergesi, DOCTYPE (iç alt kümesiyle), etiket (tırnak içindeki
 * `>` etiketi bitirmez) ve aradaki metin.
 */
const XML_TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!(?:[^>[]|\[[^\]]*\])*>|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;

/**
 * Bağımlılıksız, DOM parser kullanmayan XML/HTML güzelleştirici: etiket derinliğine göre girinti verir.
 * İçeriği yalnızca metin (ya da CDATA) olan öğe tek satırda kalır (`<a>1</a>`) ve metnine dokunulmaz:
 * güzelleştirme gönderilen değere boşluk/satır sonu eklememelidir. Tek istisna, metnin başında/sonunda
 * satır sonu varsa (önceden satırlara bölünmüş değer) kırpılmasıdır. Etiketlerle karışık metin kendi
 * satırına alınır.
 */
export function formatXml(text: string): string {
  const INDENT = '  ';
  const tokens = text.match(XML_TOKEN);
  if (!tokens || !text.trim()) return text;

  const isOpen = (t: string) => /^<[^/!?]/.test(t) && !t.endsWith('/>');
  const isClose = (t: string) => t.startsWith('</');
  const isContent = (t: string) => !t.startsWith('<') || t.startsWith('<![CDATA[');
  const leafText = (t: string) => (/^\s*\n|\n\s*$/.test(t) ? t.trim() : t);

  const lines: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isOpen(token)) {
      // <a>metin</a> ya da <a></a>: tek satır
      let j = i + 1;
      while (j < tokens.length && isContent(tokens[j]!)) j++;
      if (j < tokens.length && isClose(tokens[j]!)) {
        const inner = tokens.slice(i + 1, j);
        const content = inner.length === 1 && !inner[0]!.startsWith('<') ? leafText(inner[0]!) : inner.join('');
        lines.push(INDENT.repeat(depth) + token + content + tokens[j]!);
        i = j;
        continue;
      }
      lines.push(INDENT.repeat(depth) + token);
      depth += 1;
    } else if (isClose(token)) {
      depth = Math.max(0, depth - 1);
      lines.push(INDENT.repeat(depth) + token);
    } else if (token.startsWith('<')) {
      lines.push(INDENT.repeat(depth) + token);
    } else if (token.trim() !== '') {
      lines.push(INDENT.repeat(depth) + token.trim());
    }
  }
  return lines.join('\n');
}

/** Content-Type başlığından düzenleyici dilini seç */
export function languageFromContentType(contentType: string | undefined | null): CodeLanguage {
  if (!contentType) return 'text';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('xml') || contentType.includes('html')) return 'xml';
  return 'text';
}

/** İçerik gövdesinden dil tahmini (content-type bilinmediğinde, örn. yanıt gövdesi için) */
export function sniffLanguage(body: string): CodeLanguage {
  const trimmed = body.trim();
  if (!trimmed) return 'text';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // JSON değilmiş, devam
    }
  }
  if (trimmed.startsWith('<')) return 'xml';
  return 'text';
}

export function formatByLanguage(text: string, language: CodeLanguage): string {
  if (language === 'json') return formatJson(text);
  if (language === 'xml') return formatXml(text);
  return text;
}
