import xs, { Stream } from 'xstream';
import sampleCombine from 'xstream/extra/sampleCombine';
import { VNode, DOMSource, li, input } from '@cycle/dom';
import { StateSource } from 'cycle-onionify';

import {filter} from 'fuzzaldrin';

export type State = any;

type Reducer = (state: State) => State | undefined;

export interface Sources {
  DOM: DOMSource;
  onion: StateSource<State>;
};
export interface Sinks {
  DOM: Stream<VNode>;
  onion: Stream<Reducer>;
  choose: Stream<string | null>
};

type IdType = 'terrain' | 'furniture' | 'monstergroup' | 'item_group';

const computeVisibleItems = ({type, items, search}: {type: 'monstergroup' | 'item_group' | 'terrain' | 'furniture', items: {[id: string]: any}, search: string}) => {
  const key = type === 'monstergroup' ? 'name' : 'id';
  const matching = filter(Object.values(items), search || '', {key})
  return matching;
}

export function IdSelector(cddaData: any, type: IdType, initialSearch: string, items: Array<any>): (sources: Sources) => Sinks {
  return (sources: Sources): Sinks => {
    const state$ = sources.onion.state$
    const visibleItems = (search: string) => computeVisibleItems({type, items, search})
    const {onion: action$, choose$, cancel$} = intent(initialSearch, visibleItems, sources.DOM);
    const vdom$ = view(type, cddaData, visibleItems, state$);

    const chosenId$ = xs.merge(
      cancel$.mapTo(null),
      choose$.compose(sampleCombine(state$))
        .map(([_, s]) => s)
        .filter(state => state.selectedIdx != null)
        .map(state => visibleItems(state.search)[state.selectedIdx])
        .filter(item => item != null)
        .map(item => item.type === 'monstergroup' ? item.name as string : item.id as string)
    ).take(1);

    return {
      DOM: vdom$,
      onion: action$,
      choose: chosenId$
    };
  }
}

function intent(initialSearch: string, getVisibleItems: (search: string) => Array<any>, DOM: DOMSource): {onion: Stream<Reducer>, choose$: Stream<null>, cancel$: Stream<null>} {
  const default$ = xs.of((prevState: State | null): State => {
    if (prevState == null) {
      return { search: initialSearch, selectedIdx: 0 }
    } else return prevState;
  });

  const searchBox = DOM.select('.search input')
  const search$ = searchBox.events('input').map(e => (state: State): State => ({...state, search: (e.target as HTMLInputElement).value, selectedIdx: 0}));
  const upDown$ = xs.merge(
    searchBox.events('keydown').filter((e: KeyboardEvent) => e.key === 'ArrowDown').map(e => e.preventDefault()).mapTo(1),
    searchBox.events('keydown').filter((e: KeyboardEvent) => e.key === 'ArrowUp').map(e => e.preventDefault()).mapTo(-1)
  ).map(v => (state: any): any => ({...state,
    selectedIdx: Math.max(0, Math.min((state.selectedIdx == null ? -1 : state.selectedIdx) + v, getVisibleItems(state.search).length - 1))}));

  const choose$: Stream<null> = xs.merge(
    searchBox.events('keydown').filter((e: KeyboardEvent) => e.key === 'Enter'),
    DOM.select('.result').events('click')
  ).mapTo(null);
  const cancel$: Stream<null> = xs.merge(
    DOM.select('document').events('keydown').filter((e: KeyboardEvent) => e.key === 'Escape'),
    DOM.select('.modal-background').events('click').filter(e => e.target === e.currentTarget)
  ).mapTo(null);
  const hover$: Stream<Reducer> = DOM.select('.result').events('mouseover').map(e => (state: State): State => {
    return {...state, selectedIdx: Number((e.target as any).idx)};
  });

  const clear$: Stream<Reducer> = xs.merge(choose$, cancel$).mapTo((state: State) => undefined)

  return {onion: xs.merge(default$, search$, upDown$, hover$, clear$), choose$, cancel$};
}

