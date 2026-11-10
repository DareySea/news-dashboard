#!/usr/bin/env bash
# Установка дашборда на сервер Ubuntu 22.04/24.04 (запускать от root):
#   bash setup.sh <домен> [адрес репозитория]
# Ставит Node.js, Chromium (для MAX и праздников РБК), Caddy (HTTPS от Let's Encrypt) и автозапуск через systemd.
# Пароль дашборда генерируется сам и лежит в /etc/dashboard.env; посмотреть: sudo cat /etc/dashboard.env
set -euo pipefail

DOMAIN="${1:?Укажите домен сервера, например: bash setup.sh news.example.ru}"
REPO="${2:-https://github.com/DareySea/news-dashboard.git}"
APP=/opt/dashboard/app

echo "== Часовой пояс: Москва (отчёты и календарь считаются по нему)"
timedatectl set-timezone Europe/Moscow

echo "== Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "== Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if ! command -v caddy >/dev/null; then
  echo "== Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

echo "== Пользователь и код"
id dashboard >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/dashboard --shell /usr/sbin/nologin dashboard
if [ -d "$APP/.git" ]; then sudo -u dashboard git -C "$APP" pull --ff-only; else sudo -u dashboard git clone "$REPO" "$APP"; fi
cd "$APP"
sudo -u dashboard npm ci --omit=dev
echo "== Chromium"
npx --yes playwright-core install-deps chromium
sudo -u dashboard npx --yes playwright-core install chromium

if [ ! -f /etc/dashboard.env ]; then
  echo "== Пароль дашборда (случайный, 20 символов)"
  umask 077
  echo "DASH_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)" > /etc/dashboard.env
  chown root:dashboard /etc/dashboard.env && chmod 640 /etc/dashboard.env
fi

echo "== Автозапуск"
cp deploy/dashboard.service /etc/systemd/system/dashboard.service
systemctl daemon-reload
systemctl enable --now dashboard
systemctl restart dashboard

echo "== HTTPS для $DOMAIN"
sed "s/__DOMAIN__/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo
echo "Готово: https://$DOMAIN"
echo "Пароль: sudo cat /etc/dashboard.env   (логин — любой)"
