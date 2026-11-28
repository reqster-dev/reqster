#!/usr/bin/env node
/**
 * Reqster'ı tek klasörlük, bağımsız bir dağıtım olarak paketler.
 *
 *   node launcher/package.mjs --target win-x64            → dist/Reqster-<sürüm>-win-x64.zip
 *   node launcher/package.mjs --target linux-x64          → dist/Reqster-<sürüm>-linux-x64.tar.gz
 *   node launcher/package.mjs --target darwin-arm64       → dist/Reqster-<sürüm>-darwin-arm64.tar.gz (yalnızca macOS'ta)
 *   node launcher/package.mjs --target darwin-x64         → dist/Reqster-<sürüm>-darwin-x64.tar.gz   (yalnızca macOS'ta)
 *     --version 1.2.3        (yoksa REQSTER_VERSION, o da yoksa 0.0.0-dev)
 *     --skip-app-build       (packages/app/dist zaten güncelse)
 *     --no-archive           zip/tar.gz üretme (yalnızca çalıştırılabilir klasör)
 *     --plan                 hiçbir şey üretme; indirilecek URL'leri, triple'ı, ön-derleme durumunu ve adımları yazdır
 *     --sidecar-dir <dizin>  Tauri sidecar çıktısı: exe → <dizin>/binaries/reqster-server-<rust-triple>[.exe],
 *                            staged resources/ → <dizin>/resources/ (mevcut dizin silinip değiştirilir).
 *                            Tauri `bundle.externalBin: ["binaries/reqster-server"]` bu adlandırmayı bekler (ad, Cargo crate adı `reqster`den farklı olmak zorunda).
 *
 *   Tauri sidecar örneği:
 *   node launcher/package.mjs --target linux-x64 --sidecar-dir src-tauri --no-archive
 *
 * Çıktı klasörü:
 *   Reqster/
 *     Reqster.exe | reqster        resmî Node ikilisi + SEA blob olarak gömülü launcher/reqster-launcher.js
 *     resources/
 *       server.cjs             packages/server esbuild bundle'ı (native modüller hariç)
 *       worker.cjs             script sandbox child process bundle'ı
 *       app/                   vite çıktısı
 *       migrations/            *.sql
 *       node_modules/          better-sqlite3 + isolated-vm, HEDEF platformun ön-derlenmiş ikilileriyle
 *       build-info.json
 *
 * Linux üzerinde Windows paketi üretilebilir: native modüllerin win32-x64 ön-derlemeleri npm/GitHub'dan
 * indirilir (ikisi de npm paketinin kendi `prebuilds/`inden; better-sqlite3 13'ten beri indirme yok),
 * node.exe nodejs.org'dan indirilip SHA-256'sı doğrulanır, SEA blob'u postject ile PE dosyasına
 * enjekte edilir. Hiçbir adım derleyici gerektirmez.
 *
 * macOS hedefleri (darwin-arm64 / darwin-x64) yalnızca macOS üzerinde üretilir (CI: release.yml → macos):
 * Node SEA belgesine göre Mach-O ikilide önce `codesign --remove-signature`, sonra postject
 * `--macho-segment-name NODE_SEA` ile enjeksiyon, sonra ad-hoc `codesign --sign -` gerekir ve codesign
 * yalnızca macOS'ta vardır. Linux'ta darwin hedefi istenirse betik hiçbir dosya üretmeden durur.
 * isolated-vm'in npm paketinde darwin-x64 ön-derlemesi YOKTUR; CI onu kaynaktan derleyip kök
 * `node_modules/isolated-vm/prebuilds/darwin-x64/` altına koyar, betik buradan kopyalar (derlemez).
 *
 * Node sürümü .nvmrc'den okunur; blob'u üreten Node ile hedef ikilinin sürümü AYNI olmalıdır
 * (ABI'nin de eşleşmesi gerekir: isolated-vm ön-derlemesi ABI'ye göre seçilir).
 */
