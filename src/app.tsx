import xs, { Stream } from 'xstream';
import dropRepeats from 'xstream/extra/dropRepeats';
import dropUntil from 'xstream/extra/dropUntil';
import concat from 'xstream/extra/concat';
import sampleCombine from 'xstream/extra/sampleCombine';
import { VNode, DOMSource } from '@cycle/dom';
import * as dom from '@cycle/dom';
import isolate from '@cycle/isolate';
import { StateSource } from 'cycle-onionify';
import * as fs from 'fs';

import { Sources, Sinks, ElectronMessage } from './interfaces';
import {SymbolsTab} from './SymbolsTab';
import {ZonesTab} from './ZonesTab';
import Styles from './styles';
import {CddaData, Mapgen, MapgenObject, PlaceLoot, PlaceMonsters, loadCDDAData, emptyMapgen} from './CddaData';
import {renderMapgen} from './Rendering';

import * as electron from 'electron';
import * as stringify from 'json-beautify';

export type AppSources = Sources & { onion: StateSource<AppState> };
export type AppSinks = Sinks & { onion: Stream<Reducer> };
export type Reducer = (prev: AppState) => AppState;

export type TabName = "map" | "zone";

export interface AppState {
  cddaRoot?: string;
  cddaData?: any;
  mapgen: Mapgen;
  tileset: any;
  selectedSymbolId: string;
  editing?: any;
  mouseX: number | null;
  mouseY: number | null;
  paletteTab: TabName;
  zoneOptions: ZoneOptions;
  selectedZone: ['loot' | 'monsters', number] | null;
  intermediateRect: {current: {tx: number, ty: number}, down: {tx: number, ty: number}} | null;
};

export type ZoneOptions = LootZoneOptions | MonstersZoneOptions;

export interface LootZoneOptions {
  type: "loot";
  groupId: string;
  chance: number | null;
  repeat: [number] | [number, number] | null;
};
export interface MonstersZoneOptions {
  type: "monsters";
  groupId: string;
  chance: number | null;
  repeat: [number] | [number, number] | null;
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
    .debug('state')
    .startWith({cddaRoot: null} as any as AppState)
    .map((state: AppState) => state.cddaRoot)
    .compose(dropRepeats())
    .map((cddaRoot: string | undefined) => {
      if (cddaRoot == null) {
        return RootPicker(sources);
      } else {
        return Main(sources);
      }
    })
    .remember()
  return {
    onion: appSinks$.map((s: AppSinks) => s.onion).flatten(),
    DOM: appSinks$.map((s: AppSinks) => s.DOM || xs.empty()).flatten(),
    electron: appSinks$.map((s: AppSinks) => s.electron || xs.empty()).flatten()
  }
}

