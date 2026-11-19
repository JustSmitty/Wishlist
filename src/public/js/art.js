/**
 * Generative gift-wrap artwork.
 *
 * Hushlist does not load product photos from other sites (privacy, and the
 * content security policy forbids it), so every wish gets its own wrapping
 * paper instead: a pattern, palette and emblem derived from the item itself.
 * The same item always gets the same paper.
 *
 * When a giver has reserved an item the tile gains a ribbon; once it is
 * bought the ribbon gets its bow. Owners of a sealed list never see either.
 */

import { raw, hash } from './dom.js';

// [paper, pattern ink, accent, ribbon]
const PALETTES = [
  ['#f6d9c7', '#e9a98b', '#b3243b', '#7a1830'],
  ['#dfe9d5', '#a9c69a', '#1f6b4f', '#b3243b'],
  ['#f8e6b8', '#ecc76a', '#8a5a00', '#1f6b4f'],
  ['#dbe4f3', '#a9bfe3', '#2b4a86', '#d08a1c'],
  ['#ecdcf2', '#c9a9dc', '#5b3a7a', '#d08a1c'],
  ['#f9d9dd', '#eea5b0', '#9b2242', '#2b4a86'],
  ['#d6ece9', '#98cfc8', '#17605a', '#b3243b'],
  ['#efe3d3', '#d3bb99', '#6b4a2b', '#1f6b4f'],
  ['#2b2440', '#473b68', '#f2c768', '#ff8fa0'],
  ['#16382e', '#24574a', '#f2c768', '#f6d9c7']
];

const EMBLEMS = {
  product: '<path d="M-9 -3h18v12h-18zM-11 -8h22v5h-22zM0 -8v17M0 -8c-2-4-8-5-8-1.5 0 2.5 4 1.5 8 1.5zM0 -8c2-4 8-5 8-1.5 0 2.5-4 1.5-8 1.5z"/>',
  experience: '<path d="M-11 -6h22v4a2.5 2.5 0 0 0 0 5v4h-22v-4a2.5 2.5 0 0 0 0-5zM4 -6v13" /><path d="M-6 -1l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z" fill="currentColor" stroke="none"/>',
  cash: '<rect x="-11" y="-7" width="22" height="14" rx="2"/><circle cx="0" cy="0" r="3.5"/><path d="M-8 -4v0M8 4v0"/>',
  idea: '<path d="M-4 6h8M-3 9.5h6M-5 2.5c-2-1.4-3-3.4-3-5.5a8 8 0 0 1 16 0c0 2.1-1 4.1-3 5.5V6h-10z"/>'
};

let uniq = 0;

function pattern(kind, id, ink, accent, rnd) {
  const open = `<pattern id="${id}" patternUnits="userSpaceOnUse"`;
  switch (kind) {
    case 0: // candy stripes
      return `${open} width="28" height="28" patternTransform="rotate(${rnd(2) ? 45 : -45})"><rect width="12" height="28" fill="${ink}"/><rect x="18" width="2.5" height="28" fill="${accent}" fill-opacity=".550"/></pattern>`;
    case 1: // polka dots
      return `${open} width="30" height="30"><circle cx="7" cy="7" r="4.5" fill="${ink}"/><circle cx="22" cy="22" r="4.5" fill="${ink}"/><circle cx="22" cy="7" r="1.6" fill="${accent}" fill-opacity=".7"/></pattern>`;
    case 2: // gingham
      return `${open} width="32" height="32"><rect width="16" height="32" fill="${ink}" fill-opacity=".550"/><rect width="32" height="16" fill="${ink}" fill-opacity=".550"/></pattern>`;
    case 3: // chevrons
      return `${open} width="36" height="22"><path d="M0 16l9-10 9 10 9-10 9 10" fill="none" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/></pattern>`;
    case 4: // scallops
      return `${open} width="36" height="20"><path d="M0 0a18 18 0 0 0 36 0M-18 10a18 18 0 0 0 36 0M18 10a18 18 0 0 0 36 0" fill="none" stroke="${ink}" stroke-width="3"/></pattern>`;
    case 5: // confetti
      return `${open} width="44" height="44"><rect x="6" y="5" width="9" height="3.5" rx="1.7" fill="${ink}" transform="rotate(24 10 7)"/><rect x="27" y="14" width="9" height="3.5" rx="1.7" fill="${accent}" fill-opacity=".750" transform="rotate(-35 31 16)"/><circle cx="14" cy="29" r="2.8" fill="${accent}" fill-opacity=".6"/><rect x="29" y="33" width="9" height="3.5" rx="1.7" fill="${ink}" transform="rotate(70 33 35)"/><circle cx="36" cy="4" r="2" fill="${ink}"/></pattern>`;
    case 6: // sparkles
      return `${open} width="40" height="40"><path d="M10 3l1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8z" fill="${ink}"/><path d="M30 23l1.2 3.8L35 28l-3.8 1.2L30 33l-1.2-3.8L25 28l3.8-1.2z" fill="${accent}" fill-opacity=".7"/></pattern>`;
    case 7: // waves
      return `${open} width="48" height="18"><path d="M0 9c8-9 16-9 24 0s16 9 24 0" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/></pattern>`;
    case 8: // triangles
      return `${open} width="30" height="26"><path d="M0 26L15 0l15 26z" fill="${ink}" fill-opacity=".8"/></pattern>`;
    default: // pinstripe plaid
      return `${open} width="26" height="26"><path d="M0 6h26M0 19h26" stroke="${ink}" stroke-width="5"/><path d="M8 0v26" stroke="${accent}" stroke-opacity=".6" stroke-width="2"/></pattern>`;
  }
}