import AdmZip from 'adm-zip';
import { build } from 'esbuild';
import { inject } from 'postject';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const NATIVE_MODULES = ['better-sqlite3', 'isolated-vm'];

const TARGETS = {
  'win-x64': {
    nodePlatform: 'win32',
    nodeArch: 'x64',
    nodeDist: (v) => `node-v${v}-win-x64.zip`,
    nodeBinaryInArchive: (v) => `node-v${v}-win-x64/node.exe`,
    exeName: 'Reqster.exe',
    archive: 'zip',
    prebuildDir: 'win32-x64',
    // Tauri externalBin adlandırması: <ad>-<rust target triple>[.exe]
    rustTriple: 'x86_64-pc-windows-msvc',
    sidecarExt: '.exe',
  },
  'linux-x64': {
    nodePlatform: 'linux',
    nodeArch: 'x64',
    nodeDist: (v) => `node-v${v}-linux-x64.tar.xz`,
    nodeBinaryInArchive: (v) => `node-v${v}-linux-x64/bin/node`,
    exeName: 'reqster',
    archive: 'tar.gz',
    prebuildDir: 'linux-x64',
    rustTriple: 'x86_64-unknown-linux-gnu',
    sidecarExt: '',
  },
  'darwin-arm64': {
    nodePlatform: 'darwin',
    nodeArch: 'arm64',
    nodeDist: (v) => `node-v${v}-darwin-arm64.tar.gz`,
    nodeBinaryInArchive: (v) => `node-v${v}-darwin-arm64/bin/node`,
    exeName: 'reqster',
    archive: 'tar.gz',
    prebuildDir: 'darwin-arm64',
    rustTriple: 'aarch64-apple-darwin',
    sidecarExt: '',
  },
  'darwin-x64': {
    nodePlatform: 'darwin',
    nodeArch: 'x64',
    nodeDist: (v) => `node-v${v}-darwin-x64.tar.gz`,
    nodeBinaryInArchive: (v) => `node-v${v}-darwin-x64/bin/node`,
    exeName: 'reqster',
    archive: 'tar.gz',
    prebuildDir: 'darwin-x64',
    rustTriple: 'x86_64-apple-darwin',
    sidecarExt: '',
  },
};

/** postject'in Mach-O'da blob'u koyacağı segment; Node SEA yalnızca bu adı okur (Node SEA belgesi, macOS adımı) */
const MACHO_SEGMENT_NAME = 'NODE_SEA';

const launcherDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(launcherDir, '..');

function log(msg) {
  console.log(`[package] ${msg}`);
}

function fail(msg) {
  console.error(`[package] HATA: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    target: null,
    version: process.env.REQSTER_VERSION || '0.0.0-dev',
    skipAppBuild: false,
    archive: true,
    sidecarDir: null,
    plan: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--skip-app-build') args.skipAppBuild = true;
    else if (a === '--no-archive') args.archive = false;
    else if (a === '--sidecar-dir') args.sidecarDir = argv[++i];
    else if (a === '--plan') args.plan = true;
    else fail(`Bilinmeyen argüman: ${a}`);
  }
  if (!args.target || !TARGETS[args.target]) {
    fail(`--target şunlardan biri olmalı: ${Object.keys(TARGETS).join(', ')}`);
  }
  if (args.sidecarDir === undefined || args.sidecarDir === '') fail('--sidecar-dir bir dizin ister');
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  // Windows'ta npm bir .cmd betiğidir; Node .cmd/.bat dosyalarını kabuksuz başlatmaz (CVE-2024-27980).
  // Argümanlar yalnızca bayrak/yol olduğundan kabukla çalıştırmak güvenlidir.
  const shell = process.platform === 'win32' && cmd === 'npm';
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell, ...opts });
  if (res.status !== 0) {
    fail(`${cmd} ${cmdArgs.join(' ')} → çıkış kodu ${res.status}${res.error ? ` (${res.error.message})` : ''}`);
  }
}

/**
 * Hedefin bu makinede üretilebilir olduğunu denetler. darwin hedefleri codesign istediği için yalnızca
 * macOS'ta üretilir; hata, çıktı dizinine dokunulmadan ÖNCE verilir (yarım paket kalmasın).
 * Döndürdüğü uyarılar durdurmaz (ör. arm64 runner'da x64 hedefi: Node ikilisi x64 indirilir,
 * postject JS'tir ve codesign mimariden bağımsızdır; Rosetta altında çalışır).
 */
function hostCanBuild(target) {
  return target.nodePlatform !== 'darwin' || process.platform === 'darwin';
}

function hostCannotBuildMessage(targetName) {
  return (
    `${targetName} hedefi yalnızca macOS'ta üretilebilir (Mach-O ikilide codesign --remove-signature / --sign gerekir, ` +
    `Linux/Windows'ta codesign yok). Bu hedef için CI'daki macOS işini (release.yml → macos) kullanın; planı görmek için --plan ekleyin.`
  );
}

