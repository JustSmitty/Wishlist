/** Circles: the groups you share lists with, and Secret Santa. */

import { html, raw, money, plural, avatar, dateLong, daysUntil, countdown } from '../dom.js';
import { get, post } from '../api.js';
import { store, on, refresh, toast, openSheet, copyText } from '../app.js';
import { icon, empty } from '../parts.js';
import { confetti } from '../confetti.js';

export default {
  title: () => 'Circles',

  async load() {
    return get('/api/groups');
  },

  render({ groups }) {
    return html`
      <header class="page-head">
        <div>
          <p class="eyebrow">Circles</p>
          <h1>Your people</h1>
          <p>A circle is a family or a group of friends. Lists shared with a circle are open to everyone in it, and only people in a circle see each other's names on gifts.</p>
        </div>
        <div class="row">
          <button class="btn" type="button" data-action="join-circle">Join with a code</button>
          <button class="btn btn--primary" type="button" data-action="new-circle">${icon('plus', { size: 18 })} Start a circle</button>
        </div>
      </header>

      ${groups.length === 0 ? empty({
        title: 'You are not in a circle yet',
        text: 'Start one for your family or friends and send them the invite code — or enter a code someone sent you.',
        seed: 'circles'
      }) : groups.map(circleCard)}`;
  }
};

function circleCard(g) {
  const today = new Date().toISOString().slice(0, 10);
  const live = g.exchanges.find(ex => ex.event_date >= today);
  const past = g.exchanges.filter(ex => ex !== live);
  const adults = g.members.length;
  return html`
    <section class="card stack" aria-labelledby="circle-${g.id}">
      <div class="row row--between">
        <div>
          <h2 id="circle-${g.id}">${g.name}</h2>
          ${g.description ? html`<p class="muted">${g.description}</p>` : ''}
        </div>
        <span class="pill">${g.my_role === 'organizer' ? 'You organise this' : 'Member'}</span>
      </div>

      <div class="members">
        ${g.members.map(m => html`<span class="member">${avatar(m.name, { size: 'sm' })}${m.name}${m.role === 'organizer' ? html` <span class="muted small">· organiser</span>` : ''}</span>`)}
      </div>

      <div class="invite">
        <div class="grow"><span class="eyebrow">Invite code</span><br /><code>${g.invite_code}</code></div>
        <button class="btn btn--sm" type="button" data-action="copy-invite" data-code="${g.invite_code}">${icon('copy', { size: 16 })} Copy</button>
        <p class="small muted">Anyone with this code can join and see the lists shared here. Send it only to people you mean to invite.</p>
      </div>

      <hr />

      <div class="row row--between">
        <h3>Secret Santa</h3>
        ${!live && g.my_role === 'organizer' ? html`
          <button class="btn btn--sm btn--primary" type="button" data-action="draw-names" data-group="${g.id}" ${adults < 3 ? raw('disabled') : ''}>${icon('wand', { size: 16 })} Draw names</button>` : ''}
      </div>

      ${live ? html`
        <div class="stack">
          <p><strong>${live.name}</strong> · ${dateLong(live.event_date)} (${countdown(daysUntil(live.event_date))}) · up to ${money(live.budget_limit)} · ${plural(live.participant_count, 'person', 'people')}</p>
          ${live.my_assigned_recipient ? html`
            <button class="envelope" type="button" data-action="open-envelope" aria-expanded="false">
              <span class="envelope__paper">
                <span class="envelope__flap" aria-hidden="true"></span>
                ${raw('<svg class="envelope__wax" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18" fill="currentColor"/><path d="M13 22c0-6 3-10 7-10s7 4 7 10M17 26h6" fill="none" stroke="#fffdf8" stroke-width="2.2" stroke-linecap="round"/></svg>')}
                <span class="envelope__closed">Your name is inside. Tap to open — when nobody is looking over your shoulder.</span>
                <span class="envelope__open">You are giving to<span class="envelope__name">${live.my_assigned_recipient.name}</span><span class="small">Tap again to hide it.</span></span>
              </span>
            </button>
            <p class="small muted">Only you can see who you drew. Not even the organiser can see the other pairings.</p>` : html`
            <p class="muted small">You joined after names were drawn, so you are not in this one.</p>`}
        </div>` : html`
        <p class="muted small">${adults < 3
          ? 'A draw needs at least three people in the circle.'
          : g.my_role === 'organizer'
            ? 'Everyone is given one person to buy for. You can keep partners from drawing each other.'
            : 'No names drawn yet. An organiser can start a draw.'}</p>`}

      ${past.length ? html`<p class="small muted">Earlier: ${past.map(ex => `${ex.name} (${dateLong(ex.event_date)})`).join(', ')}</p>` : ''}
    </section>`;
}

