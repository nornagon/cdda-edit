import xs, { Stream } from 'xstream';
import dropRepeats from 'xstream/extra/dropRepeats';
import sampleCombine from 'xstream/extra/sampleCombine';
import { VNode, DOMSource } from '@cycle/dom';
import * as dom from '@cycle/dom';
import isolate from '@cycle/isolate';
import { StateSource } from 'cycle-onionify';

import { Sources, Sinks } from './interfaces';
import {SymbolsTab} from './SymbolsTab';
import {ZonesTab} from './ZonesTab';
import Styles from './styles';
import {CddaData, Mapgen, MapgenObject, PlaceLoot, PlaceMonsters, loadCDDAData} from './CddaData';
import {renderMapgen} from './Rendering';

import * as electron from 'electron';
import * as stringify from 'json-beautify';

export type AppSources = Sources & { onion: StateSource<AppState> };
export type AppSinks = Sinks & { onion: Stream<Reducer> };
export type Reducer = (prev: AppState) => AppState;

export type TabName = "map" | "zone";

export type AppState = {
  cddaRoot?: string,
  cddaData?: any,
  mapgen: Mapgen,
  tileset: any,
  selectedSymbolId: string,
  editing?: any,
  mouseX: number | null,
  mouseY: number | null,
  paletteTab: TabName,
  zoneOptions: ZoneOptions;
};

export type ZoneOptions = LootZoneOptions | MonstersZoneOptions;

export interface LootZoneOptions {
  type: "loot";
  groupId: string;
  chance: number;
  repeat: number;
};
export interface MonstersZoneOptions {
  type: "monsters";
  groupId: string;
  chance: number;
  repeat: number;
};

/**
 * source: --a--b----c----d---e-f--g----h---i--j-----
 * first:  -------F------------------F---------------
 * second: -----------------S-----------------S------
 *                         between
 * output: ----------c----d-------------h---i--------
 */
function between(first: Stream<any>, second: Stream<any>): <T>(source: Stream<T>) => Stream<T> {
  return (source: Stream<any>) => first.mapTo(source.endWhen(second)).flatten()
}

export function App(sources: AppSources): AppSinks {
  const appSinks$ = sources.onion.state$
    .startWith({cddaRoot: null})
    .map((state: AppState) => state.cddaRoot)
    .compose(dropRepeats())
    .map((cddaRoot: string | null) => {
      if (cddaRoot == null) {
        return RootPicker(sources);
      } else {
        return Main(sources);
      }
    })
    .remember()
  return {
    onion: appSinks$.map((s: AppSinks) => s.onion).flatten(),
    DOM: appSinks$.map((s: AppSinks) => s.DOM).flatten(),
    electron: appSinks$.map((s: AppSinks) => s.electron || xs.empty()).flatten()
  }
}

function RootPicker(sources: AppSources): AppSinks {
  const pick$ = sources.DOM.select('button')
    .events('click')
    .mapTo({dialog: 'open', options: {properties: ['openDirectory']}});
  const selectRoot$: Stream<Reducer> = sources.electron
    .map((e: any) => (state: AppState): AppState => {
      const cddaRoot = e[0];
      const cddaData = loadCDDAData(e[0])
      const tileset = cddaData.tilesets.find((x: any) => /ChestHoleTileset/.test(x.root))
      electron.remote.getCurrentWindow().setContentSize(tileset.config.tile_info[0].width * (24 + 13), tileset.config.tile_info[0].height * 24)
      return {
        cddaRoot,
        cddaData,
        mapgen: cddaData.objects.filter((o: any) => o.type === 'mapgen')[25],
        tileset,
        selectedSymbolId: " ",
        mouseX: null,
        mouseY: null,
        paletteTab: "map",
        zoneOptions: {
          type: "loot",
          groupId: "everyday_gear",
          chance: 100,
          repeat: 1,
        }
      }
    });
  return {
    DOM: xs.of(<div><button>select CDDA directory</button></div>),
    onion: xs.merge(selectRoot$),
    electron: pick$,
  };
}

