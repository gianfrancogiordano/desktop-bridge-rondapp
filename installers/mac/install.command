#!/bin/bash

# RondApp PrintBridge macOS Installer

echo "=========================================="
echo "Instalando RondApp PrintBridge para macOS"
echo "=========================================="

APP_DIR="$HOME/.rondapp/bin"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_NAME="com.rondapp.bridge.plist"

mkdir -p "$APP_DIR"
mkdir -p "$HOME/.rondapp/log"

# Get current script path
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# Identify the executable
if [ -f "$DIR/rondapp-bridge-mac" ]; then
    cp "$DIR/rondapp-bridge-mac" "$APP_DIR/rondapp-bridge-mac"
elif [ -f "$DIR/../../dist/rondapp-bridge-mac" ]; then
    cp "$DIR/../../dist/rondapp-bridge-mac" "$APP_DIR/rondapp-bridge-mac"
else
    echo "Error: No se encontro el archivo rondapp-bridge-mac."
    exit 1
fi

# Apply permissions and signatures
echo "Configurando permisos..."
chmod +x "$APP_DIR/rondapp-bridge-mac"
xattr -d com.apple.quarantine "$APP_DIR/rondapp-bridge-mac" 2>/dev/null || true
codesign --force --sign - "$APP_DIR/rondapp-bridge-mac"

# Create plist
echo "Configurando servicio de inicio automatico..."
cat > "$PLIST_DIR/$PLIST_NAME" << EOL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.rondapp.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_DIR/rondapp-bridge-mac</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>$HOME/.rondapp/log/bridge-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.rondapp/log/bridge-stderr.log</string>
</dict>
</plist>
EOL

# Restart the service
echo "Reiniciando el servicio..."
launchctl bootout gui/$(id -u) "$PLIST_DIR/$PLIST_NAME" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST_DIR/$PLIST_NAME"

echo "=========================================="
echo "Instalación completada exitosamente!"
echo "RondApp PrintBridge está corriendo en segundo plano."
echo "Puedes cerrar esta ventana."
echo "=========================================="