function hostWarnings(target) {
  if (target.nodePlatform === 'darwin' && process.arch !== target.nodeArch) {
    return [
      `runner mimarisi ${process.arch}, hedef ${target.nodeArch}: çapraz paketleme (Node ikilisi hedef mimari için ` +
        `indirilir; üretilen ikili bu makinede yalnızca Rosetta ile çalışır, duman testi bunu hesaba katsın).`,
    ];
  }
  return [];
}

function readNodeVersion() {
  const v = readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
  if (process.version !== `v${v}`) {
    fail(
      `.nvmrc Node ${v} istiyor, çalışan Node ${process.version}. SEA blob'u ve native modül ABI'si ` +
        `hedef ikiliyle aynı sürümden üretilmelidir; bu betiği Node ${v} ile çalıştırın.`,
    );
  }
  return v;
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function download(url, dest) {
  if (existsSync(dest)) {
    log(`önbellekte: ${path.basename(dest)}`);
    return;
  }
  log(`indiriliyor: ${url}`);
  const res = await fetch(url);
  if (!res.ok) fail(`${url} → HTTP ${res.status}`);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** nodejs.org'dan hedef platformun Node ikilisini indirir, SHA-256 doğrular, ikiliyi çıkarır */
async function fetchNodeBinary(target, nodeVersion, cacheDir) {
  const distName = target.nodeDist(nodeVersion);
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  const archivePath = path.join(cacheDir, distName);
  const sumsPath = path.join(cacheDir, `SHASUMS256-${nodeVersion}.txt`);
  await download(`${base}/${distName}`, archivePath);
  await download(`${base}/SHASUMS256.txt`, sumsPath);

  const expectedLine = readFileSync(sumsPath, 'utf8')
    .split('\n')
    .find((l) => l.trim().endsWith(`  ${distName}`));
  if (!expectedLine) fail(`SHASUMS256.txt içinde ${distName} yok`);
  const expected = expectedLine.split(/\s+/)[0];
  const actual = sha256(archivePath);
  if (actual !== expected) {
    rmSync(archivePath);
    fail(`${distName} SHA-256 uyuşmadı (beklenen ${expected}, gelen ${actual}); dosya silindi, yeniden deneyin`);
  }
  log(`SHA-256 doğrulandı: ${distName}`);

  const extractDir = path.join(cacheDir, `node-${nodeVersion}-${target.nodePlatform}`);
  const binaryPath = path.join(extractDir, target.nodeBinaryInArchive(nodeVersion));
  if (!existsSync(binaryPath)) {
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    if (distName.endsWith('.zip')) {
      new AdmZip(archivePath).extractEntryTo(target.nodeBinaryInArchive(nodeVersion), extractDir, true, true);
    } else {
      // linux dağıtımı .tar.xz, darwin dağıtımı .tar.gz
      const flag = distName.endsWith('.tar.xz') ? '-xJf' : '-xzf';
      run('tar', [flag, archivePath, '-C', extractDir, target.nodeBinaryInArchive(nodeVersion)]);
    }
  }
  if (!existsSync(binaryPath)) fail(`Node ikilisi arşivden çıkarılamadı: ${binaryPath}`);
  return binaryPath;
}

function buildApp(skip) {
  const appDist = path.join(repoRoot, 'packages/app/dist');
  if (skip) {
    if (!existsSync(path.join(appDist, 'index.html'))) fail('--skip-app-build verildi ama packages/app/dist yok');
    log('frontend build atlandı (--skip-app-build)');
  } else {
    log('frontend build (vite)');
    run('npm', ['run', 'build', '-w', '@reqster/app'], { cwd: repoRoot });
  }
  return appDist;
}

async function bundleServer(resourcesDir, nodeVersion) {
  const major = nodeVersion.split('.')[0];
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${major}`,
    external: NATIVE_MODULES,
    legalComments: 'none',
    logLevel: 'warning',
    // Kaynak ESM'dir; CJS bundle'da import.meta.url bundle dosyasının kendi URL'ine çevrilir
    // (paketlenmiş modda yollar zaten REQSTER_RESOURCES_DIR'dan çözülür, bu yalnızca güvenlik ağıdır).
    define: { 'import.meta.url': '__reqsterImportMetaUrl' },
    banner: { js: "const __reqsterImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  };
  log('server bundle (esbuild)');
  await build({
    ...common,
    entryPoints: [path.join(repoRoot, 'packages/server/src/index.ts')],
    outfile: path.join(resourcesDir, 'server.cjs'),
  });
  await build({
    ...common,
    entryPoints: [path.join(repoRoot, 'packages/server/src/scripting/worker-entry.ts')],
    outfile: path.join(resourcesDir, 'worker.cjs'),
  });
}

function copyMigrations(resourcesDir) {
  const src = path.join(repoRoot, 'packages/server/src/db/migrations');
  const dest = path.join(resourcesDir, 'migrations');
  mkdirSync(dest, { recursive: true });
  const files = readdirSync(src).filter((f) => f.endsWith('.sql'));
  if (files.length === 0) fail('migration dosyası bulunamadı');
  for (const f of files) copyFileSync(path.join(src, f), path.join(dest, f));
  log(`${files.length} migration kopyalandı`);
}

/** Mach-O sihirli sayısı: 64-bit (MH_MAGIC_64, little-endian cf fa ed fe) ya da evrensel (fat, ca fe ba be) */
function isMachO(magic) {
  const le64 = magic[0] === 0xcf && magic[1] === 0xfa && magic[2] === 0xed && magic[3] === 0xfe;
  const fat = magic[0] === 0xca && magic[1] === 0xfe && magic[2] === 0xba && magic[3] === 0xbe;
  return le64 || fat;
}

/** isolated-vm ön-derleme dizininde verilen ABI'ye uyan dosyalar (dizin yoksa boş liste) */
function listIvmPrebuilds(dir, abi) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.node') && f.includes(`abi${abi}`));
}

/** npm paketinde olmayan isolated-vm ön-derlemesi için CI'ın dolduracağı dizin (kök node_modules) */
function ivmFallbackDir(target) {
  return path.join(repoRoot, 'node_modules/isolated-vm/prebuilds', target.prebuildDir);
}

function ivmMissingMessage(target, abi) {
  const fallback = ivmFallbackDir(target);
  return (
    `isolated-vm için ${target.prebuildDir} abi${abi} ön-derlemesi yok (npm paketinde gelmiyor, ${fallback} de boş). ` +
    `Bu betik derlemez; CI bu hedeften ÖNCE kaynaktan derleyip sonucu oraya koymalı:\n` +
    `  (cd node_modules/isolated-vm && npx node-gyp rebuild --release --arch=${target.nodeArch} -j max)\n` +
    `  mkdir -p ${fallback} && cp node_modules/isolated-vm/build/Release/isolated-vm.node ${fallback}/isolated-vm.abi${abi}.node\n` +
    `  rm -rf node_modules/isolated-vm/build   # host için derlenmiş build/ paket akışını bozar\n` +
    `(isolated-vm'in install script'i node-gyp-build || node-gyp'tir; runner'ın kendi mimarisi için ön-derleme varsa ` +
    `"npm rebuild" derlemeyi atlar, bu yüzden node-gyp doğrudan ve --arch ile çağrılır.)`
  );
}

/** Native modülleri hedef platformun ön-derlemeleriyle resources/node_modules altına kurar */
function installNativeModules(resourcesDir, target) {
  const dependencies = {};
  for (const name of NATIVE_MODULES) {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8'));
    dependencies[name] = pkg.version; // kök package-lock ile birebir aynı sürüm
  }
  writeFileSync(
    path.join(resourcesDir, 'package.json'),
    JSON.stringify({ name: 'reqster-runtime', private: true, dependencies }, null, 2) + '\n',
  );
  log(`native modüller kuruluyor (${target.nodePlatform}-${target.nodeArch}): ${JSON.stringify(dependencies)}`);
  // --ignore-scripts: install script'leri HOST için derleme yapabilir (node-gyp-build, hedef
  // platform farklıysa prebuild'i bulamayıp isolated-vm'i Linux için derledi ve build/Release'e
  // koydu; Windows'ta node-gyp-build önce build/Release'e bakar → ELF yüklenemez). Hiçbir
  // install script'i çalıştırılmaz; ikililer aşağıda açıkça hedef platform için indirilir.
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts'], {
    cwd: resourcesDir,
  });
  // isolated-vm: ön-derlemeler npm paketinin prebuilds/ klasöründe gelir; node-gyp-build çalışma
  // zamanında build/Release yoksa oradan platform+ABI'ye göre seçer. build/ hiç oluşmamalı.
  const ivmBuild = path.join(resourcesDir, 'node_modules/isolated-vm/build');
  if (existsSync(ivmBuild)) fail(`isolated-vm/build beklenmedik şekilde oluştu: ${ivmBuild}`);

  // Doğrulama: doğru platformun ikilisi geldi mi?
  const abi = process.versions.modules;
  // better-sqlite3 (13+): her platformun N-API ikilisi npm paketinde `prebuilds/<platform>-<arch>.node` olarak gelir,
  // çalışma zamanında `process.platform`-`process.arch`'a göre seçilir; indirme yok. Diğer platformlarınki atılır (boyut).
  const sqlitePrebuilds = path.join(resourcesDir, 'node_modules/better-sqlite3/prebuilds');
  const sqliteName = `${target.nodePlatform}-${target.nodeArch}.node`;
  const sqliteNode = path.join(sqlitePrebuilds, sqliteName);
  if (!existsSync(sqliteNode)) fail(`better-sqlite3 ikilisi yok: ${sqliteNode}`);
  for (const f of readdirSync(sqlitePrebuilds)) {
    if (f !== sqliteName) rmSync(path.join(sqlitePrebuilds, f), { recursive: true, force: true });
  }
  const magic = readFileSync(sqliteNode).subarray(0, 4);
  const isPE = magic[0] === 0x4d && magic[1] === 0x5a; // "MZ"
  const isELF = magic[0] === 0x7f && magic[1] === 0x45; // "\x7fELF"
  if (target.nodePlatform === 'win32' && !isPE) fail('better-sqlite3 ikilisi PE (Windows) değil');
  if (target.nodePlatform === 'linux' && !isELF) fail('better-sqlite3 ikilisi ELF (Linux) değil');
  if (target.nodePlatform === 'darwin' && !isMachO(magic)) fail('better-sqlite3 ikilisi Mach-O (macOS) değil');

  const ivmPrebuilds = path.join(resourcesDir, 'node_modules/isolated-vm/prebuilds');
  const ivmTargetDir = path.join(ivmPrebuilds, target.prebuildDir);
  let wanted = listIvmPrebuilds(ivmTargetDir, abi);
  if (wanted.length === 0) {
    // npm paketinde bu platform için ön-derleme yok (bugün: darwin-x64). CI kaynaktan derleyip kök
    // node_modules'a koyarsa oradan kopyalanır; betik kendisi derlemez.
    const fallbackDir = ivmFallbackDir(target);
    const fromFallback = listIvmPrebuilds(fallbackDir, abi);
    if (fromFallback.length === 0) fail(ivmMissingMessage(target, abi));
    mkdirSync(ivmTargetDir, { recursive: true });
    for (const f of fromFallback) copyFileSync(path.join(fallbackDir, f), path.join(ivmTargetDir, f));
    log(`isolated-vm ön-derlemesi kök node_modules'tan alındı: ${fromFallback.join(', ')}`);
    wanted = fromFallback;
  }
  // Diğer platformların ön-derlemelerini ve kaynak ağaçlarını at (boyut)
  for (const dir of readdirSync(ivmPrebuilds)) {
    if (dir !== target.prebuildDir) rmSync(path.join(ivmPrebuilds, dir), { recursive: true, force: true });
  }
  for (const extra of [
    'node_modules/isolated-vm/src',
    'node_modules/isolated-vm/out',
    'node_modules/isolated-vm/native-example',
    `node_modules/isolated-vm/isolated-vm-${dependencies['isolated-vm']}.tgz`,
    'node_modules/better-sqlite3/deps',
    'node_modules/better-sqlite3/src',
  ]) {
    rmSync(path.join(resourcesDir, extra), { recursive: true, force: true });
  }
  log(`native modüller doğrulandı (abi${abi}): ${wanted.join(', ')}`);
}

