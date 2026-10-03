$ErrorActionPreference = "Stop"

Write-Host "=========================================="
Write-Host " Instalando RondApp PrintBridge (Windows) "
Write-Host "=========================================="

# Check for Administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Por favor, ejecute este script como Administrador (Click derecho -> Ejecutar con PowerShell)."
    Read-Host "Presione Enter para salir"
    exit
}

$installDir = "$env:APPDATA\RondApp\bin"
$exeName = "rondapp-bridge-win.exe"
$serviceName = "RondAppBridge"
$exePath = "$installDir\$exeName"

# Create directory if not exists
if (-not (Test-Path -Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

# Locate the executable to copy
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$sourceExe = ""

if (Test-Path "$scriptDir\$exeName") {
    $sourceExe = "$scriptDir\$exeName"
} elseif (Test-Path "$scriptDir\..\..\dist\$exeName") {
    $sourceExe = "$scriptDir\..\..\dist\$exeName"
} else {
    Write-Error "No se encontro el archivo $exeName. Asegurese de que este en la misma carpeta que este script."
    Read-Host "Presione Enter para salir"
    exit
}

# Stop service if it already exists
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    Write-Host "Deteniendo servicio existente..."
    Stop-Service -Name $serviceName -Force
    Start-Sleep -Seconds 2
}

# Copy executable
Write-Host "Copiando archivos..."
Copy-Item -Path $sourceExe -Destination $exePath -Force

# Create or Update Service
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    Write-Host "El servicio ya existe. Actualizando..."
    # The executable was overwritten, so starting it uses the new one
} else {
    Write-Host "Creando servicio de Windows..."
    New-Service -Name $serviceName `
                -BinaryPathName $exePath `
                -DisplayName "RondApp PrintBridge" `
                -Description "Servidor local para imprimir tickets y comandas en RondApp" `
                -StartupType Automatic
}

# Start Service
Write-Host "Iniciando servicio..."
Start-Service -Name $serviceName

Write-Host "=========================================="
Write-Host " Instalacion completada exitosamente!"
Write-Host " RondApp PrintBridge esta corriendo en segundo plano."
Write-Host "=========================================="
Read-Host "Presione Enter para cerrar"
