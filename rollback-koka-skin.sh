#!/bin/sh
# Remove the Koka theme from LuCI and restore the stock look.
set -e

IFACE_JS=/www/luci-static/resources/view/network/interfaces.js
if [ -f "$IFACE_JS.bak-koka" ]; then
	cp "$IFACE_JS.bak-koka" "$IFACE_JS"
	rm -f "$IFACE_JS.bak-koka"
fi

# Restore the stock interface icons.
for icon in /www/luci-static/resources/icons/*.bak-koka; do
	[ -e "$icon" ] || continue
	cp "$icon" "${icon%.bak-koka}"
	rm -f "$icon"
done
# Remove an icon the theme added that stock LuCI did not ship.
[ -f /www/luci-static/resources/icons/amneziawg_disabled.svg.bak-koka ] || \
	rm -f /www/luci-static/resources/icons/amneziawg_disabled.svg

if [ "$(uci -q get luci.main.mediaurlbase)" = "/luci-static/koka" ]; then
	uci set luci.main.mediaurlbase='/luci-static/bootstrap'
fi
uci -q delete luci.themes.Koka
uci commit luci

rm -f /tmp/luci-indexcache.*
rm -rf /tmp/luci-modulecache

echo 'Koka theme removed. Stock LuCI restored.'