function makeSeaBlob(outDir) {
  const cfgPath = path.join(outDir, 'sea-config.json');
  const blobPath = path.join(outDir, 'sea-prep.blob');
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        main: path.join(launcherDir, 'reqster-launcher.js'),
        output: blobPath,
        disableExperimentalSEAWarning: true,
        // Kod önbelleği/snapshot platforma bağlıdır; çapraz paketleme için kapalı kalmalı
        useCodeCache: false,
        useSnapshot: false,
      },
      null,
      2,
    ),
  );
  log('SEA blob üretiliyor');
  run(process.execPath, ['--experimental-sea-config', cfgPath]);
  return blobPath;
}

/**
 * Node ikilisinin kopyasına SEA blob'unu enjekte eder. macOS'ta Node SEA belgesinin sırası uygulanır:
 * imzayı kaldır → NODE_SEA segmentine enjekte et → ad-hoc imzala (imzasız/bozuk imzalı Mach-O'yu
 * çekirdek çalıştırmaz). Tauri paketlerken sidecar'ı kendi kimliğiyle yeniden imzalar.
 */
async function makeExecutable(nodeBinary, blobPath, exePath, target) {
  copyFileSync(nodeBinary, exePath);
  const darwin = target.nodePlatform === 'darwin';
  if (darwin) {
    log(`codesign --remove-signature ${path.basename(exePath)}`);
    run('codesign', ['--remove-signature', exePath]);
  }
  log(`SEA blob enjekte ediliyor → ${path.basename(exePath)}${darwin ? ` (Mach-O segmenti ${MACHO_SEGMENT_NAME})` : ''}`);
  await inject(exePath, 'NODE_SEA_BLOB', readFileSync(blobPath), {
    sentinelFuse: SEA_FUSE,
    ...(darwin ? { machoSegmentName: MACHO_SEGMENT_NAME } : {}),
  });
  chmodSync(exePath, 0o755);
  if (darwin) {
    log(`codesign --sign - ${path.basename(exePath)} (ad-hoc)`);
    run('codesign', ['--sign', '-', exePath]);
  }
}

