/**
 * background.js
 * Background script for the Spaces extension
 * 
 * This script serves as the main controller for the extension, handling:
 * - Chrome extension event listeners
 * - Window and tab management
 * - Message passing between different parts of the extension
 * - UI window management
 * - Session state coordination
 */

/* eslint-disable no-restricted-globals */
/* eslint-disable no-alert */
/* global chrome spacesService */

/* spaces
 * Copyright (C) 2015 Dean Oemcke
 */

import {spacesService} from './spacesService.js';
import * as Comlink from '../comlink-extension/node_modules/comlink/dist/esm/comlink.mjs';
import { createBackgroundEndpoint, isMessagePort } from '../build/comlink-extension.bundle.js';

// Stub screen object for service worker environment
const screen = {
    width: 1000,
    height: 1000,
};

// Main spaces module - handles all core extension functionality
var spaces = (() => {
    // Track IDs of extension's own windows
    let spacesPopupWindowId = false;
    let spacesOpenWindowId = false;
    
    // Utility functions
    const noop = () => {};
    const debug = false;

    // CHROME EVENT LISTENERS

    /**
     * Tab creation listener
     * Updates spaces window when new tabs are created
     */
    chrome.tabs.onCreated.addListener(tab => {
        if (checkInternalSpacesWindows(tab.windowId, false)) return;
        updateSpacesWindow('tabs.onCreated');
    });

    /**
     * Tab removal listener
     * Handles cleanup and updates when tabs are closed
     */
    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
        if (checkInternalSpacesWindows(removeInfo.windowId, false)) return;
        spacesService.handleTabRemoved(tabId, removeInfo, () => {
            updateSpacesWindow('tabs.onRemoved');
        });
    });

    /**
     * Tab movement listener
     * Handles tabs being moved between windows
     */
    chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
        if (checkInternalSpacesWindows(moveInfo.windowId, false)) return;
        spacesService.handleTabMoved(tabId, moveInfo, () => {
            updateSpacesWindow('tabs.onMoved');
        });
    });

    /**
     * Tab update listener
     * Handles tab content and state changes
     */
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
        if (checkInternalSpacesWindows(tab.windowId, false)) return;

        try {
            if (changeInfo.status === 'complete') {
                const session = spacesService.getSessionByWindowId(tab.windowId);
                if (session && session.name) {
                    return;
                }
            }

            spacesService.handleTabUpdated(tab, changeInfo, () => {
                updateSpacesWindow('tabs.onUpdated');
            });
        } catch (error) {
            console.error('Error in tabs.onUpdated:', error);
        }
    });

    /**
     * Window removal listener
     * Handles cleanup when windows are closed
     */
    chrome.windows.onRemoved.addListener(windowId => {
        if (checkInternalSpacesWindows(windowId, true)) return;
        spacesService.handleWindowRemoved(windowId, true, () => {
            updateSpacesWindow('windows.onRemoved');
        });

        chrome.windows.getAll({}, windows => {
            if (windows.length === 1 && spacesOpenWindowId) {
                chrome.windows.remove(spacesOpenWindowId);
            }
        });
    });

    /**
     * Window focus change listener
     * Updates UI and session state on window focus
     */
    chrome.windows.onFocusChanged.addListener(async (windowId) => {
        if (windowId === chrome.windows.WINDOW_ID_NONE ||
            windowId === spacesPopupWindowId) {
            return;
        }

        try {
            if (!debug && spacesPopupWindowId) {
                closePopupWindow();
            }
            spacesService.handleWindowFocussed(windowId);
        } catch (error) {
            console.error('Error in windows.onFocusChanged:', error);
        }
    });

    /**
     * Message handler for extension communication
     * Processes requests from popup and other extension pages
     */
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (debug) {
            console.log(`listener fired: ${JSON.stringify(request)}`);
        }

        let sessionId;
        let windowId;
        let tabId;

        if (request.screen) {
            screen.width = request.screen.width;
            screen.height = request.screen.height;
        }

        switch (request.action) {
            case 'loadSession':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId) {
                    handleLoadSession(sessionId);
                    sendResponse(true);
                }
                return true;

            case 'loadWindow':
                windowId = _cleanParameter(request.windowId);
                if (windowId) {
                    handleLoadWindow(windowId);
                    sendResponse(true);
                }
                return true;

            case 'loadTabInSession':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId && request.tabUrl) {
                    handleLoadSession(sessionId, request.tabUrl);
                    sendResponse(true);
                }
                return true;

            case 'loadTabInWindow':
                windowId = _cleanParameter(request.windowId);
                if (windowId && request.tabUrl) {
                    handleLoadWindow(windowId, request.tabUrl);
                    sendResponse(true);
                }
                return true;

            case 'saveNewSession':
                windowId = _cleanParameter(request.windowId);
                if (windowId && request.sessionName) {
                    handleSaveNewSession(windowId, request.sessionName, sendResponse);
                }
                return true;

            case 'importNewSession':
                if (request.urlList) {
                    handleImportNewSession(request.urlList, sendResponse);
                }
                return true;

            case 'restoreFromBackup':
                if (request.spaces) {
                    handleRestoreFromBackup(request.spaces, sendResponse);
                }
                return true;

            case 'deleteSession':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId) {
                    handleDeleteSession(sessionId, false, sendResponse);
                }
                return true;

            case 'updateSessionName':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId && request.sessionName) {
                    handleUpdateSessionName(sessionId, request.sessionName, sendResponse);
                }
                return true;

            case 'requestSpaceDetail':
                windowId = _cleanParameter(request.windowId);
                sessionId = _cleanParameter(request.sessionId);

                if (windowId) {
                    if (checkInternalSpacesWindows(windowId, false)) {
                        sendResponse(false);
                    } else {
                        requestSpaceFromWindowId(windowId).then(r => {sendResponse(r)});
                    }
                } else if (sessionId) {
                    requestSpaceFromSessionId(sessionId).then(r => {sendResponse(r)});
                }
                return true;

            case 'requestAllSpaces':
                requestAllSpaces(allSpaces => {
                    sendResponse(allSpaces);
                });
                return true;

            case 'requestHotkeys':
                requestHotkeys().then(r => {sendResponse(r)});
                return true;

            case 'uiConfirm':
                {
                    const userConfirmed = confirm(request.message);
                    sendResponse(userConfirmed);
                }
                return true;

            case 'requestTabDetail':
                tabId = _cleanParameter(request.tabId);
                if (tabId) {
                    requestTabDetail(tabId, tab => {
                        if (tab) {
                            sendResponse(tab);
                        } else {
                            closePopupWindow();
                        }
                    });
                }
                return true;

            case 'requestShowSpaces':
                windowId = _cleanParameter(request.windowId);
                if (windowId) {
                    showSpacesOpenWindow(windowId, request.edit);
                } else {
                    showSpacesOpenWindow();
                }
                return false;

            case 'requestShowSwitcher':
                showSpacesSwitchWindow();
                return false;

            case 'requestShowMover':
                showSpacesMoveWindow();
                return false;

            case 'requestShowKeyboardShortcuts':
                createShortcutsWindow();
                return false;

            case 'requestClose':
                closePopupWindow();
                return false;

            case 'switchToSpace':
                windowId = _cleanParameter(request.windowId);
                sessionId = _cleanParameter(request.sessionId);
                if (windowId) {
                    handleLoadWindow(windowId);
                } else if (sessionId) {
                    handleLoadSession(sessionId);
                }
                return false;

            case 'addLinkToNewSession':
                tabId = _cleanParameter(request.tabId);
                if (request.sessionName && request.url) {
                    handleAddLinkToNewSession(request.url, request.sessionName, result => {
                        if (result) {
                            updateSpacesWindow('addLinkToNewSession');
                        }
                        closePopupWindow();
                    });
                }
                return false;

            case 'moveTabToNewSession':
                tabId = _cleanParameter(request.tabId);
                if (request.sessionName && tabId) {
                    handleMoveTabToNewSession(tabId, request.sessionName, result => {
                        if (result) {
                            updateSpacesWindow('moveTabToNewSession');
                        }
                        closePopupWindow();
                    });
                }
                return false;

            case 'addLinkToSession':
                sessionId = _cleanParameter(request.sessionId);
                if (sessionId && request.url) {
                    handleAddLinkToSession(request.url, sessionId, result => {
                        if (result) updateSpacesWindow('addLinkToSession');
                        closePopupWindow();
                    });
                }
                return false;

            case 'moveTabToSession':
                sessionId = _cleanParameter(request.sessionId);
                tabId = _cleanParameter(request.tabId);
                if (sessionId && tabId) {
                    handleMoveTabToSession(tabId, sessionId, result => {
                        if (result) updateSpacesWindow('moveTabToSession');
                        closePopupWindow();
                    });
                }
                return false;

            case 'addLinkToWindow':
                windowId = _cleanParameter(request.windowId);
                if (windowId && request.url) {
                    handleAddLinkToWindow(request.url, windowId, result => {
                        if (result) updateSpacesWindow('addLinkToWindow');
                        closePopupWindow();
                    });
                }
                return false;

            case 'moveTabToWindow':
                windowId = _cleanParameter(request.windowId);
                tabId = _cleanParameter(request.tabId);
                if (windowId && tabId) {
                    handleMoveTabToWindow(tabId, windowId, result => {
                        if (result) updateSpacesWindow('moveTabToWindow');
                        closePopupWindow();
                    });
                }
                return false;

            default:
                return false;
        }
    });

    /**
     * Clean parameter values for consistency
     * @param {*} param - Parameter to clean
     * @returns {number|boolean} Cleaned parameter value
     */
    function _cleanParameter(param) {
        if (typeof param === 'number') {
            return param;
        }
        if (param === 'false') {
            return false;
        }
        if (param === 'true') {
            return true;
        }
        return parseInt(param, 10);
    }

    /**
     * Keyboard command listener
     * Handles extension keyboard shortcuts
     */
    chrome.commands.onCommand.addListener(command => {
        if (command === 'spaces-move') {
            showSpacesMoveWindow();
        } else if (command === 'spaces-switch') {
            showSpacesSwitchWindow();
        }
    });

    /**
     * Context menu click handler
     * Handles right-click menu actions
     */
    chrome.contextMenus.onClicked.addListener(info => {
        if (info.menuItemId === 'spaces-add-link') {
            showSpacesMoveWindow(info.linkUrl);
        }
    });

    /**
     * Extension installation/update handler
     * Sets up context menus and handles version updates
     */
    chrome.runtime.onInstalled.addListener(async (details) => {
        await chrome.contextMenus.removeAll();
        await chrome.contextMenus.create({
            id: 'spaces-add-link',
            title: 'Add link to space...',
            contexts: ['link']
        });

        if (details.reason === 'install') {
            console.log('This is a first install!');
            showSpacesOpenWindow();
        } else if (details.reason === 'update') {
            const thisVersion = chrome.runtime.getManifest().version;
            if (details.previousVersion !== thisVersion) {
                console.log(`Updated from ${details.previousVersion} to ${thisVersion}!`);
            }
        }
    });

    /**
     * Create Chrome shortcuts configuration window
     */
    function createShortcutsWindow() {
        chrome.tabs.create({ url: 'chrome://extensions/configureCommands' });
    }

    /**
     * Show main spaces management window
     * @param {number} windowId - Optional window ID to focus
     * @param {boolean} editMode - Whether to open in edit mode
     */
    function showSpacesOpenWindow(windowId, editMode) {
        let url;

        if (editMode && windowId) {
            url = chrome.runtime.getURL(`spaces.html#windowId=${windowId}&editMode=true`);
        } else {
            url = chrome.runtime.getURL('spaces.html');
        }

        if (spacesOpenWindowId) {
            chrome.windows.get(spacesOpenWindowId, { populate: true }, window => {
                chrome.windows.update(spacesOpenWindowId, { focused: true });
                if (window.tabs[0].id) {
                    chrome.tabs.update(window.tabs[0].id, { url });
                }
            });
        } else {
            chrome.windows.create({
                type: 'popup',
                url,
                height: screen.height - 100,
                width: Math.min(screen.width, 1000),
                top: 0,
                left: 0,
            }, window => {
                spacesOpenWindowId = window.id;
            });
        }
    }

    /**
     * Show tab/link move dialog
     * @param {string} tabUrl - Optional URL to move
     */
    function showSpacesMoveWindow(tabUrl) {
        createOrShowSpacesPopupWindow('move', tabUrl);
    }

    /**
     * Show space switcher dialog
     */
    function showSpacesSwitchWindow() {
        createOrShowSpacesPopupWindow('switch');
    }

    /**
     * Generate parameters for popup windows
     * @param {string} action - Action type
     * @param {string} tabUrl - Optional URL
     */
    async function generatePopupParams(action, tabUrl) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length === 0) return '';

        const activeTab = tabs[0];
        if (checkInternalSpacesWindows(activeTab.windowId, false)) {
            return '';
        }

        const session = spacesService.getSessionByWindowId(activeTab.windowId);
        const name = session ? session.name : '';

        let params = `action=${action}&windowId=${activeTab.windowId}&sessionName=${name}`;

        if (tabUrl) {
            params += `&url=${encodeURIComponent(tabUrl)}`;
        } else {
            params += `&tabId=${activeTab.id}`;
        }
        return params;
    }

    /**
     * Create or focus existing popup window
     * @param {string} action - Window action type
     * @param {string} tabUrl - Optional URL to handle
     */
    function createOrShowSpacesPopupWindow(action, tabUrl) {
        generatePopupParams(action, tabUrl).then(params => {
            const popupUrl = `${chrome.runtime.getURL('popup.html')}#opener=bg&${params}`;
            if (spacesPopupWindowId) {
                chrome.windows.get(spacesPopupWindowId, { populate: true }, window => {
                    if (window.focused) {
                        // do nothing
                    } else {
                        chrome.windows.update(spacesPopupWindowId, { focused: true });
                        if (window.tabs[0].id) {
                            chrome.tabs.update(window.tabs[0].id, { url: popupUrl });
                        }
                    }
                });
            } else {
                chrome.windows.create({
                    type: 'popup',
                    url: popupUrl,
                    focused: true,
                    height: 450,
                    width: 310,
                    top: screen.height - 450,
                    left: screen.width - 310,
                }, window => {
                    spacesPopupWindowId = window.id;
                });
            }
        });
    }

    /**
     * Close popup window and clean up history
     */
    function closePopupWindow() {
        if (spacesPopupWindowId) {
            chrome.windows.get(spacesPopupWindowId, { populate: true }, spacesWindow => {
                if (!spacesWindow) return;

                if (spacesWindow.tabs.length > 0 && spacesWindow.tabs[0].url) {
                    chrome.history.deleteUrl({ url: spacesWindow.tabs[0].url });
                }

                chrome.windows.remove(spacesWindow.id, () => {
                    if (chrome.runtime.lastError) {
                        console.log(chrome.runtime.lastError.message);
                    }
                });
            });
        }
    }

    /**
     * Update spaces window UI
     * @param {string} source - Source of update trigger
     */
   /**
 * Update spaces window UI
 * @param {string} source - Source of update trigger
 */
    function updateSpacesWindow(source) {
        if (debug) console.log(`updateSpacesWindow triggered. source: ${source}`);

        requestAllSpaces(allSpaces => {
            // Add error handling to avoid "Receiving end does not exist" noise
            chrome.runtime.sendMessage({
                action: 'updateSpaces',
                spaces: allSpaces,
            }, () => {
                if (chrome.runtime.lastError &&
                    chrome.runtime.lastError.message &&
                    chrome.runtime.lastError.message.includes('Receiving end does not exist')) {
                    // This just means there's no open "spaces.html" or extension page
                    // listening for this message. Safe to ignore.
                    return;
                }
                if (chrome.runtime.lastError) {
                    console.warn('[updateSpacesWindow] ' + chrome.runtime.lastError.message);
                }
            });
        });
    }

    /**
     * Check if window is internal to extension
     * @param {number} windowId - Window to check
     * @param {boolean} windowClosed - Whether window is being closed
     */
    function checkInternalSpacesWindows(windowId, windowClosed) {
        if (windowId === spacesOpenWindowId) {
            if (windowClosed) spacesOpenWindowId = false;
            return true;
        }
        if (windowId === spacesPopupWindowId) {
            if (windowClosed) spacesPopupWindowId = false;
            return true;
        }
        return false;
    }

    /**
     * Check if session can be overwritten
     * @param {Object} session - Session to check
     */
    async function checkSessionOverwrite(session) {
        if (session.windowId) {
            await chrome.runtime.sendMessage({
                action: 'uiAlert',
                message: `A session with the name '${session.name}' is currently open an cannot be overwritten`
            });
            return false;
        }
        return await chrome.runtime.sendMessage({
            action: 'uiConfirm',
            message: `Replace existing space: ${session.name}?`
        });
    }

    /**
     * Confirm session deletion
     * @param {Object} session - Session to delete
     */
    async function checkSessionDelete(session) {
        return await chrome.runtime.sendMessage({
            action: 'uiConfirm',
            message: `Are you sure you want to delete the space: ${session.name}?`
        });
    }

    /**
     * Get keyboard shortcuts configuration
     */
    async function requestHotkeys() {
        const commands = await chrome.commands.getAll();
        let switchStr;
        let moveStr;
        let spacesStr;

        commands.forEach(command => {
            if (command.name === 'spaces-switch') {
                switchStr = command.shortcut;
            } else if (command.name === 'spaces-move') {
                moveStr = command.shortcut;
            } else if (command.name === 'spaces-open') {
                spacesStr = command.shortcut;
            }
        });

        return {
            switchCode: switchStr,
            moveCode: moveStr,
            spacesCode: spacesStr,
        };
    }

    /**
     * Get tab details
     * @param {number} tabId - ID of tab to get
     */
    function requestTabDetail(tabId, callback) {
        chrome.tabs.get(tabId, callback);
    }

    /**
     * Get current active space
     */
    async function requestCurrentSpace() {
        const window = await chrome.windows.getCurrent();
        return await requestSpaceFromWindowId(window.id);
    }

    /**
     * Get space details by window ID
     * @param {number} windowId - Window to get space for
     */
    async function requestSpaceFromWindowId(windowId) {
        const session = spacesService.getSessionByWindowId(windowId);

        if (session) {
            return {
                sessionId: session.id,
                windowId: session.windowId,
                name: session.name,
                tabs: session.tabs,
                history: session.history,
            };
        } else {
            let window;
            try {
                window = await chrome.windows.get(windowId, { populate: true });
            } catch(e) {
                return false;
            }
            return {
                sessionId: false,
                windowId: window.id,
                name: false,
                tabs: window.tabs,
                history: false,
            };
        }
    }

    /**
     * Get space details by session ID
     * @param {string} sessionId - Session to get space for
     */
    async function requestSpaceFromSessionId(sessionId) {
        const session = spacesService.getSessionBySessionId(sessionId);

        return {
            sessionId: session.id,
            windowId: session.windowId,
            name: session.name,
            tabs: session.tabs,
            history: session.history,
        };
    }

    /**
     * Get all spaces
     * Returns sorted list of all sessions
     */
    function requestAllSpaces(callback) {
        const sessions = spacesService.getAllSessions();
        const allSpaces = sessions
            .map(session => {
                return { sessionId: session.id, ...session };
            })
            .filter(session => {
                return session && session.tabs && session.tabs.length > 0;
            });

        allSpaces.sort(spaceDateCompare);

        callback(allSpaces);
    }

    /**
     * Compare spaces by date for sorting
     */
    function spaceDateCompare(a, b) {
        if (a.windowId && !b.windowId) {
            return -1;
        }
        if (!a.windowId && b.windowId) {
            return 1;
        }
        if (a.lastAccess > b.lastAccess) {
            return -1;
        }
        if (a.lastAccess < b.lastAccess) {
            return 1;
        }
        return 0;
    }

    /**
     * Wait for all tabs in window to complete loading
     * @param {number} windowId - Window to wait for
     */
    async function waitForTabsComplete(windowId, maxAttempts = 10) {
        let attempt = 0;
        while (attempt < maxAttempts) {
            try {
                const w = await chrome.windows.get(windowId, { populate: true });
                const incompleteTab = w.tabs.find(t => t.status !== 'complete');
                // If all tabs are loaded (can't find any tab that's not complete), return
                if (!incompleteTab) {
                    return w;
                }
            } catch (err) {
                console.warn('waitForTabsComplete error:', err);
            }
            attempt += 1;
            // Wait 1 second and try again
            await new Promise(r => setTimeout(r, 1000));
        }
        // Return even if exceeded max attempts
        return chrome.windows.get(windowId, { populate: true });
    }

    /**
     * Load saved session
     * @param {string} sessionId - Session to load
     * @param {string} tabUrl - Optional URL to focus
     */
    async function handleLoadSession(sessionId, tabUrl) {
        try {
            const session = spacesService.getSessionBySessionId(sessionId);
            if (!session) {
                console.error('Session not found:', sessionId);
                return;
            }

            if (session.windowId) {
                await handleLoadWindow(session.windowId, tabUrl);
                return;
            }

            const urls = session.tabs.map(curTab => curTab.url);
            if (urls.length === 0) {
                console.error('No URLs found in session:', sessionId);
                return;
            }

            const newWindow = await chrome.windows.create({
                url: urls,
                height: session.height,
                width: session.width,
                top: session.top || 0,
                left: session.left || 0,
            });

            await spacesService.updateSessionWindowId(session.id, newWindow.id);

            for (const curSessionTab of session.tabs) {
                if (curSessionTab.pinned) {
                    const matchingTab = newWindow.tabs.find(curNewTab =>
                        curNewTab.url === curSessionTab.url ||
                        curNewTab.pendingUrl === curSessionTab.url
                    );
                    if (matchingTab) {
                        await chrome.tabs.update(matchingTab.id, { pinned: true });
                    }
                }
            }

            if (tabUrl) {
                await focusOrLoadTabInWindow(newWindow, tabUrl);
            }
        } catch (error) {
            console.error('Error in handleLoadSession:', error);
        }
    }

    /**
     * Load window
     * @param {number} windowId - Window to load
     * @param {string} tabUrl - Optional URL to focus
     */
    function handleLoadWindow(windowId, tabUrl) {
        if (!windowId) {
            console.error('Window ID is undefined in handleLoadWindow');
            return;
        }

        focusWindow(windowId);

        if (tabUrl) {
            chrome.windows.get(windowId, { populate: true }, window => {
                if (!window) {
                    console.error('Window not found:', windowId);
                    return;
                }
                focusOrLoadTabInWindow(window, tabUrl);
            });
        }
    }

    /**
     * Focus window
     * @param {number} windowId - Window to focus
     */
    function focusWindow(windowId) {
        if (!windowId) {
            console.error('Window ID is undefined in focusWindow');
            return;
        }
        chrome.windows.update(windowId, { focused: true });
    }

    /**
     * Focus tab or create new one
     * @param {Object} window - Window to focus/create tab in
     * @param {string} tabUrl - URL to focus/load
     */
    function focusOrLoadTabInWindow(window, tabUrl) {
        if (!window) {
            console.error('Window is undefined in focusOrLoadTabInWindow');
            return;
        }
        if (!tabUrl) {
            console.error('tabUrl is undefined in focusOrLoadTabInWindow');
            return;
        }
        const match = window.tabs.some(tab => {
            if (tab.url === tabUrl) {
                chrome.tabs.update(tab.id, { active: true });
                return true;
            }
            return false;
        });
        if (!match) {
            chrome.tabs.create({ windowId: window.id, url: tabUrl });
        }
    }

    /**
     * Save new session
     * @param {number} windowId - Window to save
     * @param {string} sessionName - Name for new session
     */
    function handleSaveNewSession(windowId, sessionName, callback) {
        (async () => {
            try {
                const curWindow = await chrome.windows.get(windowId, { populate: true });
                const existingSession = spacesService.getSessionByName(sessionName);

                if (existingSession) {
                    let overwrite = false;
                    try {
                        const spacesTabs = await chrome.tabs.query({
                            url: chrome.runtime.getURL('spaces.html')
                        });

                        if (spacesTabs.length > 0) {
                            overwrite = await new Promise((resolve) => {
                                chrome.tabs.sendMessage(spacesTabs[0].id, {
                                    action: 'uiConfirm',
                                    message: `Replace existing space: ${sessionName}?`
                                }, (response) => {
                                    if (chrome.runtime.lastError) {
                                        console.warn('Failed to show confirmation dialog:', chrome.runtime.lastError);
                                        resolve(false);
                                    } else {
                                        resolve(response);
                                    }
                                });
                            });
                        } else {
                            const tab = await chrome.tabs.create({
                                url: chrome.runtime.getURL('spaces.html'),
                                active: true
                            });

                            overwrite = await new Promise((resolve) => {
                                const listener = (message, sender, sendResponse) => {
                                    if (message.action === 'confirmationResult') {
                                        chrome.runtime.onMessage.removeListener(listener);
                                        chrome.tabs.remove(tab.id);
                                        resolve(message.result);
                                    }
                                };
                                chrome.runtime.onMessage.addListener(listener);

                                setTimeout(() => {
                                    chrome.tabs.sendMessage(tab.id, {
                                        action: 'uiConfirm',
                                        message: `Replace existing space: ${sessionName}?`
                                    });
                                }, 100);
                            });
                        }
                    } catch (err) {
                        console.warn('Failed to show confirmation dialog:', err);
                        overwrite = false;
                    }

                    if (!overwrite) {
                        callback(false);
                        return;
                    }

                    await new Promise(resolve => {
                        handleDeleteSession(existingSession.id, true, resolve);
                    });
                }

                const saveResult = await new Promise(resolve => {
                    spacesService.saveNewSession(
                        sessionName,
                        curWindow.tabs,
                        curWindow.id,
                        result => resolve(result)
                    );
                });

                callback(saveResult);
            } catch (error) {
                console.error('Error in handleSaveNewSession:', error);
                callback(false);
            }
        })();
    }

    /**
     * Restore sessions from backup
     * @param {Array} _spaces - Sessions to restore
     */
    function handleRestoreFromBackup(_spaces, callback) {
        (async () => {
            let existingSession;
            let performSave;

            const promises = [];
            for (let i = 0; i < _spaces.length; i += 1) {
                const space = _spaces[i];
                existingSession = space.name
                    ? spacesService.getSessionByName(space.name)
                    : false;
                performSave = true;

                if (existingSession) {
                    if (!await checkSessionOverwrite(existingSession)) {
                        performSave = false;
                    } else {
                        handleDeleteSession(existingSession.id, true, noop);
                    }
                }

                if (performSave) {
                    promises.push(
                        new Promise(resolve => {
                            spacesService.saveNewSession(
                                space.name,
                                space.tabs,
                                false,
                                resolve
                            );
                        })
                    );
                }
            }
            Promise.all(promises).then(callback);
        })();
    }

    /**
     * Import new session from URL list
     * @param {Array} urlList - URLs to import
     */
    function handleImportNewSession(urlList, callback) {
        let tempName = 'Imported space: ';
        let count = 1;

        while (spacesService.getSessionByName(tempName + count)) {
            count += 1;
        }

        tempName += count;

        const tabList = urlList.map(text => {
            return { url: text };
        });

        spacesService.saveNewSession(tempName, tabList, false, callback);
    }

    /**
     * Update session name
     * @param {string} sessionId - Session to update
     * @param {string} sessionName - New name
     */
    function handleUpdateSessionName(sessionId, sessionName, callback) {
        (async () => {
            try {
                const existingSession = spacesService.getSessionByName(sessionName);

                if (existingSession && existingSession.id !== sessionId) {
                    let overwrite = false;

                    try {
                        const spacesTabs = await chrome.tabs.query({
                            url: chrome.runtime.getURL('spaces.html')
                        });

                        if (spacesTabs.length > 0) {
                            overwrite = await new Promise((resolve) => {
                                chrome.tabs.sendMessage(spacesTabs[0].id, {
                                    action: 'uiConfirm',
                                    message: `Replace existing space: ${sessionName}?`
                                }, (response) => {
                                    if (chrome.runtime.lastError) {
                                        console.warn('Failed to show confirmation dialog:', chrome.runtime.lastError);
                                        resolve(false);
                                    } else {
                                        resolve(response);
                                    }
                                });
                            });
                        } else {
                            const tab = await chrome.tabs.create({
                                url: chrome.runtime.getURL('spaces.html'),
                                active: true
                            });

                            overwrite = await new Promise((resolve) => {
                                const listener = (message, sender, sendResponse) => {
                                    if (message.action === 'confirmationResult') {
                                        chrome.runtime.onMessage.removeListener(listener);
                                        chrome.tabs.remove(tab.id);
                                        resolve(message.result);
                                    }
                                };
                                chrome.runtime.onMessage.addListener(listener);

                                setTimeout(() => {
                                    chrome.tabs.sendMessage(tab.id, {
                                        action: 'uiConfirm',
                                        message: `Replace existing space: ${sessionName}?`
                                    });
                                }, 100);
                            });
                        }
                    } catch (err) {
                        console.warn('Failed to show confirmation dialog:', err);
                        overwrite = false;
                    }

                    if (!overwrite) {
                        callback(false);
                        return;
                    }

                    handleDeleteSession(existingSession.id, true, () => {
                        spacesService.updateSessionName(sessionId, sessionName, callback);
                    });
                } else {
                    spacesService.updateSessionName(sessionId, sessionName, callback);
                }
            } catch (error) {
                console.error('Error in handleUpdateSessionName:', error);
                callback(false);
            }
        })();
    }

    /**
     * Delete session
     * @param {string} sessionId - Session to delete
     * @param {boolean} force - Skip confirmation
     */
    function handleDeleteSession(sessionId, force, callback) {
        (async () => {
            const session = spacesService.getSessionBySessionId(sessionId);
            if (!force && !await checkSessionDelete(session)) {
                callback(false);
            } else {
                spacesService.deleteSession(sessionId, callback);
            }
        })();
    }

    /**
     * Add link to new session
     * @param {string} url - URL to add
     * @param {string} sessionName - Name for new session
     */
    function handleAddLinkToNewSession(url, sessionName, callback) {
        const session = spacesService.getSessionByName(sessionName);
        const newTabs = [{ url }];

        if (session) {
            callback(false);
        } else {
            spacesService.saveNewSession(sessionName, newTabs, false, callback);
        }
    }

    /**
     * Move tab to new session
     * @param {number} tabId - Tab to move
     * @param {string} sessionName - Name for new session
     */
    function handleMoveTabToNewSession(tabId, sessionName, callback) {
        requestTabDetail(tabId, tab => {
            const session = spacesService.getSessionByName(sessionName);
            const newTabs = [tab];

            if (session) {
                callback(false);
            } else {
                chrome.tabs.remove(tab.id);
                spacesService.saveNewSession(
                    sessionName,
                    newTabs,
                    false,
                    callback
                );
            }
        });
    }

    /**
     * Add link to existing session
     * @param {string} url - URL to add
     * @param {string} sessionId - Session to add to
     */
    function handleAddLinkToSession(url, sessionId, callback) {
        const session = spacesService.getSessionBySessionId(sessionId);
        const newTabs = [{ url }];

        if (!session) {
            callback(false);
            return;
        }
        if (session.windowId) {
            handleAddLinkToWindow(url, session.windowId, callback);
        } else {
            session.tabs = session.tabs.concat(newTabs);
            spacesService.updateSessionTabs(session.id, session.tabs, callback);
        }
    }

    /**
     * Add link to window
     * @param {string} url - URL to add
     * @param {number} windowId - Window to add to
     */
    function handleAddLinkToWindow(url, windowId, callback) {
        chrome.tabs.create({ windowId, url, active: false });
        spacesService.queueWindowEvent(windowId);
        callback(true);
    }

    /**
     * Move tab to session
     * @param {number} tabId - Tab to move
     * @param {string} sessionId - Session to move to
     */
    function handleMoveTabToSession(tabId, sessionId, callback) {
        requestTabDetail(tabId, tab => {
            const session = spacesService.getSessionBySessionId(sessionId);
            const newTabs = [tab];

            if (!session) {
                callback(false);
            } else {
                if (session.windowId) {
                    moveTabToWindow(tab, session.windowId, callback);
                    return;
                }

                chrome.tabs.remove(tab.id);
                session.tabs = session.tabs.concat(newTabs);
                spacesService.updateSessionTabs(session.id, session.tabs, callback);
            }
        });
    }

    /**
     * Move tab to window
     * @param {number} tabId - Tab to move
     * @param {number} windowId - Window to move to
     */
    function handleMoveTabToWindow(tabId, windowId, callback) {
        requestTabDetail(tabId, tab => {
            moveTabToWindow(tab, windowId, callback);
        });
    }

    /**
     * Move tab between windows
     * @param {Object} tab - Tab to move
     * @param {number} windowId - Destination window
     */
    function moveTabToWindow(tab, windowId, callback) {
        chrome.tabs.move(tab.id, { windowId, index: -1 });
        spacesService.queueWindowEvent(tab.windowId);
        spacesService.queueWindowEvent(windowId);
        callback(true);
    }

    // Public API
    return {
        requestSpaceFromWindowId,
        requestCurrentSpace,
        requestHotkeys,
        generatePopupParams,
    };
})();

// Set up message port for Comlink communication
chrome.runtime.onConnect.addListener((port) => {
    if (isMessagePort(port)) return;
    Comlink.expose(spaces, createBackgroundEndpoint(port));
});

// Initialize extension
try {
    spacesService.initialiseSpaces();
    spacesService.initialiseTabHistory();
} catch (err) {
    console.error('Error while initializing spacesService:', err);
}
