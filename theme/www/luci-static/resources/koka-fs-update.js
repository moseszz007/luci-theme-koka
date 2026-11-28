'use strict';
'require baseclass';
'require fs';
'require ui';
'require koka-fs-version as ver';

/* Кнопка «Обновить с GitHub» на странице настроек темы.
 * Вся работа — в /usr/share/koka/update-theme.sh: он сам определяет
 * apk/opkg, берёт последний релиз, ставит пакет и чистит кэши LuCI. */

const SCRIPT = '/usr/share/koka/update-theme.sh';

function notify(msg, type) {
	ui.addNotification(null, E('p', {}, msg), type || 'info');
}

return baseclass.extend({
	section: function () {
		var out = E('pre', { class: 'fs-ap-out', hidden: '' });
		var reload = E('button', { class: 'btn', type: 'button', hidden: '' }, 'Перезагрузить страницу');

		var btn = E('button', { class: 'btn cbi-button-action', type: 'button' }, 'Обновить с GitHub');

		function log(text) {
			out.hidden = false;
			out.textContent = String(text || '');
		}

		reload.addEventListener('click', function () {
			location.reload();
		});

		btn.addEventListener('click', function () {
			if (btn.disabled)
				return;

			btn.disabled = true;
			btn.textContent = 'Обновляю…';
			reload.hidden = true;
			log('Проверяю релизы на GitHub…');

			fs.exec(SCRIPT, []).then(function (res) {
				var text = ((res.stdout || '') + (res.stderr || '')).trim();

				log(text || ('Скрипт завершился с кодом ' + res.code));

				if (res.code === 0) {
					var upToDate = /Уже последняя/.test(text);

					notify(upToDate
						? 'Установлена последняя версия темы.'
						: 'Тема обновлена — перезагрузи страницу.', 'info');

					reload.hidden = upToDate;
				}
				else {
					notify('Обновление не удалось — смотри лог ниже.', 'error');
				}
			}).catch(function (err) {
				log(String((err && err.message) || err));
				notify('Обновление не удалось', 'error');
			}).finally(function () {
				btn.disabled = false;
				btn.textContent = 'Обновить с GitHub';
			});
		});

		return E('div', { class: 'fs-ap-section' }, [
			E('div', { class: 'fs-ap-head' }, E('h2', {}, 'Обновление')),
			E('div', {}, [
				E('div', { class: 'cbi-value-description' }, [
					'Скачивает последний релиз темы с GitHub и ставит его через ',
					E('code', {}, 'apk'), ' или ', E('code', {}, 'opkg'), '. Текущая версия: ',
					ver.label(), '.'
				]),
				E('div', { class: 'fs-ap-actrow fs-ap-updaterow' }, [ btn, ' ', reload ]),
				out
			])
		]);
	}
});
