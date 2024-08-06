/* global chrome  */
// eslint-disable-next-line no-var, no-unused-vars
export function getHashVariable(key, urlStr) {
        const valuesByKey = {};
        const keyPairRegEx = /^(.+)=(.+)/;

        if (!urlStr || urlStr.length === 0 || urlStr.indexOf('#') === -1) {
            return false;
        }

        // extract hash component from url
        const hashStr = urlStr.replace(/^[^#]+#+(.*)/, '$1');

        if (hashStr.length === 0) {
            return false;
        }

        hashStr.split('&').forEach(keyPair => {
            if (keyPair && keyPair.match(keyPairRegEx)) {
                valuesByKey[
                    keyPair.replace(keyPairRegEx, '$1')
                ] = keyPair.replace(keyPairRegEx, '$2');
            }
        });
        return valuesByKey[key] || false;
    }

export function getFaviconURL(url, size = "16") {
    const u = new URL(chrome.runtime.getURL("/_favicon/"));
    u.searchParams.set("pageUrl", url);
    u.searchParams.set("size", size);
    return u.toString();
}