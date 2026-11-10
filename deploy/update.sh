#!/usr/bin/env bash
# Обновление дашборда на сервере до последней версии с GitHub (запускать от root): bash /opt/dashboard/app/deploy/update.sh
set -euo pipefail
cd /opt/dashboard/app
sudo -u dashboard git pull --ff-only
sudo -u dashboard npm ci --omit=dev
systemctl restart dashboard
echo "Обновлено: $(sudo -u dashboard git log -1 --format='%h %s')"
