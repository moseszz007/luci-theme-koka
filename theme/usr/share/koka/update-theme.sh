#!/bin/sh
# Обновление темы Koka с GitHub Releases.
#
# Использование:
#   sh /usr/share/koka/update-theme.sh              — обновить сейчас (в консоли)
#   sh /usr/share/koka/update-theme.sh --background — запустить в фоне и сразу
#                                                     вернуть управление (так
#                                                     делает кнопка в LuCI,
#                                                     чтобы не упираться в
#                                                     таймаут XHR)
# Лог фонового запуска: /tmp/koka-update.log
# В конце лог содержит маркер "__KOKA_DONE__ 0" (успех) или "__KOKA_DONE__ 1".

REPO="moseszz007/luci-theme-koka"
PKG="luci-theme-koka"
API="https://api.github.com/repos/$REPO/releases/latest"
LATEST="https://github.com/$REPO/releases/latest"
LOG="/tmp/koka-update.log"
LOCK="/tmp/koka-update.lock"
DONE="__KOKA_DONE__"

fail() {
	echo "ОШИБКА: $1"
	echo "$DONE 1"
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

head_location() {   # редирект /releases/latest -> /releases/tag/vXXXX
	if command -v curl >/dev/null 2>&1; then
		curl -fsSI --connect-timeout 8 --max-time 20 -A "koka-update" "$LATEST" 2>/dev/null \
			| tr -d '\r' | sed -n 's#^[Ll]ocation: .*/tag/v\{0,1\}\([^/[:space:]]*\).*#\1#p' | head -n 1
		return 0
	fi
	if command -v wget >/dev/null 2>&1; then
		wget -q -S --spider -T 20 "$LATEST" 2>&1 \
			| tr -d '\r' | sed -n 's#^ *[Ll]ocation: .*/tag/v\{0,1\}\([^/[:space:]]*\).*#\1#p' | head -n 1
		return 0
	fi
	return 1
}

latest_version() {
	_v=$(fetch "$API" | tr ',' '\n' | grep '"tag_name"' | head -n 1 | cut -d '"' -f4)
	[ -z "$_v" ] && _v=$(head_location)
	printf '%s' "${_v#v}"
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

run_update() {
	trap 'rmdir "$LOCK" 2>/dev/null' EXIT

	if command -v apk >/dev/null 2>&1; then
		MGR="apk"; EXT="apk"
	elif command -v opkg >/dev/null 2>&1; then
		MGR="opkg"; EXT="ipk"
	else
		fail "не найден ни apk, ни opkg"
	fi

	echo "Пакетный менеджер: $MGR"

	echo "Смотрю последний релиз на GitHub…"
	VER=$(latest_version)
	[ -n "$VER" ] || fail "GitHub не ответил (ни API, ни редирект releases/latest)"
	echo "Последний релиз: $VER"

	if [ "$MGR" = "apk" ]; then
		CUR=$(apk list -I "$PKG" 2>/dev/null | head -n 1 | awk '{print $1}' | sed "s/^$PKG-//")
	else
		CUR=$(opkg list-installed "$PKG" 2>/dev/null | awk '{print $3}')
	fi
	echo "Установлено: ${CUR:-нет}"

	if [ -n "$CUR" ] && [ "$CUR" = "$VER" ]; then
		echo "Уже последняя версия — обновлять нечего."
		echo "$DONE 0"
		return 0
	fi

	if [ "$EXT" = "apk" ]; then
		URL="https://github.com/$REPO/releases/download/v$VER/$PKG-$VER.apk"
	else
		URL="https://github.com/$REPO/releases/download/v$VER/${PKG}_${VER}_all.ipk"
	fi

	echo "Скачиваю $PKG $VER…"
	download "$URL" "/tmp/$PKG.$EXT" || fail "не удалось скачать $URL"

	if [ "$EXT" = "apk" ]; then
		mkdir -p /etc/apk/keys
		if [ ! -s "/etc/apk/keys/$PKG.rsa.pub" ]; then
			echo "Ставлю ключ подписи…"
			download "https://github.com/$REPO/releases/download/v$VER/$PKG.rsa.pub" \
				"/etc/apk/keys/$PKG.rsa.pub" || echo "Ключ не скачался — ставлю с --allow-untrusted"
		fi
	fi

	echo "Устанавливаю…"
	if [ "$MGR" = "apk" ]; then
		apk add --allow-untrusted "/tmp/$PKG.$EXT" || fail "apk add завершился с ошибкой"
	else
		opkg install "/tmp/$PKG.$EXT" || fail "opkg install завершился с ошибкой"
	fi

	rm -f "/tmp/$PKG.$EXT" 2>/dev/null

	echo "Чищу кэши LuCI…"
	rm -f /tmp/luci-indexcache* 2>/dev/null
	rm -rf /tmp/luci-modulecache/ 2>/dev/null
	[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd reload >/dev/null 2>&1

	echo "Готово: $PKG $VER установлен. Обнови страницу (F5)."
	echo "$DONE 0"
	return 0
}

case "$1" in
	--background)
		: > "$LOG"
		# nohup есть не во всех сборках busybox — используем setsid, а если нет,
		# то обычный фоновый subshell с перенаправленным stdio
		if command -v setsid >/dev/null 2>&1; then
			setsid sh "$0" __run >>"$LOG" 2>&1 </dev/null &
		else
			( sh "$0" __run >>"$LOG" 2>&1 </dev/null & )
		fi
		echo "Обновление запущено в фоне."
		exit 0
		;;
	__run)
		if ! mkdir "$LOCK" 2>/dev/null; then
			echo "Уже идёт обновление — смотри лог."
			echo "$DONE 1"
			exit 1
		fi
		run_update
		;;
	*)
		if ! mkdir "$LOCK" 2>/dev/null; then
			echo "Уже идёт обновление."
			exit 1
		fi
		run_update
		;;
esac
