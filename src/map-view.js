/**
 * The section map, as a table.
 *
 * One row per variation, one column per part, and a dot where the part sounds.
 * This is the view the style file actually supports: it declares which parts play
 * in which variation, and nothing more. What it does not record is which note
 * belongs to which variation, so this table makes no claim about that - see
 * `attribution.js` for the part that has to guess, and says so when it does.
 *
 * The layout is a grid rather than a table element because the cells are toggles
 * with their own state, and a grid keeps the columns aligned when a section has a
 * different number of parts from its neighbour.
 */

/**
 * @param {HTMLElement} root
 * @param {{
 *   onToggle?: (sectionName: string, channel: number, on: boolean) => void,
 *   onRename?: (sectionName: string, name: string) => void,
 *   onRemove?: (sectionName: string) => void,
 *   onClone?: (sectionName: string) => void,
 *   editable?: boolean,
 * }} handlers
 */
export class MapView {
  constructor(root, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    /** @type {any} */
    this.casm = null;
    /** @type {{channel: number, names: string[], sections: number}[]} */
    this.parts = [];
    /** @type {Set<string>} */
    this.pendingSections = new Set();
    this.editable = false;
  }

  /**
   * @param {any} casm from parseCasm, already carrying any staged edits
   * @param {{channel: number, names: string[], sections: number}[]} parts
   */
  render(casm, parts, { editable = false } = {}) {
    this.casm = casm;
    this.parts = parts;
    this.editable = editable;
    this.root.textContent = '';

    if (!casm || casm.sections.length === 0) {
      this.root.innerHTML = '<p class="empty">This file declares no variations.</p>';
      return;
    }
    // The grid template needs to know how many part columns there are, and it has
    // to be one number for the whole table or the rows will not line up.
    this.root.style.setProperty('--cols', String(parts.length));
    this.root.append(this.#header());
    this.root.append(this.#body());
  }

  /** The row of part names that labels the columns. */
  #header() {
    const row = document.createElement('div');
    row.className = 'map-row map-head';
    row.append(Object.assign(document.createElement('div'), {
      className: 'map-name', textContent: 'Variation',
    }));
    for (const part of this.parts) {
      const cell = document.createElement('div');
      cell.className = 'map-col';
      const [name, ...rest] = part.names;
      cell.textContent = name;
      // A channel with one name in most variations and another in one or two is
      // worth saying out loud, because "which part is this" stops having a single
      // answer.
      cell.title = rest.length
        ? `ch ${part.channel + 1} · named ${part.names.join(' / ')} · in ${part.sections} variation(s)`
        : `ch ${part.channel + 1} · in ${part.sections} variation(s)`;
      if (rest.length) cell.classList.add('multi');
      row.append(cell);
    }
    row.append(Object.assign(document.createElement('div'), { className: 'map-actions' }));
    return row;
  }

  /** One row per variation. */
  #body() {
    const wrap = document.createElement('div');
    wrap.className = 'map-body';
    for (const section of this.casm.sections) {
      wrap.append(this.#sectionRow(section));
    }
    return wrap;
  }

  #sectionRow(section) {
    const row = document.createElement('div');
    row.className = 'map-row';

    const name = document.createElement('div');
    name.className = 'map-name';
    const label = document.createElement('span');
    label.textContent = section.name;
    name.append(label);
    if (section.channels.length === 0) {
      const empty = document.createElement('em');
      empty.textContent = 'no parts';
      name.append(empty);
    }
    row.append(name);

    for (const part of this.parts) {
      row.append(this.#cell(section, part));
    }

    row.append(this.#actions(section));
    return row;
  }

  /**
   * One toggle.
   *
   * Rendered as a button with a pressed state rather than a checkbox so it can be
   * large enough to hit on a touchscreen and can be styled as a dot - the dot is
   * the thing being read at a glance, not a small square with a tick in it.
   */
  #cell(section, part) {
    const cell = document.createElement('div');
    cell.className = 'map-col';

    const on = section.channels.includes(part.channel);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-dot' + (on ? ' on' : '');
    button.setAttribute('aria-pressed', String(on));
    const name = this.#partNameIn(section, part);
    button.setAttribute('aria-label',
      `${part.channel + 1} ${name} in ${section.name}: ${on ? 'on' : 'off'}`);
    button.title = on
      ? `${name} plays in ${section.name} — click to switch it off`
      : `${name} does not play in ${section.name} — click to switch it on`;
    button.disabled = !this.editable;
    button.addEventListener('click', () => {
      if (!this.editable) return;
      this.handlers.onToggle?.(section.name, part.channel, !on);
    });
    cell.append(button);
    return cell;
  }

  /** The name this channel carries *in this section*, which is not always one name. */
  #partNameIn(section, part) {
    const entry = section.parts.find((p) => p.channel === part.channel);
    return entry?.name ?? part.names[0] ?? `ch ${part.channel + 1}`;
  }

  #actions(section) {
    const cell = document.createElement('div');
    cell.className = 'map-actions';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'map-btn';
    rename.textContent = 'Rename';
    rename.disabled = !this.editable;
    rename.addEventListener('click', () => {
      const next = window.prompt(`Name this variation:`, section.name);
      if (next && next.trim() && next.trim() !== section.name) {
        this.handlers.onRename?.(section.name, next.trim());
      }
    });

    const clone = document.createElement('button');
    clone.type = 'button';
    clone.className = 'map-btn';
    clone.textContent = 'Copy';
    clone.title = 'Add a new variation with the same parts, then edit it';
    clone.disabled = !this.editable;
    clone.addEventListener('click', () => this.handlers.onClone?.(section.name));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'map-btn map-btn-warn';
    remove.textContent = 'Delete';
    remove.title = 'Remove this variation from the file';
    remove.disabled = !this.editable;
    remove.addEventListener('click', () => {
      if (window.confirm(`Delete "${section.name}" from this file?`)) {
        this.handlers.onRemove?.(section.name);
      }
    });

    cell.append(rename, clone, remove);
    return cell;
  }

  /**
   * A plain-text summary, for anyone who would rather read the map than look at it.
   *
   * @returns {string}
   */
  toText() {
    if (!this.casm) return '';
    const width = Math.max(4, ...this.parts.map((p) => (p.names[0] ?? '').length));
    const lines = [
      `${this.casm.sections.length} variations, ${this.parts.length} parts`,
      '',
      ['Variation'.padEnd(11), ...this.parts.map((p) => (p.names[0] ?? '').padEnd(width))].join(' '),
    ];
    for (const section of this.casm.sections) {
      lines.push([
        section.name.padEnd(11),
        ...this.parts.map((p) => (section.channels.includes(p.channel) ? 'on' : '.').padEnd(width)),
      ].join(' '));
    }
    return lines.join('\n');
  }
}

/**
 * A one-line description of how complete the map looks, said plainly.
 *
 * Most of these styles do not carry all fifteen variations - they carry the ones
 * the arranger's editor happened to write. Saying so is more use than quietly
 * showing seven rows and letting the user wonder where Main D went.
 *
 * @param {any} casm
 * @returns {{text: string, complete: boolean}}
 */
export function describeMap(casm) {
  if (!casm || casm.sections.length === 0) return { text: 'No variation map in this file.', complete: false };
  const n = casm.sections.length;
  if (n >= 15) return { text: `All ${n} variations are declared.`, complete: true };
  return {
    text: `This file declares ${n} variation${n === 1 ? '' : 's'}, not the full fifteen. `
      + 'The others were never written into it, so they cannot be edited here.',
    complete: false,
  };
}