/** --plan: yan etkisiz; hedef için indirilecekleri, ön-derleme durumunu ve adımları yazdırır */
function printPlan(targetName, target, nodeVersion, args) {
  const abi = process.versions.modules;
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  const sqlite = JSON.parse(readFileSync(path.join(repoRoot, 'node_modules/better-sqlite3/package.json'), 'utf8'));
  const ivm = JSON.parse(readFileSync(path.join(repoRoot, 'node_modules/isolated-vm/package.json'), 'utf8'));
  const ivmPkgDir = path.join(repoRoot, 'node_modules/isolated-vm/prebuilds', target.prebuildDir);
  const ivmFound = listIvmPrebuilds(ivmPkgDir, abi);
  const darwin = target.nodePlatform === 'darwin';
  const lines = [
    `PLAN ${targetName} (sürüm ${args.version}, Node ${nodeVersion}, abi${abi}) — bu makine ${process.platform}-${process.arch}`,
    `  üretilebilir mi: ${hostCanBuild(target) ? 'evet' : `HAYIR — ${hostCannotBuildMessage(targetName)}`}`,
    ...(process.platform === 'darwin' ? hostWarnings(target).map((w) => `  UYARI: ${w}`) : []),
    `  Node ikilisi : ${base}/${target.nodeDist(nodeVersion)}  (arşiv içi: ${target.nodeBinaryInArchive(nodeVersion)})`,
    `  SHA-256      : ${base}/SHASUMS256.txt`,
    `  rust triple  : ${target.rustTriple}`,
    `  sidecar      : ${args.sidecarDir ? path.join(path.resolve(repoRoot, args.sidecarDir), 'binaries', `reqster-server-${target.rustTriple}${target.sidecarExt}`) : '(--sidecar-dir verilmedi)'}`,
    `  arşiv        : ${args.archive ? `dist/Reqster-${args.version}-${target.nodePlatform === 'win32' ? 'win' : target.nodePlatform}-${target.nodeArch}.${target.archive}` : '(--no-archive)'}`,
    `  better-sqlite3 ${sqlite.version}: npm paketindeki prebuilds/${target.nodePlatform}-${target.nodeArch}.node`,
    `  isolated-vm ${ivm.version}: prebuilds/${target.prebuildDir} → ` +
      (ivmFound.length > 0 ? `VAR (${ivmFound.join(', ')})` : `YOK — paket akışı burada durur. ${ivmMissingMessage(target, abi)}`),
    '  adımlar:',
    `    1. ${args.skipAppBuild ? 'frontend build atlanır' : 'npm run build -w @reqster/app'}`,
    '    2. esbuild → resources/server.cjs, worker.cjs; migrations/ kopyası',
    '    3. resources/ içine npm install --ignore-scripts; better-sqlite3 ve isolated-vm ön-derleme seçimi',
    '    4. Node ikilisini indir + SHA-256 doğrula + arşivden çıkar',
    '    5. node --experimental-sea-config → sea-prep.blob',
    ...(darwin
      ? [
          `    6. codesign --remove-signature ${target.exeName}`,
          `    7. postject NODE_SEA_BLOB (sentinel fuse + --macho-segment-name ${MACHO_SEGMENT_NAME})`,
          `    8. codesign --sign - ${target.exeName} (ad-hoc)`,
        ]
      : [`    6. postject NODE_SEA_BLOB (sentinel fuse) → ${target.exeName}`]),
    `    ${darwin ? 9 : 7}. ${args.archive ? 'arşiv' : 'arşiv yok'}${args.sidecarDir ? ' + sidecar yerleşimi' : ''}`,
  ];
  console.log(lines.join('\n'));
}

