"""서무비서 브라우저 확장 배포본(zip) 만들기 — 배포 페이지(/api/secretary/extension.zip)와 scripts/build_extension.py 가 함께 쓴다.

기관의 서무비서 주소·ERP 주소를 manifest·config.js 에 넣어, 사용자가 따로 설정하지 않아도 바로 쓰게 한다.
"""
import io, json, os, re, zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "extension")


def origin_pattern(u: str) -> str:
    """'kerp.koat.or.kr' · 'https://kerp.koat.or.kr/gw/x.do' → 'https://kerp.koat.or.kr/*'"""
    u = (u or "").strip().rstrip("/")
    if not u:
        return ""
    if not re.match(r"^https?://", u):
        u = "https://" + u
    m = re.match(r"^(https?://(?:\*\.)?[A-Za-z0-9._\-]+(?::\d+)?)(?:/|$)", u)   # '*.기관.kr' 와일드카드·밑줄 호스트 허용(확장 설정과 같게)
    return (m.group(1) + "/*") if m else ""


def manifest() -> dict:
    with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


# ── 설치·업데이트 도구 — 어디서 실행해도 된다(다운로드 폴더 그대로 더블클릭) ─────────────────────────────
# 1) 브라우저 프로필(Preferences)에 적힌 '압축 해제 확장' 경로 가운데 서무비서(주소창 키워드 '서무')인 폴더를 찾아
#    이 서버의 최신 배포본으로 덮어쓴다 → 확장이 스스로 다시 불러온다(background.js).
# 2) 설치된 곳이 없으면 정해진 폴더에 새로 두고 그 폴더를 열어 준다(브라우저 등록은 한 번만 사람이).
# (개발자 모드로 설치한 확장은 스토어 자동 업데이트가 없다.)
UPDATE_CMD = "업데이트.cmd"          # Windows — zip 안 이름. 따로 받을 때는 UPDATE_CMD_DL
UPDATE_SH = "업데이트.command"       # macOS(더블클릭) · Linux(bash)
UPDATE_CMD_DL = "서무비서_확장.cmd"
UPDATE_SH_DL = "서무비서_확장.command"

