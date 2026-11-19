import { raw } from './dom.js';

/** Hand-drawn-feeling line icons, 24×24, stroke = currentColor. */
const PATHS = {
  list: '<path d="M4 7h3M4 12h3M4 17h3M10 7h10M10 12h10M10 17h7"/>',
  gift: '<path d="M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7c-1.5-3-5.5-3.5-5.5-1 0 1.5 2.5 1 5.5 1zM12 7c1.5-3 5.5-3.5 5.5-1 0 1.5-2.5 1-5.5 1z"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c.5-3.5 2.8-5.5 6-5.5s5.5 2 6 5.5M16 5.2a3 3 0 0 1 0 5.6M17.5 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
  bag: '<path d="M5 8h14l-1 12H6zM9 8V6.5a3 3 0 0 1 6 0V8"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="6" r="1.3" fill="currentColor"/><circle cx="17.2" cy="15" r="1.3" fill="currentColor"/><circle cx="6.8" cy="15" r="1.3" fill="currentColor"/>',
  inbox: '<path d="M4 6h16v12H4zM4 7l8 6 8-6"/>',
  shield: '<path d="M12 3l7 3v5.5c0 4.5-3 7.8-7 9.5-4-1.7-7-5-7-9.5V6z"/><path d="M9 12l2.2 2.2L15 10.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  share: '<path d="M12 15V4M8 7.5L12 4l4 3.5M5 12v7h14v-7"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/>',
  external: '<path d="M10 5H5v14h14v-5M13 4h7v7M20 4l-9 9"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
  edit: '<path d="M4 20l1-4.5L16 4.5l3.5 3.5L8.5 19zM14 6.5l3.5 3.5"/>',
  trash: '<path d="M5 7h14M9 7V4.5h6V7M7 7l1 13h8l1-13M10 11v5M14 11v5"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  ticket: '<path d="M4 8a2 2 0 0 0 0 4v0a2 2 0 0 0 0 4v2h16v-2a2 2 0 0 1 0-4v0a2 2 0 0 1 0-4V6H4zM14 6v12"/>',
  coin: '<circle cx="12" cy="12" r="8"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.2 0-2.2-.5-2.7-1.5M12 6.5V8M12 16v1.5"/>',
  bulb: '<path d="M9 17h6M10 20h4M8.5 14.5C7 13.5 6 11.8 6 10a6 6 0 0 1 12 0c0 1.8-1 3.5-2.5 4.5V17h-7z"/>',
  star: '<path d="M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7z"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.7-3.8 3.3-6 7-6s6.3 2.2 7 6"/>',
  out: '<path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h9"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  next: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
  flag: '<path d="M6 21V4M6 5h11l-2.5 4L17 13H6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  wand: '<path d="M5 19L16 8M14 6l4 4M17.5 3v2.5M20.5 5.5H18M6 4v2M7 5H5M19 14v2M20 15h-2"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8"/>'
};

export function icon(name, { size = 20, label = null } = {}) {
  const body = PATHS[name] || PATHS.gift;
  const a11y = label ? `role="img" aria-label="${label.replace(/[^\w ,.'-]/g, '')}"` : 'aria-hidden="true"';
  return raw(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${body}</svg>`);
}
