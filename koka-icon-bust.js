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

	/* The flyout lives inside the bar, whose own backdrop-filter isolates it.
	 * A body-level frost layer behind the flyout gives it real page blur. */
	function installMenuFrost() {
		var top = document.getElementById('topmenu');
		if (!top || top.__kokaFrost)
			return;

		top.__kokaFrost = true;

		var frost = document.createElement('div');
		frost.className = 'koka-menu-frost';
		frost.setAttribute('aria-hidden', 'true');
		document.body.appendChild(frost);

		var active = null, timer = null;

		function place(ul) {
			if (!ul)
				return;
			var r = ul.getBoundingClientRect();
			if (!r.width || !r.height)
				return;
			frost.style.left = r.left + 'px';
			frost.style.top = r.top + 'px';
			frost.style.width = r.width + 'px';
			frost.style.height = r.height + 'px';
		}

		function show(ul) {
			if (!ul)
				return;
			clearTimeout(timer);
			active = ul;
			place(ul);
			frost.classList.add('on');
			requestAnimationFrame(function() { place(ul); });
		}

		function hide() {
			clearTimeout(timer);
			timer = setTimeout(function() {
				frost.classList.remove('on');
				active = null;
			}, 120);
		}

		function bind(li) {
			if (li.__kokaFrost)
				return;
			var ul = li.querySelector(':scope > ul');
			if (!ul)
				return;
			li.__kokaFrost = true;
			li.addEventListener('mouseenter', function() { show(ul); });
			li.addEventListener('mouseleave', hide);
			ul.addEventListener('mouseenter', function() { show(ul); });
			ul.addEventListener('mouseleave', hide);
			li.addEventListener('focusin', function() { show(ul); });
			li.addEventListener('focusout', hide);
			new MutationObserver(function() {
				if (li.classList.contains('open'))
					show(ul);
				else if (active === ul)
					hide();
			}).observe(li, { attributes: true, attributeFilter: ['class'] });
		}

		function scan() {
			Array.prototype.forEach.call(top.querySelectorAll(':scope > li.has-sub'), bind);
		}

		scan();
		new MutationObserver(scan).observe(top, { childList: true, subtree: true });
		window.addEventListener('scroll', function() { if (active) place(active); }, { passive: true });
		window.addEventListener('resize', function() { if (active) place(active); });
		document.addEventListener('pointerdown', function(ev) {
			if (!active || ev.target.closest('#topmenu'))
				return;
			hide();
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function() {
			addAurora();
			installMenuFrost();
		});
	}
	else {
		addAurora();
		installMenuFrost();
	}
})();