function Main(sources: AppSources): AppSinks {
  const mapSinks = Mapg(sources);

  const tileset$ = sources.onion.state$.map(s => s.tileset).compose(dropRepeats()).remember();
  const selectedTab$ = sources.onion.state$.map(s => s.paletteTab).compose(dropRepeats()).remember();

  const tabSinks$ = selectedTab$.map(tab => {
    switch (tab) {
      case 'map':
        return SymbolsTab(sources);
      case 'zone':
        return ZonesTab(sources);
    }
  });

  const tab$ = sources.DOM.select('.tab').events('click')
    .map(e => (e.target as HTMLElement).getAttribute('data-tab') as TabName)
  const tabChange$ = tab$.map(tab => (state: AppState): AppState => ({...state, paletteTab: tab}))

  const tilePaint$ = mapSinks.drags
    .compose(sampleCombine(sources.onion.state$))
    .filter(([_, state]) => state.paletteTab === 'map')
    .map(([drag$, state]) => xs.combine(drag$.map(t => t.current), xs.of(state.selectedSymbolId)))
    .flatten()
    .map(([pos, symbol]) => (state: AppState): AppState => {
      const rows = [...state.mapgen.object.rows];
      const {tx, ty} = pos;
      if (rows[ty][tx] === state.selectedSymbolId)
        return state;
      let row = rows[ty];
      row = row.substring(0, tx) + state.selectedSymbolId + row.substring(tx+1)
      rows[ty] = row
      return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, rows}}}
    })

  const rect$ = mapSinks.drags
    .compose(sampleCombine(sources.onion.state$))
    .filter(([_, state]) => state.paletteTab === 'zone')
    .map(s => s[0].last())
    .flatten()

  const makeZone = (zo: ZoneOptions, xRange: [number, number], yRange: [number, number]): any => {
    switch (zo.type) {
      case 'loot':
        return {group: zo.groupId, chance: zo.chance, repeat: zo.repeat, x: xRange, y: yRange};
      case 'monsters':
        return {monster: zo.groupId, chance: zo.chance, repeat: zo.repeat, x: xRange, y: yRange};
    }
  }

  const drawZone$: Stream<Reducer> = rect$.map(({down, current}) => (state: AppState): AppState => {
    const zoneType = `place_${state.zoneOptions.type}` as 'place_loot' | 'place_monsters';
    return {...state,
      mapgen: {...state.mapgen,
        object: {...state.mapgen.object,
          [zoneType]: [...(state.mapgen.object[zoneType] || []), makeZone(state.zoneOptions, [down.tx, current.tx], [down.ty, current.ty])]
        }
      }
    };
  })

  const action$ = xs.merge(tilePaint$, drawZone$, tabChange$);

  const vdom$ = xs.combine(sources.onion.state$, selectedTab$, mapSinks.DOM || xs.empty(), tabSinks$.map(s => s.DOM || xs.empty()).flatten())
    .map(([state, selectedTab, mapVdom, tabVdom]) =>
      MainView(
        state,
        selectedTab,
        mapVdom,
        tabVdom,
      )
    )

  return {
    DOM: vdom$,
    onion: xs.merge(action$, mapSinks.onion, tabSinks$.map(t => t.onion).flatten()),
  }
}

function MainView(state: AppState, selectedTab: TabName, mapVdom: VNode, tabVdom: VNode): VNode {
  const {cddaData, tileset, mouseX, mouseY, mapgen} = state;
  const hovered = mouseX != null && mouseY != null ?
    {
      terrain: mapgen.object.terrain[mapgen.object.rows[mouseY][mouseX]] || mapgen.object.fill_ter,
      furniture: mapgen.object.furniture[mapgen.object.rows[mouseY][mouseX]],
    } : null;
  const describeHovered = ({terrain, furniture}: any) => {
    const ter = cddaData.terrain[terrain];
    const fur = cddaData.furniture[furniture];
    return `${ter.name}${fur ? ` / ${fur.name}` : ''}`;
  };
  return <div>
    <div style={{display: 'flex', flexDirection: 'row'}}>
      {mapVdom}
      <div style={{marginLeft: `${tileset.config.tile_info[0].width}px`}}>
        <div style={{height: '32px', overflow: 'hidden', textOverflow: 'ellipsis'}}>
          Hovered: {hovered ? describeHovered(hovered) : 'none'}
        </div>
        <ul className={`${Styles.tabs} ${Styles.terrainList}`}>
          {["map", "zone"].map(tabName => {
            const selected = tabName === selectedTab;
            return dom.li('.tab',
              {class: {selected},
               attrs: {'data-tab': tabName}},
              [tabName]
            );
          })}
        </ul>
        {tabVdom}
      </div>
    </div>
  </div>
}

function Mapg(sources: AppSources): AppSinks & {drags: Stream<Stream<{down: {tx: number, ty: number}, current: {tx: number, ty: number}}>>} {
  const {DOM} = sources;
  const mousePos$: Stream<{x: number, y: number} | null> = xs.merge(
    DOM.select('canvas.mapgen').events('mousemove').map((e: MouseEvent) => ({x: e.offsetX, y: e.offsetY})),
    DOM.select('canvas.mapgen').events('mouseout').mapTo(null)
  );

  const pointsAreEqual = (a: {tx: number, ty: number} | null, b: {tx: number, ty: number} | null) =>
      (a == null && b == null) || (a != null && b != null && a.tx == b.tx && a.ty == b.ty);

  const mouseTilePos$: Stream<{tx: number, ty: number} | null> = mousePos$
    .compose(sampleCombine(sources.onion.state$.map(s => s.tileset)))
    .map(([pixelPos, tileset]) => {
      if (pixelPos == null) return null;
      const {x, y} = pixelPos;
      const {config: {tile_info: [{width, height}]}} = tileset
      return {tx: (x / width)|0, ty: (y / height)|0};
    })
    .compose(dropRepeats(pointsAreEqual));


  const map = DOM.select('canvas.mapgen')
  const tileClicks$ = map.events('mousedown')
    .compose(sampleCombine(mouseTilePos$))
    .map(([_, tp]) => tp!) // always non-null because mousedown can't happen after mouseout but before mousemove
  const drags = tileClicks$.map(d =>
    mouseTilePos$
      .startWith(d)
      .filter(x => x != null)
      .map((m: {tx: number, ty: number}) => ({
        down: d,
        current: m,
      }))
      .endWhen(xs.merge(map.events('mouseup'), DOM.select('document').events('blur')))
  );

  const mouseState$: Stream<Reducer> = mouseTilePos$.map(pos => (state: AppState): AppState => (
    {...state, mouseX: pos != null ? pos.tx : null, mouseY: pos != null ? pos.ty : null}
  ));

  return {
    DOM: sources.onion.state$.map(state => {
      const {cddaData, mapgen, tileset, mouseX, mouseY, paletteTab, zoneOptions} = state;
      return dom.thunk('canvas.mapgen', 'mainmap', renderMapgen,
        [cddaData, mapgen, tileset, mouseX, mouseY, paletteTab, zoneOptions]);
    }),
    onion: xs.merge(mouseState$),
    drags,
  }
}