/**
 * @param item   { id, title, kind }
 * @param state  'open' | 'reserved' | 'bought'
 */
export function giftArt(item, state = 'open') {
  const seed = hash(`${item.id || ''}|${item.title || ''}`);
  let s = seed || 1;
  const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n; };

  const [paper, ink, accent, ribbon] = PALETTES[seed % PALETTES.length];
  const id = `wrap${(uniq++).toString(36)}`;
  const kind = Object.hasOwn(EMBLEMS, item.kind) ? item.kind : 'product';
  const defs = pattern(rnd(10), id, ink, accent, rnd);
  const tilt = rnd(9) - 4;

  const sticker = `
    <g transform="translate(200 150) rotate(${tilt})">
      <circle r="46" fill="#fffdf8"/>
      <circle r="46" fill="none" stroke="${accent}" stroke-opacity=".350" stroke-width="2" stroke-dasharray="3 5"/>
      <g fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" transform="scale(2.1)" color="${accent}">${EMBLEMS[kind]}</g>
    </g>`;

  const wrap = state === 'open' ? '' : `
    <g>
      <rect x="182" y="0" width="36" height="300" fill="${ribbon}"/>
      <rect x="0" y="132" width="400" height="36" fill="${ribbon}"/>
      <rect x="182" y="0" width="7" height="300" fill="#000" fill-opacity=".120"/>
      <rect x="0" y="161" width="400" height="7" fill="#000" fill-opacity=".120"/>
      ${state === 'bought' ? `
        <g transform="translate(200 150)" fill="${ribbon}" stroke="#000" stroke-opacity=".180" stroke-width="2" stroke-linejoin="round">
          <path d="M0 0c-14-34-70-46-74-16-4 28 42 26 74 16z"/>
          <path d="M0 0c14-34 70-46 74-16 4 28-42 26-74 16z"/>
          <path d="M-6 6l-22 48 20-10 8 20 10-52z"/>
          <path d="M6 6l22 48-20-10-8 20-10-52z"/>
          <rect x="-13" y="-13" width="26" height="26" rx="8"/>
        </g>` : ''}
    </g>`;

  const svg = `<svg class="art" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <defs>${defs}</defs>
    <rect width="400" height="300" fill="${paper}"/>
    <rect width="400" height="300" fill="url(#${id})"/>
    ${state === 'open' ? sticker : ''}
    ${wrap}
  </svg>`;
  return raw(svg);
}

/** Compact swatch (no emblem) for chips and thumbnails. */
export function swatch(seedText) {
  const seed = hash(seedText);
  let s = seed || 1;
  const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n; };
  const [paper, ink, accent] = PALETTES[seed % PALETTES.length];
  const id = `sw${(uniq++).toString(36)}`;
  const svg = `<svg class="swatch" viewBox="0 0 60 60" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false"><defs>${pattern(rnd(10), id, ink, accent, rnd)}</defs><rect width="60" height="60" fill="${paper}"/><rect width="60" height="60" fill="url(#${id})"/></svg>`;
  return raw(svg);
}
