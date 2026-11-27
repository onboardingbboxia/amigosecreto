#!/usr/bin/env bash
# Instalador de Amigo Secreto para un VPS Ubuntu (22.04 / 24.04).
# Uso:   bash instalar.sh                      (instala o actualiza)
#        DOMAIN=midominio.com bash instalar.sh  (usar otro dominio)
#        bash instalar.sh --nuevo-codigo         (genera otro código de organizador)
set -euo pipefail

CONF=/etc/amigo-secreto.conf
[ -f "$CONF" ] && . "$CONF"
DOMAIN="${DOMAIN:-${SAVED_DOMAIN:-srv2209627.hstgr.cloud}}"
BASE_PATH="${BASE_PATH-${SAVED_BASE_PATH:-}}"   # ej. /amigosecreto (vacío = en la raíz del dominio)
MAIN_SITE="${MAIN_SITE-${SAVED_MAIN_SITE:-}}"   # opcional: sitio actual del dominio, para el resto de las rutas
APP_DIR=/opt/amigo-secreto
SERVICE=amigo-secreto
NEW_CODE=0; [ "${1:-}" = "--nuevo-codigo" ] && NEW_CODE=1

[ "$(id -u)" = 0 ] || { echo "Ejecuta este script como root."; exit 1; }
case "$DOMAIN" in *[!A-Za-z0-9.,\ -]*) echo "DOMAIN no es válido: $DOMAIN"; exit 1;; esac
if [ -n "$BASE_PATH" ]; then
  BASE_PATH="/${BASE_PATH#/}"; BASE_PATH="${BASE_PATH%/}"
  case "$BASE_PATH" in ""|*[!A-Za-z0-9/_-]*) echo "BASE_PATH no es válido: $BASE_PATH"; exit 1;; esac
fi
case "$MAIN_SITE" in ""|https://*|http://*) ;; *) echo "MAIN_SITE debe empezar con https://"; exit 1;; esac
case "$MAIN_SITE" in *[!A-Za-z0-9:/._-]*) echo "MAIN_SITE no es válido"; exit 1;; esac
MAIN_DOMAIN=$(printf '%s' "$DOMAIN" | cut -d, -f1 | tr -d ' ')
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
Environment=PORT=3000 HOST=127.0.0.1 DATA_DIR=$APP_DIR/data TZ=America/Lima NODE_NO_WARNINGS=1 BASE_PATH=$BASE_PATH
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
if [ -z "$BASE_PATH" ]; then
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
EOF
else
  if [ -n "$MAIN_SITE" ]; then
    FALLBACK="reverse_proxy $MAIN_SITE {
			header_up Host {upstream_hostport}
		}"
  else
    FALLBACK="redir * $BASE_PATH/ 302"
  fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	redir $BASE_PATH $BASE_PATH/ 308
	handle_path $BASE_PATH/* {
		reverse_proxy 127.0.0.1:3000 {
			flush_interval -1
		}
	}
	handle {
		$FALLBACK
	}
}
EOF
fi
( umask 077; cat > "$CONF" <<EOF
SAVED_DOMAIN="$DOMAIN"
SAVED_BASE_PATH="$BASE_PATH"
SAVED_MAIN_SITE="$MAIN_SITE"
EOF
)
systemctl enable --quiet caddy
systemctl restart caddy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

sleep 3
if curl -fsS -o /dev/null http://127.0.0.1:3000/api/roster; then OK="sí"; else OK="NO (revisa: journalctl -u $SERVICE -n 50)"; fi
IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
RES=$(getent hosts "$MAIN_DOMAIN" | awk '{print $1}' | head -n1 || true)

echo
echo "=============================================================="
echo "  Amigo Secreto instalado. Aplicación funcionando: $OK"
echo
echo "  Enlace para el grupo:  https://$MAIN_DOMAIN$BASE_PATH${BASE_PATH:+/}"
if [ -n "$CODE" ]; then
echo
echo "  Código de organizador:  $CODE"
echo "  (Lo pide una sola vez, cuando Ivan Tadeo crea su contraseña.)"
fi
if [ -n "$RES" ] && [ "$RES" != "$IP" ]; then
echo
echo "  AVISO: $MAIN_DOMAIN apunta a $RES, pero este servidor es $IP."
echo "  El certificado HTTPS no se podrá emitir hasta que el dominio apunte aquí."
fi
echo "=============================================================="
