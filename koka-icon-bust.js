/* Koka: единый набор иконок интерфейсов.
 *
 * LuCI рисует иконки интерфейсов картинками из /luci-static/resources/icons/.
 * Подменять файлы в каталоге luci-base нельзя: пакет luci-base при обновлении
 * возвращает свои, да и владельцы файлов пересекаются. Поэтому мы просто
 * переписываем src на свою копию из /luci-static/koka/icons/ — она едет
 * внутри темы, обновляется вместе с ней и не конфликтует с LuCI.
 *
 * Работает и для страниц, отрисованных позже через SPA-роутер: MutationObserver
 * ловит новые узлы и изменения src. */
(function () {
	'use strict';

	var MARK = 'kokaicons';
	var DIR = '/luci-static/koka/icons/';

	var ICONS = [
		'alias', 'alias_disabled',
		'amneziawg', 'amneziawg_disabled',
		'bridge', 'bridge_disabled',
		'ethernet', 'ethernet_disabled',
		'loading',
		'port_down', 'port_up',
		'signal-000-000', 'signal-000-025', 'signal-025-050',
		'signal-050-075', 'signal-075-100', 'signal-none',
		'switch', 'switch_disabled',
		'tunnel', 'tunnel_disabled',
		'vlan', 'vlan_disabled',
		'vrf', 'vrf_disabled',
		'wifi', 'wifi_disabled',
		'wireguard', 'wireguard_disabled'
	];

	/* Glass preference applies to every page before first paint. */
	try {
		document.documentElement.classList.toggle('koka-glass', localStorage.getItem('koka-glass') !== 'off');
	} catch (e) {}

	function kokaUrl(src) {
		var idx = src.indexOf('/icons/');

		if (idx < 0)
			return null;

		var file = src.substring(idx + 7).split('?')[0].replace(/^.*\//, '');

		return ICONS.indexOf(file) >= 0 ? DIR + file + '?v=' + MARK : null;
	}

	function bust(img) {
		var src = img.getAttribute('src');

		if (!src || src.indexOf('/icons/') < 0)
			return;

		var mapped = kokaUrl(src);

		if (mapped) {
			if (src !== mapped)
				img.setAttribute('src', mapped);
			return;
		}

		/* Неизвестная иконка — только сбрасываем кэш */
		if (src.indexOf(MARK) >= 0)
			return;

		img.setAttribute('src', src + (src.indexOf('?') < 0 ? '?' : '&') + 'v=' + MARK);
	}

	function scan(node) {
		if (!node || node.nodeType !== 1)
			return;

		if (node.tagName === 'IMG')
			bust(node);

		if (node.querySelectorAll) {
			var list = node.querySelectorAll('img[src*="/icons/"]');

			for (var i = 0; i < list.length; i++)
				bust(list[i]);
		}
	}

	scan(document.documentElement);

	new MutationObserver(function (records) {
		for (var i = 0; i < records.length; i++) {
			var r = records[i];

			if (r.type === 'attributes') {
				if (r.target.tagName === 'IMG')
					bust(r.target);
			}
			else {
				for (var j = 0; j < r.addedNodes.length; j++)
					scan(r.addedNodes[j]);
			}
		}
	}).observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['src']
	});

	function addAurora() {
		var host = document.getElementById('maincontent') || document.body;

		if (!host || host.querySelector('.koka-aurora'))
			return;

		var aurora = document.createElement('div');

		aurora.className = 'koka-aurora';
		aurora.setAttribute('aria-hidden', 'true');
		aurora.innerHTML = '<i></i><i></i><i></i>';
		host.appendChild(aurora);
	}

	/* The flyout is a single opaque-ish panel now: the body-level "frost"
	 * layer that used to fade in behind it made the menu appear in layers
	 * (menu, then background, then blur) and cost a full-page blur on
	 * phones, so it is gone. */
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', addAurora);
	}
	else {
		addAurora();
	}
})();
