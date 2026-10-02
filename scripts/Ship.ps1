<#
.SYNOPSIS
    Commit, push, tag, and release Geneva Tennis.

.DESCRIPTION
    Pushing a v* tag is what fires the two release workflows: android-apk.yml
    (downloadable .apk) and ios-testflight.yml (TestFlight build). This script
    does the git part so you never have to remember it.

.EXAMPLE
    .\scripts\Ship.ps1
    Commits everything, pushes, and tags the next patch version.

.EXAMPLE
    .\scripts\Ship.ps1 -Version 1.2.0 -Message "New drill screen"

.NOTES
    Windows PowerShell 5.1 has no '&&' or '||' operators. They are PARSER errors,
    not style problems, so every command here is a separate statement whose exit
    code is checked with $LASTEXITCODE.
#>

[CmdletBinding()]
param(
    # Version to tag, with or without the leading 'v'. Omit to bump the patch number.
    [string] $Version,

    # Commit message for whatever is currently uncommitted.
    [string] $Message = "Ship"
)

$ErrorActionPreference = 'Stop'

# Run from the repo root no matter where the script was invoked from.
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Invoke-Step {
    param(
        [string] $What,
        [scriptblock] $Command
    )
    Write-Host ""
    Write-Host "==> $What" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "FAILED: $What (exit code $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}

function Write-PreflightSkipped {
    param([string] $Why)
    Write-Host "Preflight skipped: $Why." -ForegroundColor Yellow
    Write-Host "Carrying on anyway. If a secret really is missing, the workflow" -ForegroundColor Yellow
    Write-Host "will say so instead - see docs/SHIPPING.md." -ForegroundColor Yellow
}

# Asks GitHub which secrets this repo has. Only NAMES are readable, and only names
# are wanted - no secret value is ever printed or fetched. Returns $true to carry on.
function Test-ReleaseSecrets {
    # gh writes to stderr even when it succeeds, and under 'Stop' PowerShell 5.1
    # turns that into a terminating NativeCommandError. Exit codes are the real
    # signal here, so read those instead.
    $ErrorActionPreference = 'Continue'

    $appleNeeded = @('APPLE_TEAM_ID', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8')
    $androidNeeded = @('ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD')

    Write-Host ""
    Write-Host "==> Preflight: checking the repository secrets" -ForegroundColor Cyan

    # A missing or logged-out local CLI is not a reason to block a release.
    if ($null -eq (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-PreflightSkipped "the GitHub CLI ('gh') is not installed"
        return $true
    }

    $null = gh auth status 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-PreflightSkipped "'gh auth status' reports you are not logged in"
        return $true
    }

    # --json prints one name per line and makes gh validate the field name, so this
    # does not depend on the human-readable table layout, which differs between a
    # terminal and a captured pipe. An older gh without --json exits non-zero here
    # and the preflight skips, which is the right way to fail.
    $listed = gh secret list --json name -q '.[].name' 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-PreflightSkipped "'gh secret list' failed, so the secrets could not be read"
        return $true
    }
    $names = @($listed | ForEach-Object { ([string] $_).Trim() } | Where-Object { $_ })

    # ENV_FILE is the one that is not optional. .env is gitignored and Expo inlines
    # EXPO_PUBLIC_* into the bundle at build time, so without it BOTH jobs build an app
    # with no Firebase config -- it installs, opens, and dead-ends on "unconfigured".
    # Both workflows now refuse to continue without it, so a tag placed now would burn
    # a version number and produce nothing. There is no Android-only fallback to offer.
    if ($names -notcontains 'ENV_FILE') {
        Write-Host ""
        Write-Host "ENV_FILE is not set, and nothing can be released without it." -ForegroundColor Red
        Write-Host "      It is the whole of .env, which the builds cannot read from your" -ForegroundColor Red
        Write-Host "      machine. Set it and run this again:" -ForegroundColor Red
        Write-Host ""
        Write-Host "  gh secret set ENV_FILE --repo shaver3josiah/geneva-tennis-app < .env"
        Write-Host ""
        Write-Host "Stopped before tagging. No tag was created or pushed." -ForegroundColor Red
        return $false
    }
    Write-Host "ENV_FILE present, so the builds will carry the Firebase config." -ForegroundColor Green

    # Android keystore secrets are optional on purpose: android-apk.yml falls back
    # to a debug-signed APK, and getting an .apk onto a phone must never be blocked
    # on keystore setup.
    $androidMissing = @($androidNeeded | Where-Object { $names -notcontains $_ })
    if ($names -notcontains 'ANDROID_KEYSTORE_BASE64') {
        Write-Host "Note: no Android keystore secrets, so the APK will be debug-signed." -ForegroundColor Yellow
        Write-Host "      It still installs on any phone. Only Play Store uploads need" -ForegroundColor Yellow
        Write-Host "      a real keystore." -ForegroundColor Yellow
    } elseif ($androidMissing.Count -gt 0) {
        # android-apk.yml branches on ANDROID_KEYSTORE_BASE64 alone. With that set and
        # any of the other three missing it takes the signing path anyway and dies at
        # apksigner, so a half-set of secrets is worse than none at all.
        Write-Host "Android keystore secrets are INCOMPLETE: missing $($androidMissing -join ', ')." -ForegroundColor Red
        Write-Host "      android-apk.yml signs whenever ANDROID_KEYSTORE_BASE64 is set, so" -ForegroundColor Red
        Write-Host "      the Android job will fail at apksigner. Set the rest, or remove" -ForegroundColor Red
        Write-Host "      ANDROID_KEYSTORE_BASE64 to get a debug-signed APK instead." -ForegroundColor Red
        Write-Host "      See docs/SHIPPING.md." -ForegroundColor Red
    } else {
        Write-Host "Android keystore secrets present, the APK will be release-signed." -ForegroundColor Green
    }

    $appleMissing = @($appleNeeded | Where-Object { $names -notcontains $_ })
    if ($appleMissing.Count -eq 0) {
        Write-Host "All four Apple secrets present, the TestFlight upload will run." -ForegroundColor Green
        return $true
    }

    Write-Host ""
    Write-Host "Missing Apple secrets: $($appleMissing -join ', ')" -ForegroundColor Red
    Write-Host "If you tag now:" -ForegroundColor Yellow
    Write-Host "  - the iOS job stops at its own preflight, so there is no TestFlight build"
    Write-Host "  - the Android job still runs and still attaches an installable .apk"
    Write-Host "Setting the Apple secrets up is documented in docs/SHIPPING.md." -ForegroundColor Yellow
    Write-Host ""

    # Android-only is a legitimate release, so offer it rather than hard-blocking.
    $answer = Read-Host "Tag anyway and ship the Android APK only? [y/N]"
    if ($answer -match '^(y|yes)$') {
        return $true
    }

    Write-Host ""
    Write-Host "Stopped before tagging. No tag was created or pushed." -ForegroundColor Red
    return $false
}

# Nothing below works without a remote, and the failure messages if one is missing
# are confusing, so say it plainly up front.
$remotes = git remote
if ([string]::IsNullOrWhiteSpace($remotes)) {
    Write-Host "No git remote is configured." -ForegroundColor Red
    Write-Host "Create the GitHub repo, then run:" -ForegroundColor Yellow
    Write-Host "    git remote add origin https://github.com/<you>/geneva-tennis-app.git"
    exit 1
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()

Invoke-Step "Staging all changes" { git add -A }

# 'git commit' exits non-zero when there is nothing staged. That is a normal state
# (for example re-tagging an unchanged tree), not a failure, so check first.
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    Invoke-Step "Committing" { git commit -m $Message }
} else {
    Write-Host ""
    Write-Host "==> Nothing to commit, tree is clean" -ForegroundColor Yellow
}

Invoke-Step "Pushing branch '$branch'" { git push origin $branch }

# Work out the tag. Tags on the remote count too, so fetch them first.
Invoke-Step "Fetching existing tags" { git fetch --tags --quiet }

if ([string]::IsNullOrWhiteSpace($Version)) {
    $latest = git tag --list 'v*' --sort=-v:refname | Select-Object -First 1
    if ($latest -match '^v(\d+)\.(\d+)\.(\d+)$') {
        $Version = "v{0}.{1}.{2}" -f $Matches[1], $Matches[2], ([int]$Matches[3] + 1)
    } else {
        $Version = 'v1.0.0'
    }
    Write-Host ""
    Write-Host "==> No -Version given, using $Version" -ForegroundColor Yellow
}

if ($Version -notmatch '^v') {
    $Version = "v$Version"
}

# Re-pushing an existing tag does not re-trigger the workflows and just looks like a
# silent no-op, so refuse early and say which tag is in the way.
$existing = git tag --list $Version
if (-not [string]::IsNullOrWhiteSpace($existing)) {
    Write-Host ""
    Write-Host "Tag $Version already exists. Pick a different -Version." -ForegroundColor Red
    exit 1
}

# Last chance to bail: check the secrets before the tag exists, because after the
# push the only way out is deleting a tag from a running workflow.
if (-not (Test-ReleaseSecrets)) {
    exit 1
}

# GitHub starts no workflow for a push whose commit message carries a skip marker, even
# one merely quoted in prose, and a tag push counts: the tag would exist, the version
# would be spent, and nothing would build. The release panel refuses the same thing.
$headMessage = (git log -1 --format=%B HEAD) -join "`n"
if ($headMessage -match '\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true') {
    Write-Host ""
    Write-Host "HEAD's commit message carries a skip marker, so a tag on it would build nothing." -ForegroundColor Red
    Write-Host "Push any commit without one first, then ship." -ForegroundColor Red
    exit 1
}

Invoke-Step "Tagging $Version" { git tag $Version }
Invoke-Step "Pushing tag $Version" { git push origin $Version }

$url = (git remote get-url origin).Trim() -replace '\.git$', ''

Write-Host ""
Write-Host "Shipped $Version." -ForegroundColor Green
Write-Host "Both release builds are now running. Watch them here:" -ForegroundColor Green
Write-Host "    $url/actions"
Write-Host ""
Write-Host "When they finish:"
Write-Host "  Android .apk  ->  $url/releases/tag/$Version"
Write-Host "  iOS build     ->  App Store Connect > TestFlight (takes ~10 min to appear)"
