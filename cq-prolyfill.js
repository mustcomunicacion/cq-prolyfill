/*
 * Copyright Martin Auswöger
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

(function(window, document) {
'use strict';

// Public API
window.containerQueries = {
	reprocess: reprocess,
	reparse: reparse,
	reevaluate: reevaluate,
};

// Reevaluate now
setTimeout(reevaluate);

window.addEventListener('DOMContentLoaded', reprocess);
window.addEventListener('load', reprocess);
window.addEventListener('resize', reevaluate);

var REGEXP_ESCAPE_REGEXP = /[.?*+^$[\]\\(){}|-]/g;
var SELECTOR_REGEXP = /\.?:container\(\s*(?:width|height)\s*(?:\<=|>=|<|>|=|!=)\s*[^)]+\s*\)/gi;
var SELECTOR_ESCAPED_REGEXP = /\.\\:container\\\((width|height)(\\<\\=|\\>\\=|\\<|\\>|\\=|\\!\\=)([^)]+?)\\\)/gi;
var ESCAPE_REGEXP = /[.:()<>!=]/g;
var SPACE_REGEXP = / /g;
var LENGTH_REGEXP = /^(-?(?:\d*\.)?\d+)(em|ex|ch|rem|vh|vw|vmin|vmax|px|mm|cm|in|pt|pc)$/i;
var URL_VALUE_REGEXP = /url\(\s*(?:(["'])(.*?)\1|([^)\s]*))\s*\)/gi;
var ATTR_REGEXP = /\[.+?\]/g;
var PSEUDO_NOT_REGEXP = /:not\(/g;
var ID_REGEXP = /#[^\s\[\]\\!"#$%&'()*+,./:;<=>?@^`{|}~-]+/g;
var CLASS_REGEXP = /\.[^\s\[\]\\!"#$%&'()*+,./:;<=>?@^`{|}~-]+/g;
var PSEUDO_ELEMENT_REGEXP = /::[^\s\[\]\\!"#$%&'()*+,./:;<=>?@^`{|}~-]+/g;
var PSEUDO_CLASS_REGEXP = /:[^\s\[\]\\!"#$%&'()*+,./:;<=>?@^`{|}~-]+/g;
var ELEMENT_REGEXP = /[a-z-]+/gi;
var FIXED_UNIT_MAP = {
	px: 1,
	pt: 16 / 12,
	pc: 16,
	in: 96,
	cm: 96 / 2.54,
	mm: 96 / 25.4,
};

var queries;
var containerCache;
var processed = false;
var parsed = false;
var documentElement = document.documentElement;
var styleSheets = document.styleSheets;
var createElement = document.createElement.bind(document);

/**
 * @param {function()} callback
 */
function reprocess(callback) {
	preprocess(function() {
		processed = true;
		reparse(callback);
	});
}

/**
 * @param {function()} callback
 */
function reparse(callback) {
	if (!processed) {
		return reprocess(callback);
	}
	parseRules();
	parsed = true;
	reevaluate(callback);
}

/**
 * @param {function()} callback
 */
function reevaluate(callback) {
	if (!parsed) {
		return reparse(callback);
	}
	updateClasses();
	if (callback && callback.call) {
		callback();
	}
}

/**
 * Step 1: Preprocess all active stylesheets in the document
 *
 * Look for stylesheets that contain container queries and escape them to be
 * readable by the browser, e.g. convert `:container(width >= 10px)` to
 * `\:container\(width\>\=10px\)`
 *
 * @param {function()} callback
 */
function preprocess(callback) {
	var sheets = arrayFrom(styleSheets);
	var done = -1;
	function step() {
		done++;
		if (done === sheets.length) {
			callback();
		}
	}
	sheets.forEach(function(sheet) {
		preprocessSheet(sheet, step);
	});
	step();
}

/**
 * @param {CSSStyleSheet} sheet
 * @param {function()}    callback
 */
