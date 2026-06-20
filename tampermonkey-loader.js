// ==UserScript==
// @name         ChatGPT Auto Relay Loader
// @namespace    cgcon
// @version      1.1
// @description  通过 Tampermonkey @require 加载本地 ChatGPT Relay 脚本
// @match        https://chatgpt.com/*
// @match        https://chat.deepseek.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @require      http://localhost:8765/tampermonkey.js?v=2.2
// ==/UserScript==

(function() {
    'use strict';
    console.log('[Relay Loader] @require loaded local relay script');
})();
