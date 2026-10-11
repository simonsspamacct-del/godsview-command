/** The analyst chat: sends questions with the current view, streams events back. */

import { $, getJson, h, markdown, postJson, storage, store, uuid } from './util.js';

const SUGGESTIONS = [
  'What is happening in this view right now?',
  'Show me the public camera closest to the newest police report.',
  'Are there weather warnings here, and which cameras are inside them?',
  'Where are the ALPR cameras around here, and who operates them?',
];

export function createAnalyst({ getView, onAction, getBriefBbox }) {
  const log = $('#chat-log');
  const form = $('#chat-form');
  const input = $('#chat-input');
  const send = $('#chat-send');
  let sessionId = storage('gvc.session', null) || uuid();
  store('gvc.session', sessionId);
  let busy = false;

  const scroll = () => (log.scrollTop = log.scrollHeight);

  function system(text, kind = 'system') {
    log.append(h('div', { class: `msg ${kind}` }, text));
    scroll();
  }

  function intro() {
    log.replaceChildren(
      h(
        'div',
        { class: 'msg system' },
        'Ask about anything on the map. The analyst queries GodsView and the live feeds, then opens the relevant panels and moves the map for you.',
      ),
    );
  }
  intro();

  $('#suggestions').append(
    ...SUGGESTIONS.map((text) => h('button', { type: 'button', onClick: () => ask(text) }, text)),
  );

  async function ask(text) {
    if (busy || !text.trim()) return;
    busy = true;
    send.disabled = true;
    input.value = '';
    log.append(h('div', { class: 'msg user' }, text));
    const bubble = h('div', { class: 'msg assistant' });
    const tools = h('div', { class: 'tools' });
    const thinking = h('div', { class: 'thinking' }, 'Working…');
    bubble.append(tools, thinking);
    log.append(bubble);
    scroll();
    const chips = new Map();
    let textNode = null;
    let text_ = '';

    const handle = (event) => {
      if (event.type === 'tool') {
        let chip = chips.get(event.id);
        if (!chip) {
          chip = h('span', { class: 'chip' });
          chips.set(event.id, chip);
          tools.append(chip);
        }
        chip.dataset.state = event.state;
        chip.textContent = event.summary ? `${event.name} · ${event.summary}` : event.name;
        chip.title = event.summary || event.name;
      } else if (event.type === 'text') {
        text_ += (text_ ? '\n\n' : '') + event.text;
        if (!textNode) {
          textNode = h('div', {});
          bubble.insertBefore(textNode, thinking);
        }
        textNode.innerHTML = markdown(text_);
      } else if (event.type === 'action') onAction(event.action);
      else if (event.type === 'status') bubble.insertBefore(h('div', { class: 'thinking' }, event.text), thinking);
      else if (event.type === 'error') {
        bubble.classList.add('error');
        bubble.insertBefore(h('div', {}, event.message), thinking);
      }
      scroll();
    };

    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text, view: { ...getView(), localTime: new Date().toString() } }),
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handle(JSON.parse(line));
        }
      }
    } catch (error) {
      handle({ type: 'error', message: `Could not reach the analyst: ${error.message}` });
    } finally {
      thinking.remove();
      if (!bubble.textContent.trim()) bubble.append(h('div', { class: 'muted' }, 'No answer.'));
      busy = false;
      send.disabled = false;
      scroll();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    ask(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      ask(input.value);
    }
  });

  $('#reset-btn').addEventListener('click', async () => {
    await postJson('/api/ai/reset', { sessionId });
    sessionId = uuid();
    store('gvc.session', sessionId);
    intro();
  });

  /** A situation brief from GodsView's situation_brief tool; no model needed. */
  $('#brief-btn').addEventListener('click', async () => {
    const bbox = getBriefBbox();
    const bubble = h('div', { class: 'msg assistant' }, h('div', { class: 'thinking' }, 'Asking GodsView for a situation brief…'));
    log.append(bubble);
    scroll();
    const result = await getJson(`/api/brief?bbox=${bbox.map((v) => v.toFixed(4)).join(',')}`);
    if (!result.ok) {
      bubble.className = 'msg error';
      bubble.replaceChildren(`Brief unavailable: ${result.error}`);
      return;
    }
    const sections = result.data?.sections || {};
    const lines = Object.entries(sections).map(([key, section]) =>
      h('li', {}, h('b', {}, key.replace(/_/g, ' ')), ': ', section.unavailable ? h('span', { class: 'muted' }, section.reason || 'unavailable') : section.summary),
    );
    bubble.replaceChildren(
      h('div', { class: 'tools' }, h('span', { class: 'chip', dataset: { state: 'done' } }, 'situation_brief')),
      h('p', {}, h('b', {}, `Situation brief · ${result.data?.area || 'this view'}`)),
      lines.length ? h('ul', {}, lines) : h('p', {}, result.summary),
    );
    scroll();
  });

  return { ask, system };
}