function preprocessSheet(sheet, callback) {
	if (sheet.disabled) {
		callback();
		return;
	}
	var ownerNode = sheet.ownerNode;
	var tag = ownerNode && ownerNode.tagName;
	if (tag === 'LINK') {
		loadExternal(ownerNode.href, function(cssText) {
			// Check again because loadExternal is async
			if (sheet.disabled || !cssText) {
				callback();
				return;
			}
			preprocessStyle(ownerNode, fixRelativeUrls(cssText, ownerNode.href));
			callback();
		});
	}
	else if (tag === 'STYLE') {
		preprocessStyle(ownerNode, ownerNode.innerHTML);
		callback();
	}
	else {
		callback();
	}
}

/**
 * Load external file via AJAX
 *
 * @param {string}           href
 * @param {function(string)} callback Gets called with the response text on
 *                                    success or empty string on failure
 */
function loadExternal(href, callback) {
	var isDone = false;
	var done = function(response) {
		if (!isDone) {
			callback(response || '');
		}
		isDone = true;
	};
	var xhr = new XMLHttpRequest();
	xhr.onreadystatechange = function() {
		if (xhr.readyState !== 4) {
			return;
		}
		done(xhr.status === 200 && xhr.responseText);
	};
	try {
		xhr.open('GET', href);
		xhr.send();
	}
	catch(e) {
		if (window.XDomainRequest) {
			xhr = new XDomainRequest();
			xhr.onprogress =
				/* istanbul ignore next: fix for a rare IE9 bug */
				function() {};
			xhr.onload = xhr.onerror = xhr.ontimeout = function() {
				done(xhr.responseText);
			};
			try {
				xhr.open('GET', href);
				xhr.send();
			}
			catch(e2) {
				done();
			}
		}
		else {
			done();
		}
	}
}

/**
 * Replace relative CSS URLs with their absolute counterpart
 *
 * @param  {string} cssText
 * @param  {string} href    URL of the stylesheet
 * @return {string}
 */
function fixRelativeUrls(cssText, href) {
	var base = resolveRelativeUrl(href, document.baseURI);
	return cssText.replace(URL_VALUE_REGEXP, function(match, quote, url1, url2) {
		var url = url1 || url2;
		if (!url) {
			return match;
		}
		return 'url(' + (quote || '"') + resolveRelativeUrl(url, base) + (quote || '"') + ')';
	});
}

/**
 * @param  {string} url
 * @param  {string} base
 * @return {string}
 */
function resolveRelativeUrl(url, base) {
	var absoluteUrl;
	try {
		absoluteUrl = new URL(url, base).href;
	}
	catch(e) {
		absoluteUrl = false;
	}
	if (!absoluteUrl) {
		var baseElement = createElement('base');
		baseElement.href = base;
		document.head.insertBefore(baseElement, document.head.firstChild);
		var link = createElement('a');
		link.href = url;
		absoluteUrl = link.href;
		document.head.removeChild(baseElement);
	}
	return absoluteUrl;
}

/**
 * @param {Node}   node    Stylesheet ownerNode
 * @param {string} cssText
 */
function preprocessStyle(node, cssText) {
	var escapedText = escapeSelectors(cssText);
	var rulesLength = -1;
	if (escapedText === cssText) {
		try {
			rulesLength = node.sheet.cssRules.length;
		}
		catch(e) {
			rulesLength = -1;
		}
		// Check if cssRules is accessible
		if (rulesLength !== -1) {
			return;
		}
	}
	var style = createElement('style');
	style.textContent = escapedText;
	style.media = node.media || 'all';
	node.parentNode.insertBefore(style, node);
	node.sheet.disabled = true;
}

/**
 * @param  {string} cssText
 * @return {string}
 */
function escapeSelectors(cssText) {
	return cssText.replace(SELECTOR_REGEXP, function(selector) {
		return '.' + selector.substr(selector[0] === '.' ? 1 : 0).replace(SPACE_REGEXP, '').replace(ESCAPE_REGEXP, '\\$&');
	});
}

