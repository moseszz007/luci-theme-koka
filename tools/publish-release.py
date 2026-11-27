import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

TOKEN = os.environ['GH_TOKEN']
REPO = 'moseszz007/luci-theme-koka'
API = 'https://api.github.com/repos/' + REPO
HEADERS = {
    'Authorization': 'token ' + TOKEN,
    'User-Agent': 'koka-build',
    'Accept': 'application/vnd.github+json',
}

BODY = """Koka Modern for LuCI - тёмный скин поверх luci-theme-footstrap.

- Keenetic-подобный дашборд: Статус -> Дашборд (Обзор не тронут)
- Карточка **Ресурсы**: кольцевые индикаторы CPU/температуры/памяти/флеша,
  5-минутный график, память по сервисам и список процессов с сортировкой
  по памяти/CPU. Данные из `/proc`, без внешних сервисов
- **Настройка дашборда**: скрыть/вернуть/переместить плашки, раскладка
  запоминается в браузере
- В Система -> Дизайн тема называется **Koka** (движок остаётся footstrap)
- Единый линейный набор иконок: меню, интерфейсы, порты, Wi-Fi
- Иконки интерфейсов по протоколу: AmneziaWG, WireGuard, PPPoE, bridge, ZeroTier
- Кэш-бастинг иконок и JS после обновления

## Установка (opkg)

    opkg install luci-theme-koka_2026.11.27-r5_all.ipk

## Установка (apk)

    cp luci-theme-koka.rsa.pub /etc/apk/keys/
    apk add --allow-untrusted luci-theme-koka-2026.11.27-r5.apk

После установки пакет сам применяет скин и дашборд. Удаление пакета
возвращает стоковый вид.

Исходники, скрипты установки и отката - в репозитории.
"""


def main():
    payload = {
        'tag_name': 'v2026.11.27-r5',
        'target_commitish': 'main',
        'name': 'Koka Modern 2026.11.27-r5',
        'body': BODY,
        'draft': False,
        'prerelease': False,
    }

    req = urllib.request.Request(
        API + '/releases',
        data=json.dumps(payload).encode(),
        method='POST',
        headers={**HEADERS, 'Content-Type': 'application/json'},
    )
    rel = json.load(urllib.request.urlopen(req))
    print('release', rel['tag_name'], rel['html_url'])
    rid = rel['id']

    for path in (
        'dist/luci-theme-koka_2026.11.27-r5_all.ipk',
        'dist/luci-theme-koka-2026.11.27-r5.apk',
        'dist/luci-theme-koka.rsa.pub',
    ):
        data = Path(path).read_bytes()
        name = Path(path).name
        url = 'https://uploads.github.com/repos/%s/releases/%d/assets?name=%s' % (
            REPO, rid, urllib.parse.quote(name)
        )
        req = urllib.request.Request(
            url,
            data=data,
            method='POST',
            headers={**HEADERS, 'Content-Type': 'application/octet-stream'},
        )
        asset = json.load(urllib.request.urlopen(req))
        print('asset', asset['name'], asset['size'], asset['browser_download_url'])


if __name__ == '__main__':
    main()