on('copy-invite', (el) => copyText(el.dataset.code, 'Invite code copied'));

on('open-envelope', (el) => {
  const open = el.getAttribute('aria-expanded') === 'true';
  el.setAttribute('aria-expanded', open ? 'false' : 'true');
  if (!open) confetti(el);
});

on('new-circle', () => {
  openSheet({
    title: 'Start a circle', size: 'narrow', submitLabel: 'Create circle',
    body: html`
      <div class="field"><label for="ci-name">Name</label><input id="ci-name" name="name" required maxlength="80" placeholder="The Okafors" /></div>
      <div class="field"><label for="ci-desc">Description <span class="muted">(optional)</span></label><input id="ci-desc" name="description" maxlength="300" placeholder="Birthdays, holidays and the kids" /></div>`,
    onSubmit: async (v) => {
      await post('/api/groups', v);
      toast('Circle created. Share the invite code to bring people in.');
      await refresh();
    }
  });
});

on('join-circle', () => {
  openSheet({
    title: 'Join a circle', intro: 'Enter the invite code someone sent you. Your link-shared lists are shared with the circle too.', size: 'narrow', submitLabel: 'Join',
    body: html`<div class="field"><label for="jc-code">Invite code</label><input id="jc-code" name="invite_code" required maxlength="64" autocapitalize="characters" autocomplete="off" /></div>`,
    onSubmit: async (v) => {
      const { group } = await post('/api/groups/join', v);
      toast(`You joined ${group.name}`);
      await refresh();
    }
  });
});

on('draw-names', (el) => {
  const group = store.current.data.groups.find(g => g.id === el.dataset.group);
  const exclusions = [];
  const defaultDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const sheet = openSheet({
    title: 'Draw names',
    intro: `Each of the ${group.members.length} people in ${group.name} is given one person to buy for. Once drawn it cannot be redrawn until the exchange date has passed.`,
    submitLabel: 'Draw',
    body: html`
      <div class="field"><label for="dn-name">Name of the exchange</label><input id="dn-name" name="name" required maxlength="120" value="Secret Santa" /></div>
      <div class="fields">
        <div class="field"><label for="dn-date">Exchange date</label><input id="dn-date" name="event_date" type="date" required value="${defaultDate}" min="${new Date().toISOString().slice(0, 10)}" /></div>
        <div class="field"><label for="dn-budget">Spending limit</label><input id="dn-budget" name="budget_limit" type="number" min="0" step="1" inputmode="decimal" value="50" /></div>
      </div>
      <fieldset class="field">
        <legend class="label">Keep these two from drawing each other <span class="muted">(optional)</span></legend>
        <div class="row">
          <select name="ex_a" aria-label="First person">${group.members.map(m => html`<option value="${m.id}">${m.name}</option>`)}</select>
          <select name="ex_b" aria-label="Second person">${group.members.map((m, i) => html`<option value="${m.id}" ${i === 1 ? raw('selected') : ''}>${m.name}</option>`)}</select>
          <button class="btn btn--sm" type="button" data-add-exclusion>Add</button>
        </div>
        <div class="chips" data-exclusions aria-live="polite"></div>
      </fieldset>`,
    onSubmit: async (v) => {
      await post('/api/secret-santa', {
        group_id: group.id, name: v.name, event_date: v.event_date, budget_limit: Number(v.budget_limit) || 0, exclusions
      });
      confetti();
      toast('Names drawn. Everyone can open their envelope.');
      await refresh();
    }
  });

  const nameOf = (id) => group.members.find(m => m.id === id)?.name || '?';
  const box = sheet.form.querySelector('[data-exclusions]');
  const draw = () => {
    box.replaceChildren(...exclusions.map((pair, index) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = `${nameOf(pair[0])} ✕ ${nameOf(pair[1])} — remove`;
      chip.addEventListener('click', () => { exclusions.splice(index, 1); draw(); });
      return chip;
    }));
  };
  sheet.form.querySelector('[data-add-exclusion]').addEventListener('click', () => {
    const a = sheet.form.elements.ex_a.value;
    const b = sheet.form.elements.ex_b.value;
    if (a === b) { sheet.setError('Pick two different people'); return; }
    sheet.setError('');
    if (!exclusions.some(p => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a))) exclusions.push([a, b]);
    draw();
  });
});
