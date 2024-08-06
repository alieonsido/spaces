set shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-c"]

default: comlinkExtension

comlinkExtension:
    git submodule update --init --recursive
    cd comlink-extension && npm install
    npx esbuild comlink-extension/src/index.ts --bundle --outfile=build/comlink-extension.bundle.js --format=esm