function writeReadme(stageDir, target, version) {
  const exe = target.exeName;
  const text = [
    `Reqster ${version}`,
    '',
    `Calistirmak icin: ${exe}`,
    'Tarayici otomatik acilir (http://127.0.0.1:7357). Konsol penceresini kapatmak uygulamayi durdurur.',
    '',
    'Veri: bu klasorun yanindaki data/reqster.db dosyasinda tutulur (REQSTER_DATA_DIR ile degistirilebilir).',
    'resources/ klasoru exe ile AYNI dizinde kalmalidir.',
    '',
  ].join('\r\n');
  writeFileSync(path.join(stageDir, 'BENIOKU.txt'), text);
}

function archive(outDir, stageDir, target, version) {
  const distDir = path.join(repoRoot, 'dist');
  mkdirSync(distDir, { recursive: true });
  const baseName = `Reqster-${version}-${target.nodePlatform === 'win32' ? 'win' : target.nodePlatform}-${target.nodeArch}`;
  let out;
  if (target.archive === 'zip') {
    out = path.join(distDir, `${baseName}.zip`);
    rmSync(out, { force: true });
    const zip = new AdmZip();
    zip.addLocalFolder(stageDir, 'Reqster');
    zip.writeZip(out);
  } else {
    out = path.join(distDir, `${baseName}.tar.gz`);
    rmSync(out, { force: true });
    run('tar', ['-czf', out, '-C', outDir, 'Reqster']);
  }
  return out;
}

