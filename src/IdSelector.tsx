import xs, { Stream } from 'xstream';
import { VNode, DOMSource, li, input } from '@cycle/dom';
import { isolate } from '@cycle/isolate';
import { StateSource } from 'cycle-onionify';

import { Sources, Sinks } from './interfaces';

import * as fs from 'fs';
import * as path from 'path';
import * as electron from 'electron';
import * as glob from 'glob';
import * as stringify from 'json-beautify';

export function IdSelector(sources) {
  const {onion: action$, choose$, cancel$} = intent(sources.DOM);
  const vdom$ = view(sources.onion.state$);

  const choose$ = xs.merge(cancel$.mapTo(null), choose$.map(_ => {
    return sources.onion.state$
      .filter(state => state.selectedIdx != null)
      .take(1)
      .map(state => computeVisibleItems(state)[state.selectedIdx])
      .filter(item => item != null)
      .map(item => item.id)
  }).flatten());

  return {
    DOM: vdom$,
    onion: action$,
    choose: choose$
  };
}

function intent(DOM) {
  const default$ = xs.of(prevState => {
    if (prevState == null) {
      return { search: '' }
    } else return prevState;
  });

  const searchBox = DOM.select('.search input')
  const search$ = searchBox.events('input').map(e => state => ({...state, search: e.target.value, selectedIdx: 0}));
  const upDown$ = xs.merge(
    searchBox.events('keydown').filter(e => e.key === 'ArrowDown').map(e => e.preventDefault()).mapTo(1),
    searchBox.events('keydown').filter(e => e.key === 'ArrowUp').map(e => e.preventDefault()).mapTo(-1)
  ).map(v => state => ({...state, selectedIdx: Math.max(0, Math.min((state.selectedIdx == null ? -1 : state.selectedIdx) + v, computeVisibleItems(state).length - 1))}));

  const choose$ = searchBox.events('keydown').filter(e => e.key === 'Enter')
  const cancel$ = xs.merge(
    DOM.select('document').events('keydown').filter(e => e.key === 'Escape'),
    DOM.select('.modal-background').events('click').filter(e => e.target === e.currentTarget)
  )

  return {onion: xs.merge(default$, search$, upDown$), choose$, cancel$};
}

const computeVisibleItems = ({items, search}) => Object.values(items).filter(({id}) => id.startsWith(search || ''))

function view(state$) {
  return state$.filter(s => s.editingType != null).map(state => {
    const visibleItems = computeVisibleItems(state);
    const selectedItem = state.selectedIdx >= 0 ? visibleItems[state.selectedIdx] : undefined;
    return <div className='modal-background' style={{position: 'fixed', top: '0', bottom: '0', left: '0', right: '0', background: 'rgba(0, 0, 0, 0.5)'}}>
      <div style={{display: 'flex', position: 'fixed', top: '0px', left: '0px', background: 'black', border: '4px solid white', maxHeight: '100%'}}>
        <div className='list' style={{display: 'flex', flexDirection: 'column'}}>
          <div className='search'>
            {input('.search', {
              props: {value: state.search},
              hook: {insert: ({elm}) => elm.focus()},
              style: {font: 'inherit', background: 'black', color: 'white', outline: 'none', border: 'none'}
            })}
          </div>
          <ul className='results' style={{listStyle: 'none', margin: '0', padding: '0', overflow: 'scroll'}}>
            {visibleItems.map(item => {
              const selected = item === selectedItem;
              return li(`.result${selected ? '.selected' : ''}`, {
                key: item.id,
                style: {background: selected ? 'white' : 'black', color: selected ? 'black' : 'white'},
                hook: {insert: (e) => selected && scrollIntoView(e.elm) }
              }, [item.id]);
            })}
          </ul>
        </div>
        <div className='info'>
          {selectedItem
            ? <div>
              <h2>{selectedItem.name}</h2>
            </div>
            : <div>
              <em>Nothing selected</em>
            </div>
          }
        </div>
      </div>
    </div>;
  });
}

function scrollIntoView(e) {
  const {top, bottom} = e.getBoundingClientRect();
  const {top: parentTop, bottom: parentBottom} = e.parentNode.getBoundingClientRect();
  if (bottom > parentBottom)
    e.scrollIntoView(false)
  else if (top < parentTop)
    e.scrollIntoView(true)
}
