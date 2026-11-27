# Koka Modern for LuCI

Тёмная, аккуратная и **самостоятельная** тема для LuCI: движок темы входит в сам
пакет, `luci-theme-footstrap` больше не нужен.

Внутри — тёмная палитра navy/indigo, дашборд в духе Keenetic OS, единый набор
иконок, иконки интерфейсов по протоколу, стеклянные панели и живой фон.

![Дашборд Koka](docs/dashboard.jpg)

## Что внутри

- **Движок темы** — форк оформления footstrap, переименованный в Koka: свои
  шаблоны `themes/koka`, свой CSS `/luci-static/koka/cascade.css`, свои настройки
  в `/etc/config/koka`. Конфликтов с другими темами нет.
- **Дашборд** в духе Keenetic OS: роутер, WAN, клиенты, CPU/ОЗУ/температура,
  порты, быстрые действия, живой график трафика. Отдельный пункт
  **Статус → Дашборд**; штатный «Обзор» не трогается.
- **Карточка «Сервисы»** — состояние DNS Proxy, dnsmasq, Zapret, Steer,
  ZeroTier, SSH и LuCI с PID и быстрым переходом на нужную страницу.
- **Карточка «Ресурсы»** — кольцевые индикаторы CPU/температуры/памяти/флеша,
  5-минутный график, разбивка памяти по сервисам и список процессов.
- **Стекло и живой фон** во всех разделах LuCI; эффект стекла отключается
  в настройках дашборда.
- **Настройка дашборда** кнопкой «Настроить»: плашки скрываются, возвращаются
  и меняются местами, раскладка хранится в браузере.
- **Единые иконки**: меню, кнопки действий, интерфейсы, порты, Wi-Fi-сигнал.
- **Иконки интерфейсов по протоколу**: AmneziaWG/WireGuard, bridge, PPPoE,
  ZeroTier/туннели больше не выглядят одинаковым серым разъёмом.
- **Кэш-бастинг** CSS, JS и иконок, чтобы обновление подхватывалось сразу.
- **Русский интерфейс «из коробки»**: строки темы встроены в JS, отдельный
  пакет локализации (`luci-i18n-koka-ru`) не нужен.

## Требования

- OpenWrt 24.10+ (проверено на 24.10.5, aarch64).
- LuCI 25.x.
- Больше ничего: footstrap не требуется.

## Установка из пакета

В [Releases](https://github.com/moseszz007/luci-theme-koka/releases) лежат
`luci-theme-koka_<версия>_all.ipk` (opkg) и `luci-theme-koka-<версия>.apk` (apk).
Пакет ставит тему, иконки и дашборд и сразу включает Koka в LuCI.

```sh
opkg install luci-theme-koka_2026.11.27-r20_all.ipk
# или для apk:
cp luci-theme-koka.rsa.pub /etc/apk/keys/
apk add --allow-untrusted luci-theme-koka-2026.11.27-r20.apk
```

Или одной командой установщиком:
[Start_setup_OpenWrt](https://github.com/moseszz007/Start_setup_OpenWrt) —
пункт «Тема Koka».

## Установка без пакета

```sh
scp -r luci-theme-koka root@192.168.1.1:/root/
ssh root@192.168.1.1
sh /root/luci-theme-koka/install-koka-theme.sh
```

Затем перезагрузи страницу в браузере (`F5`).

Скрипт делает резервные копии иконок и `interfaces.js` с суффиксом `.bak-koka`,
поэтому откат возвращает сток.

## Откат

```sh
sh /usr/share/koka/rollback-koka-skin.sh          # вернуть стоковые иконки и тему
sh /root/luci-theme-koka/uninstall-koka-theme.sh  # удалить файлы ручной установки
```

Удаление пакета делает то же самое автоматически.

## Что именно меняется

| Файл | Назначение |
|---|---|
| `/www/luci-static/koka/cascade.css` | движок темы + скин Koka |
| `/www/luci-static/koka/koka-icon-bust.js` | версионирует URL иконок |
| `/usr/share/ucode/luci/template/themes/koka/` | шаблоны темы (header/footer/sysauth/head) |
| `/www/luci-static/resources/koka-fs-*.js` | JS темы (навигация, настройки, поиск) |
| `/www/luci-static/resources/menu-koka*.js` | построение меню |
| `/www/luci-static/resources/view/koka/appearance.js` | страница настроек Koka |
| `/www/luci-static/resources/view/status/koka-dashboard.js` | страница «Статус → Дашборд» |
| `/usr/share/luci/menu.d/luci-theme-koka.json` | пункт «Система → Koka» |
| `/etc/config/koka` | настройки темы |
| `/www/luci-static/resources/icons/*.svg` | набор иконок (со стоковыми `.bak-koka`) |
| `/www/luci-static/resources/view/network/interfaces.js` | иконка по протоколу интерфейса |

## Разработка

```sh
py -3 make-koka-icons.py        # пересобрать icons/*.svg
py -3 make-koka-interfaces.py   # пересобрать koka-interfaces.js из стокового LuCI
py -3 packages/build-packages.py --version 2026.11.27-r20
```

Структура исходников темы:

- `theme/` — файлы, которые ставятся на роутер как есть;
- `engine/cascade.base.css` — CSS движка без скина;
- `koka-skin.css` — сам скин, при сборке дописывается к движку;
- `icons/` — набор иконок;
- `packages/build-packages.py` — сборка `.ipk` и подписанного `.apk`.

`koka-interfaces.js` — это стоковый `view/network/interfaces.js` с патчем
`render_iface()`: иконка выбирается по `getProtocol()`. При обновлении LuCI
файл нужно пересобрать из новой стоковой версии.

## Связанные проекты

- [luci-app-dnsproxy](https://github.com/moseszz007/luci-app-dnsproxy) — UI для dnsproxy
  с редактируемыми upstream-списками и профилями.

## Благодарности

- [luci-theme-footstrap](https://github.com/VizzleTF/luci-theme-footstrap) — движок,
  от которого Koka ведёт свою родословную (Apache-2.0).
- [LuCI](https://github.com/openwrt/luci) — интерфейс OpenWrt.
- Иконки вдохновлены [Lucide](https://lucide.dev/).

## Лицензия

Apache-2.0. См. [LICENSE](LICENSE).
