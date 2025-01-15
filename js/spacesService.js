/**
 * spacesService.js
 * Core service module for managing browser window spaces/sessions
 * 
 * This module provides the core functionality for the Spaces extension, handling:
 * - Session management (creating, updating, deleting spaces)
 * - Window tracking and synchronization
 * - Tab history management
 * - Space/session state persistence
 */

/* global chrome, dbService */

/* spaces
 * Copyright (C) 2015 Dean Oemcke
 */

import { dbService } from "./dbService.js";

// Core service object that manages all spaces/sessions functionality
export var spacesService = {
    // Map to track tab URL history for proper history management
    tabHistoryUrlMap: {},
    
    // Track windows that have been closed to prevent duplicate processing
    closedWindowIds: {},
    
    // Array of all active and saved sessions
    sessions: [],
    
    // Timers for debouncing session updates
    sessionUpdateTimers: {},
    
    // Queue for tracking tab history changes
    historyQueue: [],
    
    // Counter for tracking event processing order
    eventQueueCount: 0,
    
    // Track extension version for migration purposes
    lastVersion: 0,
    
    // Debug flag for development
    debug: false,
    
    // Queue for processing async operations
    queue: [],
    
    // Flag to prevent concurrent processing
    isProcessing: false,

    // Empty callback function
    noop: () => {},

    /**
     * Initialize the spaces service
     * - Updates version information
     * - Loads saved sessions from database
     * - Matches current windows with saved sessions
     */
    initialiseSpaces: async () => {
        // update version numbers
        spacesService.lastVersion = await spacesService.fetchLastVersion();
        await spacesService.setLastVersion(chrome.runtime.getManifest().version);

        dbService.fetchAllSessions(sessions => {
            if (
                chrome.runtime.getManifest().version === '0.18' &&
                chrome.runtime.getManifest().version !==
                    spacesService.lastVersion
            ) {
                spacesService.resetAllSessionHashes(sessions);
            }

            chrome.windows.getAll({ populate: true }, windows => {
                // populate session map from database
                spacesService.sessions = sessions;

                // clear any previously saved windowIds
                spacesService.sessions.forEach(session => {
                    session.windowId = false;
                });

                // then try to match current open windows with saved sessions
                windows.forEach(curWindow => {
                    if (!spacesService.filterInternalWindows(curWindow)) {
                        spacesService.checkForSessionMatch(curWindow);
                    }
                });
            });
        });
    },

    /**
     * Reset session hashes for all sessions
     * Used during version upgrades or data migrations
     */
    resetAllSessionHashes: sessions => {
        sessions.forEach(session => {
            session.sessionHash = spacesService.generateSessionHash(
                session.tabs
            );
            dbService.updateSession(session);
        });
    },

    /**
     * Initialize tab history tracking
     * Maps tab IDs to their URLs for history management
     */
    initialiseTabHistory: () => {
        chrome.tabs.query({}, tabs => {
            tabs.forEach(tab => {
                spacesService.tabHistoryUrlMap[tab.id] = tab.url;
            });
        });
    },

    /**
     * Clean URL by removing fragments, query parameters and handling suspended tabs
     * @param {string} url - URL to clean
     * @returns {string} Cleaned URL
     */
    _cleanUrl: url => {
        if (!url) {
            return '';
        }

        if (url.indexOf(chrome.runtime.id) >= 0) {
            return '';
        }

        if (url.indexOf('chrome:// newtab/') >= 0) {
            return '';
        }

        let cleanUrl = url;

        if (
            cleanUrl.indexOf('suspended.html') > 0 &&
            cleanUrl.indexOf('uri=') > 0
        ) {
            cleanUrl = cleanUrl.substring(
                cleanUrl.indexOf('uri=') + 4,
                cleanUrl.length
            );
        }

        if (cleanUrl.indexOf('#') > 0) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.indexOf('#'));
        }

        if (cleanUrl.indexOf('?') > 0) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.indexOf('?'));
        }

        return cleanUrl;
    },

    /**
     * Generate a unique hash for a session based on its tabs
     * Used for matching windows with saved sessions
     * @param {Array} tabs - Array of tab objects
     * @returns {number} Hash value
     */
    generateSessionHash: tabs => {
        const text = tabs.reduce((prevStr, tab) => {
            return prevStr + spacesService._cleanUrl(tab.url);
        }, '');

        let hash = 0;
        if (text.length === 0) return hash;
        for (let i = 0, len = text.length; i < len; i += 1) {
            const chr = text.charCodeAt(i);
            hash = (hash << 5) - hash + chr;
            hash |= 0; // Convert to 32bit integer
        }
        return Math.abs(hash);
    },

    /**
     * Filter out internal extension windows
     * @param {Object} curWindow - Window object to check
     * @returns {boolean} True if window is internal
     */
    filterInternalWindows: curWindow => {
        if (
            curWindow.tabs.length === 1 &&
            curWindow.tabs[0].url.indexOf(chrome.runtime.id) >= 0
        ) {
            return true;
        }

        if (curWindow.type === 'popup' || curWindow.type === 'panel') {
            return true;
        }
        return false;
    },

    /**
     * Check if a window matches any saved session
     * If match found, link window with session
     * If no match, create temporary session
     */
    checkForSessionMatch: curWindow => {
        if (!curWindow.tabs || curWindow.tabs.length === 0) {
            return;
        }

        const sessionHash = spacesService.generateSessionHash(curWindow.tabs);
        const temporarySession = spacesService.getSessionByWindowId(
            curWindow.id
        );
        const matchingSession = spacesService.getSessionBySessionHash(
            sessionHash,
            true
        );

        if (matchingSession) {
            if (spacesService.debug) {
                console.log(
                    `matching session found: ${matchingSession.id}. linking with window: ${curWindow.id}`
                );
            }
            spacesService.matchSessionToWindow(matchingSession, curWindow);
        }

        if (!matchingSession && !temporarySession) {
            if (spacesService.debug) {
                console.log(
                    `no matching session found. creating temporary session for window: ${curWindow.id}`
                );
            }
            spacesService.createTemporaryUnmatchedSession(curWindow);
        }
    },

    /**
     * Link a session with a window
     * Updates session tracking and handles name preservation
     */
    matchSessionToWindow: (session, curWindow) => {
	    // We keep track of a possibly old temporary session name that was attached to the same window
	    let oldSessionName = false;

	    for (let i = spacesService.sessions.length - 1; i >= 0; i--) {
	        const s = spacesService.sessions[i];
	        if (s.windowId === curWindow.id && s !== session) {
	            // If that 's' is already stored in DB, just detach its windowId but don't remove it
	            if (s.id) {
	                s.windowId = false;
	            } else {
	                // If 's' is purely temporary, remove it from memory
	                oldSessionName = s.name;
	                spacesService.sessions.splice(i, 1);
	            }
	        }
	    }

	    // If the session doesn't have a name but we found oldSessionName, use that old name
	    if ((!session.name || session.name.trim() === '') && oldSessionName) {
	        session.name = oldSessionName;
	    }

	    // Always assign the current windowId
	    session.windowId = curWindow.id;
	},

    /**
     * Create a temporary session for an unmatched window
     * Used when a window doesn't match any saved session
     */
    createTemporaryUnmatchedSession: curWindow => {
        if (spacesService.debug) {
            console.log('Could not match window. Creating temporary session.');
        }

        const sessionHash = spacesService.generateSessionHash(curWindow.tabs);
        
        const existingSession = spacesService.sessions.find(s => s.windowId === curWindow.id);
        const existingName = existingSession ? existingSession.name : false;

        const newSession = {
            id: false,
            windowId: curWindow.id,
            sessionHash,
            name: existingName,
            tabs: curWindow.tabs,
            history: [],
            lastAccess: new Date(),
        };

        spacesService.sessions.push(newSession);

        // 若該視窗已有暫存名稱，馬上儲存到 DB
        if (existingName) {
            spacesService.saveNewSession(existingName, curWindow.tabs, curWindow.id, () => {
                chrome.runtime.sendMessage({
                    action: 'updateSpaces',
                    spaces: spacesService.getAllSessions()
                }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('[createTemporaryUnmatchedSession] ' + chrome.runtime.lastError.message);
                    }
                });
            });
        }
    },

    /**
     * Fetch the last known version of the extension
     * Used for migration and update handling
     */
    fetchLastVersion: async () => {
        let {spacesVersion: version} = await chrome.storage.local.get('spacesVersion');
        if (version != null) {
            version = JSON.parse(version);
            return version;
        }
        return 0;
    },

    /**
     * Update the stored version number
     * @param {string} newVersion - New version to store
     */
    setLastVersion: async newVersion => {
        await chrome.storage.local.set({'spacesVersion': JSON.stringify(newVersion)});
    },

    /**
     * Handle tab removal events
     * Updates history and session state accordingly
     */
    handleTabRemoved: (tabId, removeInfo, callback) => {
        if (spacesService.debug) {
            console.log(
                `handlingTabRemoved event. windowId: ${removeInfo.windowId}`
            );
        }

        if (removeInfo.isWindowClosing) {
            spacesService.handleWindowRemoved(
                removeInfo.windowId,
                true,
                spacesService.noop
            );
        } else {
            spacesService.historyQueue.push({
                url: spacesService.tabHistoryUrlMap[tabId],
                windowId: removeInfo.windowId,
                action: 'add',
            });
            spacesService.queueWindowEvent(
                removeInfo.windowId,
                spacesService.eventQueueCount,
                callback
            );

            delete spacesService.tabHistoryUrlMap[tabId];
        }
    },

    /**
     * Handle tab movement between windows
     * Updates session state to reflect new tab positions
     */
    handleTabMoved: (tabId, moveInfo, callback) => {
        if (spacesService.debug) {
            console.log(
                `handlingTabMoved event. windowId: ${moveInfo.windowId}`
            );
        }
        spacesService.queueWindowEvent(
            moveInfo.windowId,
            spacesService.eventQueueCount,
            callback
        );
    },

    /**
     * Handle tab updates (URL changes, loading status)
     * Updates history and session state
     */
    handleTabUpdated: (tab, changeInfo, callback) => {
        if (tab.status === 'complete') {
            if (spacesService.debug) {
                console.log(
                    `handlingTabUpdated event. windowId: ${tab.windowId}`
                );
            }
            spacesService.tabHistoryUrlMap[tab.id] = tab.url;
            spacesService.queueWindowEvent(
                tab.windowId,
                spacesService.eventQueueCount,
                callback
            );
        }

        if (changeInfo.url) {
            spacesService.historyQueue.push({
                url: changeInfo.url,
                windowId: tab.windowId,
                action: 'remove',
            });
        }
    },

    /**
     * Handle window removal
     * Updates session state and handles cleanup
     */
    handleWindowRemoved: (windowId, markAsClosed, callback) => {
	    if (!windowId) return;

	    chrome.windows.getAll({}, allWins => {
	        // Check if window is truly gone
	        const stillExists = allWins.some(w => w.id === windowId);
	        if (stillExists) {
	            callback();
	            return;
	        }

	        // If truly gone, mark as closed if needed
	        if (markAsClosed) {
	            spacesService.closedWindowIds[windowId] = true;
	            clearTimeout(spacesService.sessionUpdateTimers[windowId]);
	        }

	        // Find the session in memory and handle removing or updating
	        const session = spacesService.getSessionByWindowId(windowId);
	        if (session) {
	            if (session.id) {
	                // If session is in DB, just set windowId = false to mark it closed
	                session.windowId = false;
	            } else {
	                // If it's a temporary session, remove it
	                const idx = spacesService.sessions.findIndex(s => s.windowId === windowId);
	                if (idx >= 0) {
	                    spacesService.sessions.splice(idx, 1);
	                }
	            }
	        }

	        callback();
	    });
	},

    /**
     * Handle window focus change events
     * Updates session access times and handles UI updates
     */
    handleWindowFocussed: (windowId) => {
        if (windowId <= 0) return;

        const session = spacesService.getSessionByWindowId(windowId);
        if (!session) return;

        // ★★★ [修訂說明] 以下段落：若目前 session 沒有 id / 或有 name 就嘗試接回 DB。
        spacesService.queue.push(async () => {
            try {
                let dbSession = null;

                if (session.id) {
                    // 1) 先嘗試用 session.id 查 DB
                    dbSession = await new Promise(resolve => {
                        dbService.fetchSessionById(session.id, found => resolve(found));
                    });
                } else if (session.name && session.name.trim() !== '') {
                    // 2) 如果沒 id 但有 name，就用 name 查；查不到就 create
                    dbSession = await new Promise(resolve => {
                        dbService.fetchSessionByName(session.name, found => resolve(found));
                    });
                    if (!dbSession) {
                        dbSession = await new Promise(resolve => {
                            dbService.createSession(session, newSession => {
                                resolve(newSession);
                            });
                        });
                    }
                    if (dbSession) {
                        session.id = dbSession.id; 
                    }
                }

                // ★★★ 新增：若 session 還是沒有 id、也沒有非空白 name，就嘗試用 sessionHash 找看看
                if (!dbSession && (!session.name || session.name.trim() === '')) {
                    const foundByHash = await new Promise(resolve => {
                        dbService._fetchAllSessions().then(all => {
                            const matched = all.find(s => s.sessionHash === session.sessionHash);
                            resolve(matched || null);
                        });
                    });
                    if (foundByHash) {
                        dbSession = foundByHash;
                        session.id = dbSession.id;
                        session.name = dbSession.name; 
                    }
                }

                // 若成功在 DB 中找到 session，雙向同步 name
                if (dbSession) {
                    if (session.name && session.name.trim() !== '') {
                        dbSession.name = session.name;
                    } else if (dbSession.name && dbSession.name.trim() !== '') {
                        session.name = dbSession.name;
                    }
                }

                session.lastAccess = new Date();
                session.windowId = windowId;

                // 存在 id 的情況就存回 DB
                if (session.id) {
                    await new Promise((resolve, reject) => {
                        dbService.updateSession(session, updated => {
                            if (!updated) {
                                reject(new Error('[spacesService] Failed to save session on focus.'));
                            } else {
                                resolve();
                            }
                        });
                    });
                }

                // Fire an updateSpaces message
                chrome.runtime.sendMessage({
                    action: 'updateSpaces',
                    spaces: spacesService.getAllSessions()
                }, () => {
                    if (chrome.runtime.lastError) {
                        console.warn('[handleWindowFocussed] ' + chrome.runtime.lastError.message);
                    }
                });
            } catch (error) {
                console.error('Error in handleWindowFocussed:', error);
            } finally {
                spacesService.isProcessing = false;
                spacesService.processQueue();
            }
        });

        if (!spacesService.isProcessing) {
            spacesService.processQueue();
        }
    },

    /**
     * Queue window events for processing
     * Implements debouncing to prevent excessive updates
     */
    queueWindowEvent: (windowId, eventId, callback) => {
        clearTimeout(spacesService.sessionUpdateTimers[windowId]);

        spacesService.eventQueueCount += 1;

        spacesService.sessionUpdateTimers[windowId] = setTimeout(() => {
            spacesService.handleWindowEvent(windowId, eventId, callback);
        }, 1000);
    },

    /**
     * Process queued window events
     * Updates session state and handles UI synchronization
     */
    handleWindowEvent: (windowId, eventId, callback) => {
	    callback = typeof callback !== 'function' ? spacesService.noop : callback;

	    if (!windowId || windowId <= 0) {
	        callback();
	        return;
	    }

	    function doHandleValidWindow(curWindow, eventId, cb) {
	        if (!curWindow) {
	            cb();
	            return;
	        }
	        // If it's an internal extension window, skip
	        if (spacesService.filterInternalWindows(curWindow)) {
	            cb();
	            return;
	        }

	        // If it's already closed
	        if (spacesService.closedWindowIds[curWindow.id]) {
	            cb();
	            return;
	        }

	        let session = spacesService.getSessionByWindowId(curWindow.id);

	        // ★★★ [修訂說明] 若 session 不存在或 session.name 為空時，再嘗試去 DB 尋找相同 hash 的 session
	        if (!session || !session.name || session.name.trim() === '') {
	            const sessionHash = spacesService.generateSessionHash(curWindow.tabs);
	            const dbCheck = spacesService.sessions.find(
	                s => s.sessionHash === sessionHash
	            );
	            if (dbCheck) {
	                // 將該視窗附著到這個 dbCheck session
	                // 先把原本可能暫時在同個 windowId 的 session 移除/分離
	                spacesService.sessions.forEach(s => {
	                    if (s !== dbCheck && s.windowId === curWindow.id) {
	                        if (s.id) {
	                            s.windowId = false;
	                        } else {
	                            const idx = spacesService.sessions.indexOf(s);
	                            if (idx >= 0) {
	                                spacesService.sessions.splice(idx, 1);
	                            }
	                        }
	                    }
	                });
	                dbCheck.windowId = curWindow.id;
	                session = dbCheck;
	            }
	        }

	        // Update the session if it exists
	        if (session) {
	            // Process any historyQueue items
	            const historyItems = spacesService.historyQueue.filter(
	                h => h.windowId === curWindow.id
	            );
	            for (let i = historyItems.length - 1; i >= 0; i--) {
	                const item = historyItems[i];
	                if (item.action === 'add') {
	                    spacesService.addUrlToSessionHistory(session, item.url);
	                } else if (item.action === 'remove') {
	                    spacesService.removeUrlFromSessionHistory(session, item.url);
	                }
	                spacesService.historyQueue.splice(i, 1);
	            }

	            // Rebuild the session tabs array
	            session.tabs = curWindow.tabs.map(t => ({ ...t, pinned: t.pinned }));
	            session.sessionHash = spacesService.generateSessionHash(session.tabs);

	            // If the session is in DB, update it
	            if (session.id) {
	                spacesService.saveExistingSession(session.id, cb);
	            } else if (session.name && session.name.trim() !== '') {
	                // Not in DB yet, but has a valid name => create a new record
	                spacesService.saveNewSession(session.name, session.tabs, curWindow.id, () => {
	                    cb();
	                });
	            } else {
	                // No DB id, no valid name => do nothing special, treat as temporary
	                cb();
	            }

	        } else {
	            // If no session found, try to match or create a temporary one
	            spacesService.checkForSessionMatch(curWindow);
	            cb();
	        }
	    }

	    // Try to get the specified window
	    chrome.windows.get(windowId, { populate: true }, (curWindow) => {
	        if (chrome.runtime.lastError) {
	            const msg = chrome.runtime.lastError.message || '';
	            // If failed, wait a bit and re-check
	            setTimeout(() => {
	                chrome.windows.get(windowId, { populate: true }, (reCheckWindow) => {
	                    if (chrome.runtime.lastError || !reCheckWindow) {
	                        // If still cannot find it, finalize removal
	                        spacesService.handleWindowRemoved(windowId, true, spacesService.noop);
	                        callback();
	                    } else {
	                        doHandleValidWindow(reCheckWindow, eventId, callback);
	                    }
	                });
	            }, 500);
	            return;
	        }

	        // If no error, proceed
	        doHandleValidWindow(curWindow, eventId, callback);
	    });
	},

    /**
     * Get session by its ID
     * @returns {Object|false} Session object or false if not found
     */
    getSessionBySessionId: sessionId => {
        const result = spacesService.sessions.filter(session => {
            return session.id === sessionId;
        });
        return result.length === 1 ? result[0] : false;
    },

    /**
     * Get session by window ID
     * @returns {Object|false} Session object or false if not found
     */
    getSessionByWindowId: windowId => {
        const result = spacesService.sessions.filter(session => {
            return session.windowId === windowId;
        });
        return result.length === 1 ? result[0] : false;
    },

    /**
     * Get session by its hash
     * @param {boolean} closedOnly - If true, only return closed sessions
     * @returns {Object|false} Session object or false if not found
     */
    getSessionBySessionHash: (hash, closedOnly) => {
        const result = spacesService.sessions.filter(session => {
            if (closedOnly) {
                return session.sessionHash === hash && !session.windowId;
            }
            return session.sessionHash === hash;
        });
        return result.length >= 1 ? result[0] : false;
    },

    /**
     * Get session by its name
     * @returns {Object|false} Session object or false if not found
     */
    getSessionByName: name => {
        const result = spacesService.sessions.filter(session => {
            return (
                session.name &&
                session.name.toLowerCase() === name.toLowerCase()
            );
        });
        return result.length >= 1 ? result[0] : false;
    },

    /**
     * Get all active sessions
     * @returns {Array} Array of all sessions
     */
    getAllSessions: () => {
        return spacesService.sessions;
    },

    /**
     * Add URL to session history
     * Manages the history stack for a session
     */
    addUrlToSessionHistory: (session, newUrl) => {
        if (spacesService.debug) {
            console.log(`adding tab to history: ${newUrl}`);
        }

        const cleanUrl = spacesService._cleanUrl(newUrl);
        if (cleanUrl.length === 0) {
            return false;
        }

        const tabBeingRemoved = session.tabs.filter(curTab => {
            return spacesService._cleanUrl(curTab.url) === cleanUrl;
        });

        if (tabBeingRemoved.length !== 1) {
            return false;
        }

        if (!session.history) session.history = [];

        session.history.some((historyTab, index) => {
            if (spacesService._cleanUrl(historyTab.url) === cleanUrl) {
                session.history.splice(index, 1);
                return true;
            }
            return false;
        });

        session.history = tabBeingRemoved.concat(session.history);
        session.history = session.history.slice(0, 200);

        return session;
    },

    /**
     * Remove URL from session history
     * Used when tabs are closed or URLs change
     */
    removeUrlFromSessionHistory: (session, newUrl) => {
        if (spacesService.debug) {
            console.log(`removing tab from history: ${newUrl}`);
        }

        newUrl = spacesService._cleanUrl(newUrl);
        if (newUrl.length === 0) {
            return;
        }

        session.history.some((historyTab, index) => {
            if (spacesService._cleanUrl(historyTab.url) === newUrl) {
                session.history.splice(index, 1);
                return true;
            }
            return false;
        });
    },

    /**
     * Update tabs for an existing session
     * @param {string} sessionId - ID of session to update
     * @param {Array} tabs - New tabs array
     */
    updateSessionTabs: (sessionId, tabs, callback) => {
        const session = spacesService.getSessionBySessionId(sessionId);
        callback = typeof callback !== 'function' ? spacesService.noop : callback;

        session.tabs = tabs;
        session.sessionHash = spacesService.generateSessionHash(session.tabs);
        spacesService.saveExistingSession(session.id, callback);
    },

    /**
     * Update window ID for a session
     * Used when linking sessions with windows
     */
    updateSessionWindowId: async (sessionId, windowId) => {
        const session = spacesService.getSessionBySessionId(sessionId);
        if (session) {
            session.windowId = windowId;
            await dbService.updateSession(session);
        } else {
            console.error(`Session with ID ${sessionId} not found.`);
        }
    },

    /**
     * Update session name
     * Handles name conflicts and updates storage
     */
    updateSessionName: (sessionId, sessionName, callback) => {
        callback = typeof callback !== 'function' ? spacesService.noop : callback;

        const session = spacesService.getSessionBySessionId(sessionId);
        session.name = sessionName;
        spacesService.saveExistingSession(session.id, callback);
    },

    /**
     * Save changes to an existing session
     * Updates database and triggers UI refresh
     */
    saveExistingSession: (sessionId, callback) => {
        const session = spacesService.getSessionBySessionId(sessionId);
        callback = typeof callback === 'function' ? callback : spacesService.noop;

        dbService.updateSession(session, callback);
    },

    /**
     * Create and save a new session
     * Handles window linking and storage
     */
    saveNewSession: (sessionName, tabs, windowId, callback) => {
        if (!tabs) {
            callback(false);
            return;
        }

        try {
            const sessionHash = spacesService.generateSessionHash(tabs);
            let session;
            callback = typeof callback === 'function' ? callback : spacesService.noop;

            if (windowId) {
                session = spacesService.getSessionByWindowId(windowId);
            }

            if (!session) {
                session = {
                    windowId,
                    history: [],
                };
                spacesService.sessions.push(session);
            }

            session.name = sessionName;
            session.sessionHash = sessionHash;
            session.tabs = tabs;
            session.lastAccess = new Date();

            dbService.createSession(session, savedSession => {
                try {
                    if (savedSession) {
                        session.id = savedSession.id;
                        callback(savedSession);
                        console.log('saveNewSession about to store tabs =>', JSON.stringify(tabs, null, 2));
                    } else {
                        console.warn('Failed to create session in database');
                        callback(false);
                    }
                } catch (err) {
                    console.error('Error in saveNewSession callback:', err);
                    callback(false);
                }
            });

        } catch (err) {
            console.error('Error in saveNewSession:', err);
            callback(false);
        }
    },

    /**
     * Delete a session
     * Removes from memory and storage
     */
    deleteSession: (sessionId, callback) => {
        callback = typeof callback !== 'function' ? spacesService.noop : callback;

        dbService.removeSession(sessionId, () => {
            spacesService.sessions.some((session, index) => {
                if (session.id === sessionId) {
                    spacesService.sessions.splice(index, 1);
                    return true;
                }
                return false;
            });
            callback();
        });
    },

    /**
     * Process the async operation queue
     * Ensures sequential processing of updates
     */
    processQueue: () => {
        if (spacesService.isProcessing || spacesService.queue.length === 0) {
            return;
        }

        spacesService.isProcessing = true;
        const update = spacesService.queue.shift();
        
        Promise.resolve(update())
            .catch(error => {
                console.error('Error processing queue item:', error);
            })
            .finally(() => {
                spacesService.isProcessing = false;
                if (spacesService.queue.length > 0) {
                    spacesService.processQueue();
                }
            });
    },
};
