/* global chrome  */
// eslint-disable-next-line no-var, no-unused-vars
globalThis.utils = {
    getHashVariable: (key, urlStr) => {
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
};