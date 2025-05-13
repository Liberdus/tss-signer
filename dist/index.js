/******/ (function(modules) { // webpackBootstrap
/******/ 	// install a JSONP callback for chunk loading
/******/ 	function webpackJsonpCallback(data) {
/******/ 		var chunkIds = data[0];
/******/ 		var moreModules = data[1];
/******/
/******/
/******/ 		// add "moreModules" to the modules object,
/******/ 		// then flag all "chunkIds" as loaded and fire callback
/******/ 		var moduleId, chunkId, i = 0, resolves = [];
/******/ 		for(;i < chunkIds.length; i++) {
/******/ 			chunkId = chunkIds[i];
/******/ 			if(Object.prototype.hasOwnProperty.call(installedChunks, chunkId) && installedChunks[chunkId]) {
/******/ 				resolves.push(installedChunks[chunkId][0]);
/******/ 			}
/******/ 			installedChunks[chunkId] = 0;
/******/ 		}
/******/ 		for(moduleId in moreModules) {
/******/ 			if(Object.prototype.hasOwnProperty.call(moreModules, moduleId)) {
/******/ 				modules[moduleId] = moreModules[moduleId];
/******/ 			}
/******/ 		}
/******/ 		if(parentJsonpFunction) parentJsonpFunction(data);
/******/
/******/ 		while(resolves.length) {
/******/ 			resolves.shift()();
/******/ 		}
/******/
/******/ 	};
/******/
/******/
/******/ 	// The module cache
/******/ 	var installedModules = {};
/******/
/******/ 	// object to store loaded and loading chunks
/******/ 	// undefined = chunk not loaded, null = chunk preloaded/prefetched
/******/ 	// Promise = chunk loading, 0 = chunk loaded
/******/ 	var installedChunks = {
/******/ 		"main": 0
/******/ 	};
/******/
/******/
/******/
/******/ 	// script path function
/******/ 	function jsonpScriptSrc(chunkId) {
/******/ 		return __webpack_require__.p + "" + chunkId + ".index.js"
/******/ 	}
/******/
/******/ 	// object to store loaded and loading wasm modules
/******/ 	var installedWasmModules = {};
/******/
/******/ 	function promiseResolve() { return Promise.resolve(); }
/******/
/******/ 	var wasmImportObjects = {
/******/ 		"./pkg/index_bg.wasm": function() {
/******/ 			return {
/******/ 				"./index_bg.js": {
/******/ 					"__wbg_log_2cfcf059f9aaa47c": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_log_2cfcf059f9aaa47c"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_string_new": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_string_new"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_string_get": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_string_get"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_object_clone_ref": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_object_clone_ref"](p0i32);
/******/ 					},
/******/ 					"__wbg_fetch_f1856afdb49415d1": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_fetch_f1856afdb49415d1"](p0i32);
/******/ 					},
/******/ 					"__wbindgen_is_function": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_is_function"](p0i32);
/******/ 					},
/******/ 					"__wbg_queueMicrotask_97d92b4fcc8a61c5": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_queueMicrotask_97d92b4fcc8a61c5"](p0i32);
/******/ 					},
/******/ 					"__wbg_queueMicrotask_d3219def82552485": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_queueMicrotask_d3219def82552485"](p0i32);
/******/ 					},
/******/ 					"__wbindgen_cb_drop": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_cb_drop"](p0i32);
/******/ 					},
/******/ 					"__wbg_instanceof_Window_def73ea0955fc569": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_instanceof_Window_def73ea0955fc569"](p0i32);
/******/ 					},
/******/ 					"__wbg_setTimeout_f2fe5af8e3debeb3": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_setTimeout_f2fe5af8e3debeb3"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_new_018dcc2d6c8c2f6a": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_new_018dcc2d6c8c2f6a"]();
/******/ 					},
/******/ 					"__wbg_append_8c7dd8d641a5f01b": function(p0i32,p1i32,p2i32,p3i32,p4i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_append_8c7dd8d641a5f01b"](p0i32,p1i32,p2i32,p3i32,p4i32);
/******/ 					},
/******/ 					"__wbg_newwithstrandinit_06c535e0a867c635": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_newwithstrandinit_06c535e0a867c635"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_setbody_5923b78a95eedf29": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_setbody_5923b78a95eedf29"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_setcredentials_c3a22f1cd105a2c6": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_setcredentials_c3a22f1cd105a2c6"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_setheaders_834c0bdb6a8949ad": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_setheaders_834c0bdb6a8949ad"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_setmethod_3c5280fe5d890842": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_setmethod_3c5280fe5d890842"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_setmode_5dc300b865044b65": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_setmode_5dc300b865044b65"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_setsignal_75b21ef3a81de905": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_setsignal_75b21ef3a81de905"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_fetch_509096533071c657": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_fetch_509096533071c657"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_signal_aaf9ad74119f20a4": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_signal_aaf9ad74119f20a4"](p0i32);
/******/ 					},
/******/ 					"__wbg_new_e25e5aab09ff45db": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_new_e25e5aab09ff45db"]();
/******/ 					},
/******/ 					"__wbg_abort_775ef1d17fc65868": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_abort_775ef1d17fc65868"](p0i32);
/******/ 					},
/******/ 					"__wbg_instanceof_Response_f2cc20d9f7dfd644": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_instanceof_Response_f2cc20d9f7dfd644"](p0i32);
/******/ 					},
/******/ 					"__wbg_url_ae10c34ca209681d": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_url_ae10c34ca209681d"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_status_f6360336ca686bf0": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_status_f6360336ca686bf0"](p0i32);
/******/ 					},
/******/ 					"__wbg_headers_9cb51cfd2ac780a4": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_headers_9cb51cfd2ac780a4"](p0i32);
/******/ 					},
/******/ 					"__wbg_text_7805bea50de2af49": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_text_7805bea50de2af49"](p0i32);
/******/ 					},
/******/ 					"__wbg_newnoargs_105ed471475aaf50": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_newnoargs_105ed471475aaf50"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_call_672a4d21634d4a24": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_call_672a4d21634d4a24"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_call_7cccdd69e0791ae2": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_call_7cccdd69e0791ae2"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_next_6574e1a8a62d1055": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_next_6574e1a8a62d1055"](p0i32);
/******/ 					},
/******/ 					"__wbg_next_25feadfc0913fea9": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_next_25feadfc0913fea9"](p0i32);
/******/ 					},
/******/ 					"__wbg_done_769e5ede4b31c67b": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_done_769e5ede4b31c67b"](p0i32);
/******/ 					},
/******/ 					"__wbg_value_cd1ffa7b1ab794f1": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_value_cd1ffa7b1ab794f1"](p0i32);
/******/ 					},
/******/ 					"__wbg_new_405e22f390576ce2": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_new_405e22f390576ce2"]();
/******/ 					},
/******/ 					"__wbg_iterator_9a24c88df860dc65": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_iterator_9a24c88df860dc65"]();
/******/ 					},
/******/ 					"__wbg_new_23a2665fac83c611": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_new_23a2665fac83c611"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_resolve_4851785c9c5f573d": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_resolve_4851785c9c5f573d"](p0i32);
/******/ 					},
/******/ 					"__wbg_then_44b73946d2fb3e7d": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_then_44b73946d2fb3e7d"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_then_48b406749878a531": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_then_48b406749878a531"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0"]();
/******/ 					},
/******/ 					"__wbg_static_accessor_SELF_37c5d418e4bf5819": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_static_accessor_SELF_37c5d418e4bf5819"]();
/******/ 					},
/******/ 					"__wbg_static_accessor_WINDOW_5de37043a91a9c40": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_static_accessor_WINDOW_5de37043a91a9c40"]();
/******/ 					},
/******/ 					"__wbg_static_accessor_GLOBAL_88a902d13a557d07": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_static_accessor_GLOBAL_88a902d13a557d07"]();
/******/ 					},
/******/ 					"__wbg_new_a12002a7f91c75be": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_new_a12002a7f91c75be"](p0i32);
/******/ 					},
/******/ 					"__wbg_newwithbyteoffsetandlength_d97e637ebe145a9a": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_newwithbyteoffsetandlength_d97e637ebe145a9a"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbindgen_is_undefined": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_is_undefined"](p0i32);
/******/ 					},
/******/ 					"__wbindgen_is_object": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_is_object"](p0i32);
/******/ 					},
/******/ 					"__wbg_buffer_609cc3eee51ed158": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_buffer_609cc3eee51ed158"](p0i32);
/******/ 					},
/******/ 					"__wbg_stringify_f7ed6987935b4a24": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_stringify_f7ed6987935b4a24"](p0i32);
/******/ 					},
/******/ 					"__wbg_get_67b2ba62fc30de12": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_get_67b2ba62fc30de12"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_has_a5ea9117f258a0ec": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_has_a5ea9117f258a0ec"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_jsval_eq": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_jsval_eq"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_new_592cfd1910fe92ab": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_new_592cfd1910fe92ab"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_call_ca9f902b9c01d6a4": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_call_ca9f902b9c01d6a4"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_self_53a054fa1aa99285": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_self_53a054fa1aa99285"](p0i32);
/******/ 					},
/******/ 					"__wbg_crypto_b8b8d219dd106386": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_crypto_b8b8d219dd106386"](p0i32);
/******/ 					},
/******/ 					"__wbg_getRandomValues_37d862323ab7a9ea": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_getRandomValues_37d862323ab7a9ea"](p0i32);
/******/ 					},
/******/ 					"__wbg_getRandomValues_f95fbcecd77f2425": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_getRandomValues_f95fbcecd77f2425"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbg_require_51e6ff2a093da33e": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_require_51e6ff2a093da33e"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbg_randomFillSync_dacc4c955df2f8ce": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbg_randomFillSync_dacc4c955df2f8ce"](p0i32,p1i32,p2i32);
/******/ 					},
/******/ 					"__wbindgen_debug_string": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_debug_string"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_object_drop_ref": function(p0i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_object_drop_ref"](p0i32);
/******/ 					},
/******/ 					"__wbindgen_throw": function(p0i32,p1i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_throw"](p0i32,p1i32);
/******/ 					},
/******/ 					"__wbindgen_memory": function() {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_memory"]();
/******/ 					},
/******/ 					"__wbindgen_closure_wrapper5748": function(p0i32,p1i32,p2i32) {
/******/ 						return installedModules["./pkg/index_bg.js"].exports["__wbindgen_closure_wrapper5748"](p0i32,p1i32,p2i32);
/******/ 					}
/******/ 				}
/******/ 			};
/******/ 		},
/******/ 	};
/******/
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/
/******/ 		// Check if module is in cache
/******/ 		if(installedModules[moduleId]) {
/******/ 			return installedModules[moduleId].exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = installedModules[moduleId] = {
/******/ 			i: moduleId,
/******/ 			l: false,
/******/ 			exports: {}
/******/ 		};
/******/
/******/ 		// Execute the module function
/******/ 		modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/
/******/ 		// Flag the module as loaded
/******/ 		module.l = true;
/******/
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/
/******/ 	// This file contains only the entry chunk.
/******/ 	// The chunk loading function for additional chunks
/******/ 	__webpack_require__.e = function requireEnsure(chunkId) {
/******/ 		var promises = [];
/******/
/******/
/******/ 		// JSONP chunk loading for javascript
/******/
/******/ 		var installedChunkData = installedChunks[chunkId];
/******/ 		if(installedChunkData !== 0) { // 0 means "already installed".
/******/
/******/ 			// a Promise means "currently loading".
/******/ 			if(installedChunkData) {
/******/ 				promises.push(installedChunkData[2]);
/******/ 			} else {
/******/ 				// setup Promise in chunk cache
/******/ 				var promise = new Promise(function(resolve, reject) {
/******/ 					installedChunkData = installedChunks[chunkId] = [resolve, reject];
/******/ 				});
/******/ 				promises.push(installedChunkData[2] = promise);
/******/
/******/ 				// start chunk loading
/******/ 				var script = document.createElement('script');
/******/ 				var onScriptComplete;
/******/
/******/ 				script.charset = 'utf-8';
/******/ 				script.timeout = 120;
/******/ 				if (__webpack_require__.nc) {
/******/ 					script.setAttribute("nonce", __webpack_require__.nc);
/******/ 				}
/******/ 				script.src = jsonpScriptSrc(chunkId);
/******/
/******/ 				// create error before stack unwound to get useful stacktrace later
/******/ 				var error = new Error();
/******/ 				onScriptComplete = function (event) {
/******/ 					// avoid mem leaks in IE.
/******/ 					script.onerror = script.onload = null;
/******/ 					clearTimeout(timeout);
/******/ 					var chunk = installedChunks[chunkId];
/******/ 					if(chunk !== 0) {
/******/ 						if(chunk) {
/******/ 							var errorType = event && (event.type === 'load' ? 'missing' : event.type);
/******/ 							var realSrc = event && event.target && event.target.src;
/******/ 							error.message = 'Loading chunk ' + chunkId + ' failed.\n(' + errorType + ': ' + realSrc + ')';
/******/ 							error.name = 'ChunkLoadError';
/******/ 							error.type = errorType;
/******/ 							error.request = realSrc;
/******/ 							chunk[1](error);
/******/ 						}
/******/ 						installedChunks[chunkId] = undefined;
/******/ 					}
/******/ 				};
/******/ 				var timeout = setTimeout(function(){
/******/ 					onScriptComplete({ type: 'timeout', target: script });
/******/ 				}, 120000);
/******/ 				script.onerror = script.onload = onScriptComplete;
/******/ 				document.head.appendChild(script);
/******/ 			}
/******/ 		}
/******/
/******/ 		// Fetch + compile chunk loading for webassembly
/******/
/******/ 		var wasmModules = {"1":["./pkg/index_bg.wasm"]}[chunkId] || [];
/******/
/******/ 		wasmModules.forEach(function(wasmModuleId) {
/******/ 			var installedWasmModuleData = installedWasmModules[wasmModuleId];
/******/
/******/ 			// a Promise means "currently loading" or "already loaded".
/******/ 			if(installedWasmModuleData)
/******/ 				promises.push(installedWasmModuleData);
/******/ 			else {
/******/ 				var importObject = wasmImportObjects[wasmModuleId]();
/******/ 				var req = fetch(__webpack_require__.p + "" + {"./pkg/index_bg.wasm":"c1f088aaa7bce35c293c"}[wasmModuleId] + ".module.wasm");
/******/ 				var promise;
/******/ 				if(importObject instanceof Promise && typeof WebAssembly.compileStreaming === 'function') {
/******/ 					promise = Promise.all([WebAssembly.compileStreaming(req), importObject]).then(function(items) {
/******/ 						return WebAssembly.instantiate(items[0], items[1]);
/******/ 					});
/******/ 				} else if(typeof WebAssembly.instantiateStreaming === 'function') {
/******/ 					promise = WebAssembly.instantiateStreaming(req, importObject);
/******/ 				} else {
/******/ 					var bytesPromise = req.then(function(x) { return x.arrayBuffer(); });
/******/ 					promise = bytesPromise.then(function(bytes) {
/******/ 						return WebAssembly.instantiate(bytes, importObject);
/******/ 					});
/******/ 				}
/******/ 				promises.push(installedWasmModules[wasmModuleId] = promise.then(function(res) {
/******/ 					return __webpack_require__.w[wasmModuleId] = (res.instance || res).exports;
/******/ 				}));
/******/ 			}
/******/ 		});
/******/ 		return Promise.all(promises);
/******/ 	};
/******/
/******/ 	// expose the modules object (__webpack_modules__)
/******/ 	__webpack_require__.m = modules;
/******/
/******/ 	// expose the module cache
/******/ 	__webpack_require__.c = installedModules;
/******/
/******/ 	// define getter function for harmony exports
/******/ 	__webpack_require__.d = function(exports, name, getter) {
/******/ 		if(!__webpack_require__.o(exports, name)) {
/******/ 			Object.defineProperty(exports, name, { enumerable: true, get: getter });
/******/ 		}
/******/ 	};
/******/
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = function(exports) {
/******/ 		if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		}
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/
/******/ 	// create a fake namespace object
/******/ 	// mode & 1: value is a module id, require it
/******/ 	// mode & 2: merge all properties of value into the ns
/******/ 	// mode & 4: return value when already ns object
/******/ 	// mode & 8|1: behave like require
/******/ 	__webpack_require__.t = function(value, mode) {
/******/ 		if(mode & 1) value = __webpack_require__(value);
/******/ 		if(mode & 8) return value;
/******/ 		if((mode & 4) && typeof value === 'object' && value && value.__esModule) return value;
/******/ 		var ns = Object.create(null);
/******/ 		__webpack_require__.r(ns);
/******/ 		Object.defineProperty(ns, 'default', { enumerable: true, value: value });
/******/ 		if(mode & 2 && typeof value != 'string') for(var key in value) __webpack_require__.d(ns, key, function(key) { return value[key]; }.bind(null, key));
/******/ 		return ns;
/******/ 	};
/******/
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function getDefault() { return module['default']; } :
/******/ 			function getModuleExports() { return module; };
/******/ 		__webpack_require__.d(getter, 'a', getter);
/******/ 		return getter;
/******/ 	};
/******/
/******/ 	// Object.prototype.hasOwnProperty.call
/******/ 	__webpack_require__.o = function(object, property) { return Object.prototype.hasOwnProperty.call(object, property); };
/******/
/******/ 	// __webpack_public_path__
/******/ 	__webpack_require__.p = "";
/******/
/******/ 	// on error function for async loading
/******/ 	__webpack_require__.oe = function(err) { console.error(err); throw err; };
/******/
/******/ 	// object with all WebAssembly.instance exports
/******/ 	__webpack_require__.w = {};
/******/
/******/ 	var jsonpArray = window["webpackJsonp"] = window["webpackJsonp"] || [];
/******/ 	var oldJsonpFunction = jsonpArray.push.bind(jsonpArray);
/******/ 	jsonpArray.push = webpackJsonpCallback;
/******/ 	jsonpArray = jsonpArray.slice();
/******/ 	for(var i = 0; i < jsonpArray.length; i++) webpackJsonpCallback(jsonpArray[i]);
/******/ 	var parentJsonpFunction = oldJsonpFunction;
/******/
/******/
/******/ 	// Load entry module and return exports
/******/ 	return __webpack_require__(__webpack_require__.s = "./run_keygen_sign.js");
/******/ })
/************************************************************************/
/******/ ({

/***/ "./run_keygen_sign.js":
/*!****************************!*\
  !*** ./run_keygen_sign.js ***!
  \****************************/
/*! no static exports found */
/***/ (function(module, exports, __webpack_require__) {

eval("const thsig = Promise.all(/*! import() */[__webpack_require__.e(0), __webpack_require__.e(1)]).then(__webpack_require__.bind(null, /*! ./pkg */ \"./pkg/index.js\"));\n\nvar items = [{ idx: 0 }, { idx: 1 }, { idx: 2 }];\nvar results = [];\n\nlet t = 1;\nlet n = 3;\nlet addr = \"http://127.0.0.1:8000\"\n\nconst delay_ms = ms => new Promise(resolve => setTimeout(resolve, ms))\n\nasync function keygen(m, arg, delay) {\n  let context = await m.gg18_keygen_client_new_context(addr, t, n, delay);\n  console.log(\"keygen new context: \", context);\n  context = await m.gg18_keygen_client_round1(context, delay);\n  console.log(\"keygen round1: \", context);\n  context = await m.gg18_keygen_client_round2(context, delay);\n  console.log(\"keygen round2: \", context);\n  context = await m.gg18_keygen_client_round3(context, delay);\n  console.log(\"keygen round3: \", context);\n  context = await m.gg18_keygen_client_round4(context, delay);\n  console.log(\"keygen round4: \", context);\n  keygen_json = await m.gg18_keygen_client_round5(context, delay);\n  console.log(\"keygen json: \", keygen_json);\n  return keygen_json;\n}\n\nasync function sign(m, arg, key_store, delay) {\n  let context = await m.gg18_sign_client_new_context(\n    addr,\n    t,\n    n,\n    key_store,\n    ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Hello Eigen')).slice(2)\n  );\n  console.log(\"sign new context: \", context);\n  context = await m.gg18_sign_client_round0(context, delay);\n  console.log(\"sign round0: \", context);\n  context = await m.gg18_sign_client_round1(context, delay);\n  console.log(\"sign round1: \", context);\n  context = await m.gg18_sign_client_round2(context, delay);\n  console.log(\"sign round2: \", context);\n  context = await m.gg18_sign_client_round3(context, delay);\n  console.log(\"sign round3: \", context);\n  context = await m.gg18_sign_client_round4(context, delay);\n  console.log(\"sign round4: \", context);\n  context = await m.gg18_sign_client_round5(context, delay);\n  console.log(\"sign round5: \", context);\n  context = await m.gg18_sign_client_round6(context, delay);\n  console.log(\"sign round6: \", context);\n  context = await m.gg18_sign_client_round7(context, delay);\n  console.log(\"sign round7: \", context);\n  context = await m.gg18_sign_client_round8(context, delay);\n  console.log(\"sign round8: \", context);\n  sign_json = await m.gg18_sign_client_round9(context, delay);\n  console.log(\"keygen json: \", sign_json);\n  return sign_json;\n}\n\n/*\nasync function main() {\n  const gg18 = await thsig;\n  await Promise.all(\n    items.map(\n      async (item) => {\n        let delay = Math.max(Math.random() % 500, 100);\n        res = await keygen(gg18, item, delay);\n        console.log(\"Keysign done\", item.idx, \" \", res);\n        results.push(res);\n      }\n    )\n  )\n\n  await Promise.all(\n    items.map(\n      async (item) => {\n        if (item.idx < t+1) {\n          let delay = Math.max(Math.random() % 500, 100);\n          delay_ms(delay);\n          console.log(item.idx, \" \", results[item.idx]);\n          res = await sign(gg18, item, results[item.idx], delay + 1);\n          console.log(\"Sign result: \", res);\n        }\n      }\n    )\n  )\n}\n\nmain().then(() => {\n  console.log(\"Done\");\n})\n*/\nthsig.then((m) => {\n  items.forEach(async function (item) {\n    let delay = Math.max(Math.random() % 500, 100);\n    res = await keygen(m, item, delay);\n    console.log(item.idx, \" \", res);\n    results.push(res);\n\n    if (results.length == items.length) {\n      console.log(results.length);\n      items.forEach(async function (item) {\n        if (item.idx < t + 1) {\n          console.log(item.idx, \" \", results[item.idx]);\n          let delay = Math.max(Math.random() % 500, 100);\n          res = await sign(m, item, results[item.idx], delay);\n          console.log(\"Sign result: \", res);\n        }\n      });\n    }\n  });\n});\n\n\n//# sourceURL=webpack:///./run_keygen_sign.js?");

/***/ })

/******/ });