function view(type: IdType, cddaData: any, getVisibleItems: (search: string) => Array<any>, state$: Stream<any>): Stream<VNode> {
  return state$.filter(s => s != null).map(state => {
    const {search, selectedIdx} = state;
    const visibleItems = getVisibleItems(search);
    const selectedItem = selectedIdx >= 0 ? visibleItems[selectedIdx] : undefined;
    const key = type === 'monstergroup' ? 'name' : 'id';
    return <div className='modal-background' style={{position: 'fixed', top: '0', bottom: '0', left: '0', right: '0', background: 'rgba(0, 0, 0, 0.5)'}}>
      <div style={{display: 'flex', position: 'fixed', top: '0px', left: '0px', background: 'black', border: '4px solid white', maxHeight: '100%'}}>
        <div className='list' style={{display: 'flex', flexDirection: 'column'}}>
          <div className='search'>
            {input('.search', {
              props: {value: search},
              hook: {insert: ({elm}: {elm: HTMLInputElement}) => elm.focus()},
              style: {font: 'inherit', background: 'black', color: 'orange', outline: 'none', border: 'none'}
            })}
          </div>
          <ul className='results' style={{listStyle: 'none', margin: '0', padding: '0', overflowY: 'auto'}}>
            {visibleItems.map((item: any, idx: number) => {
              const selected = item === selectedItem;
              return li('.result', {
                key: item[key],
                class: {selected},
                props: {idx: idx.toString()},
                style: {background: selected ? 'white' : 'black', color: selected ? 'black' : 'white'},
                hook: {insert: ({elm}: {elm: HTMLElement}) => selected && scrollIntoView(elm), update: ({elm}: {elm: HTMLElement}) => selected && scrollIntoView(elm)}
              }, [item[key]]);
            })}
          </ul>
        </div>
        <div className='info' style={{overflowY: 'auto'}}>
          {selectedItem
            ? renderItem(cddaData, selectedItem)
            : <div><em>Nothing selected</em></div>}
        </div>
      </div>
    </div>;
  });
}

type ItemMod = {
  charges?: [number, number] | number,
  "charges-min"?: number,
  "charges-max"?: number,
  damage?: [number, number] | number,
  "damage-min"?: number,
  "damage-max"?: number,
  count?: [number, number] | number,
  "count-min"?: number,
  "count-max"?: number,
  "container-item"?: string,
}

type ItemEntry = (
  {
    item: string,
    prob?: number,
  }
  | {
    group: string,
    prob?: number,
  }
  | {
    distribution: Array<ItemEntry>,
    prob?: number,
  }
  | {
    collection: Array<ItemEntry>,
    prob?: number,
  }
) & ItemMod;

function isItem(t: ItemEntry): t is {item: string, prob?: number} & ItemMod {
  return 'item' in t;
}
function isGroup(t: ItemEntry): t is {group: string, prob?: number} & ItemMod {
  return 'group' in t;
}
function isCollection(t: ItemEntry): t is {collection: ItemEntry[]} & ItemMod {
  return 'collection' in t;
}
function isDistribution(t: ItemEntry): t is {distribution: ItemEntry[]} & ItemMod {
  return 'distribution' in t;
}

function renderItem(cddaData: any, item: any): VNode {
  switch (item.type) {
    case 'terrain':
      return <div>
        <div>{item.name}</div>
        <br/><div>{item.flags != null ? item.flags.join(", ") : <em>No flags.</em>}</div>
        <br/><div>Move cost: {item.move_cost}</div>
      </div>;
    case 'furniture':
      return <div>
        <div>{item.name}</div>
        <br/><div>{item.flags != null ? item.flags.join(", ") : <em>No flags.</em>}</div>
        {item.move_cost_mod != null ? <div><br/>Move cost modifier: {item.move_cost_mod}</div> : null}
        {item.max_volume != null ? <div><br/>Maximum volume: {item.max_volume / 1000} L</div> : null}
      </div>;
    case 'item_group': {
      const readEntry = (e: ItemEntry | [string, number], defaultType: 'item' | 'group'): ItemEntry => {
        if (Array.isArray(e)) {
          const [itemId, prob] = e;
          if (defaultType === 'item')
            return {item: itemId, prob};
          else
            return {group: itemId, prob};
        } else {
          return e;
        }
      }
      const entries: Array<ItemEntry> = [].concat(
        (item.items || []).map((i: ItemEntry) => readEntry(i, 'item')),
        (item.groups || []).map((i: ItemEntry) => readEntry(i, 'group')),
        item.entries || []
      );
      const totalProb = entries.reduce((t, e) => t + (e.prob != null ? e.prob : 100), 0)
      entries.sort((b, a) => (a.prob != null ? a.prob : 100) - (b.prob != null ? b.prob : 100));
      const comment = item.comment || item['//'];
      return <div>
        <div>{item.id}</div>
        {comment != null ? <div><br/>{comment}</div> : null}
        <ul>
          {(item.subtype === 'collection' ? [{collection: entries}] : entries).map(e => renderItemGroupEntry(cddaData, e, totalProb))}
        </ul>
      </div>
    }
    case 'monstergroup': {
      const monsters = [...(item.monsters || [])];
      monsters.sort((a, b) => b.freq - a.freq);
      const comment = item['//'] || item._comment;
      const totalFreq = monsters.reduce((t, m) => t + m.freq, 0)
      return <div>
        <div>{item.name}</div>
        {comment != null ? <div><br/>{comment}</div> : null}
        {item.replace_monster_group ? <div><br/>Replaced by {item.new_monster_group_id} at time {item.replacement_time}</div> : null}
        <ul>
          {item.default !== 'mon_null' ?
            <li>{((1000 - totalFreq) / 1000 * 100).toFixed(1)}% {cddaData.monster[item.default].name} <span style={{color: 'gray'}}>({item.default})</span></li>
            : null}
          {monsters.map(mon => {
            const pack = mon.pack_size ? ` x ${mon.pack_size[0]}-${mon.pack_size[1]}` : '';
            const cost = `${mon.cost_multiplier}`;
            return <li>{(mon.freq / 1000 * 100).toFixed(1)}% [{cost}] {cddaData.monster[mon.monster].name}{pack} <span style={{color: 'gray'}}>({mon.monster})</span></li>
          })}
        </ul>
      </div>;
    }
    default:
      return <div>
        <pre style={{font: '16px Fixedsys', whiteSpace: 'pre-wrap'}}>{JSON.stringify(item, null, 2)}</pre>
      </div>
  }
}