/**
 * Tauri sidecar yerleşimi: exe `<sidecarDir>/binaries/reqster-server-<triple>[.exe]` olur (Tauri,
 * `externalBin` girdisine hedef üçlüsünü kendisi ekleyerek arar), staged `resources/` ise
 * `<sidecarDir>/resources/` olarak kopyalanır (tauri.conf.json `bundle.resources`). Hedef
 * resources dizini eski bir paketleme kalıntısı taşımasın diye önce silinir.
 */
function emitSidecar(sidecarDir, stageDir, target) {
  const dir = path.resolve(repoRoot, sidecarDir);
  const binariesDir = path.join(dir, 'binaries');
  mkdirSync(binariesDir, { recursive: true });
  const sidecarExe = path.join(binariesDir, `reqster-server-${target.rustTriple}${target.sidecarExt}`);
  copyFileSync(path.join(stageDir, target.exeName), sidecarExe);
  chmodSync(sidecarExe, 0o755);
  log(`sidecar ikilisi → ${sidecarExe}`);

  const sidecarResources = path.join(dir, 'resources');
  rmSync(sidecarResources, { recursive: true, force: true });
  cpSync(path.join(stageDir, 'resources'), sidecarResources, { recursive: true });
  log(`sidecar kaynakları → ${sidecarResources}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = TARGETS[args.target];
  const nodeVersion = readNodeVersion();
  if (args.plan) {
    printPlan(args.target, target, nodeVersion, args); // yan etkisiz, Linux'ta da çalışır
    return;
  }
  // Çıktı dizinine dokunmadan ÖNCE: darwin hedefi Linux'ta üretilemez (yarım paket kalmasın)
  if (!hostCanBuild(target)) fail(hostCannotBuildMessage(args.target));
  for (const w of hostWarnings(target)) log(`UYARI: ${w}`);

  const outDir = path.join(repoRoot, 'dist/package', args.target);
  const cacheDir = path.join(repoRoot, 'dist/package/.cache');
  const stageDir = path.join(outDir, 'Reqster');
  const resourcesDir = path.join(stageDir, 'resources');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(resourcesDir, { recursive: true });
  log(`hedef ${args.target}, sürüm ${args.version}, Node ${nodeVersion}`);

  const appDist = buildApp(args.skipAppBuild);
  cpSync(appDist, path.join(resourcesDir, 'app'), { recursive: true });
  await bundleServer(resourcesDir, nodeVersion);
  copyMigrations(resourcesDir);
  installNativeModules(resourcesDir, target);
  writeFileSync(
    path.join(resourcesDir, 'build-info.json'),
    JSON.stringify(
      { version: args.version, gitSha: gitSha(), node: nodeVersion, target: args.target, builtAt: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );

  const nodeBinary = await fetchNodeBinary(target, nodeVersion, cacheDir);
  const blobPath = makeSeaBlob(outDir);
  await makeExecutable(nodeBinary, blobPath, path.join(stageDir, target.exeName), target);
  writeReadme(stageDir, target, args.version);

  if (args.archive) {
    const out = archive(outDir, stageDir, target, args.version);
    log(`arşiv → ${out}`);
  } else {
    log('arşiv atlandı (--no-archive)');
  }
  if (args.sidecarDir) emitSidecar(args.sidecarDir, stageDir, target);
  log(`çalıştırılabilir klasör → ${stageDir}`);
}

main().catch((err) => fail(err?.stack ?? String(err)));
