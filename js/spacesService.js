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
        let oldSessionName = false;
        
        for (let i = spacesService.sessions.length - 1; i >= 0; i--) {
            if (spacesService.sessions[i].windowId === curWindow.id) {
                if (spacesService.sessions[i].id) {
                    spacesService.sessions[i].windowId = false;
                } else {
                    oldSessionName = spacesService.sessions[i].name;
                    spacesService.sessions.splice(i, 1);
                }
            }
        }

        if (!session.name && oldSessionName) {
            session.name = oldSessionName;
        }

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
        if (spacesService.closedWindowIds[windowId]) {
            callback();
        }

        if (spacesService.debug) {
            console.log(`handlingWindowRemoved event. windowId: ${windowId}`);
        }

        if (markAsClosed) {
            if (spacesService.debug) {
                console.log(`adding window to closedWindowIds: ${windowId}`);
            }
            spacesService.closedWindowIds[windowId] = true;
            clearTimeout(spacesService.sessionUpdateTimers[windowId]);
        }

        const session = spacesService.getSessionByWindowId(windowId);
        if (session) {
            if (session.id) {
                session.windowId = false;
            } else {
                spacesService.sessions.some((curSession, index) => {
                    if (curSession.windowId === windowId) {
                        spacesService.sessions.splice(index, 1);
                        return true;
                    }
                    return false;
                });
            }
        }

        callback();
    },

    /**
     * Handle window focus change events
     * Updates session access times and handles UI updates
     */
    handleWindowFocussed: (windowId) => {
        // Skip if windowId is invalid
        if (windowId <= 0) return;

        // Find the corresponding session by windowId
        const session = spacesService.getSessionByWindowId(windowId);
        if (!session) return;

        // Skip DB update if this session hasn't been written to IndexedDB yet (session.id = false)
        if (!session.id) {
            if (spacesService.debug) {
                console.warn('[spacesService] handleWindowFocussed: temporary session, skip DB update');
            }
            return;
        }

        // Use queue mechanism to ensure only one update operation is processed at a time
        spacesService.queue.push(async () => {
            try {
                // First fetch the latest session state from DB (dbSession)
                const dbSession = await new Promise(resolve => {
                    dbService.fetchSessionById(session.id, found => resolve(found));
                });
                if (!dbSession) {
                    console.warn('[spacesService] handleWindowFocussed: session not found in DB, skip');
                    return;
                }

                // --------------------- Fix: Session Name Priority Logic ---------------------
                // If memory has a valid sessionName (non-empty), prioritize it and write back to DB
                if (session.name && session.name.trim() !== '') {
                    dbSession.name = session.name;
                } 
                // Otherwise, if DB has a stored name (non-empty), update memory with DB's name
                else if (dbSession.name && dbSession.name.trim() !== '') {
                    session.name = dbSession.name;
                }
                // ----------------------------------------------------------------------------------------------

                // Synchronously update lastAccess and windowId
                session.lastAccess = new Date();
                session.windowId = windowId;

                // Write session back to DB
                await new Promise((resolve, reject) => {
                    dbService.updateSession(session, updated => {
                        if (!updated) {
                            reject(new Error('[spacesService] Failed to save session on focus.'));
                        } else {
                            resolve();
                        }
                    });
                });

                // Notify frontend UI to update; if UI is not open, will receive "Receiving end does not exist."
                chrome.runtime.sendMessage({
                    action: 'updateSpaces',
                    spaces: spacesService.getAllSessions()
                }, () => {
                    // Log the status to avoid misidentifying it as a critical error
                    if (chrome.runtime.lastError) {
                        console.warn('[handleWindowFocussed] ' + chrome.runtime.lastError.message);
                    }
                });

            } catch (error) {
                console.error('Error in handleWindowFocussed:', error);
            } finally {
                // Finally, close the processing state and continue processing the next queue
                spacesService.isProcessing = false;
                spacesService.processQueue();
            }
        });

        // If not currently processing any queue, start processQueue immediately
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
        if (spacesService.debug) {
            console.log('------------------------------------------------');
            console.log(`event: ${eventId}. attempting session update. windowId: ${windowId}`);
        }
        if (!windowId || windowId <= 0) {
            if (spacesService.debug) {
                console.log(`received an event for invalid windowId: ${windowId}`);
            }
            return;
        }
    
        chrome.windows.get(windowId, { populate: true }, (curWindow) => {
            if (chrome.runtime.lastError) {
                console.warn(`[handleWindowEvent] ${chrome.runtime.lastError.message}. Skip event.`);
                spacesService.handleWindowRemoved(windowId, false, spacesService.noop);
                return;
            }
            if (!curWindow) return;
    
            if (spacesService.filterInternalWindows(curWindow)) {
                return;
            }
    
            if (spacesService.closedWindowIds[windowId]) {
                if (spacesService.debug) {
                    console.log(`Ignoring event because windowId ${windowId} is marked as closed.`);
                }
                return;
            }
    
            const session = spacesService.getSessionByWindowId(windowId);
    
            if (session) {
                // Update tabs and history
                if (spacesService.debug) {
                    console.log(
                        `tab statuses: ${curWindow.tabs
                            .map(curTab => curTab.status)
                            .join('|')}`
                    );
                }
    
                const historyItems = spacesService.historyQueue.filter(
                    historyItem => historyItem.windowId === windowId
                );
    
                for (let i = historyItems.length - 1; i >= 0; i -= 1) {
                    const historyItem = historyItems[i];
    
                    if (historyItem.action === 'add') {
                        spacesService.addUrlToSessionHistory(
                            session,
                            historyItem.url
                        );
                    } else if (historyItem.action === 'remove') {
                        spacesService.removeUrlFromSessionHistory(
                            session,
                            historyItem.url
                        );
                    }
                    spacesService.historyQueue.splice(i, 1);
                }
    
                session.tabs = curWindow.tabs.map(t => ({
                    ...t,
                    pinned: t.pinned
                }));
                session.sessionHash = spacesService.generateSessionHash(session.tabs);
    
                // ① If session already has an ID, save updates directly
                if (session.id) {
                    spacesService.saveExistingSession(session.id);
                }
                // ② If session is temporary but has a name (session.name non-empty), save it to DB immediately to avoid being overwritten by subsequent logic
                else if (session.name && session.name.trim() !== '') {
                    spacesService.saveNewSession(session.name, session.tabs, session.windowId, () => {
                        // Execute callback regardless of success or failure
                        callback();
                    });
                }
            }
    
            // If there's no session or session.id=false and no name, check for auto-matching or create temporary storage
            if (!session || !session.id) {
                if (spacesService.debug) {
                    console.log('session check triggered');
                }
                const currentName = session ? session.name : false;
                spacesService.checkForSessionMatch(curWindow);
    
                // If the window originally had a temporary name, carry it over to the newly matched session
                if (currentName) {
                    const newSession = spacesService.getSessionByWindowId(curWindow.id);
                    if (newSession) {
                        newSession.name = currentName;
                    }
                }
            }
            callback();
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
