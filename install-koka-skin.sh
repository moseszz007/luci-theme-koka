#!/bin/sh
# Apply the standalone Koka theme: icon set, interface icons, LuCI activation.
# Runs from the package postinst and from a manual install.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

# 1. Clean up the old "skin over footstrap" install (r19 and older).
CSS=/www/luci-static/footstrap/cascade.css
HEAD=/usr/share/ucode/luci/template/themes/footstrap/partials/head.ut
if [ -f "$CSS.bak-koka" ]; then
	cp "$CSS.bak-koka" "$CSS"
	rm -f "$CSS.bak-koka"
fi
if [ -f "$HEAD.bak-koka" ]; then
	cp "$HEAD.bak-koka" "$HEAD"
	rm -f "$HEAD.bak-koka"
fi
rm -f /www/luci-static/footstrap/koka-icon-bust.js
rm -f /www/luci-static/resources/view/status/koka_[0-9]*.js

# 2. Вернуть стоковые иконки LuCI, если старые версии темы их перезаписали.
#    Свои иконки тема больше не копирует в luci-base: они лежат в
#    /luci-static/koka/icons/ и подставляются на лету (koka-icon-bust.js),
#    поэтому обновление luci-base их не затирает.
ICONS=/www/luci-static/resources/icons
for bak in "$ICONS"/*.bak-koka; do
	[ -e "$bak" ] || continue
	cp "$bak" "${bak%.bak-koka}"
	rm -f "$bak"
done

# 3. Снять старый патч списка интерфейсов, если он остался от прошлых версий.
IFACE_JS=/www/luci-static/resources/view/network/interfaces.js
if [ -f "$IFACE_JS.bak-koka" ]; then
	cp "$IFACE_JS.bak-koka" "$IFACE_JS"
	rm -f "$IFACE_JS.bak-koka"
fi

# 4. Runtime directory for the appearance page uploads.
mkdir -p /etc/koka

# 5. Register the theme and make it active.
uci set luci.themes.Koka='/luci-static/koka'
uci set luci.main.mediaurlbase='/luci-static/koka'
uci commit luci

# 6. Drop LuCI caches so new templates and CSS are picked up.
rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache

echo 'Koka theme applied. Hard-refresh the browser (Ctrl+F5).'
