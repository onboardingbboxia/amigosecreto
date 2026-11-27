# Amigo Secreto

Plataforma para un intercambio de regalos: cuentas con nombre de la lista y contraseña, sorteo de amigo secreto con exclusiones, listas de deseos privadas, chat grupal, mensajes privados y anónimos, trivia navideña, reto diario, retos del organizador y ranking por puntos.

Sin dependencias externas: Node.js 22+ con `node:sqlite`.

## Instalar en un VPS Ubuntu (como root)

```bash
curl -fsSL https://raw.githubusercontent.com/onboardingbboxia/amigosecreto/main/dist/instalar.sh | bash
```

Por defecto publica el sitio en `https://srv2209627.hstgr.cloud`. Para otro dominio:

```bash
curl -fsSL https://raw.githubusercontent.com/onboardingbboxia/amigosecreto/main/dist/instalar.sh | DOMAIN=midominio.com bash
```

El mismo comando sirve para actualizar; los datos se conservan en `/opt/amigo-secreto/data`.

## Comandos útiles en el servidor

```bash
systemctl status amigo-secreto        # estado
journalctl -u amigo-secreto -n 50     # registros
curl -fsSL .../dist/instalar.sh | bash -s -- --nuevo-codigo   # nuevo código de organizador
```

## Desarrollo local

```bash
node server.js          # http://127.0.0.1:3000
node server.js --admin-code
```

Tras cambiar el código, regenera el instalador con `bash deploy/build.sh`.