/**
 * Step 2: Parse all processed container query rules and store them in `queries`
 * indexed by the preceding selector
 */
function parseRules() {
	queries = {};
	var rules;
	for (var i = 0; i < styleSheets.length; i++) {
		if (styleSheets[i].disabled) {
			continue;
		}
		try {
			rules = styleSheets[i].cssRules;
			if (!rules || !rules.length) {
				continue;
			}
		}
		catch(e) {
			continue;
		}
		for (var j = 0; j < rules.length; j++) {
			parseRule(rules[j]);
		}
	}
}

/**
 * @param {CSSRule} rule
 */
function parseRule(rule) {
	if (rule.cssRules) {
		for (var i = 0; i < rule.cssRules.length; i++) {
			parseRule(rule.cssRules[i]);
		}
		return;
	}
	if (rule.type !== 1) {
		return;
	}
	splitSelectors(rule.selectorText).forEach(function(selector) {
		selector = escapeSelectors(selector);
		selector.replace(SELECTOR_ESCAPED_REGEXP, function(match, prop, type, value, offset) {
			var precedingSelector = selector.substr(0, offset) + selector.substr(offset + match.length).replace(/[\s>+~].*$/, '');
			if (!precedingSelector.substr(-1).trim()) {
				precedingSelector += '*';
			}
			precedingSelector = precedingSelector.replace(/:(?:active|hover|focus|checked)/gi, '');
			queries[precedingSelector + match.toLowerCase()] = {
				_selector: precedingSelector,
				_prop: prop.replace(/\\(.)/g, '$1').toLowerCase(),
				_type: type.replace(/\\(.)/g, '$1'),
				_value: value.replace(/\\(.)/g, '$1'),
				_className: match.toLowerCase().substr(1).replace(/\\(.)/g, '$1'),
			};
		});
	});
}

/**
 * Split multiple selectors by `,`
 *
 * @param  {string} selectors
 * @return {Array.<string>}
 */
function splitSelectors(selectors) {
	// TODO: Fix complex selectors like fo\,o[attr="val,u\"e"]
	return selectors.split(/\s*,\s*/);
}

/**
 * Step 3: Loop through the `queries` and add or remove the CSS classes of all
 * matching elements
 */
function updateClasses() {
	containerCache = createCacheMap();
	Object.keys(queries).forEach(function(key) {
		var elements = document.querySelectorAll(queries[key]._selector);
		for (var i = 0; i < elements.length; i++) {
			updateClass(elements[i], queries[key]);
		}
	});
}

/**
 * Add or remove CSS class on the element depending on the specified query
 *
 * @param {Element} element
 * @param {object}  query
 */
function updateClass(element, query) {
	if (element === documentElement) {
		return;
	}
	var container = getContainer(element.parentNode, query._prop);
	var size = getSize(container, query._prop);
	var value = getComputedLength(query._value, element.parentNode);
	if (
		(query._type === '>=' && size >= value)
		|| (query._type === '<=' && size <= value)
		|| (query._type === '>' && size > value)
		|| (query._type === '<' && size < value)
		|| (query._type === '=' && size === value)
		|| (query._type === '!=' && size !== value)
	) {
		addClass(element, query._className);
	}
	else {
		removeClass(element, query._className);
	}
}

/**
 * Get the nearest qualified container element starting by the element itself
 *
 * @param  {Element} element
 * @param  {string}  prop    `width` or `height`
 * @return {Element}
 */
