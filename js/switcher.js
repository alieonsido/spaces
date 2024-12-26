/* global chrome, spacesRenderer  */

// TODO is this dead code?  It's not loaded anywhere.

(() => {
    function getSelectedSpace() {
        return document.querySelector('.space.selected');
    }

    function handleSwitchAction(selectedSpaceEl) {
        const sessionId = selectedSpaceEl.getAttribute('data-sessionId');
        const windowId = selectedSpaceEl.getAttribute('data-windowId');
        
        if (windowId) {
            // 先檢查 window 是否存在
            chrome.windows.get(parseInt(windowId), (window) => {
                if (chrome.runtime.lastError) {
                    // Window 不存在，嘗試使用 sessionId
                    if (sessionId) {
                        chrome.runtime.sendMessage({
                            action: 'loadSession',
                            sessionId: sessionId
                        });
                    }
                } else {
                    chrome.runtime.sendMessage({
                        action: 'loadWindow',
                        windowId: windowId
                    });
                }
            });
        } else if (sessionId) {
            chrome.runtime.sendMessage({
                action: 'loadSession',
                sessionId: sessionId
            });
        }
    }

    function handleCloseAction() {
        chrome.runtime.sendMessage({
            action: 'requestClose',
        });
    }

    function getSwitchKeycodes(callback) {
        chrome.runtime.sendMessage({ action: 'requestHotkeys' }, commands => {
            // eslint-disable-next-line no-console
            console.dir(commands);

            const commandStr = commands.switchCode;
            const keyStrArray = commandStr.split('+');

            // get keyStr of primary modifier
            const primaryModifier = keyStrArray[0];

            // get keyStr of secondary modifier
            const secondaryModifier =
                keyStrArray.length === 3 ? keyStrArray[1] : false;

            // get keycode of main key (last in array)
            const curStr = keyStrArray[keyStrArray.length - 1];
            let mainKeyCode;

            // TODO: There's others. Period. Up Arrow etc.
            if (curStr === 'Space') {
                mainKeyCode = 32;
            } else {
                mainKeyCode = curStr.toUpperCase().charCodeAt();
            }

            callback({
                primaryModifier,
                secondaryModifier,
                mainKeyCode,
            });
        });
    }

    function addEventListeners() {
        document.getElementById('spaceSelectForm').onsubmit = e => {
            e.preventDefault();
            handleSwitchAction(getSelectedSpace());
        };

        const allSpaceEls = document.querySelectorAll('.space');
        Array.prototype.forEach.call(allSpaceEls, el => {
            // eslint-disable-next-line no-param-reassign
            el.onclick = () => {
                handleSwitchAction(el);
            };
        });

        // Here lies some pretty hacky stuff. Yus! Hax!
        getSwitchKeycodes(() => {
            const body = document.querySelector('body');

            body.onkeyup = e => {
                // listen for escape key
                if (e.keyCode === 27) {
                    handleCloseAction();
                }
            };
        });
    }

    function validateWindow(windowId) {
        return new Promise((resolve, reject) => {
            if (!windowId) {
                resolve(null);
                return;
            }
            
            chrome.windows.get(parseInt(windowId), (window) => {
                if (chrome.runtime.lastError) {
                    resolve(null);
                } else {
                    resolve(window);
                }
            });
        });
    }

    window.onload = async () => {
        // 先請求更新所有 spaces 的狀態
        chrome.runtime.sendMessage({ action: 'requestAllSpaces' }, async spaces => {
            if (!spaces || spaces.length === 0) return;
            
            // 初始化 renderer
            spacesRenderer.initialise(8, true);
            
            // 在渲染之前檢查每個 space 的 window 狀態
            const validatedSpaces = await Promise.all(spaces.map(async space => {
                if (space.windowId) {
                    try {
                        await chrome.windows.get(parseInt(space.windowId));
                        return space;
                    } catch (e) {
                        // 如果 window 不存在，重置 windowId
                        return { ...space, windowId: null };
                    }
                }
                return space;
            }));
            
            // 渲染驗證後的 spaces
            spacesRenderer.renderSpaces(validatedSpaces);
            addEventListeners();
        });
    };
})();
