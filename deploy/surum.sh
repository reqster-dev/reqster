#!/usr/bin/env bash
# Tek komutla sürüm çıkarma (CLAUDE.md "CI" bölümü): tüm workspace manifestleri + package-lock
# yükseltilir → "Sürüm X" commit'i → vX etiketi → main + etiket push → CI Release'i üretir.
#
# Kullanım: deploy/surum.sh <rc|patch|minor|major|X.Y.Z[-rc.N]> [--zorunlu] [--no-push]
#   rc      → mevcut sürümün bir sonraki rc'si (1.0.0-rc.6 → 1.0.0-rc.7; 1.0.0 → 1.0.1-rc.0)
#   patch|minor|major → kararlı sürüm (1.0.0-rc.7 + patch → 1.0.0)
#   X.Y.Z   → doğrudan bu sürüm
#   Kararlı sürümde CHANGELOG.md ve CHANGELOG.tr.md'deki "## [Unreleased]" dolu olmalıdır (deploy/changelog.sh):
#   bölüm sürüm başlığına taşınır, Release notuna ve uygulamanın güncelleme penceresine oradan gider.
#   --zorunlu → zorunlu güncelleme: bu sürümün altındaki masaüstü kurulumları güncellenmeden açılmaz. Commit'e
#               `Zorunlu-Guncelleme: evet` satırı yazılır; release.yml Release notuna işaret koyar, site yayını
#               manifeste `minimumVersion` yazar (en yüksek işaretli sürüm).
# Ortam: SURUM_COMMIT_TRAILERS (isteğe bağlı) commit mesajının sonuna eklenir (Co-Authored-By vb.);
#        GIT_USER + GIT_TOKEN tanımlıysa push geçici credential helper ile yapılır (token URL'e gömülmez).
set -euo pipefail
cd "$(dirname "$0")/.."

arg=""; push=1; required=0
for a in "$@"; do
  case "$a" in
    --no-push) push=0 ;;
    --zorunlu) required=1 ;;
    -*) echo "HATA: bilinmeyen seçenek: $a"; exit 2 ;;
    *) [[ -z "$arg" ]] || { echo "HATA: birden çok sürüm argümanı"; exit 2; }; arg="$a" ;;
  esac
done
[[ -z "$arg" ]] && { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

branch=$(git rev-parse --abbrev-ref HEAD)
[[ "$branch" == "main" ]] || { echo "HATA: main dalında değilsin ($branch)"; exit 1; }
# .claude/settings.local.json yerel ayar dosyasıdır, commit edilmez; onun dışında kirli dosya olmamalı
dirty=$(git status --porcelain -- . ':!.claude/settings.local.json')
[[ -z "$dirty" ]] || { echo "HATA: çalışma ağacı temiz değil:"; echo "$dirty"; exit 1; }

case "$arg" in
  rc) bump=(rc) ;;
  patch|minor|major) bump=("$arg") ;;
  [0-9]*) bump=("$arg") ;;
  *) echo "HATA: bilinmeyen argüman: $arg"; exit 2 ;;
esac

old=$(node -p "require('./package.json').version")
# npm version KULLANILMAZ: workspace'lerle çalışırken lock'u eşitlemek için reify çalıştırıyor, bu da
# host'taki Node 22'de isolated-vm'i derlemeye kalkıyor (ABI yok, ağ ister). Sürüm hesabı ve dosya
# yazımı salt-dosya işidir; node ile yapılır. Kurallar npm version ile aynı (prerelease/patch/minor/major).
new=$(node -e '
  const [old, kind] = process.argv.slice(1);
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(old);
  if (!m) throw new Error("mevcut sürüm anlaşılmadı: " + old);
  let [maj, min, pat, rc] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
  if (/^\d/.test(kind)) { if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(kind)) throw new Error("geçersiz sürüm: " + kind); console.log(kind); process.exit(0); }
  if (kind === "rc") { if (rc === undefined) { pat++; rc = 0; } else rc++; }
  else { if (rc === undefined || kind !== "patch") { if (kind === "major") { maj++; min = 0; pat = 0; } else if (kind === "minor") { min++; pat = 0; } else pat++; } rc = undefined; }
  console.log(rc === undefined ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat}-rc.${rc}`);
' "$old" "${bump[0]}")
# Kararlı sürümde değişiklik günlüğü zorunlu: iki dosyadaki "## [Unreleased]" bölümü bu sürümün başlığına taşınır
# (boşsa burada durulur, hiçbir dosya değişmez). Önsürümler (rc) günlüğe dokunmaz; Release notları Unreleased'i gösterir.
if [[ "$new" != *-* ]]; then
  deploy/changelog.sh cut "$new" "$(date -u +%F)"
fi
node -e '
  const fs = require("fs"); const v = process.argv[1];
  const write = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");
  for (const f of ["package.json", ...fs.readdirSync("packages").map((d) => `packages/${d}/package.json`)]) {
    const pkg = JSON.parse(fs.readFileSync(f, "utf8")); pkg.version = v; write(f, pkg);
  }
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  lock.version = v;
  for (const [path, pkg] of Object.entries(lock.packages)) if (path === "" || path.startsWith("packages/")) pkg.version = v;
  write("package-lock.json", lock);
' "$new"
for f in package.json packages/*/package.json; do
  [[ "$(node -p "require('./$f').version")" == "$new" ]] || { echo "HATA: $f sürümü eşleşmiyor"; exit 1; }
done
grep -q "\"version\": \"$new\"" package-lock.json || { echo "HATA: package-lock.json güncellenmedi"; exit 1; }
echo "sürüm: $old → $new"

msg=$(mktemp); trap 'rm -f "$msg"' EXIT
{
  printf 'Sürüm %s\n' "$new"
  (( required )) && printf '\nZorunlu-Guncelleme: evet\n'
  [[ -n "${SURUM_COMMIT_TRAILERS:-}" ]] && printf '\n%s\n' "$SURUM_COMMIT_TRAILERS"
  true
} > "$msg"
git add package.json package-lock.json packages/*/package.json CHANGELOG.md CHANGELOG.tr.md
git commit -q -s -F "$msg"   # DCO: Signed-off-by (CONTRIBUTING.md)
git tag -a "v$new" -m "Reqster $new"
echo "commit: $(git rev-parse --short HEAD)  etiket: v$new$( (( required )) && echo '  (ZORUNLU güncelleme)')"

if (( push )); then
  if [[ -n "${GIT_USER:-}" && -n "${GIT_TOKEN:-}" ]]; then
    git -c credential.helper= \
        -c credential.helper='!f() { echo "username=$GIT_USER"; echo "password=$GIT_TOKEN"; }; f' \
        push origin main "v$new"
  else
    git push origin main "v$new"
  fi
  echo "CI: https://github.com/reqster-dev/reqster/actions   Release: https://github.com/reqster-dev/reqster/releases/tag/v$new"
else
  echo "push atlandı (--no-push); elle: git push origin main v$new"
fi
