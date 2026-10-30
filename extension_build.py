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


# ── 업데이트 도구 — 확장 폴더 안에서 더블클릭하면 이 서버의 최신 배포본을 받아 그 폴더에 덮어쓴다 ────────
# (개발자 모드로 설치한 확장은 스토어 자동 업데이트가 없다.) 파일이 바뀌면 확장이 스스로 다시 불러온다(background.js).
UPDATE_CMD = "업데이트.cmd"          # Windows
UPDATE_SH = "업데이트.command"       # macOS(더블클릭) · Linux(bash)

_PS = (
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop';"
    " [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;"
    " $dir='%DIR%'.TrimEnd('\\');"
    " if(-not (Test-Path (Join-Path $dir 'manifest.json'))){ throw '이 파일을 확장 폴더(manifest.json 이 있는 곳) 안에 두고 실행하세요.' };"
    " $z=Join-Path $env:TEMP 'secretary-extension.zip'; Write-Host '받는 중: {url}'; Invoke-WebRequest -UseBasicParsing -Uri '{url}' -OutFile $z;"
    " $t=Join-Path $env:TEMP ('sec-ext-'+[guid]::NewGuid()); Expand-Archive -LiteralPath $z -DestinationPath $t -Force;"
    " $src=Join-Path $t 'secretary-extension'; if(-not (Test-Path (Join-Path $src 'manifest.json'))){ throw '받은 파일이 확장 배포본이 아닙니다.' };"
    " Copy-Item -Path (Join-Path $src '*') -Destination $dir -Recurse -Force; Remove-Item $t -Recurse -Force; Remove-Item $z -Force;"
    " $v=(Get-Content -Raw -LiteralPath (Join-Path $dir 'manifest.json') | ConvertFrom-Json).version;"
    " Write-Host ('완료: 확장 파일을 버전 ' + $v + ' 으로 바꿨습니다.')"
)


def update_scripts(server: str) -> dict:
    """{파일 이름: 내용}. 서버 주소가 없으면 빈 dict(어디서 받을지 모른다)."""
    server = (server or "").strip().rstrip("/")
    if not server:
        return {}
    url = server + "/api/secretary/extension.zip"
    # 실행 중인 배치 파일을 덮어쓰면 깨질 수 있어, 임시 폴더로 복사한 뒤 거기서 '/run 대상폴더' 로 다시 실행한다
    cmd = "\r\n".join([
        "@echo off",
        "chcp 65001 >nul",
        "setlocal",
        'if "%~1"=="/run" goto run',
        'copy /y "%~f0" "%TEMP%\\sec-ext-update.cmd" >nul',
        'call "%TEMP%\\sec-ext-update.cmd" /run "%~dp0"',
        "exit /b",
        ":run",
        'set "DIR=%~2"',
        "echo 서무비서 확장 업데이트",
        "echo 폴더: %DIR%",
        "echo.",
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "& { ' + _PS.replace("{url}", url) + ' }"',
        "if errorlevel 1 (",
        "  echo.",
        "  echo 업데이트하지 못했습니다. 서무비서 웹 화면의 [확장 설치]에서 zip 을 받아 이 폴더에 덮어쓰세요.",
        ") else (",
        "  echo.",
        "  echo 브라우저가 확장을 스스로 다시 불러옵니다. 패널이 열려 있으면 패널 위의 [지금 적용]을 누르세요.",
        "  echo 열려 있던 ERP 탭은 새로고침^(F5^)하면 새 판이 적용됩니다.",
        ")",
        "echo.",
        "pause",
        "",
    ])
    # bash 는 함수 본문을 먼저 다 읽으므로, 실행 중에 자기 파일이 바뀌어도 안전하다
    sh = "\n".join([
        "#!/bin/bash",
        "# 서무비서 확장 업데이트 — 이 파일이 있는 폴더에 최신 배포본을 덮어쓴다(macOS: 더블클릭, 처음엔 오른쪽 클릭 → 열기)",
        "main() {",
        "  set -e",
        '  DIR="$(cd "$(dirname "$0")" && pwd)"',
        f'  URL="{url}"',
        '  if [ ! -f "$DIR/manifest.json" ]; then echo "이 파일을 확장 폴더(manifest.json 이 있는 곳) 안에 두고 실행하세요."; exit 1; fi',
        '  echo "서무비서 확장 업데이트 — $DIR"',
        '  TMP="$(mktemp -d)"',
        '  echo "받는 중: $URL"',
        '  curl -fsSL "$URL" -o "$TMP/ext.zip"',
        '  unzip -oq "$TMP/ext.zip" -d "$TMP"',
        '  if [ ! -f "$TMP/secretary-extension/manifest.json" ]; then echo "받은 파일이 확장 배포본이 아닙니다."; exit 1; fi',
        '  cp -R "$TMP/secretary-extension/." "$DIR/"',
        '  rm -rf "$TMP"',
        "  V=\"$(sed -n 's/.*\"version\": *\"\\([^\"]*\\)\".*/\\1/p' \"$DIR/manifest.json\" | head -1)\"",
        '  echo "완료: 확장 파일을 버전 $V 으로 바꿨습니다."',
        '  echo "브라우저가 확장을 스스로 다시 불러옵니다. 패널이 열려 있으면 패널 위의 [지금 적용]을 누르세요."',
        '  echo "열려 있던 ERP 탭은 새로고침하면 새 판이 적용됩니다."',
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
