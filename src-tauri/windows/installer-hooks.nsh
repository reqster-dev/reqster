; Reqster NSIS kurulum kancaları (tauri.windows.conf.json > bundle.windows.nsis.installerHooks).

; Uygulamanın eski adı Reqly'ydi. Kurulum klasörü, kısayollar ve kaldırma kaydı ürün adına bağlıdır:
; Reqster yeni bir klasöre kurulur, eski "Reqly" kaydı yanında kalırdı. Kurulum bitince eski kopya,
; kendi kaldırıcısıyla sessiz (/S) kaldırılır. Sessiz kaldırma "uygulama verisini sil" seçeneğini
; işaretlemez; kullanıcı verisine (%APPDATA%\Reqster, rc.26 ve öncesinde %APPDATA%\tr.talhacigdem.reqly) dokunulmaz.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\Reqly" "InstallLocation"
  ${If} $R0 != ""
    ; InstallLocation tırnak içinde yazılır: "C:\Users\...\Reqly"
    StrCpy $R1 $R0 1
    ${If} $R1 == '"'
      StrCpy $R0 $R0 "" 1
      StrCpy $R0 $R0 -1
    ${EndIf}
    ${If} $R0 != $INSTDIR
    ${AndIf} ${FileExists} "$R0\uninstall.exe"
      ; _?= kaldırıcının kendini geçici dizine kopyalayıp hemen dönmesini engeller (bitmesini bekleriz)
      ExecWait '"$R0\uninstall.exe" /S _?=$R0'
      Delete "$R0\uninstall.exe"
      RMDir "$R0"
    ${EndIf}
  ${EndIf}
!macroend
