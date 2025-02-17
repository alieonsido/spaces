# <img src="/img/icon48.png" align="absmiddle"> Spaces

### A browser extension for Intuitive tab management

Spaces is a workspace manager for chrome and edge.
It treats each window like a different workspace and lets you name and save each space.
You can close a window full of tabs at any time then reopen it later and continue exactly
where you left off.

Spaces keeps track of new tabs opened in each workspace and also tabs that you close.
It also allows you to quickly move a tab that you are currently viewing into any
other space- whether it's open or closed.
Great for when you find yourself opening a tab out of context with what you are currently
working on and want to come back to it later.

Spaces was developed to help users that tend to have way too many tabs open in a window.
It encourages you to move tabs that are not immediately relevant into a different,
more appropriate space - thus removing it from your current window.
This keeps your browser session manageable - both visually and from a memory perspective.

Isn't this essentially just bookmarks with folders? Yeah, pretty much - but who uses bookmarks?

<!-- ### Chrome Web Store

Spaces is also [available via the official Chrome Web Store](https://chrome.google.com/webstore/detail/spaces/cenkmofngpohdnkbjdpilgpmbiiljjim).

Please note that the webstore version may be behind the latest version here. -->

### Install as an extension from source

1. Download the latest available version
- Notice: At root directory, you could run `just` or `just comlink-extension` to build new submodule from `justfile` if you need to.
2. Unarchive to your preferred location (e.g., `Downloads`).
3. In **Google Chrome**, navigate to [chrome://extensions/](chrome://extensions/) and enable <kbd>Developer mode</kbd> in the upper right corner.
4. Click on the <kbd>LOAD UNPACKED</kbd> button.
- if you want to sync in every chrome browser between every device, you could use <kbd>PACK EXTENSION</kbd> button and then drag the `crx` file which you packed to the chrome extension page. More details could be found in [chrome extension documentation](https://developer.chrome.com/docs/extensions/mv3/getstarted/development-basics/#load-unpacked).
5. Browse to the _root directory_ of the unarchived download, and click <kbd>OPEN</kbd>.

> **TODO** &mdash; add more sections
> - [ ] Build from github
> - [ ] License (currently unspecified)
