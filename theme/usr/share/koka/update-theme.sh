#!/bin/sh
# Обновление темы Koka с GitHub Releases.
# Запускается из LuCI: Система -> Koka -> Обновление,
# или вручную: sh /usr/share/koka/update-theme.sh

REPO="moseszz007/luci-theme-koka"
PKG="luci-theme-koka"
API="https://api.github.com/repos/$REPO/releases/latest"

fail() {
	echo "$1"
	exit 1
}

fetch() {   # <url> -> stdout
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --connect-timeout 8 --max-time 30 -A "koka-update" "$1" && return 0
		return 1
	fi
	if command -v wget >/dev/null 2>&1; then
		wget -q -T 30 -O - "$1" && return 0
		return 1
	fi
	if command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -q -T 30 -O - "$1" && return 0
		return 1
	fi
	return 1
}

download() {   # <url> <file>
	rm -f "$2"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --connect-timeout 10 --max-time 120 -A "koka-update" -o "$2" "$1" \
			&& [ -s "$2" ] && return 0
	fi
	if command -v wget >/dev/null 2>&1; then
		wget -q -T 120 -O "$2" "$1" && [ -s "$2" ] && return 0
	fi
	if command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -q -T 120 -O "$2" "$1" && [ -s "$2" ] && return 0
	fi
	return 1
}

# 1. пакетный менеджер
if command -v apk >/dev/null 2>&1; then
	MGR="apk"; EXT="apk"
elif command -v opkg >/dev/null 2>&1; then
	MGR="opkg"; EXT="ipk"
else
	fail "Не найден ни apk, ни opkg"
fi

echo "Пакетный менеджер: $MGR"

# 2. последний релиз
TAG=$(fetch "$API" | tr ',' '\n' | grep '"tag_name"' | head -n 1 | cut -d '"' -f4)
[ -n "$TAG" ] || fail "Не удалось узнать последнюю версию (GitHub API недоступен)"
VER=${TAG#v}
echo "Последний релиз: $VER"

# 3. что установлено сейчас
if [ "$MGR" = "apk" ]; then
	CUR=$(apk list -I "$PKG" 2>/dev/null | head -n 1 | awk '{print $1}' | sed "s/^$PKG-//")
else
	CUR=$(opkg list-installed "$PKG" 2>/dev/null | awk '{print $3}')
fi

echo "Установлено: ${CUR:-нет}"

if [ -n "$CUR" ] && [ "$CUR" = "$VER" ]; then
	echo "Уже последняя версия — обновлять нечего."
	exit 0
fi

# 4. ссылка на файл релиза
if [ "$EXT" = "apk" ]; then
	URL="https://github.com/$REPO/releases/download/v$VER/$PKG-$VER.apk"
else
	URL="https://github.com/$REPO/releases/download/v$VER/${PKG}_${VER}_all.ipk"
fi

echo "Скачиваю $PKG $VER…"
download "$URL" "/tmp/$PKG.$EXT" || fail "Не удалось скачать $URL"

# 5. ключ подписи для apk
if [ "$EXT" = "apk" ]; then
	mkdir -p /etc/apk/keys
	if [ ! -s "/etc/apk/keys/$PKG.rsa.pub" ]; then
		echo "Ставлю ключ подписи…"
		download "https://github.com/$REPO/releases/download/v$VER/$PKG.rsa.pub" \
			"/etc/apk/keys/$PKG.rsa.pub" || echo "Ключ не скачался — ставлю с --allow-untrusted"
	fi
fi

# 6. установка
echo "Устанавливаю…"
if [ "$MGR" = "apk" ]; then
	apk add --allow-untrusted "/tmp/$PKG.$EXT" || fail "apk add завершился с ошибкой"
else
	opkg install "/tmp/$PKG.$EXT" || fail "opkg install завершился с ошибкой"
fi

rm -f "/tmp/$PKG.$EXT" 2>/dev/null

# 7. сброс кэшей LuCI
rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache/ 2>/dev/null
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload >/dev/null 2>&1

echo "Готово: $PKG $VER установлен. Обнови страницу (F5)."
exit 0