# PowerShell 본문 — cmd 의 -Command "..." 안에 들어가므로 큰따옴표를 쓰지 않는다(문자열은 작은따옴표·연결, 정규식의 " 는 \x22)
_PS = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "$ErrorActionPreference='Stop'",
    "try {",
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12",
    "$url='{url}'",
    "$here='%HERE%'.TrimEnd('\\')",
    "$isSec={ param($d) (Test-Path -LiteralPath (Join-Path $d 'manifest.json')) -and (Test-Path -LiteralPath (Join-Path $d 'sidepanel.html'))"
    " -and ((Get-Content -Raw -LiteralPath (Join-Path $d 'manifest.json')) -match '\\x22keyword\\x22:\\s*\\x22(서무|\\\\uc11c\\\\ubb34)\\x22') }",   # 유니코드 이스케이프로 저장된 manifest 도
    "$found=New-Object System.Collections.Generic.List[string]",
    "if($here -and (& $isSec $here)){ $found.Add($here) }",
    "$roots=@(($env:LOCALAPPDATA+'\\Google\\Chrome\\User Data'),($env:LOCALAPPDATA+'\\Microsoft\\Edge\\User Data'),($env:LOCALAPPDATA+'\\Naver\\Naver Whale\\User Data'),"
    "($env:LOCALAPPDATA+'\\Chromium\\User Data'),($env:LOCALAPPDATA+'\\BraveSoftware\\Brave-Browser\\User Data'))",
    "$edge=$false",
    "foreach($r in $roots){ if(-not (Test-Path -LiteralPath $r)){ continue }",
    " foreach($p in (Get-ChildItem -LiteralPath $r -Directory | Where-Object { $_.Name -match '^(Default|Profile \\d+)$' })){",
    "  foreach($f in @('Preferences','Secure Preferences')){ $pf=Join-Path $p.FullName $f",
    "   if(-not (Test-Path -LiteralPath $pf)){ continue }",
    "   foreach($m in [regex]::Matches((Get-Content -Raw -LiteralPath $pf), '\\x22path\\x22:\\x22([^\\x22]+)\\x22')){ $d=$m.Groups[1].Value -replace '\\\\\\\\','\\'",
    "    if([IO.Path]::IsPathRooted($d) -and -not $found.Contains($d) -and (& $isSec $d)){ $found.Add($d)",
    "     if($r -like '*Edge*'){ $edge=$true } } } } } }",
    "$z=Join-Path $env:TEMP 'secretary-extension.zip'",
    "Write-Host ('받는 중: '+$url)",
    "Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $z",
    "$t=Join-Path $env:TEMP ('sec-ext-'+[guid]::NewGuid())",
    "Expand-Archive -LiteralPath $z -DestinationPath $t -Force",
    "$src=Join-Path $t 'secretary-extension'",
    "if(-not (Test-Path -LiteralPath (Join-Path $src 'manifest.json'))){ throw '받은 파일이 확장 배포본이 아닙니다.' }",
    "$v=(Get-Content -Raw -LiteralPath (Join-Path $src 'manifest.json') | ConvertFrom-Json).version",
    "if($found.Count -gt 0){",
    " foreach($d in $found){ $old=(Get-Content -Raw -LiteralPath (Join-Path $d 'manifest.json') | ConvertFrom-Json).version",
    "  Copy-Item -Path (Join-Path $src '*') -Destination $d -Recurse -Force",
    "  Write-Host ('업데이트: '+$d+'  ('+$old+' -> '+$v+')') }",
    " Write-Host ''",
    " Write-Host '완료. 브라우저가 확장을 스스로 다시 불러옵니다(패널이 열려 있으면 패널 위의 [지금 적용]을 누르세요).'",
    " Write-Host '열려 있던 ERP 탭은 새로고침(F5)하면 새 판이 적용됩니다.'",
    "} else {",
    " $dst=Join-Path $env:LOCALAPPDATA '서무비서\\secretary-extension'",
    " New-Item -ItemType Directory -Force -Path $dst | Out-Null",
    " Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force",
    " $page=if($edge -or ((Test-Path -LiteralPath ($env:LOCALAPPDATA+'\\Microsoft\\Edge\\User Data')) -and -not (Test-Path -LiteralPath ($env:LOCALAPPDATA+'\\Google\\Chrome\\User Data')))){ 'edge://extensions' } else { 'chrome://extensions' }",
    " try { Set-Clipboard -Value $page } catch { }",
    " Write-Host ('설치된 확장을 찾지 못해 새로 설치할 파일을 두었습니다(버전 '+$v+'):')",
    " Write-Host ('  '+$dst)",
    " Write-Host ''",
    " Write-Host '브라우저에 한 번만 등록하면 됩니다:'",
    " Write-Host ('  1. 주소창에 '+$page+' 를 입력합니다(클립보드에 복사해 두었습니다 - Ctrl+V).')",
    " Write-Host '  2. 개발자 모드를 켭니다.'",
    " Write-Host '  3. [압축해제된 확장 프로그램을 로드](Edge: [압축을 푼 파일 로드])를 누르고 방금 열린 폴더를 고릅니다.'",
    " Start-Process explorer.exe -ArgumentList ([char]34+$dst+[char]34)",
    "}",
    "Remove-Item $t -Recurse -Force",
    "Remove-Item $z -Force",
    "} catch { Write-Host ''",
    " Write-Host ('실패: '+$_.Exception.Message)",
    " Write-Host '서무비서 웹 화면의 [확장 설치]에서 zip 을 받아 수동으로 설치·덮어쓸 수 있습니다.'",
    " exit 1 }",
]


