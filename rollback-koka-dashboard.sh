#!/bin/sh
# Remove the separate Dashboard page and restore the stock Overview template.
set -e

VIEWDIR=/www/luci-static/resources/view/status
MENU=/usr/share/luci/menu.d/luci-app-koka-dashboard.json
TEMPLATE=/usr/share/ucode/luci/template/admin_status/index.ut

rm -f "$MENU"
rm -f "$VIEWDIR"/koka*.js

[ -f "$TEMPLATE.bak-koka-dashboard" ] && cp "$TEMPLATE.bak-koka-dashboard" "$TEMPLATE"

rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache

echo 'Koka dashboard removed; Overview is stock.'
