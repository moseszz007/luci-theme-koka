/* Koka: give every LuCI interface icon a versioned URL so a stale browser
 * cache cannot keep showing the old Tango artwork. Runs on every page,
 * including views loaded later by the SPA router. */
(function () {
	'use strict';

	var MARK = 'kokaicons';

	/* Glass preference applies to every page before first paint. */
	try {
		document.documentElement.classList.toggle('koka-glass', localStorage.getItem('koka-glass') !== 'off');
	} catch (e) {}

	function bust(img) {
		var src = img.getAttribute('src');
		if (!src || src.indexOf('/icons/') < 0 || src.indexOf(MARK) >= 0)
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
})();
