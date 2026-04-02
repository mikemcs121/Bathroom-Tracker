const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;
const fs = require('fs');
const path = require('path');
const os = require('os');

// Hall pass card with approved checkmark — no toilet imagery
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <!-- App navy background -->
  <rect width="256" height="256" rx="40" fill="#1a365d"/>

  <!-- Pass card (white) -->
  <rect x="44" y="24" width="168" height="214" rx="18" fill="#f8fafc"/>

  <!-- Card header bar -->
  <rect x="44" y="24" width="168" height="62" rx="18" fill="#2a4a7f"/>
  <rect x="44" y="68"  width="168" height="18"  fill="#2a4a7f"/>

  <!-- Header text lines -->
  <rect x="64" y="40" width="90" height="11" rx="5" fill="rgba(255,255,255,0.9)"/>
  <rect x="64" y="58" width="62" height="8"  rx="4" fill="rgba(255,255,255,0.55)"/>

  <!-- Body content lines -->
  <rect x="64" y="106" width="128" height="10" rx="5" fill="#cbd5e1"/>
  <rect x="64" y="126" width="100" height="9"  rx="4" fill="#e2e8f0"/>
  <rect x="64" y="145" width="116" height="9"  rx="4" fill="#e2e8f0"/>
  <rect x="64" y="164" width="80"  height="9"  rx="4" fill="#e2e8f0"/>

  <!-- Approved badge (green circle + checkmark) -->
  <circle cx="178" cy="212" r="30" fill="white"/>
  <circle cx="178" cy="212" r="25" fill="#16a34a"/>
  <path d="M164 212 L174 222 L192 200"
        stroke="white" stroke-width="6"
        stroke-linecap="round" stroke-linejoin="round"
        fill="none"/>
</svg>
`;

async function main() {
  const assetsDir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  // Write 256x256 PNG to a temp file
  const tmpPng = path.join(os.tmpdir(), 'bt-icon-256.png');
  await sharp(Buffer.from(svg)).resize(256, 256).png().toFile(tmpPng);

  // png-to-ico default export accepts a file path and auto-generates all sizes
  const icoBuffer = await pngToIco(tmpPng);
  const outPath = path.join(assetsDir, 'icon.ico');
  fs.writeFileSync(outPath, icoBuffer);
  fs.unlinkSync(tmpPng);
  console.log('Icon created:', outPath);
}

main().catch(err => { console.error(err); process.exit(1); });
