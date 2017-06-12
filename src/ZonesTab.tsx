import xs, { Stream } from 'xstream';
import sampleCombine from 'xstream/extra/sampleCombine';
import concat from 'xstream/extra/concat';
import { VNode } from '@cycle/dom';
import * as dom from '@cycle/dom';
import isolate from '@cycle/isolate';

import {IdSelector, Sinks as IdSelectorSinks} from './IdSelector';
import Styles from './styles';

import {AppSources, AppSinks, Reducer, AppState, ZoneOptions, LootZoneOptions, MonstersZoneOptions} from './app';


export function ZonesTab(sources: AppSources): AppSinks {
  const {DOM} = sources;
  const changeZoneType$: Stream<Reducer> = DOM.select('.zoneType').events('change').map(e => (state: AppState): AppState => {
    const select = e.target as HTMLSelectElement;
    const newZoneOptions = {
      loot: { type: 'loot', groupId: 'everyday_gear', chance: 100, repeat: 1 } as LootZoneOptions,
      monsters: { type: 'monsters', groupId: 'GROUP_ZOMBIE', chance: 1, repeat: 1 } as MonstersZoneOptions
    }[select.value as "loot" | "monsters"];
    return {...state, zoneOptions: newZoneOptions}
  })

  const chooseRequest$ = DOM.select('.zoneGroup')
    .events('click')
    .compose(sampleCombine(sources.onion.state$.map(s => s.zoneOptions)))
    .map(([_, zoneOptions]) => {
      return {
        zoneType: zoneOptions.type,
        type: {
          loot: 'item_group',
          monsters: 'monstergroup'
        }[zoneOptions.type] as 'item_group' | 'monstergroup',
        search: zoneOptions.groupId,
      };
    });

  const selector$ = chooseRequest$.compose(sampleCombine(sources.onion.state$)).map(([req, state]) => {
    return isolate(IdSelector(state.cddaData, req.type, req.search || '', state.cddaData[req.type]), 'editingZone')(sources);
  }) as Stream<IdSelectorSinks>;
  const selectorDom$ = selector$.map(s => concat(s.DOM.endWhen(s.choose), xs.of(null))).flatten().startWith(null)
  const selectorReducers$ = selector$.map(s => s.onion).flatten()

  const editZoneGroup$ = selector$.map(s => s.choose).flatten().map(chosen => {
    return (state: AppState): AppState => {
      if (chosen == null) return state;
      return {...state, zoneOptions: {...state.zoneOptions, groupId: chosen}};
    }
  })

  return {
    DOM: xs.combine(
      sources.onion.state$.map(ZonesTabView),
      selectorDom$,
    ).map(doms => <span>{doms}</span>),
    onion: xs.merge(changeZoneType$, editZoneGroup$, selectorReducers$),
  }
}

function ZonesTabView(state: AppState): VNode {
  const {zoneOptions} = state;
  return <div>
    <div>
      Place:
      <select className="zoneType" value={zoneOptions.type}>
        <option>loot</option>
        <option>monsters</option>
      </select>
    </div>
    <div>
      Group: {dom.button('.zoneGroup.selector', [zoneOptions.groupId])}
    </div>
    <div>
      Repeat: {dom.input('.zoneRepeat', {attrs: {type: 'text'}, props: {value: zoneOptions.repeat}})}
    </div>
    <div>
      Chance: {dom.input('.zoneChance', {attrs: {type: 'text'}, props: {value: zoneOptions.chance}})}
    </div>
  </div>;
}