function getContainer(element, prop) {

	var cache;
	if (containerCache.has(element)) {
		cache = containerCache.get(element);
		if (cache[prop]) {
			return cache[prop];
		}
	}
	else {
		cache = {};
		containerCache.set(element, cache);
	}

	if (element === documentElement) {
		cache[prop] = element;
	}

	// Skip inline elements
	else if (getComputedStyle(element).display === 'inline') {
		cache[prop] = getContainer(element.parentNode, prop);
	}

	else if (isFixedSize(element, prop)) {
		cache[prop] = element;
	}

	else {
		var parentContainer = getContainer(element.parentNode, prop);
		var parentNode = element.parentNode;
		while (getComputedStyle(parentNode).display === 'inline') {
			parentNode = parentNode.parentNode;
		}
		if (parentNode === parentContainer && !isIntrinsicSize(element, prop)) {
			cache[prop] = element;
		}
		else {
			cache[prop] = parentContainer;
		}
	}

	return cache[prop];

}

/**
 * Is the size of the element a fixed length e.g. `1px`?
 *
 * @param  {Element} element
 * @param  {string}  prop    `width` or `height`
 * @return {boolean}
 */
function isFixedSize(element, prop) {
	var originalStyle = getOriginalStyle(element, [prop]);
	if (originalStyle[prop] && originalStyle[prop].match(LENGTH_REGEXP)) {
		return true;
	}
	return false;
}

/**
 * Is the size of the element depending on its descendants?
 *
 * @param  {Element} element
 * @param  {string}  prop    `width` or `height`
 * @return {boolean}
 */
function isIntrinsicSize(element, prop) {

	var computedStyle = getComputedStyle(element);

	if (computedStyle.display === 'none') {
		return false;
	}

	if (computedStyle.display === 'inline') {
		return true;
	}

	// Non-floating non-absolute block elements (only width)
	if (
		prop === 'width'
		&& ['block', 'list-item', 'flex', 'grid'].indexOf(computedStyle.display) !== -1
		&& computedStyle.cssFloat === 'none'
		&& computedStyle.position !== 'absolute'
		&& computedStyle.position !== 'fixed'
	) {
		return false;
	}

	var originalStyle = getOriginalStyle(element, [prop]);

	// Fixed size
	if (originalStyle[prop] && originalStyle[prop].match(LENGTH_REGEXP)) {
		return false;
	}

	// Percentage size
	if (originalStyle[prop] && originalStyle[prop].substr(-1) === '%') {
		return false;
	}

	// Elements without a defined size
	return true;

}

/**
 * Get the computed content-box size
 *
 * @param  {Element} element
 * @param  {string}  prop    `width` or `height`
 * @return {number}
 */
function getSize(element, prop) {
	var style = getComputedStyle(element);
	if (prop === 'width') {
		return element.offsetWidth
			- parseFloat(style.borderLeftWidth)
			- parseFloat(style.paddingLeft)
			- parseFloat(style.borderRightWidth)
			- parseFloat(style.paddingRight);
	}
	else {
		return element.offsetHeight
			- parseFloat(style.borderTopWidth)
			- parseFloat(style.paddingTop)
			- parseFloat(style.borderBottomWidth)
			- parseFloat(style.paddingBottom);
	}
}

/**
 * Get the computed length in pixel of a CSS length value
 *
 * @param  {string}  value
 * @param  {Element} element
 * @return {number}
 */
function getComputedLength(value, element) {
	var length = value.match(LENGTH_REGEXP);
	if (!length) {
		return parseFloat(value);
	}
	value = parseFloat(length[1]);
	var unit = length[2].toLowerCase();
	if (FIXED_UNIT_MAP[unit]) {
		return value * FIXED_UNIT_MAP[unit];
	}
	if (unit === 'vw') {
		return value * window.innerWidth / 100;
	}
	if (unit === 'vh') {
		return value * window.innerHeight / 100;
	}
	if (unit === 'vmin') {
		return value * Math.min(window.innerWidth, window.innerHeight) / 100;
	}
	if (unit === 'vmax') {
		return value * Math.max(window.innerWidth, window.innerHeight) / 100;
	}
	// em units
	if (unit === 'rem') {
		element = documentElement;
	}
	if (unit === 'ex') {
		value /= 2;
	}
	return parseFloat(getComputedStyle(element).fontSize) * value;
}

