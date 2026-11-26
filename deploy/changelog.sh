#!/usr/bin/env bash
# Değişiklik günlüğü yardımcıları (CHANGELOG.md İngilizce, CHANGELOG.tr.md Türkçe; ikisi aynı sürüm başlıklarını taşır).
#
#   deploy/changelog.sh section <dosya> <sürüm|Unreleased>   o başlığın altındaki metni yazdırır (yoksa boş)
#   deploy/changelog.sh notes <sürüm>                        Release notunun başına konacak "What's new" bloğu
#                                                            (sürüm bölümü yoksa Unreleased; ikisi de boşsa çıktı yok)
#   deploy/changelog.sh merge <sürüm> <gövde dosyası>        var olan Release gövdesini güncel "What's new" bloğuyla yazdırır
#                                                            (release-notes.yml: günlük düzeltilince Release notları eşitlenir)
#   deploy/changelog.sh cut <sürüm> <YYYY-AA-GG>             iki dosyada da "## [Unreleased]" altındakileri
#                                                            "## [sürüm] - tarih" başlığına taşır; biri boşsa hata
#
# `notes` bloğundaki Türkçe kısım `<!-- reqster:notes-tr -->` işaretleri arasındadır: indirme sitesi onu updater
# manifestine `notes` olarak yazar, uygulamanın güncelleme penceresi gösterir (deploy/surum.sh `cut`'ı, release.yml
# `notes`'u çağırır).
set -euo pipefail
cd "$(dirname "$0")/.."
FILES=(CHANGELOG.md CHANGELOG.tr.md)

section() { # <dosya> <başlık>
  awk -v want="[$2]" '
    /^## \[/ { on = ($2 == want); next }
    on { lines[++n] = $0 }
    END {
      first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
      while (n >= first && lines[n] ~ /^[[:space:]]*$/) n--
      for (i = first; i <= n; i++) print lines[i]
    }' "$1"
}

section_or_unreleased() { # <dosya> <sürüm>
  local text; text=$(section "$1" "$2")
  [[ -n "$text" ]] || text=$(section "$1" Unreleased)
  printf '%s' "$text"
}

case "${1:-}" in
  section)
    section "$2" "$3"
    ;;
  notes)
    en=$(section_or_unreleased CHANGELOG.md "$2")
    tr=$(section_or_unreleased CHANGELOG.tr.md "$2")
    [[ -n "$en" || -n "$tr" ]] || exit 0
    printf "## What's new\n\n%s\n\n" "${en:-See the Turkish notes below.}"
    if [[ -n "$tr" ]]; then
      printf '<details><summary>Türkçe</summary>\n\n<!-- reqster:notes-tr -->\n%s\n<!-- /reqster:notes-tr -->\n\n</details>\n\n' "$tr"
    fi
    printf '## Downloads\n\n'
    ;;
  merge)
    # Var olan bir Release gövdesinin başındaki bloğu günlükteki güncel haliyle değiştirir (yoksa başa ekler);
    # "## Downloads" başlığından sonrası (dosya tablosu, zorunlu güncelleme işareti) aynen kalır.
    old=$(tr -d '\r' < "$3")
    if grep -q '^## Downloads$' <<<"$old"; then
      rest=$(awk 'found { print } /^## Downloads$/ { found = 1 }' <<<"$old")
    else
      rest=$old
    fi
    "$0" notes "$2"
    printf '%s\n' "$rest" | sed '/./,$!d'
    ;;
  cut)
    ver=$2; date=$3
    for f in "${FILES[@]}"; do
      grep -q '^## \[Unreleased\]' "$f" || { echo "HATA: $f içinde '## [Unreleased]' başlığı yok"; exit 1; }
      grep -q "^## \[$ver\]" "$f" && { echo "HATA: $f içinde $ver bölümü zaten var"; exit 1; }
      [[ -n "$(section "$f" Unreleased)" ]] || {
        echo "HATA: $f içinde '## [Unreleased]' boş. Bu sürümde ne değiştiğini (Added/Changed/Fixed/Security;"
        echo "      Türkçede Eklendi/Değişti/Düzeltildi/Güvenlik) yazıp commit'leyin, sonra sürümü yeniden çıkarın."
        exit 1
      }
    done
    for f in "${FILES[@]}"; do
      awk -v head="## [$ver] - $date" '
        /^## \[Unreleased\]/ { print; print ""; print head; next }
        { print }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    done
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2
    ;;
esac
