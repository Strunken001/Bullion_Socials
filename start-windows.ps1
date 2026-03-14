<#
.SYNOPSIS
    Installs dependencies and starts the BullionSocial remote browser service natively on Windows natively using PM2.
#>

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " BullionSocial Windows Deployment Setup" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

# Check for Administrator privileges
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Please run this script as an Administrator."
    Pause
    Exit
}

# 1. Install Project Dependencies
Write-Host "Installing NPM Packages..." -ForegroundColor Green
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install NPM packages."
    Exit
}

# 2. Install Playwright Native Browsers for Windows
Write-Host "Installing Playwright Chromium (Native Windows Edition)..." -ForegroundColor Green
npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install Playwright Chromium."
    Exit
}

# 3. Install PM2 globally if not installed
if (!(Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "Installing PM2 globally..." -ForegroundColor Green
    npm install -g pm2 pm2-windows-startup
}

# 4. Setup PM2 to run on Windows Startup
Write-Host "Configuring PM2 to start on boot..." -ForegroundColor Green
pm2-startup install

# 5. Stop the existing instance (if running) and start a new one
Write-Host "Starting BullionSocial with PM2..." -ForegroundColor Green
pm2 stop bullion-social -s
pm2 start server.js --name "bullion-social" --env NODE_ENV=production

# 6. Save PM2 list so it restarts on boot
Write-Host "Saving PM2 process list..." -ForegroundColor Green
pm2 save

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " Deployment Complete!" -ForegroundColor Green
Write-Host " Your app is running natively on Windows."
Write-Host " Access it via: http://<your_server_ip>:3000"
Write-Host " To view live logs, run: pm2 logs bullion-social"
Write-Host "=============================================" -ForegroundColor Cyan
Pause
