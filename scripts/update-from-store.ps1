param(
    [switch]$CheckOnly
)

$ExtensionId  = "fcoeoabgfenejglbffodgkkbkcdhcgfn"
$ProjectRoot  = Split-Path $PSScriptRoot -Parent

# Files / folders never overwritten by updates
$Protected = @(
    "manifest.json",
    "firefox-page-shims.js",
    "firefox-bg-loader.js",
    "firefox-oauth-bridge.js",
    "firefox-oauth-relay.js",
    "browser-polyfill.min.js",
    "chrome-version.txt",
    "refactor-plan",
    "scripts",
    "_metadata"
)

# HTML pages that load the minified module bundles and need the shim <script> injected
$ShimPages = @("sidepanel.html", "options.html", "pairing.html")

# ── 1. Current version ────────────────────────────────────────────────────────
$versionFile    = Join-Path $ProjectRoot "chrome-version.txt"
$currentVersion = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { "" }
Write-Host "Current version: $($currentVersion -or '(none)')"

# ── 2. Latest version from Web Store ─────────────────────────────────────────
Write-Host "Checking Chrome Web Store..."
$checkUrl = "https://clients2.google.com/service/update2/crx?response=updatecheck&x=id%3D$ExtensionId%26v%3D0.0%26uc"
try {
    $raw = (Invoke-WebRequest -Uri $checkUrl -UseBasicParsing).Content
} catch {
    Write-Error "Failed to reach Web Store: $_"; exit 1
}

$newVersion = if ($raw -match 'version="([0-9.]+)"') { $Matches[1] } else { $null }
if (-not $newVersion) {
    Write-Error "Could not parse version from update XML."; exit 1
}
Write-Host "Latest version:  $newVersion"

if ($currentVersion -eq $newVersion) {
    Write-Host "Already up to date." -ForegroundColor Green; exit 0
}

if ($CheckOnly) {
    Write-Host "Update available: $currentVersion → $newVersion" -ForegroundColor Yellow; exit 0
}

# ── 3. Download CRX ──────────────────────────────────────────────────────────
$crxPath     = Join-Path $env:TEMP "claude-ext-$newVersion.crx"
$zipPath     = Join-Path $env:TEMP "claude-ext-$newVersion.zip"
$extractPath = Join-Path $env:TEMP "claude-ext-$newVersion"

Write-Host "Downloading CRX..."
$crxUrl = "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0&x=id%3D$ExtensionId%26installsource%3Dondemand%26uc"
try {
    Invoke-WebRequest -Uri $crxUrl -OutFile $crxPath -UseBasicParsing -ErrorAction Stop
} catch {
    Write-Error "Download failed: $_"; exit 1
}

# ── 4. Strip CRX3 header — find PK\x03\x04 ZIP signature ────────────────────
Write-Host "Extracting..."
$crxBytes = [System.IO.File]::ReadAllBytes($crxPath)
$zipStart = -1
for ($i = 0; $i -lt $crxBytes.Length - 3; $i++) {
    if ($crxBytes[$i] -eq 0x50 -and $crxBytes[$i+1] -eq 0x4B -and
        $crxBytes[$i+2] -eq 0x03 -and $crxBytes[$i+3] -eq 0x04) {
        $zipStart = $i; break
    }
}
if ($zipStart -eq -1) { Write-Error "No ZIP data found in CRX."; exit 1 }

[System.IO.File]::WriteAllBytes($zipPath, $crxBytes[$zipStart..($crxBytes.Length - 1)])

# ── 5. Unzip ──────────────────────────────────────────────────────────────────
if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

# ── 6. Copy files, skip protected ────────────────────────────────────────────
Write-Host "Copying files..."
$copied = @()

Get-ChildItem $extractPath -Recurse -File | ForEach-Object {
    $rel     = $_.FullName.Substring($extractPath.Length + 1)
    $topLevel = $rel.Split([System.IO.Path]::DirectorySeparatorChar)[0]
    if ($Protected -contains $topLevel) { return }

    $dest    = Join-Path $ProjectRoot $rel
    $destDir = Split-Path $dest -Parent
    if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }

    Copy-Item $_.FullName -Destination $dest -Force
    $copied += $rel
}

# ── 6b. Re-patch HTML pages overwritten above ────────────────────────────────
#  (1) strip the CSP-blocked inline theme script (theme is handled by the shim)
#  (2) inject the shim <script> before the first module script
#  (3) sidepanel.html only: rename the bundle's `type="module"` to
#      `type="firefox-deferred-module"` so the shim controls when it loads
#      (it must wait until ?tabId=N is set; otherwise the bundle throws
#      "No active tab" on any user action).
foreach ($page in $ShimPages) {
    $pagePath = Join-Path $ProjectRoot $page
    if (-not (Test-Path $pagePath)) { continue }
    $html = Get-Content $pagePath -Raw
    $orig = $html

    # Remove inline theme block: <script> ... Set initial theme mode ... </script>
    $html = $html -replace '(?s)\s*<script>\s*// Set initial theme mode.*?</script>', ''

    # Inject shim tag if missing
    if ($html -notmatch 'firefox-page-shims\.js') {
        $html = $html -replace '(\s*)(<script type="module")', '$1<script src="/firefox-page-shims.js"></script>$1$2'
    }

    # sidepanel.html only: defer the bundle's module script so the shim can
    # inject ?tabId=N into the URL before the bundle reads it.
    if ($page -eq 'sidepanel.html') {
        $html = $html -replace '<script type="module"(\s+crossorigin\s+src="/assets/sidepanel-)', '<script type="firefox-deferred-module"$1'
    }

    if ($html -ne $orig) {
        Set-Content -Path $pagePath -Value $html -NoNewline
        Write-Host "  patched $page"
    }
}

# ── 7. Update version file ────────────────────────────────────────────────────
Set-Content -Path $versionFile -Value $newVersion -NoNewline

# ── 8. Cleanup ────────────────────────────────────────────────────────────────
Remove-Item $crxPath, $zipPath -Force -ErrorAction SilentlyContinue
Remove-Item $extractPath -Recurse -Force -ErrorAction SilentlyContinue

# ── 9. Summary ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Updated $currentVersion → $newVersion  ($($copied.Count) files)" -ForegroundColor Green
$copied | ForEach-Object { Write-Host "  $_" }
Write-Host ""
Write-Host "Tip: review changes with  git diff assets/"