function RootPicker(sources: AppSources): AppSinks {
  const pick$ = sources.DOM.select('button')
    .events('click')
    .mapTo({type: 'dialog', dialog: 'open', options: {properties: ['openDirectory']}} as ElectronMessage);
  const pathFromLocalStorage = localStorage.getItem('cddaRoot');
  const initialRoot$ = pathFromLocalStorage != null ? xs.of(pathFromLocalStorage) : xs.empty();
  const selectRoot$: Stream<Reducer> = xs.merge(sources.electron, initialRoot$.map(r => [r]))
    .map((e: any) => (state: AppState): AppState => {
      const cddaRoot = e[0];
      const cddaData = loadCDDAData(e[0])
      localStorage.setItem('cddaRoot', cddaRoot)
      const tileset = cddaData.tilesets.find((x: any) => /ChestHoleTileset$/.test(x.root))
      electron.remote.getCurrentWindow().setContentSize(tileset.config.tile_info[0].width * (24 + 13), tileset.config.tile_info[0].height * 24)
      return {
        cddaRoot,
        cddaData,
        mapgen: emptyMapgen,
        tileset,
        selectedSymbolId: " ",
        mouseX: null,
        mouseY: null,
        paletteTab: "map",
        zoneOptions: {
          type: "loot",
          groupId: "everyday_gear",
          chance: 100,
          repeat: [1],
        },
        intermediateRect: null,
        selectedZone: null
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

  const tilePaint$ = xs.merge(mapSinks.drags.flatten().map(t => t.current), mapSinks.clicks)
    .compose(sampleCombine(sources.onion.state$))
    .filter(([_, state]) => state.paletteTab === 'map')
    .map(([pos, _]) => (state: AppState): AppState => {
      const rows = [...state.mapgen.object.rows];
      const {tx, ty} = pos;
      if (rows[ty][tx] === state.selectedSymbolId)
        return state;
      const row = rows[ty];
      rows[ty] = row.substring(0, tx) + state.selectedSymbolId + row.substring(tx+1)
      return {...state, mapgen: {...state.mapgen, object: {...state.mapgen.object, rows}}}
    })

  const rect$ = mapSinks.drags
    .compose(sampleCombine(sources.onion.state$))
    .filter(([_, state]) => state.paletteTab === 'zone')
    .map(s => s[0].last().replaceError(e => xs.empty()))
    .flatten()

  const makeZone = (zo: ZoneOptions, xRange: [number, number], yRange: [number, number]): any => {
    switch (zo.type) {
      case 'loot':
        return {group: zo.groupId, chance: zo.chance, repeat: zo.repeat, x: xRange, y: yRange};
      case 'monsters':
        return {monster: zo.groupId, chance: zo.chance, repeat: zo.repeat, x: xRange, y: yRange};
    }
  }

  function within(x: number, y: number, xrange: [number, number] | [number] | number, yrange: [number, number] | [number] | number): boolean {
    const [xLo, xHi] = Array.isArray(xrange) ? [Math.min.apply(null, xrange), Math.max.apply(null, xrange)] : [xrange, xrange];
    const [yLo, yHi] = Array.isArray(yrange) ? [Math.min.apply(null, yrange), Math.max.apply(null, yrange)] : [yrange, yrange];
    return x >= xLo && x <= xHi && y >= yLo && y <= yHi;
  }

  const zoneClick$ = mapSinks.clicks
    .compose(sampleCombine(sources.onion.state$))
    .map(([pos, state]) => {
      const zoneType = `place_${state.zoneOptions.type}` as 'place_loot' | 'place_monsters';
      const things = (state.mapgen.object[zoneType] || []);
      const idx = (things as PlaceLoot[]).findIndex((z: PlaceLoot) => within(pos.tx, pos.ty, z.x, z.y))
      return [state.zoneOptions.type, idx] as ['loot' | 'monsters', number]
    })
    .map(sel => sel[1] >= 0 ? sel : null)

  const selectZone$: Stream<Reducer> = zoneClick$.map((zoneId) => (state: AppState): AppState => {
    if (zoneId != null) {
      const [zt, idx] = zoneId;
      const zoneType = zt === 'loot' ? 'place_loot' : 'place_monsters';
      const normalizeRepeat = (rep: number | [number] | [number, number] | undefined): [number] | [number, number] => {
        if (typeof rep === 'number') return [rep];
        else if (rep == null) return [1];
        else return rep;
      }
      if (zt === 'loot') {
        const zone = (state.mapgen.object.place_loot || [])[idx];
        const zoneOptions: LootZoneOptions = {
          type: 'loot',
          groupId: zone.group,
          repeat: normalizeRepeat(zone.repeat),
          chance: zone.chance == null ? 100 : zone.chance,
        };
        return {...state, selectedZone: zoneId, zoneOptions};
      } else if (zt === 'monsters') {
        const zone = (state.mapgen.object.place_monsters || [])[idx];
        const zoneOptions: MonstersZoneOptions = {
          type: 'monsters',
          groupId: zone.monster,
          repeat: normalizeRepeat(zone.repeat),
          chance: zone.chance == null ? 1 : zone.chance,
        };
        return {...state, selectedZone: zoneId, zoneOptions}
      } else {
        return {...state, selectedZone: null}
      }
    } else {
      return {...state, selectedZone: null}
    }
  })

  const drawZone$: Stream<Reducer> = rect$
    .map(({down, current}) => (state: AppState): AppState => {
      const zoneType = `place_${state.zoneOptions.type}` as 'place_loot' | 'place_monsters';
      const newZones = [...(state.mapgen.object[zoneType] || []), makeZone(state.zoneOptions, [down.tx, current.tx], [down.ty, current.ty])];
      return {...state,
        mapgen: {...state.mapgen,
          object: {...state.mapgen.object,
            [zoneType]: newZones
          }
        },
        selectedZone: [state.zoneOptions.type, newZones.length - 1]
      };
    })

  const intermediateRect$ = mapSinks.drags.map(drag$ =>
    concat(
      drag$.map(d => (state: AppState): AppState => ({...state, intermediateRect: d})),
      xs.of((state: AppState): AppState => ({...state, intermediateRect: null}))
    )
  ).flatten()

  const mapgenIdEdit$ = sources.DOM.select('.om_terrain').events('input')
    .map(e => (e.target as HTMLInputElement).value)
    .map(overmapId => (state: AppState): AppState => ({...state, mapgen: {...state.mapgen, om_terrain: [overmapId]}}))

  const clear$ = sources.DOM.select('.clear').events('click').filter(() => confirm("Unsaved changes will be lost. Proceed?")).mapTo((state: AppState): AppState => {
    return {...state, mapgen: emptyMapgen}
  });

  const open$: Stream<ElectronMessage> = sources.DOM.select('.open').events('click')
    .mapTo({type: 'dialog', dialog: 'open'} as ElectronMessage)

  const loadFromFile$ = sources.electron.map(e => (state: AppState): AppState => {
    if (e.length === 0) {
      // User canceled.
      return state;
    }
    try {
      const mapgenFile = e[0];
      const mapgenJson = JSON.parse(fs.readFileSync(mapgenFile).toString());
      if (!Array.isArray(mapgenJson)) {
        alert("Root of JSON must be an array.");
        return state;
      }
      const mapgens = mapgenJson.filter(obj => obj.type === 'mapgen');
      if (mapgens.length > 1) {
        alert("CDDA-edit only supports one mapgen per file currently.")
        return state;
      }
      const mapgen = mapgens[0];
      if (mapgen.type !== 'mapgen') {
        alert("This doesn't appear to be a JSON mapgen.")
        return state;
      }
      if (mapgen.method !== 'json') {
        alert("Can't edit a Lua mapgen! Don't be silly!")
      }
      // TODO: more checks that the mapgen JSON makes sense & is something we can handle
      return {...state, mapgen};
    } catch (e) {
      alert("This doesn't look like a valid mapgen JSON file.")
    }
    return state;
  })

  const export$ = sources.DOM.select('.export').events('click').compose(sampleCombine(sources.onion.state$)).map(([_, state]) => state.mapgen).map(mapgen => {
    return {
      type: 'dialog',
      dialog: 'save',
      data: stringify(mapgen, null, 2, 100)
    } as ElectronMessage;
  });

  const action$ = xs.merge(
    tilePaint$,
    drawZone$,
    selectZone$,
    intermediateRect$,
    tabChange$,
    clear$,
    loadFromFile$,
    mapgenIdEdit$
  );

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
    electron: xs.merge(export$, open$)
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
      <div style={{marginLeft: `${tileset.config.tile_info[0].width}px`, display: 'flex', flexDirection: 'column'}}>
        <div style={{flexGrow: '1'}}>
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
        <div>
          <div>
            Overmap ID: {dom.input('.om_terrain', {attrs: {type: 'text'}, props: {value: state.mapgen.om_terrain[0]}})}
          </div>
          <div>
            <button className='clear'>new</button>
            {' '}
            <button className='open'>open</button>
            {' '}
            <button className='export'>export</button>
          </div>
        </div>
      </div>
    </div>
  </div>
}

function dropUntilMatches<T>(pred: (t: T) => boolean): (s: Stream<T>) => Stream<T> {
  return (s: Stream<T>) => s.compose(dropUntil(s.filter(pred)))
}

function Mapg(sources: AppSources): AppSinks & {
  drags: Stream<Stream<{down: {tx: number, ty: number}, current: {tx: number, ty: number}}>>,
  clicks: Stream<{tx: number, ty: number}>,
} {
  const {DOM} = sources;
  const mousePos$: Stream<{x: number, y: number} | null> = xs.merge(
    DOM.select('canvas.mapgen').events('mousemove').map((e: MouseEvent) => ({x: e.offsetX, y: e.offsetY})),
    DOM.select('canvas.mapgen').events('mouseout').mapTo(null)
  );

  const pointsAreEqual = (a: {tx: number, ty: number} | null, b: {tx: number, ty: number} | null) =>
      (a == null && b == null) || (a != null && b != null && a.tx === b.tx && a.ty === b.ty);

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
  const mouseClick$ = map.events('mousedown')
    .compose(sampleCombine(mousePos$))
    .map(([_, tp]) => tp!)
  const mouseDrags$ = mouseClick$.map(d =>
    mousePos$
      .startWith(d)
      .filter(x => x != null)
      .map((m: {x: number, y: number}) => ({down: d, current: m}))
      .compose(dropUntilMatches((p: {current: {x: number, y: number}, down: {x: number, y: number}}) =>
        Math.abs(p.current.x - p.down.x) >= 5 || Math.abs(p.current.y - p.down.y) >= 5
      ))
      .endWhen(xs.merge(map.events('mouseup'), DOM.select('document').events('blur')))
  );
  const mouseTileDrag$ = mouseDrags$.map(d =>
    d.compose(sampleCombine(sources.onion.state$.map(s => s.tileset)))
      .map(([pixelPos, tileset]) => {
        const {current: {x: cx, y: cy}, down: {x: dx, y: dy}} = pixelPos;
        const {config: {tile_info: [{width, height}]}} = tileset
        return {
          current: {tx: (cx / width)|0, ty: (cy / height)|0},
          down: {tx: (dx / width)|0, ty: (dy / height)|0}
        };
      })
  )
  const tileClicks$ = map.events('mousedown')
    .compose(sampleCombine(mouseTilePos$))
    .map(([_, tp]) => tp!) // always non-null because mousedown can't happen after mouseout but before mousemove

  const mouseState$: Stream<Reducer> = mouseTilePos$.map(pos => (state: AppState): AppState => (
    {...state, mouseX: pos != null ? pos.tx : null, mouseY: pos != null ? pos.ty : null}
  ));

  return {
    DOM: sources.onion.state$.map(state => {
      const {cddaData, mapgen, tileset, mouseX, mouseY, paletteTab, zoneOptions} = state;
      return dom.thunk('canvas.mapgen', 'mainmap', renderMapgen,
        [cddaData, mapgen, tileset, mouseX, mouseY, paletteTab, zoneOptions, state.selectedZone, state.intermediateRect]);
    }),
    onion: xs.merge(mouseState$),
    clicks: tileClicks$,
    drags: mouseTileDrag$,
  }
}
