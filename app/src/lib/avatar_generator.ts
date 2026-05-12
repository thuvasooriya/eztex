// Playful Avatars "beam" variant (MIT licensed)
// Source: https://github.com/cmaas/playful-avatars

const PALETTE = [
  "#7aa2f7",
  "#bb9af7",
  "#73daca",
  "#e0af68",
  "#f7768e",
  "#9ece6a",
  "#2ac3de",
  "#ff9e64",
];

function hashCode(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const character = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + character;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function getDigit(number: number, index: number): number {
  return Math.floor((number / Math.pow(10, index)) % 10);
}

function getBoolean(number: number, index: number): boolean {
  return !((getDigit(number, index)) % 2);
}

function getUnit(number: number, range: number, index?: number): number {
  const value = number % range;
  if (index && ((getDigit(number, index) % 2) === 0)) {
    return -value;
  }
  return value;
}

function getRandomColor(number: number, colors: string[], range: number): string {
  return colors[(number) % range];
}

function getContrastColor(hexcolor: string): string {
  hexcolor = hexcolor.replace("#", "");
  const r = parseInt(hexcolor.substr(0, 2), 16);
  const g = parseInt(hexcolor.substr(2, 2), 16);
  const b = parseInt(hexcolor.substr(4, 2), 16);
  const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
  return (yiq >= 128) ? "#000000" : "#FFFFFF";
}

function generateBeamData(name: string, colors: string[], size: number) {
  const numFromName = hashCode(name);
  const range = colors.length;
  const wrapperColor = getRandomColor(numFromName, colors, range);
  const preTranslateX = getUnit(numFromName, 10, 1);
  const wrapperTranslateX = preTranslateX < 5 ? preTranslateX + size / 9 : preTranslateX;
  const preTranslateY = getUnit(numFromName, 10, 2);
  const wrapperTranslateY = preTranslateY < 5 ? preTranslateY + size / 9 : preTranslateY;

  return {
    wrapperColor,
    faceColor: getContrastColor(wrapperColor),
    backgroundColor: getRandomColor(numFromName + 13, colors, range),
    wrapperTranslateX,
    wrapperTranslateY,
    wrapperRotate: getUnit(numFromName, 360),
    wrapperScale: 1 + getUnit(numFromName, size / 12) / 10,
    isMouthOpen: getBoolean(numFromName, 2),
    isCircle: getBoolean(numFromName, 1),
    eyeSpread: getUnit(numFromName, 5),
    mouthSpread: getUnit(numFromName, 3),
    faceRotate: getUnit(numFromName, 10, 3),
    faceTranslateX: wrapperTranslateX > size / 6 ? wrapperTranslateX / 2 : getUnit(numFromName, 8, 1),
    faceTranslateY: wrapperTranslateY > size / 6 ? wrapperTranslateY / 2 : getUnit(numFromName, 7, 2),
  };
}

function generateBeamSVG(name: string, colors: string[]): string {
  const size = 36;
  const data = generateBeamData(name, colors, size);
  const faceTransform = `translate(${data.faceTranslateX} ${data.faceTranslateY}) rotate(${data.faceRotate} ${size / 2} ${size / 2})`;
  const mouth = data.isMouthOpen
    ? `<path d="M15 ${19 + data.mouthSpread}c2 1 4 1 6 0" stroke="${data.faceColor}" fill="none" stroke-linecap="round" />`
    : `<path d="M13,${19 + data.mouthSpread} a1,0.75 0 0,0 10,0" fill="${data.faceColor}" />`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="none" role="img" width="100%" height="100%">
    <title>${name}</title>
    <mask id="mask-${name}">
      <rect width="${size}" height="${size}" rx="${size / 2}" ry="${size / 2}" fill="#FFFFFF" />
    </mask>
    <g mask="url(#mask-${name})">
      <rect width="${size}" height="${size}" fill="${data.backgroundColor}" />
      <rect x="0" y="0" width="${size}" height="${size}" transform="translate(${data.wrapperTranslateX} ${data.wrapperTranslateY}) rotate(${data.wrapperRotate} ${size / 2} ${size / 2}) scale(${data.wrapperScale})" fill="${data.wrapperColor}" rx="${data.isCircle ? size : size / 6}" />
      <g transform="${faceTransform}">
        ${mouth}
        <rect x="${14 - data.eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${data.faceColor}" />
        <rect x="${20 + data.eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${data.faceColor}" />
      </g>
    </g>
  </svg>`;
}

export function generate_avatar_svg(seed: string, _size: number = 32): string {
  return generateBeamSVG(seed, PALETTE);
}
