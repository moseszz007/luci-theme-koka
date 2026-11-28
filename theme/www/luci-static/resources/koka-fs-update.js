'use strict';
'require baseclass';
'require fs';
'require ui';
'require koka-fs-version as ver';

/* Кнопка «Обновить с GitHub» на странице настроек темы.
 *
 * Обновление идёт в фоне (/usr/share/koka/update-theme.sh --background),
 * а панель читает /tmp/koka-update.log. Так RPC не висит 30+ секунд и
 * не падает с «XHR request timed out», даже если GitHub отвечает медленно. */

const SCRIPT = '/usr/share/koka/update-theme.sh';
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

		function poll() {
			fs.read(LOG).then(function (data) {
				var text = String(data || '');
				var m = text.match(new RegExp(DONE + '\\s+(\\d)'));

				log(text);

				if (m)
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
			log('Запускаю обновление в фоне…');

			fs.exec(SCRIPT, [ '--background' ]).then(function (res) {
				if (res.code !== 0)
					throw new Error(((res.stderr || res.stdout) || 'скрипт не запустился').trim());

				btn.textContent = 'Обновляю…';
				started = Date.now();
				timer = window.setTimeout(poll, 600);
			}).catch(function (err) {
				stop();
				log(String((err && err.message) || err));
				notify('Не удалось запустить обновление', 'error');
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