/**
 * @param  {Element} element
 * @return {CSSStyleDeclaration}
 */
function getComputedStyle(element) {

	var style = window.getComputedStyle(element);

	// Fix display inline in some browsers
	if (style.display === 'inline' && (
		style.position === 'absolute'
		|| style.position === 'fixed'
		|| style.cssFloat !== 'none'
	)) {
		var newStyle = {};
		for (var prop in style) {
			if (typeof style[prop] === 'string') {
				newStyle[prop] = style[prop];
			}
		}
		style = newStyle;
		style.display = 'block';
	}

	return style;

}

/**
 * Get the original style of an element as it was specified in CSS
 *
 * @param  {Element}        element
 * @param  {Array.<string>} props   Properties to return, e.g. `['width', 'height']`
 * @return {Object.<string, string>}
 */
function getOriginalStyle(element, props) {

	var matchedRules = [];
	var rules;
	var result = {};
	var value;
	var i, j;

	for (i = 0; i < styleSheets.length; i++) {
		if (styleSheets[i].disabled) {
			continue;
		}
		try {
			rules = styleSheets[i].cssRules;
			if (!rules || !rules.length) {
				continue;
			}
		}
		catch(e) {
			continue;
		}
		matchedRules = matchedRules.concat(filterRulesByElementAndProps(rules, element, props));
	}

	matchedRules = sortRulesBySpecificity(matchedRules);

	// Add style attribute
	matchedRules.unshift({
		_rule: {
			style: element.style,
		},
	});

	// Loop through all important styles
	for (i = 0; i < props.length; i++) {
		for (j = 0; j < matchedRules.length; j++) {
			if (
				(value = matchedRules[j]._rule.style.getPropertyValue(props[i]))
				&& matchedRules[j]._rule.style.getPropertyPriority(props[i]) === 'important'
			) {
				result[props[i]] = value;
				break;
			}
		}
	}

	// Loop through all non-important styles
	for (i = 0; i < props.length; i++) {
		// Skip if an !important rule already matched
		if (result[props[i]]) {
			continue;
		}
		for (j = 0; j < matchedRules.length; j++) {
			if (
				(value = matchedRules[j]._rule.style.getPropertyValue(props[i]))
				&& matchedRules[j]._rule.style.getPropertyPriority(props[i]) !== 'important'
			) {
				result[props[i]] = value;
				break;
			}
		}
	}

	return result;

}

/**
 * Filter rules by matching the element and at least one property
 *
 * @param  {CSSRuleList}    rules
 * @param  {Element}        element
 * @param  {Array.<string>} props
 * @return {Array.<{_selector: string, _rule: CSSRule}>}
 */
function filterRulesByElementAndProps(rules, element, props) {
	var matchedRules = [];
	for (var i = 0; i < rules.length; i++) {
		if (rules[i].cssRules) {
			matchedRules = matchedRules.concat(filterRulesByElementAndProps(rules[i].cssRules, element, props));
		}
		else if (rules[i].type === 1) { // Style rule
			if (
				styleHasProperty(rules[i].style, props)
				&& (
					!rules[i].parentRule
					|| rules[i].parentRule.type !== 4 // @media rule
					|| matchesMedia(rules[i].parentRule.media.mediaText)
				)
				&& elementMatchesSelector(element, rules[i].selectorText)
			) {
				splitSelectors(rules[i].selectorText).forEach(function(selector) {
					if (elementMatchesSelector(element, selector)) {
						matchedRules.push({
							_selector: selector,
							_rule: rules[i],
						});
					}
				});
			}
		}
	}
	return matchedRules;
}

/**
 * @param  {Element} element
 * @param  {string}  selector
 * @return {boolean}
 */
function elementMatchesSelector(element, selector) {
	var func = element.matches
		|| element.mozMatchesSelector
		|| element.msMatchesSelector
		|| element.oMatchesSelector
		|| element.webkitMatchesSelector;
	return func.call(element, escapeSelectors(selector));
}

