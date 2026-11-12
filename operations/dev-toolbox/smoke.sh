#!/bin/sh
# Execute INSIDE the target image, under the same unprivileged/offline policy as QA.
set -eu
target="${1:-core}"
node -e 'if(Number(process.versions.node.split(".")[0])!==24)process.exit(4)'
python3 -c 'import sys; assert sys.version_info[:2] == (3,13),sys.version'
npm --version >/dev/null
pnpm --version >/dev/null
yarn --version >/dev/null
tsc --version >/dev/null
tsx --version >/dev/null
git --version >/dev/null
gh --version >/dev/null
jq --version >/dev/null
rg --version >/dev/null
g++ --version >/dev/null
cmake --version >/dev/null
psql --version >/dev/null
redis-cli --version >/dev/null
echo "PASS: toolbox core Ubuntu 24.04 / Node 24 / Python 3.13 / CLI"

case "$target" in
  core) exit 0 ;;
  languages|browser|full)
    go version
    rustc --version
    cargo --version
    java -version
    ruby --version
    php --version
    echo "PASS: multi-language compilers"
    ;;
  *) echo "Unknown toolbox target: $target" >&2; exit 2 ;;
esac
case "$target" in
  languages) exit 0 ;;
  browser|full)
    playwright --version | grep '1.56.1'
    node - <<'NODE'
const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:393,height:873}});
    await page.goto('data:text/html,<canvas id="c" width="8" height="8"></canvas>');
    const pixel=await page.evaluate(()=>{
      const ctx=document.getElementById('c').getContext('2d');
      ctx.fillStyle='#00ff00';ctx.fillRect(0,0,8,8);
      return [...ctx.getImageData(1,1,1,1).data].join(',');
    });
    if(pixel!=='0,255,0,255')throw Error('Canvas pixel invalid: '+pixel);
    console.log('PASS: real Chromium and Canvas pixel');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
NODE
    ;;
esac
if [ "$target" = full ]; then
  python3 -c 'import pandas,numpy,scipy,sklearn,matplotlib,pytest,docx,pptx,pypdf,PIL,cv2'
  bun --version
  soffice --version
  pandoc --version >/dev/null
  qpdf --version >/dev/null
  ffmpeg -version >/dev/null
  tesseract --version 2>/dev/null
  echo "PASS: optional document/data/media stack"
fi
