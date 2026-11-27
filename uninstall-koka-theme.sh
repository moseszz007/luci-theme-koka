#!/bin/sh
# Remove a manually installed Koka theme and restore stock LuCI.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f /usr/share/koka/rollback-koka-skin.sh ]; then
	sh /usr/share/koka/rollback-koka-skin.sh || true
fi

rm -rf /www/luci-static/koka
rm -rf /usr/share/ucode/luci/template/themes/koka
rm -rf /www/luci-static/resources/view/koka
rm -f /www/luci-static/resources/koka-fs-*.js
rm -f /www/luci-static/resources/menu-koka.js /www/luci-static/resources/menu-koka-common.js
rm -f /www/luci-static/resources/view/status/koka-dashboard.js
rm -f /www/cgi-bin/luci-theme-koka-pattern
rm -f /usr/share/luci/menu.d/luci-theme-koka.json
rm -f /usr/share/luci/menu.d/luci-app-koka-dashboard.json
rm -f /usr/share/rpcd/acl.d/luci-theme-koka.json
rm -f /lib/upgrade/keep.d/luci-theme-koka
rm -f /etc/uci-defaults/30_luci-theme-koka
rm -rf /usr/share/koka

rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache

echo 'Koka theme files removed. Settings in /etc/config/koka are kept.'
