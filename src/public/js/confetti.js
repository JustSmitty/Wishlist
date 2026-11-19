/** A short burst of paper confetti. Skipped when the person prefers reduced motion. */

const COLOURS = ['#b3243b', '#1f6b4f', '#e2a12b', '#2b4a86', '#5b3a7a', '#f39aa7'];

export function confetti(origin = null) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (typeof Element.prototype.animate !== 'function') return;

  const rect = origin?.getBoundingClientRect?.();
  const x0 = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y0 = rect ? rect.top + rect.height / 2 : window.innerHeight / 3;

  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);

  const pieces = 42;
  let remaining = pieces;
  for (let i = 0; i < pieces; i++) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    // Set through the CSSOM, which the content security policy permits.
    piece.style.backgroundColor = COLOURS[i % COLOURS.length];
    piece.style.left = `${x0}px`;
    piece.style.top = `${y0}px`;
    if (i % 3 === 0) piece.style.borderRadius = '50%';
    layer.appendChild(piece);

    const angle = (Math.PI * 2 * i) / pieces + Math.random() * 0.4;
    const reach = 90 + Math.random() * 190;
    const dx = Math.cos(angle) * reach;
    const dy = Math.sin(angle) * reach - 120;
    const spin = (Math.random() - 0.5) * 900;

    piece.animate([
      { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.8}px, ${dy}px) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy + 260}px) rotate(${spin}deg)`, opacity: 0 }
    ], { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' })
      .finished.catch(() => {}).finally(() => { if (--remaining === 0) layer.remove(); });
  }
}
