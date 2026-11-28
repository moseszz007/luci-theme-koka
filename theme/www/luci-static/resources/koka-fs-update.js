'use strict';
'require baseclass';
'require fs';
'require ui';
'require koka-fs-version as ver';

/* Кнопка «Обновить с GitHub» на странице настроек темы.
 *
 * Обновление запускается как one-shot сервис procd (/etc/init.d/koka-update):
 * rpcd file exec ждёт завершения ВСЕХ потомков команды, поэтому обычный
 * запуск в фоне всё равно упирался в «XHR request timed out». procd же
 * забирает процесс себе и отвечает сразу.
 * Прогресс пишется в /tmp/koka-update.log, панель его читает и показывает. */

const INIT = '/etc/init.d/koka-update';
const LOG = '/tmp/koka-update.log';
const DONE = '__KOKA_DONE__';
const POLL_MS = 900;
const MAX_MS = 4 * 60 * 1000;

function notify(msg, type) {
	ui.addNotification(null, E('p', {}, msg), type || 'info');
}

return baseclass.extend({
	section: function () {
		var out = E('pre', { class: 'fs-ap-out', hidden: '' });
		var reload = E('button', { class: 'btn', type: 'button', hidden: '' }, 'Перезагрузить страницу');
		var btn = E('button', { class: 'btn cbi-button-action', type: 'button' }, 'Обновить с GitHub');

		var timer = null;
		var started = 0;

		function log(text) {
			out.hidden = false;
			out.textContent = String(text || '');
		}

		function stop() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}

			btn.disabled = false;
			btn.textContent = 'Обновить с GitHub';
		}

		function finish(text, ok) {
			stop();

			if (!ok) {
				notify('Обновление не удалось — смотри лог ниже.', 'error');
				return;
			}

			var upToDate = /Уже последняя/.test(text);

			notify(upToDate
				? 'Установлена последняя версия темы.'
				: 'Тема обновлена — перезагрузи страницу.', 'info');

			reload.hidden = upToDate;
		}

		function readLog() {
			/* rpcd перезапускается в конце обновления: запрос может не
			 * ответить и не упасть. Не ждём его вечно — пробуем снова. */
			return Promise.race([
				fs.read(LOG).catch(function () { return ''; }),
				new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 5000); })
			]);
		}

		function poll() {
			readLog().then(function (data) {
				if (data === null) {
					timer = window.setTimeout(poll, POLL_MS);
					return;
				}

				var text = String(data || '');
				var m = text.match(new RegExp(DONE + '\\s+(\\d)'));

				log(text);

				/* Первые пару секунд лог может быть ещё от прошлого запуска:
				 * служба очищает его чуть позже, чем мы делаем первый запрос. */
				if (m && Date.now() - started > 2000)
					return finish(text, m[1] === '0');

				if (Date.now() - started > MAX_MS) {
					stop();
					notify('Обновление идёт слишком долго — открой /tmp/koka-update.log на роутере.', 'warning');
					return;
				}

				timer = window.setTimeout(poll, POLL_MS);
			}).catch(function () {
				if (Date.now() - started > MAX_MS) {
					stop();
					notify('Не читается лог обновления — проверь /tmp/koka-update.log.', 'warning');
					return;
				}

				timer = window.setTimeout(poll, POLL_MS);
			});
		}

		reload.addEventListener('click', function () {
			location.reload();
		});

		btn.addEventListener('click', function () {
			if (btn.disabled)
				return;

			btn.disabled = true;
			btn.textContent = 'Запускаю…';
			reload.hidden = true;
			log('Запускаю обновление…');

			/* Поллим лог сразу и независимо от ответа RPC: если rpcd в этот
			 * момент перезапускается, запрос может зависнуть, а обновление
			 * при этом уже идёт. Лог — единственный источник правды. */
			started = Date.now();
			timer = window.setTimeout(poll, 700);

			fs.exec(INIT, [ 'restart' ]).then(function (res) {
				if (res.code !== 0)
					throw new Error(((res.stderr || res.stdout) || 'скрипт не запустился').trim());

				btn.textContent = 'Обновляю…';
			}).catch(function (err) {
				var msg = String((err && err.message) || err);

				/* Таймаут RPC при уже запущенном обновлении — не ошибка */
				if (!/timed out/i.test(msg)) {
					log(msg);
					notify('Не удалось запустить обновление', 'error');
					stop();
				}
			});
		});

		return E('div', { class: 'fs-ap-section' }, [
			E('div', { class: 'fs-ap-head' }, E('h2', {}, 'Обновление')),
			E('div', {}, [
				E('div', { class: 'cbi-value-description' }, [
					'Скачивает последний релиз темы с GitHub и ставит его через ',
					E('code', {}, 'apk'), ' или ', E('code', {}, 'opkg'), '. Работает в фоне, ',
					'поэтому не упирается в таймаут браузера. Текущая версия: ',
					ver.label(), '.'
				]),
				E('div', { class: 'fs-ap-actrow fs-ap-updaterow' }, [ btn, ' ', reload ]),
				out
			])
		]);
	}
});
