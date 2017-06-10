import xs, { Stream } from 'xstream';
import { VNode, DOMSource, li, input } from '@cycle/dom';
import isolate from '@cycle/isolate';
import { StateSource } from 'cycle-onionify';

import { Sources, Sinks } from './interfaces';

import * as fs from 'fs';
import * as path from 'path';
import * as electron from 'electron';
import * as glob from 'glob';
import * as stringify from 'json-beautify';
import {filter} from 'fuzzaldrin';

export function IdSelector(sources) {
  const {onion: action$, choose$, cancel$} = intent(sources.DOM);
  const vdom$ = view(sources.onion.state$);

  const chosenId$ = xs.merge(cancel$.mapTo(null), choose$.map(_ => {
    return sources.onion.state$
      .filter(state => state.selectedIdx != null)
      .take(1)
      .map(state => computeVisibleItems(state)[state.selectedIdx])
      .filter(item => item != null)
      .map(item => item.type === 'monstergroup' ? item.name : item.id)
  }).flatten());

  return {
    DOM: vdom$,
    onion: action$,
    choose: chosenId$
  };
}

function intent(DOM: DOMSource) {
  const default$ = xs.of(prevState => {
    if (prevState == null) {
      return { search: '' }
    } else return prevState;
  });

  const searchBox = DOM.select('.search input')
  const search$ = searchBox.events('input').map(e => state => ({...state, search: e.target.value, selectedIdx: 0}));
  const upDown$ = xs.merge(
    searchBox.events('keydown').filter((e: KeyboardEvent) => e.key === 'ArrowDown').map(e => e.preventDefault()).mapTo(1),
    searchBox.events('keydown').filter((e: KeyboardEvent) => e.key === 'ArrowUp').map(e => e.preventDefault()).mapTo(-1)
  ).map(v => (state: any): any => ({...state, selectedIdx: Math.max(0, Math.min((state.selectedIdx == null ? -1 : state.selectedIdx) + v, computeVisibleItems(state).length - 1))}));

  const choose$ = xs.merge(
    searchBox.events('keydown').filter((e: KeyboardEvent) => e.key === 'Enter'),
    DOM.select('.result').events('click')
  )
  const cancel$ = xs.merge(
    DOM.select('document').events('keydown').filter((e: KeyboardEvent) => e.key === 'Escape'),
    DOM.select('.modal-background').events('click').filter(e => e.target === e.currentTarget)
  )
  const hover$ = DOM.select('.result').events('mouseover').map(e => state => {
    return {...state, selectedIdx: Number(e.target.idx)};
  });

  return {onion: xs.merge(default$, search$, upDown$, hover$), choose$, cancel$};
}

const computeVisibleItems = ({type, items, search}: {type: 'monstergroup' | 'item_group' | 'terrain' | 'furniture', items: {[id: string]: any}, search: string}) => {
  const key = type === 'monstergroup' ? 'name' : 'id';
  const matching = filter(Object.values(items), search || '', {key})
  return matching;
}

function view(state$: Stream<any>) {
  return state$.filter(s => s.type != null).map(state => {
    const visibleItems = computeVisibleItems(state);
    const selectedItem = state.selectedIdx >= 0 ? visibleItems[state.selectedIdx] : undefined;
    const key = state.type === 'monstergroup' ? 'name' : 'id';
    return <div className='modal-background' style={{position: 'fixed', top: '0', bottom: '0', left: '0', right: '0', background: 'rgba(0, 0, 0, 0.5)'}}>
      <div style={{display: 'flex', position: 'fixed', top: '0px', left: '0px', background: 'black', border: '4px solid white', maxHeight: '100%'}}>
        <div className='list' style={{display: 'flex', flexDirection: 'column'}}>
          <div className='search'>
            {input('.search', {
              props: {value: state.search},
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
                hook: {insert: ({elm}: {elm: HTMLElement}) => selected && scrollIntoView(elm) }
              }, [item[key]]);
            })}
          </ul>
        </div>
        <div className='info' style={{overflowY: 'auto'}}>
          {selectedItem
            ? renderItem(selectedItem)
            : <div><em>Nothing selected</em></div>}
        </div>
      </div>
    </div>;
  });
}

function renderItem(item: any) {
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
    default:
      return <div>
        <pre style={{font: '16px Fixedsys'}}>{JSON.stringify(item, null, 2)}</pre>
      </div>
  }
}

function scrollIntoView(e: HTMLElement) {
  const {top, bottom} = e.getBoundingClientRect();
  if (!e.parentElement) return;
  const {top: parentTop, bottom: parentBottom} = e.parentElement.getBoundingClientRect();
  if (bottom > parentBottom)
    e.scrollIntoView(false)
  else if (top < parentTop)
    e.scrollIntoView(true)
}
