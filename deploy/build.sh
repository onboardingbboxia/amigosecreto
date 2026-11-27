#!/usr/bin/env bash
# Genera dist/instalar.sh: un único archivo con la aplicación incluida.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
PAYLOAD=$(tar -cz server.js content.js seed.json public/index.html | base64 -w 76)
python3 - "$PAYLOAD" <<'EOF'
import sys
t = open('deploy/instalar.template.sh').read()
open('dist/instalar.sh', 'w').write(t.replace('__PAYLOAD_DATA__', sys.argv[1]))
EOF
chmod +x dist/instalar.sh
echo "dist/instalar.sh ($(wc -c < dist/instalar.sh) bytes)"