def update_scripts(server: str) -> dict:
    """{파일 이름: 내용}. 서버 주소가 없으면 빈 dict(어디서 받을지 모른다)."""
    server = (server or "").strip().rstrip("/")
    if not server:
        return {}
    url = server + "/api/secretary/extension.zip"
    # 문장 사이는 ';' — 블록을 여는 '{' 뒤에는 붙이지 않는다('} else {' 가 끊기지 않게)
    ps = ""
    for line in _PS:
        line = line.replace("{url}", url).strip()
        ps += line + (" " if line.endswith("{") else "; ")
    ps = ps.rstrip("; ")
    assert '"' not in ps, "PowerShell 본문에 큰따옴표가 있으면 cmd 인자가 끊긴다"
    # 실행 중인 배치 파일을 덮어쓰면 깨질 수 있어(확장 폴더 안에서 실행한 경우), 임시 폴더로 복사한 뒤 '/run 원래폴더' 로 다시 실행한다
    cmd = "\r\n".join([
        "@echo off",
        "chcp 65001 >nul",
        "setlocal",
        'if "%~1"=="/run" goto run',
        'copy /y "%~f0" "%TEMP%\\sec-ext-update.cmd" >nul',
        'call "%TEMP%\\sec-ext-update.cmd" /run "%~dp0"',
        "exit /b",
        ":run",
        'set "HERE=%~2"',
        "echo 서무비서 확장 설치·업데이트",
        "echo.",
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "& { ' + ps + ' }"',
        "echo.",
        "pause",
        "",
    ])
    # bash 는 함수 본문을 먼저 다 읽으므로, 실행 중에 자기 파일이 바뀌어도 안전하다. SEC_PROFILE_ROOTS 는 시험용(브라우저 프로필 위치 지정)
    sh = "\n".join([
        "#!/bin/bash",
        "# 서무비서 확장 설치·업데이트 — 어디서 실행해도 됩니다(macOS: 더블클릭, 처음엔 오른쪽 클릭 → 열기)",
        "main() {",
        f'  URL="{url}"',
        '  HERE="$(cd "$(dirname "$0")" && pwd)"',
        "  is_sec() { [ -f \"$1/manifest.json\" ] && [ -f \"$1/sidepanel.html\" ] && grep -Eq '\"keyword\": *\"(서무|\\\\uc11c\\\\ubb34)\"' \"$1/manifest.json\"; }",
        "  FOUND=()",
        '  is_sec "$HERE" && FOUND+=("$HERE")',
        '  if [ -n "$SEC_PROFILE_ROOTS" ]; then IFS=: read -r -a ROOTS <<< "$SEC_PROFILE_ROOTS"; else',
        '    ROOTS=("$HOME/Library/Application Support/Google/Chrome" "$HOME/Library/Application Support/Microsoft Edge" "$HOME/Library/Application Support/Chromium"',
        '      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" "$HOME/Library/Application Support/Naver/Whale"',
        '      "$HOME/.config/google-chrome" "$HOME/.config/microsoft-edge" "$HOME/.config/chromium" "$HOME/.config/BraveSoftware/Brave-Browser"); fi',
        '  EDGE=0',
        '  for r in "${ROOTS[@]}"; do [ -d "$r" ] || continue',
        '    for pf in "$r"/Default/Preferences "$r"/Default/"Secure Preferences" "$r"/Profile*/Preferences "$r"/Profile*/"Secure Preferences"; do [ -f "$pf" ] || continue',
        "      while IFS= read -r d; do",
        '        case "$d" in /*) ;; *) continue;; esac',
        '        skip=0; for f in "${FOUND[@]}"; do [ "$f" = "$d" ] && skip=1; done; [ $skip = 1 ] && continue',
        '        if is_sec "$d"; then FOUND+=("$d"); case "$r" in *Edge*|*edge*) EDGE=1;; esac; fi',
        "      done < <(grep -o '\"path\":\"[^\"]*\"' \"$pf\" | sed 's/^\"path\":\"//; s/\"$//')",
        "    done",
        "  done",
        '  TMP="$(mktemp -d)"',
        '  echo "받는 중: $URL"',
        '  curl -fsSL "$URL" -o "$TMP/ext.zip"',
        '  unzip -oq "$TMP/ext.zip" -d "$TMP"',
        '  SRC="$TMP/secretary-extension"',
        '  if [ ! -f "$SRC/manifest.json" ]; then echo "받은 파일이 확장 배포본이 아닙니다."; rm -rf "$TMP"; return 1; fi',
        "  ver() { sed -n 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/p' \"$1/manifest.json\" | head -1; }",
        '  V="$(ver "$SRC")"',
        '  if [ ${#FOUND[@]} -gt 0 ]; then',
        '    for d in "${FOUND[@]}"; do OLD="$(ver "$d")"; cp -R "$SRC/." "$d/"; echo "업데이트: $d  ($OLD -> $V)"; done',
        '    echo; echo "완료. 브라우저가 확장을 스스로 다시 불러옵니다(패널이 열려 있으면 패널 위의 [지금 적용]을 누르세요)."',
        '    echo "열려 있던 ERP 탭은 새로고침하면 새 판이 적용됩니다."',
        "  else",
        '    DST="$HOME/서무비서/secretary-extension"; mkdir -p "$DST"; cp -R "$SRC/." "$DST/"',
        '    if [ $EDGE = 1 ]; then PAGE="edge://extensions"; else PAGE="chrome://extensions"; fi',
        '    command -v pbcopy >/dev/null && printf "%s" "$PAGE" | pbcopy',
        '    echo "설치된 확장을 찾지 못해 새로 설치할 파일을 두었습니다(버전 $V):"; echo "  $DST"; echo',
        '    echo "브라우저에 한 번만 등록하면 됩니다:"',
        '    echo "  1. 주소창에 $PAGE 를 입력합니다(클립보드에 복사해 두었습니다 - Cmd+V)."',
        '    echo "  2. 개발자 모드를 켭니다."',
        '    echo "  3. [압축해제된 확장 프로그램을 로드]를 누르고 방금 열린 폴더를 고릅니다."',
        '    command -v open >/dev/null && open "$DST"',
        "  fi",
        '  rm -rf "$TMP"',
        "}",
        'main "$@"',
        "",
    ])
    return {UPDATE_CMD: cmd, UPDATE_SH: sh}