/**
 * Check if the style object has one of the specified properties
 *
 * @param  {CSSStyleDeclaration} style
 * @param  {Array.<string>}      props
 * @return {boolean}
 */
function styleHasProperty(style, props) {
	for (var i = 0; i < style.length; i++) {
		if (props.indexOf(style.item(i)) !== -1) {
			return true;
		}
	}
	return false;
}

/**
 * @param  {Array.<{_selector: string}>} rules
 * @return {Array.<{_selector: string}>}
 */
function sortRulesBySpecificity(rules) {
	return rules.map(function(rule, i) {
		return [rule, i];
	}).sort(function(a, b) {
		return (getSpecificity(b[0]._selector) - getSpecificity(a[0]._selector)) || b[1] - a[1];
	}).map(function(rule) {
		return rule[0];
	});
}

/**
 * @param  {string} selector
 * @return {number}
 */
function getSpecificity(selector) {

	var idScore = 0;
	var classScore = 0;
	var typeScore = 0;

	selector
		.replace(SELECTOR_ESCAPED_REGEXP, function() {
			classScore++;
			return '';
		})
		.replace(SELECTOR_REGEXP, function() {
			classScore++;
			return '';
		})
		.replace(ATTR_REGEXP, function() {
			classScore++;
			return '';
		})
		.replace(PSEUDO_NOT_REGEXP, '')
		.replace(ID_REGEXP, function() {
			idScore++;
			return '';
		})
		.replace(CLASS_REGEXP, function() {
			classScore++;
			return '';
		})
		.replace(PSEUDO_ELEMENT_REGEXP, function() {
			typeScore++;
			return '';
		})
		.replace(PSEUDO_CLASS_REGEXP, function() {
			classScore++;
			return '';
		})
		.replace(ELEMENT_REGEXP, function() {
			typeScore++;
			return '';
		});

	return (
		(idScore * 256 * 256)
		+ (classScore * 256)
		+ typeScore
	);

}

/**
 * Create a new Map or a simple shim of it in non-supporting browsers
 *
 * @return {Map}
 */
function createCacheMap() {

	if (typeof Map === 'function') {
		return new Map();
	}

	var keys = [];
	var values = [];

	function get(key) {
		return values[keys.indexOf(key)];
	}

	function has(key) {
		return keys.indexOf(key) !== -1;
	}

	function set(key, value) {
		var index = keys.indexOf(key);
		if (index === -1) {
			index = keys.push(key) - 1;
		}
		values[index] = value;
	}

	return {
		set: set,
		get: get,
		has: has,
	};
}

/**
 * @param {Element} element
 * @param {string}  className
 */
function addClass(element, className) {
	if (element.classList) {
		element.classList.add(className);
	}
	else {
		removeClass(element, className);
		element.className += ' ' + className;
	}
}

/**
 * @param {Element} element
 * @param {string}  className
 */
function removeClass(element, className) {
	if (element.classList) {
		element.classList.remove(className);
	}
	else {
		element.className = element.className.replace(
			new RegExp(
				'(?:^|\\s+)'
				+ className.replace(REGEXP_ESCAPE_REGEXP, '\\$&')
				+ '($|\\s+)'
			),
			'$1'
		);
	}
}

/**
 * @param  {string} media
 * @return {boolean}
 */
function matchesMedia(media) {
	if (window.matchMedia) {
		return window.matchMedia(media).matches;
	}
	return (window.styleMedia || window.media).matchMedium(media);
}

/**
 * Array.from or a simple shim for non-supporting browsers
 *
 * @param  {{length: number}} arrayLike
 * @return {array}
 */
function arrayFrom(arrayLike) {
	if (Array.from) {
		return Array.from(arrayLike);
	}
	var array = [];
	for (var i = 0; i < arrayLike.length; i++) {
		array[i] = arrayLike[i];
	}
	return array;
}

})(window, document);
