'use strict';
'require baseclass';
'require ui';
'require koka-fs-axes as axes';

/* Встроенные SVG-узоры фона. Ничего не качается с интернета:
 * файлы лежат в /luci-static/koka/bg/ и весят 0.2–1 КБ.
 * Выбор хранится в UCI (koka.settings.wallpaper_bg), поэтому применяется
 * на всех страницах и во всех браузерах, ещё до первой отрисовки —
 * через data-bg в шапке (partials/head.ut). */

const ATTR = 'data-bg';

const OPTIONS = [
	[ '', 'Нет' ],
	[ 'dots', 'Точки' ],
	[ 'grid', 'Сетка' ],
	[ 'topo', 'Топография' ],
	[ 'waves', 'Волны' ],
	[ 'diag', 'Диагонали' ],
	[ 'mesh', 'Мягкие пятна' ]
];

function notify(msg, type) {
	ui.addNotification(null, E('p', {}, msg), type || 'info');
}

return baseclass.extend({
	section: function () {
		var current = document.documentElement.getAttribute(ATTR) || '';

		var select = E('select', { class: 'cbi-select', id: 'koka-bg-select', 'aria-label': 'Узор фона' },
			OPTIONS.map(function (opt) {
				return E('option', { value: opt[0] }, opt[1]);
			}));

		select.value = current;

		select.addEventListener('change', function () {
			var value = select.value;

			if (value === '')
				document.documentElement.removeAttribute(ATTR);
			else
				document.documentElement.setAttribute(ATTR, value);

			axes.saveSettings({ wallpaper_bg: value }).then(function () {
				notify(value === ''
					? 'Узор выключен.'
					: 'Узор «' + select.options[select.selectedIndex].text + '» сохранён.', 'info');
			}).catch(function (err) {
				notify('Не удалось сохранить: ' + String((err && err.message) || err), 'error');
			});
		});

		return E('div', { class: 'fs-ap-section' }, [
			E('div', { class: 'fs-ap-head' }, E('h2', {}, 'Узор фона')),
			E('div', {}, [
				E('div', { class: 'cbi-value' }, [
					E('label', { class: 'cbi-value-title', for: 'koka-bg-select' }, 'Узор'),
					E('div', { class: 'cbi-value-field' }, select)
				]),
				E('div', { class: 'cbi-value-description' },
					'Готовые векторные узоры: ~1 КБ каждый, без загрузки из интернета, ' +
					'не мешают блюру и не тормозят скролл. Сохраняется в настройках роутера.')
			])
		]);
	}
});
