import xs, { Stream } from 'xstream';
import sampleCombine from 'xstream/extra/sampleCombine';
import concat from 'xstream/extra/concat';
import { VNode } from '@cycle/dom';
import * as dom from '@cycle/dom';
import isolate from '@cycle/isolate';

import {IdSelector, Sinks as IdSelectorSinks} from './IdSelector';
import Styles from './styles';

import {AppSources, AppSinks, Reducer, AppState, ZoneOptions, LootZoneOptions, MonstersZoneOptions} from './app';

const parseRange = (str: string): [number] | [number,number] | null => {
  const m = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(str)
  if (!m) return null;
  if (m[2]) {
    return [parseInt(m[1]), parseInt(m[2])];
  } else {
    return [parseInt(m[1])];
  }
}

const parsePositiveInteger = (str: string): number | null => {
  if (/^\s*(\d+)\s*$/.test(str))
    return Number(str);
  return null;
}

export function ZonesTab(sources: AppSources): AppSinks {
  const {DOM} = sources;
  const changeZoneType$: Stream<Reducer> = DOM.select('.zoneType').events('change').map(e => (state: AppState): AppState => {
    const select = e.target as HTMLSelectElement;
    const newZoneOptions = {
      loot: { type: 'loot', groupId: 'everyday_gear', chance: 100, repeat: [1] } as LootZoneOptions,
      monsters: { type: 'monsters', groupId: 'GROUP_ZOMBIE', chance: 1, repeat: [1] } as MonstersZoneOptions
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

  const changeGroup$ = selector$.map(s => s.choose).flatten()
  const changeRepeat$ =
    DOM.select('.zoneRepeat').events('blur')
      .map(e => (e.target as HTMLInputElement).value)
      .map(v => parseRange(v) || ([1] as [number]))

  const changeChance$ =
    DOM.select('.zoneChance').events('blur')
      .map(e => (e.target as HTMLInputElement).value)
      .map(parsePositiveInteger)

  const editZoneGroup$ = changeGroup$.map(chosen => (state: AppState): AppState => {
    if (chosen == null) return state;
    return {...state, zoneOptions: {...state.zoneOptions, groupId: chosen}};
  })

  const updateSelectedZone = (state: AppState, mutate: (zone: object) => object): AppState => {
    const {selectedZone} = state;
    if (!selectedZone) return state;
    const zoneType = selectedZone[0] === 'loot' ? 'place_loot' : 'place_monsters';
    return {...state,
      mapgen: {...state.mapgen,
        object: {...state.mapgen.object,
          [zoneType]: (state.mapgen.object[zoneType] || [] as any[]).map((z, i) => i === selectedZone[1] ? mutate(z) : z)
        }
      }
    }
  }

  const editSelectedZoneGroup$ = changeGroup$.filter(c => c != null).map(c => (state: AppState): AppState => {
    const {selectedZone} = state;
    if (!selectedZone) return state;
    return updateSelectedZone(state, (a: object): object => {
      switch (selectedZone[0]) {
        case 'loot':
          return {...a, group: c};
        case 'monsters':
          return {...a, monster: c};
      }
    });
  })

  const editRepeat$ = changeRepeat$.map(repeat => (state: AppState): AppState =>
    ({...state, zoneOptions: {...state.zoneOptions, repeat: repeat}}))

  const editSelectedZoneRepeat$ = changeRepeat$.map(repeat => (state: AppState): AppState => {
    const {selectedZone} = state;
    if (!selectedZone) return state;
    return updateSelectedZone(state, (a: object): object => {
      return {...a, repeat}
    });
  })

  const editChance$ = changeChance$.map(chance => (state: AppState): AppState => {
    return {...state, zoneOptions: {...state.zoneOptions, chance: chance == null ? (state.zoneOptions.type === 'loot' ? 100 : 1) : chance}}
  })

  const editSelectedZoneChance$ = changeChance$.map(chance => (state: AppState): AppState => {
    const {selectedZone} = state;
    if (!selectedZone) return state;
    return updateSelectedZone(state, (a: object): object => {
      return {...a, chance: chance == null ? (selectedZone[0] === 'loot' ? 100 : 1) : chance}
    });
  })

  const deleteZone$ = DOM.select('.deleteZone').events('click')
    .mapTo((state: AppState): AppState => {
      const {selectedZone} = state;
      if (!selectedZone) return state;
      const zoneType = selectedZone[0] === 'loot' ? 'place_loot' : 'place_monsters';
      return {...state,
        selectedZone: null,
        mapgen: {...state.mapgen,
          object: {...state.mapgen.object,
            [zoneType]: (state.mapgen.object[zoneType] || [] as any[]).filter((_, i) => i !== selectedZone[1])
          }
        }
      }
    })

  return {
    DOM: xs.combine(
      sources.onion.state$.map(ZonesTabView),
      selectorDom$,
    ).map(doms => <span>{doms}</span>),
    onion: xs.merge(changeZoneType$, editZoneGroup$, selectorReducers$, deleteZone$, editRepeat$, editSelectedZoneGroup$, editSelectedZoneRepeat$, editChance$, editSelectedZoneChance$),
  }
}

function ZonesTabView(state: AppState): VNode {
  const {zoneOptions} = state;
  const repeat = zoneOptions.repeat != null ? zoneOptions.repeat : 1;
  const repeatRange = Array.isArray(repeat) ? repeat : [repeat];
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
      Repeat: {dom.input('.zoneRepeat', {attrs: {type: 'text'}, props: {value: [repeatRange.join('-')] /* figure that one out, ha! */}})}
    </div>
    <div>
      Chance: {dom.input('.zoneChance', {attrs: {type: 'text'}, props: {value: [zoneOptions.chance]}})}
    </div>

    {state.selectedZone ? <div>
      <button className="deleteZone">delete zone</button>
    </div> : null}
  </div>;
}