function renderItemGroupEntry(cddaData: any, e: ItemEntry, totalProb: number): VNode {
  if (isItem(e)) {
    const prob = (e.prob != null ? e.prob : 100) / totalProb;
    return <li>{(prob * 100).toFixed(1)}% {cddaData.item[e.item].name}{renderItemMod(e)} <span style={{color: 'gray'}}>({e.item})</span></li>;
  } else if (isGroup(e)) {
    const prob = (e.prob != null ? e.prob : 100) / totalProb;
    return <li>{(prob * 100).toFixed(1)}% Group: {e.group}{renderItemMod(e)}</li>;
  } else if (isDistribution(e)) {
    const subTotalProb = e.distribution.reduce((t, c) => t + (c.prob != null ? c.prob : 100), 0)
    const entries = [...e.distribution];
    entries.sort((a, b) => (a.prob != null ? a.prob : 100) - (b.prob != null ? b.prob : 100)).reverse();
    return <li>{`${((e.prob != null ? e.prob : 100) / totalProb * 100).toFixed(1)}% `}One of:{renderItemMod(e)}
      <ul>
        {entries.map(c => renderItemGroupEntry(cddaData, c, subTotalProb))}
      </ul>
    </li>
  } else if (isCollection(e)) {
    const subTotalProb = 100;
    const entries = [...e.collection];
    entries.sort((a, b) => (a.prob != null ? a.prob : 100) - (b.prob != null ? b.prob : 100)).reverse();
    return <li>{`${((e.prob != null ? e.prob : 100) / totalProb * 100).toFixed(1)}% `}Some of:{renderItemMod(e)}
      <ul>
        {entries.map(c => renderItemGroupEntry(cddaData, c, subTotalProb))}
      </ul>
    </li>
  } else {
    console.error("Unknown item entry", e);
    return <li><pre>{JSON.stringify(e, null, 2)}</pre></li>
  }
}

const formatRange = (r: number | [number, number]): string =>
  typeof r === 'number' ? `${r}` : `${r[0]}-${r[1]}`

function renderItemMod(mod: ItemMod): string {
  const getRange = (k: 'charges' | 'damage' | 'count'): number | [number, number] | null =>
    mod[k] != null
    ? mod[k] as number | [number, number]
    : ((mod as any)[`${k}-min`] != null && (mod as any)[`${k}-max`] != null)
      ? [(mod as any)[`${k}-min`] as number, (mod as any)[`${k}-max`] as number]
      : null;
  const mods = [];
  const charges = getRange('charges');
  if (charges != null) {
    mods.push(`${formatRange(charges)} charges`)
  }
  const damage = getRange('damage');
  if (damage != null) {
    mods.push(`damage ${formatRange(damage)}`)
  }
  const modsStr = mods.length ? ` [${mods.join(', ')}]` : ''

  const count = getRange('count');
  const countStr = count != null ? ` x ${formatRange(count)}` : '';

  return [countStr, modsStr].join('')
}

function scrollIntoView(e: HTMLElement): void {
  const {top, bottom} = e.getBoundingClientRect();
  if (!e.parentElement) return;
  const {top: parentTop, bottom: parentBottom} = e.parentElement.getBoundingClientRect();
  if (bottom > parentBottom)
    e.scrollIntoView(false)
  else if (top < parentTop)
    e.scrollIntoView(true)
}
