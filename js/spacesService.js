/* global chrome, dbService */

/* spaces
 * Copyright (C) 2015 Dean Oemcke
 */

import { dbService } from "./dbService.js";

// eslint-disable-next-line no-var
export var spacesService = {
    tabHistoryUrlMap: {},
    closedWindowIds: {},
    sessions: [],
    sessionUpdateTimers: {},
    historyQueue: [],
    eventQueueCount: 0,
    lastVersion: 0,
    debug: false,
    queue: [],
    isProcessing: false,

    noop: () => {},

    // initialise spaces - combine open windows with saved sessions
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
                    // eslint-disable-next-line no-param-reassign
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

    resetAllSessionHashes: sessions => {
        sessions.forEach(session => {
            // eslint-disable-next-line no-param-reassign
            session.sessionHash = spacesService.generateSessionHash(
                session.tabs
            );
            dbService.updateSession(session);
        });
    },

    // record each tab's id and url so we can add history items when tabs are removed
    initialiseTabHistory: () => {
        chrome.tabs.query({}, tabs => {
            tabs.forEach(tab => {
                spacesService.tabHistoryUrlMap[tab.id] = tab.url;
            });
        });
    },

    // NOTE: if ever changing this funciton, then we'll need to update all
    // saved sessionHashes so that they match next time, using: resetAllSessionHashes()
    _cleanUrl: url => {
        if (!url) {
            return '';
        }

        // ignore urls from this extension
        if (url.indexOf(chrome.runtime.id) >= 0) {
            return '';
        }

        // ignore 'new tab' pages
        if (url.indexOf('chrome:// newtab/') >= 0) {
            return '';
        }

        let cleanUrl = url;

        // add support for 'The Great Suspender'
        if (
            cleanUrl.indexOf('suspended.html') > 0 &&
            cleanUrl.indexOf('uri=') > 0
        ) {
            cleanUrl = cleanUrl.substring(
                cleanUrl.indexOf('uri=') + 4,
                cleanUrl.length
            );
        }

        // remove any text after a '#' symbol
        if (cleanUrl.indexOf('#') > 0) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.indexOf('#'));
        }

        // remove any text after a '?' symbol
        if (cleanUrl.indexOf('?') > 0) {
            cleanUrl = cleanUrl.substring(0, cleanUrl.indexOf('?'));
        }

        return cleanUrl;
    },

    generateSessionHash: tabs => {
        const text = tabs.reduce((prevStr, tab) => {
            return prevStr + spacesService._cleanUrl(tab.url);
        }, '');

        let hash = 0;
        if (text.length === 0) return hash;
        for (let i = 0, len = text.length; i < len; i += 1) {
            const chr = text.charCodeAt(i);
            // eslint-disable-next-line no-bitwise
            hash = (hash << 5) - hash + chr;
            // eslint-disable-next-line no-bitwise
            hash |= 0; // Convert to 32bit integer
        }
        return Math.abs(hash);
    },

    filterInternalWindows: curWindow => {
        // sanity check to make sure window isnt an internal spaces window
        if (
            curWindow.tabs.length === 1 &&
            curWindow.tabs[0].url.indexOf(chrome.runtime.id) >= 0
        ) {
            return true;
        }

        // also filter out popup or panel window types
        if (curWindow.type === 'popup' || curWindow.type === 'panel') {
            return true;
        }
        return false;
    },

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
            if (spacesService.debug)
                // eslint-disable-next-line no-console
                console.log(
                    `matching session found: ${matchingSession.id}. linking with window: ${curWindow.id}`
                );

            spacesService.matchSessionToWindow(matchingSession, curWindow);
        }

        // if no match found and this window does not already have a temporary session
        if (!matchingSession && !temporarySession) {
            if (spacesService.debug)
                // eslint-disable-next-line no-console
                console.log(
                    `no matching session found. creating temporary session for window: ${curWindow.id}`
                );

            // create a new temporary session for this window (with no sessionId or name)
            spacesService.createTemporaryUnmatchedSession(curWindow);
        }
    },

    matchSessionToWindow: (session, curWindow) => {
        // 保存舊 session 的名稱
        let oldSessionName = false;
        
        // 移除其他綁定到此 windowId 的 sessions
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

        // 如果新 session 沒有名稱但有舊名稱，則保留舊名稱
        if (!session.name && oldSessionName) {
            session.name = oldSessionName;
        }

        // 分配 windowId 給新匹配的 session
        session.windowId = curWindow.id;
    },

    createTemporaryUnmatchedSession: curWindow => {
        if (spacesService.debug) {
            // eslint-disable-next-line no-console
            console.dir(spacesService.sessions);
            // eslint-disable-next-line no-console
            console.dir(curWindow);
            // eslint-disable-next-line no-console
            console.log('Could not match window. Creating temporary session.');
        }

        // 先計算 sessionHash
        const sessionHash = spacesService.generateSessionHash(curWindow.tabs);
        
        // 檢查是否存在相同 windowId 的舊 session
        const existingSession = spacesService.sessions.find(s => s.windowId === curWindow.id);
        const existingName = existingSession ? existingSession.name : false;

        // 創建新的臨時 session
        const newSession = {
            id: false,
            windowId: curWindow.id,
            sessionHash,
            name: existingName, // 保留原有名稱
            tabs: curWindow.tabs,
            history: [],
            lastAccess: new Date(),
        };

        // 將新 session 加入到 sessions 陣列
        spacesService.sessions.push(newSession);

        // 如果有名稱，立即保存到資料庫
        if (existingName) {
            spacesService.saveNewSession(existingName, curWindow.tabs, curWindow.id, () => {
                // 更新 UI
                chrome.runtime.sendMessage({
                    action: 'updateSpaces',
                    spaces: spacesService.getAllSessions()
                });
            });
        }
    },

    // local storage getters/setters
    fetchLastVersion: async () => {
        let {spacesVersion: version} = await chrome.storage.local.get('spacesVersion');
        if (version != null) {
            version = JSON.parse(version);
            return version;
        }
        return 0;
    },

    setLastVersion: async newVersion => {
        await chrome.storage.local.set({'spacesVersion': JSON.stringify(newVersion)});
    },

    // event listener functions for window and tab events
    // (events are received and screened first in background.js)
    // -----------------------------------------------------------------------------------------

    handleTabRemoved: (tabId, removeInfo, callback) => {
        if (spacesService.debug)
            // eslint-disable-next-line no-console
            console.log(
                `handlingTabRemoved event. windowId: ${removeInfo.windowId}`
            );

        // NOTE: isWindowClosing is true if the window cross was clicked causing the tab to be removed.
        // If the tab cross is clicked and it is the last tab in the window
        // isWindowClosing will still be false even though the window will close
        if (removeInfo.isWindowClosing) {
            // be very careful here as we definitley do not want these removals being saved
            // as part of the session (effectively corrupting the session)

            // should be handled by the window removed listener
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

            // remove tab from tabHistoryUrlMap
            delete spacesService.tabHistoryUrlMap[tabId];
        }
    },
    handleTabMoved: (tabId, moveInfo, callback) => {
        if (spacesService.debug)
            // eslint-disable-next-line no-console
            console.log(
                `handlingTabMoved event. windowId: ${moveInfo.windowId}`
            );
        spacesService.queueWindowEvent(
            moveInfo.windowId,
            spacesService.eventQueueCount,
            callback
        );
    },
    handleTabUpdated: (tab, changeInfo, callback) => {
        // NOTE: only queue event when tab has completed loading (title property exists at this point)
        if (tab.status === 'complete') {
            if (spacesService.debug)
                // eslint-disable-next-line no-console
                console.log(
                    `handlingTabUpdated event. windowId: ${tab.windowId}`
                );

            // update tab history in case the tab url has changed
            spacesService.tabHistoryUrlMap[tab.id] = tab.url;
            spacesService.queueWindowEvent(
                tab.windowId,
                spacesService.eventQueueCount,
                callback
            );
        }

        // check for change in tab url. if so, update history
        if (changeInfo.url) {
            // add tab to history queue as an item to be removed (as it is open for this window)
            spacesService.historyQueue.push({
                url: changeInfo.url,
                windowId: tab.windowId,
                action: 'remove',
            });
        }
    },
    handleWindowRemoved: (windowId, markAsClosed, callback) => {
        // ignore subsequent windowRemoved events for the same windowId (each closing tab will try to call this)
        if (spacesService.closedWindowIds[windowId]) {
            callback();
        }

        if (spacesService.debug)
            // eslint-disable-next-line no-console
            console.log(`handlingWindowRemoved event. windowId: ${windowId}`);

        // add windowId to closedWindowIds. the idea is that once a window is closed it can never be
        // rematched to a new session (hopefully these window ids never get legitimately re-used)
        if (markAsClosed) {
            if (spacesService.debug)
                // eslint-disable-next-line no-console
                console.log(`adding window to closedWindowIds: ${windowId}`);
            spacesService.closedWindowIds[windowId] = true;
            clearTimeout(spacesService.sessionUpdateTimers[windowId]);
        }

        const session = spacesService.getSessionByWindowId(windowId);
        if (session) {
            // if this is a saved session then just remove the windowId reference
            if (session.id) {
                session.windowId = false;

            // else if it is temporary session then remove the session from the cache
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
     * [修訂] 在 Focus 時只更新 lastAccess，不覆寫使用者自訂的 session.name
     * 並先檢查 DB 內該 session 是否仍存在，以避免「Failed to save session」。
     */
    handleWindowFocussed: (windowId) => {
        if (windowId <= 0) return;

        const session = spacesService.getSessionByWindowId(windowId);
        if (!session) return;

        // 若 session.id 不存在，表示是暫存(unnamed) session，不進行 DB 更新
        if (!session.id) {
            if (spacesService.debug) {
                console.warn('[spacesService] handleWindowFocussed: temporary session, skip DB update');
            }
            return;
        }

        // 將更新任務 push 進 queue，避免 race condition
        spacesService.queue.push(async () => {
            try {
                // 先從 DB 拉出最新的 session (若找不到，則略過處理)
                const dbSession = await new Promise(resolve => {
                    dbService.fetchSessionById(session.id, found => resolve(found));
                });
                if (!dbSession) {
                    console.warn('[spacesService] handleWindowFocussed: session not found in DB, skip');
                    return;
                }

                // 若本地 session.name 不為空，而且與 dbSession.name 不同，以「本地為準」覆蓋 DB
                // 避免意外覆蓋使用者剛剛改好的名稱
                if (session.name && session.name.trim() !== '' && session.name !== dbSession.name) {
                    dbSession.name = session.name;
                } else {
                    // 若本地沒有特別命名，則反向套用 DB 裏的名稱
                    session.name = dbSession.name;
                }

                // 僅更新 lastAccess 和 windowId，其它屬性不要動，以免 race condition
                session.lastAccess = new Date();
                session.windowId = windowId;

                // 寫回 DB
                await new Promise((resolve, reject) => {
                    dbService.updateSession(session, updated => {
                        if (!updated) {
                            reject(new Error('[spacesService] Failed to save session on focus.'));
                        } else {
                            resolve();
                        }
                    });
                });

                // 發送更新訊息給 UI
                await new Promise(resolve => {
                    chrome.runtime.sendMessage({
                        action: 'updateSpaces',
                        spaces: spacesService.getAllSessions()
                    }, () => resolve());
                });

            } catch (error) {
                console.error('Error in handleWindowFocussed:', error);
            } finally {
                spacesService.isProcessing = false;
                spacesService.processQueue();
            }
        });

        // 若目前沒在處理 queue，啟動 processQueue()
        if (!spacesService.isProcessing) {
            spacesService.processQueue();
        }
    },

    // 1sec timer-based batching system.
    // Set a timeout so that multiple tabs all opened at once (like when restoring a session)
    // only trigger this function once (as per the timeout set by the last tab event)
    // This will cause multiple triggers if time between tab openings is longer than 1 sec
    queueWindowEvent: (windowId, eventId, callback) => {
        clearTimeout(spacesService.sessionUpdateTimers[windowId]);

        spacesService.eventQueueCount += 1;

        spacesService.sessionUpdateTimers[windowId] = setTimeout(() => {
            spacesService.handleWindowEvent(windowId, eventId, callback);
        }, 1000);
    },

    // careful here as this function gets called A LOT
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
            // 若無法 get 到該 window，代表已關閉或無效
            if (chrome.runtime.lastError) {
                console.warn(`[handleWindowEvent] ${chrome.runtime.lastError.message}. Skip event.`);
                // 若找不到該 window，就把對應 session 的 windowId 移除，防止「幽靈」狀態
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

            // don't allow event if it pertains to a closed window id
            if (spacesService.closedWindowIds[windowId]) {
                if (spacesService.debug)
                    // eslint-disable-next-line no-console
                    console.log(
                        `ignoring event as it pertains to a closed windowId: ${windowId}`
                    );
                return;
            }

            // if window is associated with an open session then update session
            const session = spacesService.getSessionByWindowId(windowId);

            if (session) {
                if (spacesService.debug)
                    // eslint-disable-next-line no-console
                    console.log(
                        `tab statuses: ${curWindow.tabs
                            .map(curTab => {
                                return curTab.status;
                            })
                            .join('|')}`
                    );

                // look for tabs recently added/removed from this session and update session history
                const historyItems = spacesService.historyQueue.filter(
                    historyItem => {
                        return historyItem.windowId === windowId;
                    }
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

                // ---------------------------------------------------------
                // ★★ 確保 session.tabs 存有 pinned 屬性 ★★
                // ---------------------------------------------------------
                session.tabs = curWindow.tabs.map(t => ({
                    // 保留所有必要的屬性
                    ...t,
                    pinned: t.pinned
                }));

                session.sessionHash = spacesService.generateSessionHash(
                    session.tabs
                );

                // if it is a saved session then update db
                if (session.id) {
                    spacesService.saveExistingSession(session.id);
                }
            }

            // if no session found, it must be a new window.
            // if session found without session.id then it must be a temporary session
            // check for sessionMatch
            if (!session || !session.id) {
                if (spacesService.debug) {
                    console.log('session check triggered');
                }
                // 保存當前 session 名稱
                const currentName = session ? session.name : false;
                
                // 檢查 session 匹配
                spacesService.checkForSessionMatch(curWindow);
                
                // 如果有名稱，更新新建的臨時 session
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

    // PUBLIC FUNCTIONS

    getSessionBySessionId: sessionId => {
        const result = spacesService.sessions.filter(session => {
            return session.id === sessionId;
        });
        return result.length === 1 ? result[0] : false;
    },
    getSessionByWindowId: windowId => {
        const result = spacesService.sessions.filter(session => {
            return session.windowId === windowId;
        });
        return result.length === 1 ? result[0] : false;
    },
    getSessionBySessionHash: (hash, closedOnly) => {
        const result = spacesService.sessions.filter(session => {
            if (closedOnly) {
                return session.sessionHash === hash && !session.windowId;
            }
            return session.sessionHash === hash;
        });
        return result.length >= 1 ? result[0] : false;
    },
    getSessionByName: name => {
        const result = spacesService.sessions.filter(session => {
            return (
                session.name &&
                session.name.toLowerCase() === name.toLowerCase()
            );
        });
        return result.length >= 1 ? result[0] : false;
    },
    getAllSessions: () => {
        return spacesService.sessions;
    },

    addUrlToSessionHistory: (session, newUrl) => {
        if (spacesService.debug) {
            // eslint-disable-next-line no-console
            console.log(`adding tab to history: ${newUrl}`);
        }

        const cleanUrl = spacesService._cleanUrl(newUrl);

        if (cleanUrl.length === 0) {
            return false;
        }

        // don't add removed tab to history if there is still a tab open with same url
        // note: assumes tab has NOT already been removed from session.tabs
        const tabBeingRemoved = session.tabs.filter(curTab => {
            return spacesService._cleanUrl(curTab.url) === cleanUrl;
        });

        if (tabBeingRemoved.length !== 1) {
            return false;
        }

        // eslint-disable-next-line no-param-reassign
        if (!session.history) session.history = [];

        // see if tab already exists in history. if so then remove it (it will be re-added)
        session.history.some((historyTab, index) => {
            if (spacesService._cleanUrl(historyTab.url) === cleanUrl) {
                session.history.splice(index, 1);
                return true;
            }
            return false;
        });

        // add url to session history
        // eslint-disable-next-line no-param-reassign
        session.history = tabBeingRemoved.concat(session.history);

        // trim history for this space down to last 200 items
        // eslint-disable-next-line no-param-reassign
        session.history = session.history.slice(0, 200);

        return session;
    },

    removeUrlFromSessionHistory: (session, newUrl) => {
        if (spacesService.debug) {
            // eslint-disable-next-line no-console
            console.log(`removing tab from history: ${newUrl}`);
        }

        // eslint-disable-next-line no-param-reassign
        newUrl = spacesService._cleanUrl(newUrl);

        if (newUrl.length === 0) {
            return;
        }

        // see if tab already exists in history. if so then remove it
        session.history.some((historyTab, index) => {
            if (spacesService._cleanUrl(historyTab.url) === newUrl) {
                session.history.splice(index, 1);
                return true;
            }
            return false;
        });
    },

    // Database actions

    updateSessionTabs: (sessionId, tabs, callback) => {
        const session = spacesService.getSessionBySessionId(sessionId);

        // eslint-disable-next-line no-param-reassign
        callback =
            typeof callback !== 'function' ? spacesService.noop : callback;

        // update tabs in session
        session.tabs = tabs;
        session.sessionHash = spacesService.generateSessionHash(session.tabs);

        spacesService.saveExistingSession(session.id, callback);
    },

    /**
     * 更新指定會話的窗口 ID
     * @param {number} sessionId - 會話的 ID
     * @param {number} windowId - 新窗口的 ID
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

    updateSessionName: (sessionId, sessionName, callback) => {
        // eslint-disable-next-line no-param-reassign
        callback =
            typeof callback !== 'function' ? spacesService.noop : callback;

        const session = spacesService.getSessionBySessionId(sessionId);
        session.name = sessionName;

        spacesService.saveExistingSession(session.id, callback);
    },

    /**
     * 這裡是原本的 saveExistingSession，接受 sessionId，
     * 內部用 dbService.updateSession( session, callback )。
     */
    saveExistingSession: (sessionId, callback) => {
        const session = spacesService.getSessionBySessionId(sessionId);

        // 如果沒有提供回調，使用 noop 函數
        callback = typeof callback === 'function' ? callback : spacesService.noop;

        // 更新 session 並調用回調
        dbService.updateSession(session, callback);
    },

    saveNewSession: (sessionName, tabs, windowId, callback) => {
        if (!tabs) {
            callback(false);
            return;
        }

        try {
            const sessionHash = spacesService.generateSessionHash(tabs);
            let session;

            // 確保回調函數存在
            callback = typeof callback === 'function' ? callback : spacesService.noop;

            // 檢查窗口ID對應的臨時會話
            if (windowId) {
                session = spacesService.getSessionByWindowId(windowId);
            }

            // 如果沒有找到臨時會話，創建新的
            if (!session) {
                session = {
                    windowId,
                    history: [],
                };
                spacesService.sessions.push(session);
            }

            // 更新會話詳情
            session.name = sessionName;
            session.sessionHash = sessionHash;
            session.tabs = tabs;
            session.lastAccess = new Date();

            // 保存到數據庫
            dbService.createSession(session, savedSession => {
                try {
                    if (savedSession) {
                        // 更新緩存中的會話ID
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

    deleteSession: (sessionId, callback) => {
        // eslint-disable-next-line no-param-reassign
        callback =
            typeof callback !== 'function' ? spacesService.noop : callback;

        dbService.removeSession(sessionId, () => {
            // remove session from cached array
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

    processQueue: () => {
        if (spacesService.isProcessing || spacesService.queue.length === 0) {
            return;
        }

        spacesService.isProcessing = true;
        const update = spacesService.queue.shift();
        
        // 使用 Promise 來處理非同步操作
        Promise.resolve(update())
            .catch(error => {
                console.error('Error processing queue item:', error);
            })
            .finally(() => {
                spacesService.isProcessing = false;
                // 檢查是否還有其他任務需要處理
                if (spacesService.queue.length > 0) {
                    spacesService.processQueue();
                }
            });
    },
};