def build_zip(server: str = "", erps=None, name: str = "", version: str = "", profile=None) -> tuple[bytes, dict]:
    server = (server or "").strip().rstrip("/")
    if server and not re.match(r"^https://", server) and not re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", server):
        raise ValueError("서무비서 주소는 https 여야 합니다.")
    man = manifest()
    pats = [p for p in (origin_pattern(x) for x in (erps or [])) if p]
    # 기관이 ERP 주소를 정했으면 그 주소만(다른 기관 배포본에 KOAT 주소 권한이 남지 않게), 없으면 기본 주소
    if erps and not pats:   # 기관이 주소를 적었는데 하나도 못 읽었으면 KOAT 기본 주소로 대신하지 않고 알린다
        raise ValueError("ERP 주소를 읽지 못했습니다: " + ", ".join(map(str, erps))[:200])
    pats = list(dict.fromkeys(pats)) or man["content_scripts"][0]["matches"]
    man["host_permissions"] = pats
    man["content_scripts"][0]["matches"] = pats
    if server:
        # 서무비서 웹 화면: 확장 설치 표시·기한 전달(marker.js)
        man["content_scripts"].append({"matches": [server + "/*"], "js": ["marker.js"], "run_at": "document_start"})
    if name:
        man["name"] = name[:45]
        man["short_name"] = name[:12]
    if version:
        if not re.match(r"^\d+(\.\d+){0,3}$", version):
            raise ValueError("버전 형식: 1.0.1")
        man["version"] = version
    with open(os.path.join(SRC, "config.js"), encoding="utf-8") as f:
        cfg = f.read()
    cfg = re.sub(r'server: "[^"]*"', "server: " + json.dumps(server), cfg, count=1)
    cfg = re.sub(r"erpHosts: \[[^\]]*\]", "erpHosts: " + json.dumps(pats), cfg, count=1)
    if profile:   # 기관 ERP 규칙 — 서버에 닿지 않을 때도 화면 감지·결재 전 점검이 기관 규칙으로 동작하게
        cfg = cfg.replace("globalThis.SEC_PROFILE_DEFAULT = null;",
                          "globalThis.SEC_PROFILE_DEFAULT = " + json.dumps(profile, ensure_ascii=False) + ";", 1)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(SRC):
            for fn in sorted(files):
                full = os.path.join(base, fn)
                rel = os.path.relpath(full, SRC).replace(os.sep, "/")
                if rel.startswith(".") or rel.endswith(".md"):
                    continue
                arc = "secretary-extension/" + rel            # 압축을 풀면 폴더 하나로 — '폴더 선택'이 쉽도록
                if rel == "manifest.json":
                    z.writestr(arc, json.dumps(man, ensure_ascii=False, indent=2) + "\n")
                elif rel == "config.js":
                    z.writestr(arc, cfg)
                else:
                    z.write(full, arc)
        for fn, body in update_scripts(server).items():
            info = zipfile.ZipInfo("secretary-extension/" + fn)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if fn.endswith(".command") else 0o644) << 16   # .command 는 실행 권한
            z.writestr(info, body.encode("utf-8"))
    return buf.getvalue(), man
