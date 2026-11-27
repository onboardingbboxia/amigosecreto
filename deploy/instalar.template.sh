#!/usr/bin/env bash
# Instalador de Amigo Secreto para un VPS Ubuntu (22.04 / 24.04).
# Uso:   bash instalar.sh                      (instala o actualiza)
#        DOMAIN=midominio.com bash instalar.sh  (usar otro dominio)
#        bash instalar.sh --nuevo-codigo         (genera otro código de organizador)
set -euo pipefail

DOMAIN="${DOMAIN:-srv2209627.hstgr.cloud}"
APP_DIR=/opt/amigo-secreto
SERVICE=amigo-secreto
NEW_CODE=0; [ "${1:-}" = "--nuevo-codigo" ] && NEW_CODE=1

[ "$(id -u)" = 0 ] || { echo "Ejecuta este script como root."; exit 1; }
export DEBIAN_FRONTEND=noninteractive
say(){ printf '\n\033[1;31m==>\033[0m %s\n' "$*"; }

say "Instalando paquetes del sistema"
apt-get update -y -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

NODE_MAJOR=0; command -v node >/dev/null && NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  say "Instalando Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  say "Instalando Caddy (servidor web con HTTPS automático)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -qq && apt-get install -y -qq caddy >/dev/null
fi

for svc in apache2 nginx; do
  if systemctl is-active --quiet "$svc"; then say "Deteniendo $svc para liberar los puertos 80 y 443"; systemctl disable --now "$svc"; fi
done

say "Copiando la aplicación en $APP_DIR"
id amigo >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin amigo
mkdir -p "$APP_DIR/data"
base64 -d <<'__PAYLOAD__' | tar -xz -C "$APP_DIR"
__PAYLOAD_DATA__
__PAYLOAD__
chown -R amigo:amigo "$APP_DIR"
chmod 700 "$APP_DIR/data"

say "Configurando el servicio"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Amigo Secreto
After=network.target

[Service]
User=amigo
WorkingDirectory=$APP_DIR
Environment=PORT=3000 HOST=127.0.0.1 DATA_DIR=$APP_DIR/data TZ=America/Lima NODE_NO_WARNINGS=1
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

CODE=""
if [ ! -f "$APP_DIR/data/.codigo-creado" ] || [ "$NEW_CODE" = 1 ]; then
  CODE=$(sudo -u amigo env DATA_DIR="$APP_DIR/data" TZ=America/Lima NODE_NO_WARNINGS=1 node "$APP_DIR/server.js" --admin-code | tail -n1)
  touch "$APP_DIR/data/.codigo-creado"; chown amigo:amigo "$APP_DIR/data/.codigo-creado"
fi

systemctl daemon-reload
systemctl enable --quiet $SERVICE
systemctl restart $SERVICE

say "Configurando HTTPS para $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
EOF
systemctl enable --quiet caddy
systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

sleep 3
if curl -fsS -o /dev/null http://127.0.0.1:3000/api/roster; then OK="sí"; else OK="NO (revisa: journalctl -u $SERVICE -n 50)"; fi
IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
RES=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)

echo
echo "=============================================================="
echo "  Amigo Secreto instalado. Aplicación funcionando: $OK"
echo
echo "  Enlace para el grupo:  https://$DOMAIN"
if [ -n "$CODE" ]; then
echo
echo "  Código de organizador:  $CODE"
echo "  (Lo pide una sola vez, cuando Ivan Tadeo crea su contraseña.)"
fi
if [ -n "$RES" ] && [ "$RES" != "$IP" ]; then
echo
echo "  AVISO: $DOMAIN apunta a $RES, pero este servidor es $IP."
echo "  El certificado HTTPS no se podrá emitir hasta que el dominio apunte aquí."
fi
echo "=============================================================="
